// Répartiteur des fonctions métier : POST /api/rpc/<nom> { ...arguments }.
// Mêmes noms et mêmes arguments que les fonctions Postgres `lg_*` de la version précédente
// (supabase/migrations, gardées comme référence) : l'interface appelle toujours rpc(nom, args).
//
// Chaque fonction est déclarée ainsi :
//   lg_xxx: { roles: ['dispatcher', …] | 'admin' | 'member' | 'public', handler: async (ctx, args) => résultat }
// - 'public'  : sans connexion (page de suivi client) — ctx.user / ctx.company peuvent être null ;
// - 'member'  : tout membre de l'entreprise active ;
// - 'admin'   : propriétaire ou administrateur de l'entreprise ;
// - [rôles]   : administrateur OU un de ces rôles logistiques actif.
// Le handler reçoit ctx = { env, db, now, user, company, member, roles, isAdmin, courierId, sessionId, deviceId }.
// RÈGLE : toute requête d'un handler filtre sur ctx.company.id (test d'isolation sur chaque fonction).
import { json, readJson } from '../http.js';
import { currentSession, now } from '../auth.js';
import { companyConfig } from '../config.js';
import { RpcFail, hasRole } from './core.js';
import socle from './socle.js';
import tarifs from './tarifs.js';
import commandes from './commandes.js';
import suivi from './suivi.js';
import preparation from './preparation.js';
import entrepot from './entrepot.js';
import flotte from './flotte.js';
import voyages from './voyages.js';
import terrain from './terrain.js';
import retours from './retours.js';
import caisse from './caisse.js';
import factures from './factures.js';
import pilotage from './pilotage.js';
import messages from './messages.js';
import offre, { isPlatformAdmin } from './offre.js';
import webhooks from './webhooks.js';

export const REGISTRY = { ...socle, ...tarifs, ...commandes, ...suivi, ...preparation, ...entrepot, ...flotte, ...voyages,
  ...terrain, ...retours, ...caisse, ...factures, ...pilotage, ...messages, ...offre, ...webhooks };


export async function buildContext(request, env) {
  const s = await currentSession(request, env);
  const ctx = { env, db: env.DB, now: now(), user: null, company: null, member: null, roles: [], isAdmin: false,
    courierId: null, sessionId: null, deviceId: null, request };
  if (!s || s.user.suspended) return ctx;
  if (!s.companyId) return { ...ctx, user: s.user, sessionId: s.sessionId }; // connecté, sans entreprise active
  const row = await env.DB.prepare(
    `SELECT c.*, m.role AS member_role,
            (SELECT json_group_array(json_object('role', r.role, 'hub_id', r.hub_id))
               FROM staff_roles r WHERE r.company_id = c.id AND r.user_id = m.user_id AND r.active = 1) AS staff,
            (SELECT k.id FROM couriers k WHERE k.company_id = c.id AND k.user_id = m.user_id AND k.active = 1) AS courier_id
       FROM members m JOIN companies c ON c.id = m.company_id
      WHERE m.company_id = ? AND m.user_id = ? AND c.suspended_at IS NULL`,
  ).bind(s.companyId, s.user.id).first();
  if (!row) return { ...ctx, user: s.user, sessionId: s.sessionId };
  const { member_role, staff, courier_id, ...company } = row;
  return {
    ...ctx,
    user: s.user,
    sessionId: s.sessionId,
    company: { ...company, config: companyConfig(company) },
    member: member_role,
    roles: JSON.parse(staff || '[]'),
    isAdmin: member_role === 'owner' || member_role === 'admin',
    courierId: courier_id ?? null,
    deviceId: (request.headers.get('x-lg-device') || '').slice(0, 64) || null,
  };
}


/** Appareil bloqué (perdu, volé) ou session coupée à distance : refus côté serveur. */
export async function deviceBlocked(ctx) {
  if (!ctx.deviceId || !ctx.company) return false;
  const d = await ctx.db.prepare('SELECT blocked, revoked_session FROM devices WHERE company_id = ? AND user_id = ? AND device_id = ?')
    .bind(ctx.company.id, ctx.user.id, ctx.deviceId).first();
  return Boolean(d && (d.blocked || (d.revoked_session && d.revoked_session === ctx.sessionId)));
}

export async function handleRpc(request, env, name) {
  const def = Object.hasOwn(REGISTRY, name) ? REGISTRY[name] : null;
  if (!def) throw new RpcFail('unknown_function', 404);
  const args = await readJson(request, 6_000_000);
  const ctx = await buildContext(request, env);
  if (def.roles === 'platform') {
    // administration de la plateforme : adresses de ADMIN_EMAILS, sans entreprise active nécessaire
    if (!ctx.user) throw new RpcFail('auth', 401);
    if (!isPlatformAdmin(env, ctx.user)) throw new RpcFail('forbidden', 403);
  } else if (def.roles !== 'public') {
    if (!ctx.user) throw new RpcFail('auth', 401);
    if (!ctx.company) throw new RpcFail('no_company', 403);
    if (!def.allowBlocked && (await deviceBlocked(ctx))) throw new RpcFail('device_blocked', 403);
    const ok = def.roles === 'member' || (def.roles === 'admin' ? ctx.isAdmin : hasRole(ctx, def.roles));
    if (!ok) throw new RpcFail('forbidden', 403);
  }
  const result = await def.handler(ctx, args ?? {});
  return json(result === undefined ? null : result);
}
