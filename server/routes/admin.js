// Tableau de bord d'administration de la plateforme (/admin/), comme My shop et CV en ligne :
// connexion avec le COMPTE DEVIZO (base devizo lue en lecture seule, liaison AUTH_DB, server/devizo.js), e-mail
// obligatoirement dans ADMIN_EMAILS. Session à part (cookie lg_admin limité à /api/admin, 12 h), indépendante des
// comptes des entreprises. Toute fonction appelée ici est une fonction `roles: 'platform'` du REGISTRY ;
// chaque appel qui modifie quelque chose est écrit dans admin_audit.
import { HttpError, json, readJson, getCookie, clientIp } from '../http.js';
import { sha256Hex, randomToken } from '../crypto.js';
import { rateLimit, clearRateLimit, now } from '../auth.js';
import { findDevizoAccount, isSuperAdmin } from '../devizo.js';
import { REGISTRY } from '../rpc/index.js';

const ADMIN_COOKIE = 'lg_admin';
const SESSION_HOURS = 12;

const adminCookie = (token, maxAge = SESSION_HOURS * 3600) =>
  `${ADMIN_COOKIE}=${token}; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

export async function adminAudit(env, admin, action, target = null, detail = null) {
  try {
    await env.DB.prepare('INSERT INTO admin_audit (admin, action, target, detail) VALUES (?, ?, ?, ?)')
      .bind(admin, action, target == null ? null : String(target).slice(0, 200),
        detail == null ? null : JSON.stringify(detail).slice(0, 2000)).run();
  } catch { /* le journal ne bloque jamais l'action */ }
}

/** POST /api/admin/login { email, password } — identifiants du compte Devizo. */
export async function login(request, env) {
  if (!env.AUTH_DB) throw new HttpError(503, 'Connexion indisponible : la base des comptes Devizo n’est pas reliée (liaison AUTH_DB).', 'no_auth_db');
  const body = await readJson(request, 5000);
  const email = String(body.email || '').trim().toLowerCase().slice(0, 200);
  await rateLimit(env, `admin-login:ip:${clientIp(request)}`, 20, 900);
  await rateLimit(env, `admin-login:email:${email}`, 8, 900);
  const account = await findDevizoAccount(env, email, String(body.password || ''));
  if (!account) throw new HttpError(401, 'E-mail ou mot de passe incorrect (identifiants de votre compte Devizo).', 'login_failed');
  if (account.suspended) throw new HttpError(403, 'Ce compte Devizo est suspendu.', 'suspended');
  if (!isSuperAdmin(email, env)) throw new HttpError(403, 'Ce compte n’est pas administrateur de la plateforme.', 'not_admin');
  await clearRateLimit(env, `admin-login:email:${email}`);
  const token = randomToken(32);
  const expires = new Date(Date.now() + SESSION_HOURS * 3600000).toISOString();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO admin_sessions (token_hash, email, expires_at) VALUES (?, ?, ?)').bind(await sha256Hex(token), email, expires),
    env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').bind(now()),
  ]);
  await adminAudit(env, email, 'connexion', null, { ip: clientIp(request) });
  return json({ email, expires_at: expires }, 200, { 'set-cookie': adminCookie(token) });
}

/** Administrateur connecté (e-mail) ou null. Vérifie ADMIN_EMAILS à chaque appel (retrait immédiat). */
export async function currentAdmin(request, env) {
  const token = getCookie(request, ADMIN_COOKIE);
  if (!token || token.length > 100) return null;
  const row = await env.DB.prepare('SELECT email, expires_at FROM admin_sessions WHERE token_hash = ?').bind(await sha256Hex(token)).first();
  if (!row || row.expires_at < now() || !isSuperAdmin(row.email, env)) return null;
  return row.email;
}

export async function logout(request, env) {
  const token = getCookie(request, ADMIN_COOKIE);
  if (token) await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  return json({ ok: true }, 200, { 'set-cookie': adminCookie('', 0) });
}

/** GET /api/admin/me — { email } ou { email: null } (jamais d'erreur : sert au démarrage du tableau de bord). */
export async function me(request, env) {
  return json({ email: await currentAdmin(request, env) });
}

/** POST /api/admin/rpc/<nom> — fonctions de plateforme, sous l'identité de l'administrateur. */
export async function rpc(request, env, { name }) {
  const admin = await currentAdmin(request, env);
  if (!admin) throw new HttpError(401, 'Connectez-vous à l’administration.', 'admin_auth');
  const def = Object.hasOwn(REGISTRY, name) ? REGISTRY[name] : null;
  if (!def || def.roles !== 'platform') throw new HttpError(404, 'Fonction inconnue.', 'unknown_function');
  const args = (await readJson(request, 1_000_000)) ?? {};
  const ctx = {
    env, db: env.DB, now: now(), request, admin,
    user: { id: `admin:${admin}`, email: admin, name: 'Administration' },
    company: null, member: null, roles: [], isAdmin: false, courierId: null, sessionId: null, deviceId: null,
  };
  const result = await def.handler(ctx, args);
  if (!def.read) await adminAudit(env, admin, name, args.p_company ?? args.p_user ?? args.p_id ?? null, args);
  return json(result === undefined ? null : result);
}
