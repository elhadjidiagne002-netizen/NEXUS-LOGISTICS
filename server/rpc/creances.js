// Créances clients : commandes à terme (sur facture) — 09/10/2026.
// Une commande à terme part en préparation sans attendre de paiement, le chauffeur n'encaisse rien, la facture porte
// une échéance (livraison + délai) et la somme reste à recevoir jusqu'à l'enregistrement du règlement par la
// comptabilité. Les relances (échéance proche, échue, échue depuis 15 jours) partent par la tâche « reminders ».
// Stockage : payment_method = 'prepaid' + payment_terms_days non nul (cf. migrations/0016, payMode()).
import { fail, audit, text, int, parseJson } from './core.js';
import { notifyOrder, sendLater } from './messages.js';

const VIA = ['transfer', 'cheque', 'cash', 'mobile', 'other'];
const DAY = 86400000;
const ddmmyyyy = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
const customerRef = (ref) => (ref ? String(ref).replace(/^[a-z0-9._-]{1,40}:/i, '') : null);

/** Montant restant dû d'une commande à terme : facture moins avoirs ; avant facture, le total prévu. */
const OWED_SQL = `coalesce((SELECT sum(i.amount_ttc) FROM invoices i WHERE i.order_id = o.id AND i.company_id = o.company_id), o.total_fcfa - o.shortage_fcfa)`;

export async function receivables(ctx, { state = 'open', q = null } = {}) {
  const rows = (await ctx.db.prepare(
    `SELECT o.id, o.number, o.external_ref, o.status, o.buyer_name, o.buyer_phone, o.customer_id, o.payment_terms_days, o.due_at,
            o.delivered_at, o.payment_status, o.paid_at, o.payment_ref, o.payment_via, o.created_at, ${OWED_SQL} AS owed,
            (SELECT invoice_number FROM invoices i WHERE i.order_id = o.id AND i.company_id = o.company_id AND i.credit_of IS NULL) AS invoice,
            (SELECT stage FROM payment_reminders_sent r WHERE r.order_id = o.id ORDER BY sent_at DESC LIMIT 1) AS reminded
       FROM orders o
      WHERE o.company_id = ?1 AND o.payment_terms_days IS NOT NULL AND o.status <> 'cancelled'
        AND (CASE WHEN ?2 = 'paid' THEN o.payment_status = 'paid' ELSE o.payment_status <> 'paid' END)
        AND (?2 <> 'overdue' OR (o.due_at IS NOT NULL AND o.due_at < ?3))
        AND (?4 IS NULL OR o.buyer_name LIKE '%' || ?4 || '%' OR o.external_ref LIKE '%' || ?4 || '%' OR CAST(o.number AS TEXT) = ?4)
      ORDER BY CASE WHEN o.due_at IS NULL THEN 1 ELSE 0 END, o.due_at, o.created_at LIMIT 500`,
  ).bind(ctx.company.id, ['open', 'overdue', 'paid'].includes(state) ? state : 'open', ctx.now, text(q, 60)).all()).results;
  const now = Date.parse(ctx.now);
  const list = rows.map((o) => {
    const late = o.payment_status !== 'paid' && o.due_at ? Math.floor((now - Date.parse(o.due_at)) / DAY) : null;
    return {
      order_id: o.id, number: o.number, customer: o.buyer_name, phone: o.buyer_phone, customer_id: o.customer_id, customer_ref: customerRef(o.external_ref),
      status: o.status, invoice: o.invoice, owed_fcfa: Math.max(0, Math.round(o.owed ?? 0)), terms_days: o.payment_terms_days, due_at: o.due_at,
      delivered_at: o.delivered_at, days_late: late != null && late >= 0 ? late : null, days_left: late != null && late < 0 ? -late : null,
      paid: o.payment_status === 'paid', paid_at: o.paid_at, payment_ref: o.payment_ref, payment_via: o.payment_via, reminded: o.reminded,
    };
  });
  // balance âgée (créances ouvertes seulement) et regroupement par client
  const open = list.filter((r) => !r.paid);
  const bucket = (r) => (r.due_at == null ? 'not_due' : r.days_late == null ? 'not_due' : r.days_late <= 30 ? 'd0_30' : r.days_late <= 60 ? 'd31_60' : 'd60_plus');
  const aging = { not_due: 0, d0_30: 0, d31_60: 0, d60_plus: 0 };
  const byCustomer = new Map();
  for (const r of open) {
    aging[bucket(r)] += r.owed_fcfa;
    const k = r.customer_id ?? r.customer;
    const c = byCustomer.get(k) ?? { customer: r.customer, owed_fcfa: 0, overdue_fcfa: 0, orders: 0 };
    c.owed_fcfa += r.owed_fcfa; c.orders += 1; if (r.days_late != null) c.overdue_fcfa += r.owed_fcfa;
    byCustomer.set(k, c);
  }
  return {
    list, aging, total_open_fcfa: open.reduce((s, r) => s + r.owed_fcfa, 0),
    overdue_fcfa: open.filter((r) => r.days_late != null).reduce((s, r) => s + r.owed_fcfa, 0),
    customers: [...byCustomer.values()].sort((a, b) => b.overdue_fcfa - a.overdue_fcfa || b.owed_fcfa - a.owed_fcfa),
  };
}

/**
 * Relances d'impayés (tâche « reminders ») : J-3 (« soon »), lendemain de l'échéance (« late »), +15 jours (« late2 »).
 * Une relance par étape et par commande (payment_reminders_sent) ; jamais la nuit ; 100 par passage au plus.
 */
export async function paymentReminders(env, now) {
  const h = Number(now.slice(11, 13));                    // Dakar = UTC
  if (h < 8 || h >= 19) return { payment_reminders: 0 };
  const soon = new Date(Date.parse(now) + 3 * DAY).toISOString();
  const late2 = new Date(Date.parse(now) - 15 * DAY).toISOString();
  const rows = (await env.DB.prepare(
    `SELECT o.*, c.name AS company_name, c.settings, ${OWED_SQL} AS owed,
            CASE WHEN o.due_at < ?3 THEN 'late2' WHEN o.due_at < ?1 THEN 'late' ELSE 'soon' END AS stage,
            (SELECT invoice_number FROM invoices i WHERE i.order_id = o.id AND i.company_id = o.company_id AND i.credit_of IS NULL) AS invoice
       FROM orders o JOIN companies c ON c.id = o.company_id
      WHERE c.suspended_at IS NULL AND o.payment_terms_days IS NOT NULL AND o.payment_status <> 'paid' AND o.status = 'delivered'
        AND o.due_at IS NOT NULL AND o.due_at < ?2
        AND NOT EXISTS (SELECT 1 FROM payment_reminders_sent r WHERE r.order_id = o.id
                         AND r.stage = CASE WHEN o.due_at < ?3 THEN 'late2' WHEN o.due_at < ?1 THEN 'late' ELSE 'soon' END)
      LIMIT 100`,
  ).bind(now, soon, late2).all()).results;
  const byCompany = new Map();
  for (const r of rows) (byCompany.get(r.company_id) ?? byCompany.set(r.company_id, []).get(r.company_id)).push(r);
  let sent = 0;
  for (const [cid, list] of byCompany) {
    const ctx = { db: env.DB, now, company: { id: cid, name: list[0].company_name, config: parseJson(list[0].settings, {}) } };
    const stmts = [];
    for (const r of list) {
      stmts.push(env.DB.prepare('INSERT OR IGNORE INTO payment_reminders_sent (order_id, stage, company_id, sent_at) VALUES (?, ?, ?, ?)').bind(r.id, r.stage, cid, now));
      if (!(r.owed > 0)) continue;                         // soldée par avoir : rien à réclamer
      const msg = await notifyOrder(ctx, r.stage === 'soon' ? 'lg_invoice_due_soon' : 'lg_invoice_overdue', r,
        { montant: Math.round(r.owed), facture: r.invoice ?? `commande ${r.number}`, echeance: ddmmyyyy(r.due_at) });
      if (msg) { stmts.push(msg); sent += 1; }
    }
    await sendLater(ctx, stmts);
  }
  return { payment_reminders: sent };
}

export default {
  // Créances à terme : ouvertes (défaut), échues, ou réglées ; balance âgée et totaux par client.
  lg_receivables: {
    roles: ['accountant', 'support'],
    async handler(ctx, a) {
      return receivables(ctx, { state: a.p_state, q: a.p_q });
    },
  },

  // Règlement reçu (virement, chèque…) d'une commande à terme. Rejouable : déjà réglée → { already: true }.
  lg_order_record_payment: {
    roles: ['accountant'],
    async handler(ctx, a) {
      const via = VIA.includes(a.p_via) ? a.p_via : 'transfer';
      const day = /^\d{4}-\d{2}-\d{2}$/.test(String(a.p_paid_on ?? '')) ? `${a.p_paid_on}T12:00:00.000Z` : ctx.now;
      if (day.slice(0, 10) > ctx.now.slice(0, 10)) fail('invalid_date');
      const id = String(a.p_order ?? '');
      const r = await ctx.db.prepare(
        `UPDATE orders SET payment_status = 'paid', paid_at = ?, payment_ref = ?, payment_via = ?, updated_at = ?
          WHERE id = ? AND company_id = ? AND payment_terms_days IS NOT NULL AND payment_status <> 'paid' AND status <> 'cancelled'`,
      ).bind(day, text(a.p_ref, 80), via, ctx.now, id, ctx.company.id).run();
      if (!r.meta.changes) {
        const o = await ctx.db.prepare('SELECT payment_status, payment_terms_days, status FROM orders WHERE id = ? AND company_id = ?').bind(id, ctx.company.id).first();
        if (!o) fail('unknown_order', 404);
        if (o.payment_terms_days == null) fail('not_on_account');
        if (o.payment_status === 'paid') return { ok: true, already: true };
        fail('order_cancelled');
      }
      await audit(ctx, 'payment_recorded', 'order', id, { via, ref: text(a.p_ref, 80), paid_on: day.slice(0, 10) });
      return { ok: true };
    },
  },

  // Client « en compte » : délai de paiement par défaut de ses commandes (null = retour au paiement à la livraison).
  lg_customer_terms_set: {
    roles: ['accountant', 'support'],
    async handler(ctx, a) {
      const days = a.p_days == null || a.p_days === '' ? null : int(a.p_days);
      if (days != null && !(days >= 0 && days <= 365)) fail('invalid_terms');
      const r = await ctx.db.prepare('UPDATE customers SET payment_terms_days = ?, updated_at = ? WHERE id = ? AND company_id = ?')
        .bind(days, ctx.now, String(a.p_customer ?? ''), ctx.company.id).run();
      if (!r.meta.changes) fail('unknown_customer', 404);
      await audit(ctx, 'customer_terms', 'customer', String(a.p_customer), { days });
      return { ok: true, days };
    },
  },
};
