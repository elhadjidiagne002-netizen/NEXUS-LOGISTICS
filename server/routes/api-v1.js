// API publique des boutiques en ligne : POST /api/v1/orders avec une clé d'entreprise.
// En-tête « Authorization: Bearer nxl_… » (ou « x-api-key: nxl_… »). Clé créée dans Administration → API,
// révocable ; seule son empreinte SHA-256 est stockée. Corps : une commande, ou { orders: [ … ] } (50 au plus).
// Une même external_ref n'est jamais créée deux fois : un renvoi rend la commande existante (duplicate: true).
import { HttpError, json, readJson } from '../http.js';
import { sha256Hex } from '../crypto.js';
import { now, rateLimit } from '../auth.js';
import { companyConfig } from '../config.js';
import { createOrders, amountDue, trackingUrl, payMode } from '../rpc/commandes.js';
import { audit } from '../rpc/core.js';

async function companyForKey(request, env) {
  const auth = request.headers.get('authorization') || '';
  const key = (auth.match(/^Bearer\s+(\S+)$/i)?.[1] ?? request.headers.get('x-api-key') ?? '').trim();
  if (!/^nxl_[\w-]{20,60}$/.test(key)) throw new HttpError(401, "Clé d'API absente ou invalide.", 'invalid_api_key');
  const row = await env.DB.prepare(
    `SELECT k.id AS key_id, k.last_used_at, c.* FROM api_keys k JOIN companies c ON c.id = k.company_id
      WHERE k.key_hash = ? AND k.revoked_at IS NULL AND c.suspended_at IS NULL`,
  ).bind(await sha256Hex(key)).first();
  if (!row) throw new HttpError(401, "Clé d'API absente ou invalide.", 'invalid_api_key');
  const { key_id, last_used_at, ...company } = row;
  return { keyId: key_id, lastUsed: last_used_at, company: { ...company, config: companyConfig(company) } };
}

/**
 * GET /api/v1/orders/<référence> — état d'une commande envoyée par la boutique (sa référence externe) :
 * statut, paiement, étapes, livreur, heure prévue, facture, lien de suivi. Lecture seule, même clé que l'envoi.
 */
export async function getOrder(request, env, { ref }) {
  const k = await companyForKey(request, env);
  await rateLimit(env, `api:${k.keyId}`, 300, 3600);
  const o = await env.DB.prepare(
    `SELECT o.*, (SELECT invoice_number FROM invoices i WHERE i.order_id = o.id AND i.credit_of IS NULL) AS invoice,
            (SELECT json_object('status', s.status, 'eta', s.eta, 'failure_reason', s.failure_reason, 'courier', c.name) FROM trip_stops s JOIN trips t ON t.id = s.trip_id
               LEFT JOIN couriers c ON c.id = t.courier_id WHERE s.order_id = o.id AND s.kind = 'delivery' AND s.status <> 'skipped' AND t.status <> 'cancelled'
              ORDER BY t.created_at DESC LIMIT 1) AS stop
       FROM orders o WHERE o.company_id = ? AND o.external_ref = ?`,
  ).bind(k.company.id, decodeURIComponent(ref)).first();
  if (!o) throw new HttpError(404, 'Commande inconnue.', 'unknown_order');
  const stop = o.stop ? JSON.parse(o.stop) : null;
  return json({
    external_ref: o.external_ref, number: o.number, status: o.status, payment_method: payMode(o), payment_status: o.payment_status, payment_terms_days: o.payment_terms_days ?? null, due_at: o.due_at ?? null,
    amount_due_fcfa: amountDue(o), total_fcfa: o.total_fcfa, delivery_fee_fcfa: o.delivery_fee_fcfa, zone: o.delivery_zone, promised_at: o.promised_at,
    steps: { created_at: o.created_at, confirmed_at: o.cod_confirmed_at ?? o.paid_at, in_transit_at: o.in_transit_at, delivered_at: o.delivered_at, cancelled_at: o.cancelled_at },
    delivery: stop ? { status: stop.status, eta: stop.eta, courier: stop.courier ? String(stop.courier).split(' ')[0] : null, failure_reason: stop.failure_reason } : null,
    invoice: o.invoice, cancel_reason: o.cancel_reason, tracking_url: trackingUrl({ request, company: k.company }, o.tracking_token),
  });
}

/** POST /api/v1/orders */
export async function postOrders(request, env) {
  const k = await companyForKey(request, env);
  await rateLimit(env, `api:${k.keyId}`, 300, 3600);
  const body = await readJson(request, 1_000_000);
  const many = Array.isArray(body?.orders);
  const inputs = many ? body.orders : [body];
  const ctx = { env, db: env.DB, now: now(), user: null, company: k.company, member: null, roles: [], isAdmin: false, request };
  const results = await createOrders(ctx, inputs, 'api');
  // date de dernière utilisation : écrite au plus une fois par heure (budget d'écritures D1)
  if (!k.lastUsed || Date.parse(k.lastUsed) < Date.now() - 3600000) {
    await env.DB.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ? AND company_id = ?').bind(ctx.now, k.keyId, k.company.id).run();
  }
  const created = results.filter((r) => r.ok && !r.duplicate).length;
  if (created) await audit(ctx, 'api_orders', 'order', null, { created, key: k.keyId });
  if (!many) {
    const r = results[0];
    if (!r.ok) return json({ error: r.error, message: 'Commande refusée.' }, 400);
    return json(r, r.duplicate ? 200 : 201);
  }
  return json({ ok: true, created, results }, created ? 201 : 200);
}
