// Comptes, sessions, entreprise active, limitation de débit.
import { HttpError, getCookie, SESSION_COOKIE, SESSION_DAYS } from './http.js';
import { sha256Hex, randomToken } from './crypto.js';

export const now = () => new Date().toISOString();

export async function createSession(env, userId, companyId, userAgent = null) {
  const token = randomToken(32);
  const id = await sha256Hex(token);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await env.DB.prepare('INSERT INTO sessions (id, user_id, company_id, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)')
    .bind(id, userId, companyId ?? null, expires, userAgent ? String(userAgent).slice(0, 200) : null).run();
  return token;
}

/** Utilisateur connecté et entreprise active (ou null). */
export async function currentSession(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token || token.length > 100) return null;
  const id = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.phone, u.suspended_at, s.expires_at, s.company_id
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
  ).bind(id).first();
  if (!row) return null;
  if (row.expires_at < now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
    return null;
  }
  return {
    user: { id: row.id, email: row.email, name: row.name, phone: row.phone, suspended: Boolean(row.suspended_at) },
    sessionId: id,
    companyId: row.company_id,
  };
}

export async function requireSession(request, env) {
  const s = await currentSession(request, env);
  if (!s) throw new HttpError(401, 'Connectez-vous pour continuer.', 'auth');
  if (s.user.suspended) throw new HttpError(403, 'Ce compte est suspendu. Contactez le support NEXUS Logistics.', 'suspended');
  return s;
}

/** Entreprises dont l'utilisateur est membre. */
export async function companiesOf(env, userId) {
  const r = await env.DB.prepare(
    `SELECT c.id, c.name, c.slug, c.kind, c.plan, c.plan_until, m.role FROM members m JOIN companies c ON c.id = m.company_id
      WHERE m.user_id = ? AND c.suspended_at IS NULL ORDER BY m.created_at`,
  ).bind(userId).all();
  return r.results;
}

/**
 * Limitation de débit à fenêtre glissante stockée dans D1.
 * Lève 429 si `key` a déjà `max` tentatives dans les `windowSec` dernières secondes.
 */
export async function rateLimit(env, key, max, windowSec) {
  const since = new Date(Date.now() - windowSec * 1000).toISOString();
  const row = await env.DB.prepare('SELECT COUNT(*) AS n, MIN(ts) AS first FROM rate_limits WHERE key = ? AND ts > ?').bind(key, since).first();
  if (row && row.n >= max) {
    const retry = Math.max(1, Math.ceil((Date.parse(row.first) + windowSec * 1000 - Date.now()) / 1000));
    const err = new HttpError(429, `Trop de tentatives. Réessayez dans ${Math.ceil(retry / 60)} min.`, 'rate');
    err.retryAfter = retry;
    throw err;
  }
  await env.DB.batch([
    env.DB.prepare('INSERT INTO rate_limits (key, ts) VALUES (?, ?)').bind(key, now()),
    env.DB.prepare('DELETE FROM rate_limits WHERE ts < ?').bind(new Date(Date.now() - 86400000).toISOString()),
  ]);
}

export async function clearRateLimit(env, key) {
  await env.DB.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run();
}
