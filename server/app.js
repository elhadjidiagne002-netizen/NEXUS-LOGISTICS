// Routeur de l'API (Cloudflare Pages Functions). Point d'entrée : functions/api/[[path]].js
import { HttpError, json } from './http.js';
import * as account from './routes/account.js';
import { handleRpc } from './rpc/index.js';
import * as apiV1 from './routes/api-v1.js';
import * as files from './routes/files.js';
import * as cron from './routes/cron.js';

const ROUTES = [
  ['GET', /^\/api\/health$/, () => json({ ok: true, service: 'nexus-logistics' })],
  ['POST', /^\/api\/auth\/register$/, account.register],
  ['POST', /^\/api\/auth\/login$/, account.login],
  ['POST', /^\/api\/auth\/logout$/, account.logout],
  ['GET', /^\/api\/auth\/session$/, account.session],
  ['POST', /^\/api\/auth\/company$/, account.switchCompany],
  ['POST', /^\/api\/auth\/password$/, account.changePassword],
  ['GET', /^\/api\/invites\/(?<token>[\w-]{16,80})$/, account.getInvite],
  ['POST', /^\/api\/invites\/(?<token>[\w-]{16,80})\/accept$/, account.acceptInvite],
  ['POST', /^\/api\/v1\/orders$/, apiV1.postOrders],
  ['PUT', /^\/api\/files\/(?<path>[^?#]{8,320})$/, files.put],
  ['GET', /^\/api\/files\/(?<path>[^?#]{8,320})$/, files.get],
  ['POST', /^\/api\/cron\/(?<task>[a-z_]{3,30})$/, cron.run],
  ['POST', /^\/api\/rpc\/(?<name>lg_[a-z0-9_]{1,60})$/, (req, env, p) => handleRpc(req, env, p.name)],
];

/** Protection CSRF : en plus de SameSite=Lax et du JSON obligatoire, l'origine doit être la nôtre. */
function checkOrigin(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return;
  const origin = request.headers.get('origin');
  if (!origin) return; // clients non navigateurs (tests, curl)
  if (origin !== new URL(request.url).origin) throw new HttpError(403, 'Origine refusée.', 'origin');
}

export async function handle(request, env, ctx = null) {
  const url = new URL(request.url);
  try {
    if (!env?.DB) throw new HttpError(503, 'Base de données non configurée (liaison D1 « DB »).', 'no_db');
    checkOrigin(request);
    let methodMismatch = false;
    for (const [method, re, fn] of ROUTES) {
      const m = url.pathname.match(re);
      if (!m) continue;
      if (method !== request.method) { methodMismatch = true; continue; }
      return await fn(request, env, m.groups ?? {}, ctx);
    }
    throw new HttpError(methodMismatch ? 405 : 404, methodMismatch ? 'Méthode non autorisée.' : 'Adresse inconnue.', methodMismatch ? 'method' : 'not_found');
  } catch (e) {
    if (e instanceof HttpError) {
      const headers = e.retryAfter ? { 'retry-after': String(e.retryAfter) } : {};
      return json({ error: e.code ?? 'error', message: e.message, ...(e.detail !== undefined ? { detail: e.detail } : {}) }, e.status, headers);
    }
    // jamais 502 (Cloudflare remplace le corps) : 500 pour les erreurs imprévues
    console.error('api', url.pathname, e?.stack || e);
    return json({ error: 'server_error', message: 'Erreur du serveur. Réessayez dans un instant.' }, 500);
  }
}
