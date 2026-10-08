// Photos et signatures de preuve : PUT /api/files/<voyage>/<…>, GET /api/files/<voyage>/<…>.
// Stockage privé par entreprise : R2 (liaison PROOFS, clé « <entreprise>/<chemin> ») si elle existe, sinon table
// `files` de D1 (repli gratuit, photos compressées par l'app). Jamais d'adresse publique : la lecture passe par la
// session. Le premier segment du chemin est un voyage de l'entreprise ; un chauffeur n'écrit que dans les siens.
import { HttpError } from '../http.js';
import { buildContext, deviceBlocked } from '../rpc/index.js';
import { hasRole } from '../rpc/core.js';

const PATH = /^[A-Za-z0-9-]{8,64}(\/[A-Za-z0-9._-]{1,120}){1,3}$/;
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX = 1_500_000;

async function access(request, env, path, write) {
  if (!PATH.test(path) || path.includes('..')) throw new HttpError(400, 'Chemin de fichier invalide.', 'invalid_path');
  const ctx = await buildContext(request, env);
  if (!ctx.user) throw new HttpError(401, 'Connectez-vous pour continuer.', 'auth');
  if (!ctx.company) throw new HttpError(403, "Ce compte n'est rattaché à aucune entreprise.", 'no_company');
  if (await deviceBlocked(ctx)) throw new HttpError(403, 'Appareil bloqué.', 'device_blocked');
  const trip = await env.DB.prepare('SELECT courier_id FROM trips WHERE id = ? AND company_id = ?').bind(path.split('/')[0], ctx.company.id).first();
  if (!trip) throw new HttpError(404, 'Fichier inconnu.', 'not_found');
  const staff = hasRole(ctx, write ? ['dock_chief', 'dispatcher'] : ['dock_chief', 'dispatcher', 'support', 'cashier', 'accountant']);
  if (!staff && !(ctx.courierId && trip.courier_id === ctx.courierId)) throw new HttpError(403, "Vous n'avez pas le droit de faire cette action.", 'forbidden');
  return ctx;
}

/** PUT /api/files/<chemin> — corps brut (image). Écrit une seule fois : un renvoi ne remplace rien. */
export async function put(request, env, { path }) {
  const ctx = await access(request, env, path, true);
  const type = (request.headers.get('content-type') || '').split(';')[0].trim();
  if (!TYPES.includes(type)) throw new HttpError(415, 'Format attendu : photo JPEG, PNG ou WebP.', 'invalid_type');
  const body = await request.arrayBuffer();
  if (!body.byteLength) throw new HttpError(400, 'Fichier vide.', 'empty_file');
  if (body.byteLength > MAX) throw new HttpError(413, 'Fichier trop lourd (1,5 Mo au plus).', 'file_too_large');
  if (env.PROOFS) {
    await env.PROOFS.put(`${ctx.company.id}/${path}`, body, { httpMetadata: { contentType: type }, customMetadata: { by: ctx.user.id } });
  } else {
    await env.DB.prepare('INSERT OR IGNORE INTO files (company_id, path, content_type, size, data, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(ctx.company.id, path, type, body.byteLength, new Uint8Array(body), ctx.user.id).run();
  }
  return new Response(JSON.stringify({ ok: true, path }), { status: 201, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

/** GET /api/files/<chemin> — l'image, pour un membre autorisé (cache privé du navigateur). */
export async function get(request, env, { path }) {
  const ctx = await access(request, env, path, false);
  const headers = { 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' };
  if (env.PROOFS) {
    const o = await env.PROOFS.get(`${ctx.company.id}/${path}`);
    if (o) return new Response(o.body, { headers: { ...headers, 'content-type': o.httpMetadata?.contentType ?? 'image/jpeg' } });
  }
  const f = await env.DB.prepare('SELECT content_type, data FROM files WHERE company_id = ? AND path = ?').bind(ctx.company.id, path).first();
  if (!f) throw new HttpError(404, 'Fichier inconnu.', 'not_found');
  return new Response(new Uint8Array(f.data), { headers: { ...headers, 'content-type': f.content_type } });
}
