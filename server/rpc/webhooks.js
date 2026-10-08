// Cycle C10 — statuts renvoyés aux boutiques en ligne (dont NEXUS Market) : à chaque étape d'une commande reçue par
// l'API (référence externe), un événement signé part vers l'adresse de rappel de l'entreprise.
// Signature : en-tête « X-Nexus-Signature: sha256=<hex> » = HMAC-SHA256(secret, « <horodatage>.<corps> »),
// horodatage dans « X-Nexus-Timestamp » (refuser au-delà de 5 min côté boutique). Envoi par la tâche « messages ».
import { fail, audit, text, uuid } from './core.js';
import { encryptSecret, decryptSecret, randomToken } from '../crypto.js';

export const WEBHOOK_EVENTS = ['order.confirmed', 'order.prepared', 'order.in_transit', 'order.delivered', 'order.failed', 'order.cancelled'];

/**
 * Instruction (à mettre dans un lot) : événement créé seulement si la commande a une référence externe et si
 * l'entreprise a une adresse de rappel active — aucune lecture préalable.
 */
export function webhookStatement(ctx, orderId, event, extra = {}) {
  const at = ctx.now;
  return ctx.db.prepare(
    `INSERT INTO webhook_events (id, company_id, order_id, event, payload, created_at)
     SELECT ?, o.company_id, o.id, ?, json_object('event', ?, 'at', ?, 'external_ref', o.external_ref, 'number', o.number, 'status', o.status,
              'payment_status', o.payment_status, 'tracking_token', o.tracking_token, 'data', json(?)), ?
       FROM orders o WHERE o.id = ? AND o.company_id = ? AND o.external_ref IS NOT NULL
        AND EXISTS (SELECT 1 FROM webhook_endpoints w WHERE w.company_id = o.company_id AND w.active = 1)`,
  ).bind(uuid(), event, event, at, JSON.stringify(extra), at, orderId, ctx.company.id);
}

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export async function signedHeaders(secret, body, ts = Math.floor(Date.now() / 1000)) {
  return { 'content-type': 'application/json', 'x-nexus-timestamp': String(ts), 'x-nexus-signature': `sha256=${await hmacHex(secret, `${ts}.${body}`)}`,
    'user-agent': 'NEXUS-Logistics-Webhook/1' };
}

/** Envoie les événements en attente (30 au plus par passage, 6 essais) ; appelée par la tâche planifiée « messages ». */
export async function sendWebhooks(env, now) {
  if (!env.SECRETS_KEY) return { webhooks: 0 };
  const rows = (await env.DB.prepare(
    `SELECT e.*, w.url, w.secret_enc FROM webhook_events e JOIN webhook_endpoints w ON w.company_id = e.company_id AND w.active = 1
      WHERE e.status = 'pending' AND e.attempts < 6 ORDER BY e.created_at LIMIT 30`,
  ).all()).results;
  const secrets = new Map(); const updates = [];
  for (const e of rows) {
    let err = null;
    try {
      if (!secrets.has(e.company_id)) secrets.set(e.company_id, await decryptSecret(env.SECRETS_KEY, e.secret_enc));
      const r = await fetch(e.url, { method: 'POST', headers: await signedHeaders(secrets.get(e.company_id), e.payload), body: e.payload });
      if (!r.ok) err = `HTTP ${r.status}`;
    } catch (x) { err = String(x?.message ?? x).slice(0, 200); }
    updates.push(env.DB.prepare('UPDATE webhook_events SET status = ?, attempts = attempts + 1, last_error = ?, sent_at = ? WHERE id = ?')
      .bind(err ? (e.attempts + 1 >= 6 ? 'failed' : 'pending') : 'sent', err, err ? null : now, e.id));
    if (err) updates.push(env.DB.prepare('UPDATE webhook_endpoints SET last_error = ? WHERE company_id = ?').bind(`${now.slice(0, 16)} ${err}`, e.company_id));
  }
  if (updates.length) await env.DB.batch(updates);
  return { webhooks: rows.length };
}

export default {
  lg_webhook_get: {
    roles: 'admin',
    async handler(ctx) {
      const [w, ev] = await ctx.db.batch([
        ctx.db.prepare('SELECT url, active, last_error, updated_at FROM webhook_endpoints WHERE company_id = ?').bind(ctx.company.id),
        ctx.db.prepare('SELECT id, event, status, attempts, last_error, created_at, sent_at FROM webhook_events WHERE company_id = ? ORDER BY created_at DESC LIMIT 30').bind(ctx.company.id),
      ]);
      return { endpoint: w.results[0] ? { ...w.results[0], active: Boolean(w.results[0].active) } : null, events: ev.results, can_encrypt: Boolean(ctx.env.SECRETS_KEY) };
    },
  },

  // Adresse de rappel : https seulement ; le secret de signature est montré UNE fois (nouveau à chaque enregistrement).
  lg_webhook_save: {
    roles: 'admin',
    async handler(ctx, a) {
      if (a.p_delete === true) {
        await ctx.db.prepare('DELETE FROM webhook_endpoints WHERE company_id = ?').bind(ctx.company.id).run();
        return { ok: true };
      }
      if (!ctx.env.SECRETS_KEY) fail('secrets_key_missing', 503);
      const url = text(a.p_url, 300);
      let u = null; try { u = new URL(url); } catch { /* invalide */ }
      if (!u || u.protocol !== 'https:' || /^(localhost|127\.|10\.|192\.168\.)/.test(u.hostname)) fail('invalid_url');
      const secret = `whsec_${randomToken(24)}`;
      await ctx.db.prepare(`INSERT INTO webhook_endpoints (company_id, url, secret_enc, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (company_id) DO UPDATE SET url = excluded.url, secret_enc = excluded.secret_enc, active = 1, last_error = NULL,
            updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .bind(ctx.company.id, u.toString(), await encryptSecret(ctx.env.SECRETS_KEY, secret), ctx.user.id, ctx.now).run();
      await audit(ctx, 'webhook_save', 'company', ctx.company.id, { url: u.toString() });
      return { ok: true, secret };
    },
  },
};
