// E-mails reçus sur bons+<cle>@commandes.nexusmarket.sn : le Worker mail/ (Cloudflare Email Routing) les découpe et les
// envoie ici (POST /api/inbound/email, en-tête x-inbound-secret = INBOUND_SECRET). Chaque pièce jointe lisible (PDF,
// Excel, Word, photo, CSV) devient un document ; sans pièce jointe, le corps du message en devient un. Lecture par
// l'IA ensuite (ctx.waitUntil), pour répondre vite au Worker. Un même e-mail renvoyé n'est pas compté deux fois.
// GET /api/inbox/<id>/file : le fichier d'origine, pour un membre de l'entreprise (session).
import { HttpError, json, readJson } from '../http.js';
import { buildContext } from '../rpc/index.js';
import { hasRole } from '../rpc/core.js';
import { addDocument, extractDocument, readFile, b64ToBytes } from '../rpc/collecte.js';
import { DOC_TYPES, guessType } from '../extract.js';

const MAX_FILE = 1_500_000;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && a.length >= 16
  && [...a].reduce((d, c, i) => d | (c.charCodeAt(0) ^ b.charCodeAt(i)), 0) === 0;

export async function email(request, env, _p, ctx) {
  if (!env.INBOUND_SECRET) throw new HttpError(503, 'Réception des e-mails non configurée.', 'inbound_disabled');
  if (!same(request.headers.get('x-inbound-secret'), env.INBOUND_SECRET)) throw new HttpError(403, 'Accès refusé.', 'forbidden');
  const m = await readJson(request, 30_000_000);
  // bons+<clé>@… (adressage plus, règle unique) ; <clé>@… accepté aussi (règle propre à une entreprise)
  const lp = String(m.to ?? '').toLowerCase().split('@')[0].trim();
  const local = lp.includes('+') ? lp.slice(lp.indexOf('+') + 1) : lp;
  const company = local ? await env.DB.prepare('SELECT id FROM companies WHERE inbound_key = ? AND suspended_at IS NULL').bind(local).first() : null;
  // adresse inconnue : on répond 200 pour que l'expéditeur ne reçoive pas d'erreur exploitable (pas de fuite d'adresses)
  if (!company) return json({ ok: true, accepted: 0, reason: 'unknown_address' });
  const files = (Array.isArray(m.attachments) ? m.attachments : []).slice(0, 10)
    .map((a) => ({ filename: String(a.filename ?? 'piece-jointe'), contentType: guessType(a.filename, a.content_type), bytes: b64ToBytes(a.data ?? '') }))
    .filter((f) => DOC_TYPES.includes(f.contentType) && f.bytes.byteLength > 0 && f.bytes.byteLength <= MAX_FILE);
  const body = String(m.text ?? '').trim();
  if (!files.length && body.length >= 40) files.push({ filename: 'message.txt', contentType: 'text/plain', bytes: new TextEncoder().encode(body.slice(0, 200000)) });
  const ids = [];
  for (const f of files) {
    const id = await addDocument(env, { companyId: company.id, source: 'email', sender: String(m.from ?? '').slice(0, 200), subject: String(m.subject ?? '').slice(0, 300),
      messageId: m.message_id ? String(m.message_id).slice(0, 300) : null, ...f });
    if (id) ids.push(id);
  }
  const work = (async () => { for (const id of ids) await extractDocument(env, company.id, id); })();
  if (ctx?.waitUntil) ctx.waitUntil(work); else await work;
  return json({ ok: true, accepted: ids.length });
}

export async function file(request, env, { id }) {
  const ctx = await buildContext(request, env);
  if (!ctx.user) throw new HttpError(401, 'Connectez-vous pour continuer.', 'auth');
  if (!ctx.company) throw new HttpError(403, "Ce compte n'est rattaché à aucune entreprise.", 'no_company');
  if (!hasRole(ctx, ['support', 'dispatcher', 'dock_chief', 'accountant'])) throw new HttpError(403, "Vous n'avez pas le droit de faire cette action.", 'forbidden');
  const d = await env.DB.prepare('SELECT file_path, filename, content_type FROM inbox_documents WHERE id = ? AND company_id = ?').bind(id, ctx.company.id).first();
  if (!d) throw new HttpError(404, 'Document inconnu.', 'not_found');
  const bytes = await readFile(env, ctx.company.id, d.file_path);
  if (!bytes) throw new HttpError(404, 'Fichier introuvable.', 'not_found');
  return new Response(bytes, { headers: { 'content-type': d.content_type || 'application/octet-stream', 'cache-control': 'private, no-store',
    'content-disposition': `inline; filename="${String(d.filename ?? 'document').replace(/["\r\n]/g, '')}"`, 'x-content-type-options': 'nosniff' } });
}
