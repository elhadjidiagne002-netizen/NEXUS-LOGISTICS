// Routes publiques du site : formules et prix (page d'accueil), remontée des erreurs de l'interface.
import { json, readJson, clientIp, str } from '../http.js';
import { rateLimit, currentSession } from '../auth.js';
import { plansOf } from '../rpc/offre.js';

/** GET /api/plans — formules affichées sur la page d'accueil (quotas et prix réglés par la plateforme). */
export async function plans(request, env) {
  const p = await plansOf({ db: env.DB });
  return json({ free: p.free, pro: p.pro }, 200, { 'cache-control': 'public, max-age=600' });
}

/** POST /api/errors — erreur JavaScript d'un navigateur (20 par heure et par adresse au plus). */
export async function report(request, env) {
  await rateLimit(env, `err:${clientIp(request)}`, 20, 3600);
  const b = await readJson(request, 20_000).catch(() => ({}));
  const message = str(b?.message, 500);
  if (!message) return json({ ok: false }, 400);
  const s = await currentSession(request, env).catch(() => null);
  await env.DB.prepare('INSERT INTO client_errors (company_id, user_id, message, stack, url, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(s?.companyId ?? null, s?.user?.id ?? null, message, str(b.stack, 4000), str(b.url, 300), str(request.headers.get('user-agent'), 300)).run();
  return json({ ok: true });
}
