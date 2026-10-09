// Administration de la plateforme — compléments du tableau de bord /admin/ (connexion par compte Devizo, cf.
// server/routes/admin.js) : détail d'une entreprise, membres et rôles, comptes, commandes de toutes les entreprises,
// clés d'API, état du système (tâches planifiées, files d'envoi), journal des actions d'administration.
// Toutes en rôle 'platform' : AUCUN filtre par entreprise (vue d'ensemble voulue) — elles ne sont joignables que
// par l'administration (ADMIN_EMAILS). `read: true` = lecture seule, non journalisée dans admin_audit.
import { fail, text, int, parseJson } from './core.js';
import { effectivePlan } from './offre.js';

const MEMBER_ROLES = ['owner', 'admin', 'staff', 'vendor', 'courier'];
const ORDER_STATUSES = ['pending', 'processing', 'in_transit', 'delivered', 'cancelled'];
const like = (q) => `%${String(q ?? '').trim().toLowerCase().replace(/[%_]/g, '')}%`;
const days = (now, n) => new Date(Date.parse(now) - n * 86400000).toISOString();

async function mustCompany(ctx, id) {
  const c = await ctx.db.prepare('SELECT * FROM companies WHERE id = ?').bind(String(id ?? '')).first();
  if (!c) fail('unknown_company', 404);
  return c;
}

export default {
  lg_platform_company_detail: {
    roles: 'platform', read: true,
    async handler(ctx, a) {
      const c = await mustCompany(ctx, a.p_company);
      const id = c.id; const d30 = days(ctx.now, 30); const d7 = days(ctx.now, 7);
      const [members, hubs, keys, hook, counts, orders, pays, activity] = await ctx.db.batch([
        ctx.db.prepare(`SELECT u.id AS user_id, u.name, u.email, u.phone, u.suspended_at, m.role, m.created_at AS since,
              (SELECT json_group_array(s.role) FROM staff_roles s WHERE s.company_id = m.company_id AND s.user_id = m.user_id AND s.active = 1) AS staff,
              (SELECT max(created_at) FROM sessions x WHERE x.user_id = u.id) AS last_login
            FROM members m JOIN users u ON u.id = m.user_id WHERE m.company_id = ? ORDER BY m.role = 'owner' DESC, u.name`).bind(id),
        ctx.db.prepare('SELECT id, name, kind, address, active FROM hubs WHERE company_id = ? ORDER BY created_at').bind(id),
        ctx.db.prepare('SELECT id, name, prefix, created_at, last_used_at, revoked_at FROM api_keys WHERE company_id = ? ORDER BY created_at DESC').bind(id),
        ctx.db.prepare('SELECT url, active, last_error, updated_at FROM webhook_endpoints WHERE company_id = ?').bind(id),
        ctx.db.prepare(`SELECT
              (SELECT count(*) FROM orders WHERE company_id = ?1) AS orders,
              (SELECT count(*) FROM orders WHERE company_id = ?1 AND created_at >= ?2) AS orders_30d,
              (SELECT count(*) FROM orders WHERE company_id = ?1 AND status = 'delivered' AND delivered_at >= ?2) AS delivered_30d,
              (SELECT count(*) FROM couriers WHERE company_id = ?1 AND active = 1) AS couriers,
              (SELECT count(*) FROM trips WHERE company_id = ?1 AND created_at >= ?2) AS trips_30d,
              (SELECT count(*) FROM invoices WHERE company_id = ?1) AS invoices,
              (SELECT count(*) FROM outbox WHERE company_id = ?1 AND status = 'failed' AND created_at >= ?3) AS messages_failed_7d,
              (SELECT count(*) FROM devices WHERE company_id = ?1 AND blocked = 1) AS devices_blocked`).bind(id, d30, d7),
        ctx.db.prepare(`SELECT id, number, external_ref, status, payment_method, payment_status, payment_terms_days, buyer_name, delivery_zone, total_fcfa, created_at
            FROM orders WHERE company_id = ? ORDER BY created_at DESC LIMIT 20`).bind(id),
        ctx.db.prepare('SELECT id, months, amount_fcfa, method, ref, status, declared_at, decided_at, note FROM plan_payments WHERE company_id = ? ORDER BY declared_at DESC LIMIT 24').bind(id),
        ctx.db.prepare(`SELECT a.action, a.entity, a.created_at, u.name AS user FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
            WHERE a.company_id = ? ORDER BY a.id DESC LIMIT 30`).bind(id),
      ]);
      const { settings, ...company } = c;
      return {
        company: { ...company, plan_effective: effectivePlan(c, ctx.now), suspended: Boolean(c.suspended_at), settings: parseJson(settings, {}) },
        members: members.results.map(({ staff, ...m }) => ({ ...m, staff: parseJson(staff, []), suspended: Boolean(m.suspended_at) })),
        hubs: hubs.results, api_keys: keys.results, webhook: hook.results[0] ?? null, counts: counts.results[0],
        orders: orders.results, payments: pays.results, activity: activity.results,
      };
    },
  },

  // Coordonnées d'une entreprise.
  lg_platform_company_update: {
    roles: 'platform',
    async handler(ctx, a) {
      const c = await mustCompany(ctx, a.p_company);
      const name = a.p_name === undefined ? c.name : text(a.p_name, 120);
      if (!name) fail('invalid_name');
      await ctx.db.prepare('UPDATE companies SET name = ?, city = ?, phone = ? WHERE id = ?')
        .bind(name, a.p_city === undefined ? c.city : text(a.p_city, 60) ?? c.city, a.p_phone === undefined ? c.phone : text(a.p_phone, 30), c.id).run();
      return { ok: true };
    },
  },

  // Rôle d'un membre (dont le transfert de propriété) ou retrait de l'entreprise.
  lg_platform_member_set: {
    roles: 'platform',
    async handler(ctx, a) {
      const c = await mustCompany(ctx, a.p_company);
      const m = await ctx.db.prepare('SELECT role FROM members WHERE company_id = ? AND user_id = ?').bind(c.id, String(a.p_user ?? '')).first();
      if (!m) fail('unknown_user', 404);
      if (a.p_remove === true) {
        if (m.role === 'owner') fail('cannot_remove_owner', 403); // transférer la propriété d'abord
        await ctx.db.batch([
          ctx.db.prepare('DELETE FROM staff_roles WHERE company_id = ? AND user_id = ?').bind(c.id, a.p_user),
          ctx.db.prepare('UPDATE couriers SET user_id = NULL, active = 0 WHERE company_id = ? AND user_id = ?').bind(c.id, a.p_user),
          ctx.db.prepare('DELETE FROM devices WHERE company_id = ? AND user_id = ?').bind(c.id, a.p_user),
          ctx.db.prepare('DELETE FROM members WHERE company_id = ? AND user_id = ?').bind(c.id, a.p_user),
          ctx.db.prepare('UPDATE sessions SET company_id = NULL WHERE user_id = ? AND company_id = ?').bind(a.p_user, c.id),
        ]);
        return { ok: true, removed: true };
      }
      if (!MEMBER_ROLES.includes(a.p_role)) fail('invalid_role');
      if (m.role === 'owner' && a.p_role !== 'owner') fail('owner_transfer_required', 409); // un propriétaire par entreprise
      const stmts = [];
      // transfert : l'ancien propriétaire devient administrateur, dans le même lot
      if (a.p_role === 'owner') stmts.push(ctx.db.prepare("UPDATE members SET role = 'admin' WHERE company_id = ? AND role = 'owner' AND user_id != ?").bind(c.id, a.p_user));
      stmts.push(ctx.db.prepare('UPDATE members SET role = ? WHERE company_id = ? AND user_id = ?').bind(a.p_role, c.id, a.p_user));
      await ctx.db.batch(stmts);
      return { ok: true, role: a.p_role };
    },
  },

  // Comptes de toute la plateforme (recherche par nom, e-mail ou téléphone), avec leurs entreprises.
  lg_platform_users: {
    roles: 'platform', read: true,
    async handler(ctx, a) {
      const q = String(a.p_q ?? '').trim();
      const r = await ctx.db.prepare(`SELECT u.id, u.name, u.email, u.phone, u.created_at, u.suspended_at,
            (SELECT max(created_at) FROM sessions s WHERE s.user_id = u.id) AS last_login,
            (SELECT count(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS sessions,
            (SELECT json_group_array(json_object('id', c.id, 'name', c.name, 'role', m.role)) FROM members m JOIN companies c ON c.id = m.company_id WHERE m.user_id = u.id) AS companies
          FROM users u WHERE (? = '' OR lower(u.name) LIKE ? OR lower(u.email) LIKE ? OR coalesce(u.phone, '') LIKE ?)
          ORDER BY u.created_at DESC LIMIT ?`)
        .bind(ctx.now, q, like(q), like(q), like(q), Math.min(Math.max(int(a.p_limit) ?? 100, 1), 300)).all();
      return r.results.map((u) => ({ ...u, suspended: Boolean(u.suspended_at), companies: parseJson(u.companies, []) }));
    },
  },

  // Suspendre / rétablir un compte, ou fermer toutes ses sessions (déconnexion partout).
  lg_platform_user_set: {
    roles: 'platform',
    async handler(ctx, a) {
      const u = await ctx.db.prepare('SELECT id FROM users WHERE id = ?').bind(String(a.p_user ?? '')).first();
      if (!u) fail('unknown_user', 404);
      const stmts = [];
      if (a.p_suspend !== undefined) stmts.push(ctx.db.prepare('UPDATE users SET suspended_at = ? WHERE id = ?').bind(a.p_suspend === true ? ctx.now : null, u.id));
      if (a.p_suspend === true || a.p_logout === true) stmts.push(ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id));
      if (!stmts.length) fail('nothing_to_change');
      await ctx.db.batch(stmts);
      return { ok: true };
    },
  },

  // Commandes de toutes les entreprises (recherche : numéro, référence, client, téléphone).
  lg_platform_orders: {
    roles: 'platform', read: true,
    async handler(ctx, a) {
      const q = String(a.p_q ?? '').trim(); const st = a.p_status && ORDER_STATUSES.includes(a.p_status) ? a.p_status : null;
      const r = await ctx.db.prepare(`SELECT o.id, o.number, o.external_ref, o.status, o.payment_method, o.payment_status, o.payment_terms_days, o.buyer_name, o.buyer_phone,
            o.delivery_zone, o.total_fcfa, o.created_at, o.delivered_at, c.id AS company_id, c.name AS company
          FROM orders o JOIN companies c ON c.id = o.company_id
          WHERE (? IS NULL OR o.company_id = ?) AND (? IS NULL OR o.status = ?)
            AND (? = '' OR lower(o.buyer_name) LIKE ? OR o.buyer_phone LIKE ? OR lower(coalesce(o.external_ref, '')) LIKE ? OR CAST(o.number AS TEXT) = ?)
          ORDER BY o.created_at DESC LIMIT ?`)
        .bind(a.p_company ?? null, a.p_company ?? null, st, st, q, like(q), like(q), like(q), q, Math.min(Math.max(int(a.p_limit) ?? 100, 1), 300)).all();
      return r.results;
    },
  },

  lg_platform_api_key_revoke: {
    roles: 'platform',
    async handler(ctx, a) {
      const r = await ctx.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').bind(ctx.now, String(a.p_id ?? '')).run();
      if (!r.meta.changes) fail('unknown_key', 404);
      return { ok: true };
    },
  },

  // État du système : tâches planifiées (dernier passage), files d'envoi, volumes.
  lg_platform_system: {
    roles: 'platform', read: true,
    async handler(ctx) {
      const d7 = days(ctx.now, 7);
      const [cron, outbox, hooks, vol] = await ctx.db.batch([
        ctx.db.prepare('SELECT task, ran_at, result FROM cron_runs ORDER BY task'),
        ctx.db.prepare('SELECT status, count(*) AS n FROM outbox WHERE created_at >= ? GROUP BY status').bind(d7),
        ctx.db.prepare('SELECT status, count(*) AS n FROM webhook_events WHERE created_at >= ? GROUP BY status').bind(d7),
        ctx.db.prepare(`SELECT (SELECT count(*) FROM companies) AS companies, (SELECT count(*) FROM users) AS users,
            (SELECT count(*) FROM orders) AS orders, (SELECT count(*) FROM trips) AS trips, (SELECT count(*) FROM invoices) AS invoices,
            (SELECT count(*) FROM outbox) AS messages, (SELECT count(*) FROM files) AS files, (SELECT count(*) FROM admin_sessions WHERE expires_at > ?) AS admin_sessions`).bind(ctx.now),
      ]);
      const late = (t) => (Date.parse(ctx.now) - Date.parse(t.ran_at)) / 60000;
      return {
        cron: cron.results.map((t) => ({ ...t, result: parseJson(t.result, null), late_minutes: Math.round(late(t)) })),
        outbox_7d: Object.fromEntries(outbox.results.map((r) => [r.status, r.n])),
        webhooks_7d: Object.fromEntries(hooks.results.map((r) => [r.status, r.n])),
        volumes: vol.results[0],
        config: { whatsapp_key: Boolean(ctx.env.SECRETS_KEY), email: Boolean(ctx.env.BREVO_API_KEY), cron: Boolean(ctx.env.CRON_SECRET), devizo_accounts: Boolean(ctx.env.AUTH_DB) },
      };
    },
  },

  // Messages en échec ou en attente sur toute la plateforme.
  lg_platform_outbox: {
    roles: 'platform', read: true,
    async handler(ctx, a) {
      const st = ['pending', 'failed', 'sent', 'cancelled'].includes(a.p_status) ? a.p_status : 'failed';
      return (await ctx.db.prepare(`SELECT x.id, x.event_key, x.phone, x.email, x.status, x.whatsapp_status, x.email_status, x.attempts, x.last_error,
            x.created_at, x.sent_at, c.name AS company FROM outbox x JOIN companies c ON c.id = x.company_id
          WHERE x.status = ? ORDER BY x.created_at DESC LIMIT 200`).bind(st).all()).results;
    },
  },

  // Journal des actions d'administration (connexions comprises).
  lg_platform_audit: {
    roles: 'platform', read: true,
    async handler(ctx, a) {
      return (await ctx.db.prepare('SELECT * FROM admin_audit ORDER BY id DESC LIMIT ?').bind(Math.min(Math.max(int(a.p_limit) ?? 200, 1), 500)).all()).results
        .map((r) => ({ ...r, detail: parseJson(r.detail, null) }));
    },
  },
};
