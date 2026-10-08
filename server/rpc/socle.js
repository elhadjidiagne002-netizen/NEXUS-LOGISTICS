// Cycle C1 — socle : utilisateur connecté, équipe et rôles, chauffeurs, lieux, réglages, appareils.
// Portage des fonctions Postgres de 20261007000800_administration.sql et 20261008001500_cycle15_appareils.sql,
// limité à l'entreprise active (ctx.company.id).
import { sha256Hex, randomToken } from '../crypto.js';
import { cleanConfig, parseSettings } from '../config.js';
import { fail, audit } from './core.js';
import { isPlatformAdmin, effectivePlan, checkQuota } from './offre.js';

const STAFF_ROLES = ['picker', 'dock_chief', 'dispatcher', 'cashier', 'accountant', 'support'];
const VEHICLE_KINDS = ['moto', 'velo', 'voiture', 'fourgonnette', 'tricycle', 'pied'];
const INVITE_DAYS = 7;

const text = (v, max = 200) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const uuid = () => crypto.randomUUID();
const bool = (v) => (v ? 1 : 0);

async function hubsOf(ctx) {
  return (await ctx.db.prepare('SELECT id, name, kind, address, lat, lng FROM hubs WHERE company_id = ? AND active = 1 ORDER BY created_at')
    .bind(ctx.company.id).all()).results;
}

async function isMember(ctx, userId) {
  if (typeof userId !== 'string') return false;
  return Boolean(await ctx.db.prepare('SELECT 1 AS x FROM members WHERE company_id = ? AND user_id = ?').bind(ctx.company.id, userId).first());
}

export default {
  // Qui suis-je, dans quelle entreprise, avec quels rôles (même forme que la version Postgres).
  lg_me: {
    roles: 'member',
    async handler(ctx) {
      const hubs = await hubsOf(ctx);
      const byId = Object.fromEntries(hubs.map((h) => [h.id, h.name]));
      const c = ctx.company;
      const loc = await ctx.db.prepare('SELECT address, lat, lng FROM members WHERE company_id = ? AND user_id = ?').bind(ctx.company.id, ctx.user.id).first();
      const companies = (await ctx.db.prepare(
        'SELECT c.id, c.name FROM members m JOIN companies c ON c.id = m.company_id WHERE m.user_id = ? AND c.suspended_at IS NULL ORDER BY m.created_at',
      ).bind(ctx.user.id).all()).results;
      return {
        user_id: ctx.user.id, name: ctx.user.name, email: ctx.user.email, phone: ctx.user.phone,
        profile_role: ctx.member, member_role: ctx.member,
        is_admin: ctx.isAdmin, is_owner: ctx.member === 'owner', is_vendor: ctx.member === 'vendor',
        courier_id: ctx.courierId,
        roles: ctx.roles.map((r) => ({ role: r.role, hub_id: r.hub_id, hub: r.hub_id ? byId[r.hub_id] ?? null : null })),
        hubs,
        company: { id: c.id, name: c.name, slug: c.slug, kind: c.kind, city: c.city, phone: c.phone, plan: c.plan, plan_until: c.plan_until },
        companies,
        is_platform_admin: isPlatformAdmin(ctx.env, ctx.user),
        plan: effectivePlan(c, ctx.now),
        location: loc ?? null,   // adresse de collecte (vendeur)
        config: { max_attempts: c.config.max_attempts, require_photo: c.config.require_photo, proof_radius_m: c.config.proof_radius_m, heavy_kg: c.config.heavy_kg },
      };
    },
  },

  // Coordonnées de l'entreprise (propriétaire ou administrateur).
  lg_company_update: {
    roles: 'admin',
    async handler(ctx, a) {
      const name = text(a.p_name, 120);
      if (a.p_name !== undefined && !name) fail('invalid_name');
      await ctx.db.prepare('UPDATE companies SET name = coalesce(?, name), phone = coalesce(?, phone), city = coalesce(?, city) WHERE id = ?')
        .bind(name, text(a.p_phone, 30), text(a.p_city, 60), ctx.company.id).run();
      await audit(ctx, 'company_update', 'company', ctx.company.id, { name, phone: a.p_phone, city: a.p_city });
      return { ok: true };
    },
  },

  // ----------------------------------------------------------------- équipe et rôles
  lg_team_list: {
    roles: 'admin',
    async handler(ctx) {
      const r = await ctx.db.prepare(
        `SELECT u.id AS user_id, u.name, u.email, u.phone, m.role AS member_role, m.created_at AS since,
                (SELECT json_group_array(json_object('role', s.role, 'hub_id', s.hub_id)) FROM staff_roles s
                  WHERE s.company_id = m.company_id AND s.user_id = m.user_id AND s.active = 1) AS staff
           FROM members m JOIN users u ON u.id = m.user_id WHERE m.company_id = ? ORDER BY u.name`,
      ).bind(ctx.company.id).all();
      return r.results.map(({ staff, ...x }) => ({ ...x, roles: JSON.parse(staff || '[]') }));
    },
  },

  lg_staff_list: {
    roles: 'admin',
    async handler(ctx) {
      const r = await ctx.db.prepare(
        `SELECT s.user_id, u.name, u.email, u.phone, s.role, h.name AS hub, s.hub_id, s.active, s.updated_at AS since
           FROM staff_roles s JOIN users u ON u.id = s.user_id LEFT JOIN hubs h ON h.id = s.hub_id AND h.company_id = s.company_id
          WHERE s.company_id = ? ORDER BY u.name, s.role`,
      ).bind(ctx.company.id).all();
      return r.results.map((x) => ({ ...x, active: Boolean(x.active) }));
    },
  },

  // Recherche parmi les MEMBRES de l'entreprise (jamais parmi tous les comptes de la plateforme).
  lg_find_users: {
    roles: 'admin',
    async handler(ctx, a) {
      const q = String(a.p_q ?? '').trim();
      if (q.length < 2) return [];
      const like = `%${q.replace(/[%_]/g, '')}%`;
      return (await ctx.db.prepare(
        `SELECT u.id, u.name, u.email, u.phone, m.role FROM members m JOIN users u ON u.id = m.user_id
          WHERE m.company_id = ? AND (u.name LIKE ? OR u.email LIKE ? OR coalesce(u.phone, '') LIKE ?) ORDER BY u.name LIMIT 15`,
      ).bind(ctx.company.id, like, like, like).all()).results;
    },
  },

  lg_grant_role: {
    roles: 'admin',
    async handler(ctx, a) {
      if (!STAFF_ROLES.includes(a.p_role)) fail('invalid_role');
      if (!(await isMember(ctx, a.p_user))) fail('unknown_user', 404);
      const hub = a.p_hub || null;
      if (hub && !(await ctx.db.prepare('SELECT 1 AS x FROM hubs WHERE id = ? AND company_id = ?').bind(hub, ctx.company.id).first())) fail('unknown_hub', 404);
      await ctx.db.batch([
        ctx.db.prepare(
          `INSERT INTO staff_roles (company_id, user_id, role, hub_id, active, granted_by, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT (company_id, user_id, role) DO UPDATE SET active = 1, hub_id = excluded.hub_id, granted_by = excluded.granted_by, updated_at = excluded.updated_at`,
        ).bind(ctx.company.id, a.p_user, a.p_role, hub, ctx.user.id, ctx.now),
        // un vendeur ou chauffeur qui reçoit un rôle d'équipe devient membre « staff » (ses fiches restent)
        ctx.db.prepare("UPDATE members SET role = 'staff' WHERE company_id = ? AND user_id = ? AND role IN ('vendor')").bind(ctx.company.id, a.p_user),
      ]);
      await audit(ctx, 'role_grant', 'user', a.p_user, { role: a.p_role, hub });
      return { ok: true };
    },
  },

  lg_revoke_role: {
    roles: 'admin',
    async handler(ctx, a) {
      const r = await ctx.db.prepare('UPDATE staff_roles SET active = 0, updated_at = ? WHERE company_id = ? AND user_id = ? AND role = ? AND active = 1')
        .bind(ctx.now, ctx.company.id, a.p_user, a.p_role).run();
      await audit(ctx, 'role_revoke', 'user', a.p_user, { role: a.p_role });
      return { ok: r.meta.changes > 0 };
    },
  },

  // Invitation par lien (à envoyer par WhatsApp). Le jeton n'est montré qu'une fois ; on stocke son empreinte.
  lg_invite_create: {
    roles: 'admin',
    async handler(ctx, a) {
      const role = a.p_role ?? 'staff';
      if (!['admin', 'staff', 'vendor', 'courier'].includes(role)) fail('invalid_role');
      if (role === 'admin' && ctx.member !== 'owner') fail('owner_only', 403);
      const staff = Array.isArray(a.p_staff_roles) ? a.p_staff_roles.filter((r) => STAFF_ROLES.includes(r)) : [];
      if (role === 'courier') await checkQuota(ctx, 'couriers');
      const token = randomToken(24);
      const expires = new Date(Date.now() + INVITE_DAYS * 86400000).toISOString();
      await ctx.db.prepare('INSERT INTO invites (token_hash, company_id, role, staff_roles, name, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(await sha256Hex(token), ctx.company.id, role, JSON.stringify(staff), text(a.p_name, 80), ctx.user.id, expires).run();
      await audit(ctx, 'invite_create', 'invite', null, { role, staff });
      return { ok: true, token, path: `/invitation/${token}`, expires_at: expires };
    },
  },

  lg_member_remove: {
    roles: 'admin',
    async handler(ctx, a) {
      if (a.p_user === ctx.user.id) fail('cannot_remove_self');
      const m = await ctx.db.prepare('SELECT role FROM members WHERE company_id = ? AND user_id = ?').bind(ctx.company.id, a.p_user).first();
      if (!m) fail('unknown_user', 404);
      if (m.role === 'owner') fail('cannot_remove_owner', 403);
      if (m.role === 'admin' && ctx.member !== 'owner') fail('owner_only', 403);
      await ctx.db.batch([
        ctx.db.prepare('DELETE FROM staff_roles WHERE company_id = ? AND user_id = ?').bind(ctx.company.id, a.p_user),
        ctx.db.prepare('UPDATE couriers SET user_id = NULL, active = 0 WHERE company_id = ? AND user_id = ?').bind(ctx.company.id, a.p_user),
        ctx.db.prepare('DELETE FROM devices WHERE company_id = ? AND user_id = ?').bind(ctx.company.id, a.p_user),
        ctx.db.prepare('DELETE FROM members WHERE company_id = ? AND user_id = ?').bind(ctx.company.id, a.p_user),
        // ses sessions ouvertes sur CETTE entreprise sont fermées
        ctx.db.prepare('UPDATE sessions SET company_id = NULL WHERE user_id = ? AND company_id = ?').bind(a.p_user, ctx.company.id),
      ]);
      await audit(ctx, 'member_remove', 'user', a.p_user, null);
      return { ok: true };
    },
  },

  // ----------------------------------------------------------------- chauffeurs et lieux
  lg_couriers_list: {
    roles: ['dock_chief', 'dispatcher', 'cashier'],
    async handler(ctx) {
      const r = await ctx.db.prepare(
        `SELECT id, user_id, name, phone, vehicle_kind AS vehicle_type, CASE WHEN active = 1 THEN 'active' ELSE 'inactive' END AS status,
                last_seen_at, license_expires_at,
                EXISTS (SELECT 1 FROM trips t WHERE t.courier_id = couriers.id AND t.status IN ('planned', 'loading', 'sealed', 'in_progress', 'completed')) AS busy
           FROM couriers WHERE company_id = ? AND active = 1 ORDER BY name`,
      ).bind(ctx.company.id).all();
      // occupé = voyage ouvert ou pas encore clôturé en caisse
      return r.results.map((c) => ({ ...c, busy: Boolean(c.busy) }));
    },
  },

  lg_courier_upsert: {
    roles: 'admin',
    async handler(ctx, a) {
      const name = text(a.p_name, 80);
      if (!name) fail('invalid_name');
      const kind = a.p_vehicle_kind ?? 'moto';
      if (!VEHICLE_KINDS.includes(kind)) fail('invalid_vehicle');
      const userId = a.p_user || null;
      if (userId && !(await isMember(ctx, userId))) fail('unknown_user', 404);
      const id = a.p_id || uuid();
      if (a.p_id) {
        const r = await ctx.db.prepare('UPDATE couriers SET name = ?, phone = ?, vehicle_kind = ?, user_id = ?, active = ? WHERE id = ? AND company_id = ?')
          .bind(name, text(a.p_phone, 30), kind, userId, bool(a.p_active !== false), id, ctx.company.id).run();
        if (!r.meta.changes) fail('unknown_courier', 404);
      } else {
        await checkQuota(ctx, 'couriers');
        await ctx.db.prepare('INSERT INTO couriers (id, company_id, user_id, name, phone, vehicle_kind) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(id, ctx.company.id, userId, name, text(a.p_phone, 30), kind).run();
      }
      await audit(ctx, 'courier_upsert', 'courier', id, { name, kind, user: userId });
      return { ok: true, id };
    },
  },

  lg_hub_upsert: {
    roles: 'admin',
    async handler(ctx, a) {
      const name = text(a.p_name, 80);
      if (!name) fail('invalid_name');
      const kind = a.p_kind ?? 'hub';
      if (!['hub', 'relay', 'vendor'].includes(kind)) fail('invalid_kind');
      const lat = num(a.p_lat); const lng = num(a.p_lng);
      if ((lat != null && Math.abs(lat) > 90) || (lng != null && Math.abs(lng) > 180)) fail('invalid_position');
      const id = a.p_id || uuid();
      if (a.p_id) {
        const r = await ctx.db.prepare('UPDATE hubs SET name = ?, kind = ?, address = ?, lat = ?, lng = ?, active = ? WHERE id = ? AND company_id = ?')
          .bind(name, kind, text(a.p_address, 200), lat, lng, bool(a.p_active !== false), id, ctx.company.id).run();
        if (!r.meta.changes) fail('unknown_hub', 404);
      } else {
        await checkQuota(ctx, 'hubs');
        await ctx.db.prepare('INSERT INTO hubs (id, company_id, name, kind, address, lat, lng) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(id, ctx.company.id, name, kind, text(a.p_address, 200), lat, lng).run();
      }
      await audit(ctx, 'hub_upsert', 'hub', id, { name, kind });
      return { ok: true, id };
    },
  },

  // ----------------------------------------------------------------- réglages
  lg_set_config: {
    roles: 'admin',
    async handler(ctx, a) {
      const clean = cleanConfig(a.p);
      const merged = { ...parseSettings(ctx.company.settings), ...clean };
      await ctx.db.prepare('UPDATE companies SET settings = ? WHERE id = ?').bind(JSON.stringify(merged), ctx.company.id).run();
      await audit(ctx, 'config', 'company', ctx.company.id, clean);
      return { ok: true, config: merged };
    },
  },

  lg_config: {
    roles: 'member',
    async handler(ctx) {
      return { config: ctx.company.config, saved: parseSettings(ctx.company.settings) };
    },
  },

  // ----------------------------------------------------------------- appareils
  lg_device_ping: {
    roles: 'member',
    allowBlocked: true, // doit pouvoir répondre « bloqué » à l'appareil bloqué
    async handler(ctx, a) {
      const dev = a.p_device;
      if (typeof dev !== 'string' || dev.length < 8 || dev.length > 64) fail('invalid_device');
      const ua = (ctx.request.headers.get('user-agent') || '').slice(0, 300) || null;
      const d = await ctx.db.prepare(
        `INSERT INTO devices (id, company_id, user_id, device_id, label, user_agent, session_id) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (company_id, user_id, device_id) DO UPDATE SET last_seen_at = ?,
           label = coalesce(excluded.label, devices.label), user_agent = coalesce(excluded.user_agent, devices.user_agent),
           session_id = excluded.session_id
         RETURNING id, blocked, revoked_session`,
      ).bind(uuid(), ctx.company.id, ctx.user.id, dev, text(a.p_label, 80), ua, ctx.sessionId, ctx.now).first();
      if (d.blocked) return { ok: false, error: 'device_blocked' };
      if (d.revoked_session && d.revoked_session === ctx.sessionId) return { ok: false, error: 'device_revoked' };
      return { ok: true, id: d.id };
    },
  },

  lg_devices_list: {
    roles: 'member',
    async handler(ctx, a) {
      const all = ctx.isAdmin;
      const r = await ctx.db.prepare(
        `SELECT d.id, d.user_id, u.name AS user, d.label, d.user_agent, d.first_seen_at, d.last_seen_at, d.blocked, d.blocked_at, d.revoked_at,
                d.device_id, d.session_id, d.revoked_session
           FROM devices d JOIN users u ON u.id = d.user_id
          WHERE d.company_id = ? AND (? = 1 AND (? IS NULL OR d.user_id = ?) OR d.user_id = ?)
          ORDER BY d.blocked DESC, d.last_seen_at DESC`,
      ).bind(ctx.company.id, all ? 1 : 0, a.p_user ?? null, a.p_user ?? null, ctx.user.id).all();
      return r.results.map(({ device_id, session_id, revoked_session, ...d }) => ({
        ...d, blocked: Boolean(d.blocked),
        this_device: device_id === ctx.deviceId && d.user_id === ctx.user.id,
        active_session: Boolean(session_id) && session_id !== revoked_session,
      }));
    },
  },

  lg_device_block: {
    roles: 'admin',
    async handler(ctx, a) {
      const d = await ctx.db.prepare('SELECT user_id, device_id, label FROM devices WHERE id = ? AND company_id = ?').bind(a.p_id, ctx.company.id).first();
      if (!d) fail('unknown_device', 404);
      const blocked = a.p_blocked !== false;
      if (blocked && d.user_id === ctx.user.id && d.device_id === ctx.deviceId) return { ok: false, error: 'cannot_block_self' };
      await ctx.db.prepare('UPDATE devices SET blocked = ?, blocked_at = ? WHERE id = ? AND company_id = ?')
        .bind(bool(blocked), blocked ? ctx.now : null, a.p_id, ctx.company.id).run();
      await audit(ctx, blocked ? 'device_block' : 'device_unblock', 'device', a.p_id, { user: d.user_id, label: d.label });
      return { ok: true, blocked };
    },
  },

  lg_device_revoke: {
    roles: 'member',
    async handler(ctx, a) {
      const d = await ctx.db.prepare('SELECT user_id, session_id, label FROM devices WHERE id = ? AND company_id = ?').bind(a.p_id, ctx.company.id).first();
      if (!d) fail('unknown_device', 404);
      if (!(ctx.isAdmin || d.user_id === ctx.user.id)) fail('forbidden', 403);
      if (!d.session_id) return { ok: false, error: 'no_session' };
      await ctx.db.prepare('UPDATE devices SET revoked_session = session_id, revoked_at = ? WHERE id = ? AND company_id = ?')
        .bind(ctx.now, a.p_id, ctx.company.id).run();
      await audit(ctx, 'device_revoke', 'device', a.p_id, { user: d.user_id, label: d.label });
      return { ok: true };
    },
  },
};
