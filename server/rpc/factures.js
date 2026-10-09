// Cycle C6 — factures et avoirs, export comptable, relevés de reversement des vendeurs.
// Portage de 20261007000500_facturation.sql (lg_issue_invoice, lg_credit_note, lg_invoice_get, lg_invoices_list,
// lg_accounting_export, lg_words_fr, lg_track_invoice) et de 20261008001600 (lg_vendor_statement[s]).
// La facture naît à la livraison (une par commande) ; une facture émise ne se modifie pas : toute correction est un
// avoir numéroté dans sa propre séquence. Numéros sans trou par entreprise et par année : le compteur est incrémenté
// DANS LE MÊME LOT que la facture (un lot annulé n'use aucun numéro).
import { fail, audit, int, text, uuid, parseJson, guard, runBatch } from './core.js';
import { causesOf } from './retours.js';
import { payMode } from './commandes.js';

const r2 = (x) => Math.round(x * 100) / 100;
/** « bon:23716 » ou « auchan:23716 » (référence posée par la collecte) → « 23716 » ; référence boutique gardée telle quelle. */
const customerRef = (ref) => (ref ? String(ref).replace(/^[a-z0-9._-]{1,40}:/i, '') : null);
const ht = (ttc, rate) => r2(ttc / (1 + rate / 100));

/** Montant en lettres (lg_words_fr), pour la mention obligatoire de la facture. */
export function wordsFr(value) {
  const u = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize'];
  const dz = ['', 'dix', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante', 'soixante', 'quatre-vingt', 'quatre-vingt'];
  let n = Math.abs(Math.trunc(value));
  if (n === 0) return 'zéro';
  const out = [];
  const big = (div, one, many) => {
    if (n < div) return;
    const q = Math.floor(n / div);
    out.push(q === 1 ? one : `${wordsFr(q)} ${many}`);
    n %= div;
  };
  big(1e9, 'un milliard', 'milliards');
  big(1e6, 'un million', 'millions');
  if (n >= 1000) {
    const q = Math.floor(n / 1000);
    // « quatre-vingt mille », « deux cent mille » : pas de pluriel devant mille
    out.push(q === 1 ? 'mille' : `${wordsFr(q).replace(/(cent|vingt)s$/, '$1')} mille`);
    n %= 1000;
  }
  if (n >= 100) {
    const q = Math.floor(n / 100);
    out.push((q === 1 ? 'cent' : `${u[q]} cent`) + (n % 100 === 0 && q > 1 ? 's' : ''));
    n %= 100;
  }
  if (n > 0) {
    if (n <= 16) out.push(u[n]);
    else if (n < 20) out.push(`dix-${u[n - 10]}`);
    else {
      const d = Math.floor(n / 10); const e = n % 10;
      if (d === 7 || d === 9) out.push(dz[d] + (d === 7 && e === 1 ? ' et ' : '-') + (e + 10 <= 16 ? u[e + 10] : `dix-${u[e]}`));
      else out.push(dz[d] + (e === 0 ? (d === 8 ? 's' : '') : e === 1 && d !== 8 ? ' et un' : `-${u[e]}`));
    }
  }
  return out.join(' ');
}
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Vendeur, émetteur et client de la facture (lg_invoice_parties). */
function parties(ctx, o) {
  const cfg = ctx.company.config; const co = ctx.company;
  const company = { name: co.name, ninea: cfg.company_ninea ?? null, rc: cfg.company_rc ?? null, address: cfg.company_address ?? co.city ?? null, phone: co.phone ?? null };
  const forVendor = cfg.invoice_issuer === 'vendor' && o.vendor_name;
  return {
    issuer_mode: forVendor ? 'vendor' : 'company',
    seller: forVendor ? { name: o.vendor_name, ninea: null, rc: null, address: null, phone: null, vat_registered: false } : { ...company, vat_registered: Boolean(company.ninea) },
    platform: { name: co.name, address: company.address, phone: company.phone },
    customer: { name: o.buyer_name, phone: o.buyer_phone, email: o.buyer_email, address: [o.buyer_address, o.delivery_zone].filter(Boolean).join(', ') || null },
  };
}

const lineStmt = (ctx, invoiceId, pos, l) => ctx.db.prepare(
  'INSERT INTO invoice_lines (company_id, invoice_id, position, kind, order_item_id, label, quantity, unit_price_ht, tva_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
).bind(ctx.company.id, invoiceId, pos, l.kind, l.order_item_id ?? null, l.label, l.quantity, l.unit_price_ht, l.tva_rate);
const counterStmt = (ctx, key) => ctx.db.prepare('INSERT INTO counters (company_id, key, n) VALUES (?, ?, 1) ON CONFLICT (company_id, key) DO UPDATE SET n = n + 1').bind(ctx.company.id, key);
const isUnique = (e) => /UNIQUE constraint failed/i.test(String(e?.message ?? e));

/**
 * Facture de la commande (lg_issue_invoice) : lignes réellement livrées (ruptures et retours exclus), remise au
 * prorata, livraison, assurance ; TTC = le montant encaissé. Renvoie { ok, id, number } ou la facture existante.
 */
export async function issueInvoice(ctx, orderId) {
  const cid = ctx.company.id;
  const [ex, os, items, cc] = await ctx.db.batch([
    ctx.db.prepare('SELECT id, invoice_number FROM invoices WHERE order_id = ? AND company_id = ? AND credit_of IS NULL').bind(orderId, cid),
    ctx.db.prepare('SELECT * FROM orders WHERE id = ? AND company_id = ?').bind(orderId, cid),
    ctx.db.prepare('SELECT id, product_name, quantity, unit_price_fcfa, line_status, picked_qty FROM order_items WHERE order_id = ? AND company_id = ? ORDER BY rowid').bind(orderId, cid),
    ctx.db.prepare("SELECT group_concat(DISTINCT method || coalesce(':' || payment_ref, '')) AS ref FROM cod_collections WHERE order_id = ? AND company_id = ?").bind(orderId, cid),
  ]);
  if (ex.results[0]) return { ok: true, already: true, id: ex.results[0].id, number: ex.results[0].invoice_number };
  const o = os.results[0];
  if (!o) return { ok: false, error: 'unknown_order' };
  if (!(o.payment_status === 'paid' || o.status === 'delivered')) return { ok: false, error: 'not_paid' };
  const cfg = ctx.company.config; const rate = Number(cfg.tva_rate ?? 18);
  const lines = []; let full = 0; let prod = 0;
  for (const it of items.results) {
    full += it.unit_price_fcfa * it.quantity;
    const q = it.line_status === 'cancelled' ? 0 : it.line_status === 'short' ? it.picked_qty : it.quantity;
    if (q <= 0) continue;
    lines.push({ kind: 'product', order_item_id: it.id, label: it.product_name, quantity: q, unit_price_ht: ht(it.unit_price_fcfa, rate), tva_rate: rate });
    prod += it.unit_price_fcfa * q;
  }
  let disc = o.discount_fcfa ?? 0;
  if (disc > 0 && lines.length) {
    disc = Math.round((disc * prod) / Math.max(full, 1));   // au prorata de ce qui est réellement facturé
    lines.push({ kind: 'discount', label: 'Remise', quantity: 1, unit_price_ht: -ht(disc, rate), tva_rate: rate });
    prod -= disc;
  } else disc = 0;
  if (o.delivery_fee_fcfa > 0) lines.push({ kind: 'delivery', label: `Livraison${o.delivery_zone ? ` — ${o.delivery_zone}` : ''}`, quantity: 1, unit_price_ht: ht(o.delivery_fee_fcfa, rate), tva_rate: rate });
  if (o.insurance_fee_fcfa > 0) lines.push({ kind: 'fee', label: 'Assurance du colis', quantity: 1, unit_price_ht: ht(o.insurance_fee_fcfa, rate), tva_rate: rate });
  const ttc = prod + (o.delivery_fee_fcfa ?? 0) + (o.insurance_fee_fcfa ?? 0);
  const totalHt = r2(lines.reduce((s, l) => s + r2(l.unit_price_ht * l.quantity), 0));
  const commission = o.vendor_id ? Math.round((prod * Number(cfg.commission_pct ?? 0)) / 100) : 0;
  const year = ctx.now.slice(0, 4); const key = `FAC-${year}`; const id = uuid();
  // à terme : échéance (fixée à la livraison) et référence du bon du client, exigée par les enseignes sur la facture
  const terms = o.payment_terms_days;
  const due = terms == null ? null : o.due_at ?? new Date(Date.parse(o.delivered_at ?? ctx.now) + terms * 86400000).toISOString();
  const meta = { ...parties(ctx, o), currency: 'XOF', kind: 'invoice', order_short: String(o.number), payment_method: payMode(o),
    payment_ref: cc.results[0]?.ref ?? null, amount_words: `${capital(wordsFr(ttc))} francs CFA`, discount_fcfa: disc,
    payment_terms_days: terms ?? null, due_at: due, customer_ref: customerRef(o.external_ref) };
  try {
    const res = await ctx.db.batch([
      counterStmt(ctx, key),
      ctx.db.prepare(`INSERT INTO invoices (id, company_id, invoice_number, order_id, vendor_id, status, amount_ht, tva, amount_ttc, commission, net_vendor, metadata, issued_at)
          VALUES (?, ?, ? || printf('%06d', (SELECT n FROM counters WHERE company_id = ? AND key = ?)), ?, ?, 'paid', ?, ?, ?, ?, ?, ?, ?) RETURNING invoice_number`)
        .bind(id, cid, `${key}-`, cid, key, orderId, o.vendor_id ?? null, totalHt, r2(ttc - totalHt), ttc, commission, prod - commission, JSON.stringify(meta), ctx.now),
      ...lines.map((l, i) => lineStmt(ctx, id, i + 1, l)),
    ]);
    return { ok: true, id, number: res[1].results[0].invoice_number, ttc };
  } catch (e) {
    if (!isUnique(e)) throw e;
    // émise entre-temps par un autre appel (double clic, rejeu) : le lot entier est annulé, aucun numéro perdu
    const again = await ctx.db.prepare('SELECT id, invoice_number FROM invoices WHERE order_id = ? AND company_id = ? AND credit_of IS NULL').bind(orderId, cid).first();
    return { ok: true, already: true, id: again.id, number: again.invoice_number };
  }
}

/**
 * Avoir sur une facture (lg_credit_note) : par lignes { order_item_id, quantity } (jamais plus que facturé moins déjà
 * crédité) ou geste commercial global (p_amount_fcfa). Le contrôle « pas plus que facturé » est dans le lot.
 */
export async function creditNote(ctx, invoiceId, reqLines, reason, amount = null) {
  const cid = ctx.company.id;
  const inv = await ctx.db.prepare('SELECT * FROM invoices WHERE id = ? AND company_id = ?').bind(String(invoiceId ?? ''), cid).first();
  if (!inv || inv.credit_of) fail('unknown_invoice', 404);
  const rate = Number(ctx.company.config.tva_rate ?? 18);
  const lines = []; let ttc = 0; const checks = [];
  if (amount != null) {
    const a = int(amount);
    if (!(a > 0)) fail('invalid_amount');
    lines.push({ kind: 'fee', label: text(reason, 120) ?? 'Geste commercial', quantity: 1, unit_price_ht: -ht(a, rate), tva_rate: rate });
    ttc = a;
  } else {
    const want = (Array.isArray(reqLines) ? reqLines : []).filter((l) => l && l.order_item_id);
    if (want.length) {
      const [billed, items] = await ctx.db.batch([
        ctx.db.prepare("SELECT order_item_id, quantity, tva_rate FROM invoice_lines WHERE invoice_id = ? AND kind = 'product'").bind(inv.id),
        ctx.db.prepare('SELECT id, product_name, unit_price_fcfa FROM order_items WHERE order_id = ? AND company_id = ?').bind(inv.order_id, cid),
      ]);
      for (const l of want) {
        const q = int(l.quantity);
        const b = billed.results.find((x) => x.order_item_id === l.order_item_id);
        const it = items.results.find((x) => x.id === l.order_item_id);
        if (!it) fail('unknown_line');
        if (!(q > 0)) fail('invalid_quantity');
        if (!b) fail('credit_exceeds_invoice');
        lines.push({ kind: 'product', order_item_id: it.id, label: `${it.product_name} — ${text(reason, 80) ?? 'avoir'}`, quantity: q, unit_price_ht: -ht(it.unit_price_fcfa, b.tva_rate), tva_rate: b.tva_rate });
        ttc += it.unit_price_fcfa * q;
        checks.push([it.id, b.quantity]);
      }
    }
  }
  if (!lines.length) fail('empty_credit_note');
  const totalHt = r2(lines.reduce((s, l) => s + r2(l.unit_price_ht * l.quantity), 0));
  const year = ctx.now.slice(0, 4); const key = `AV-${year}`; const id = uuid();
  const meta = { ...parseJson(inv.metadata, {}), kind: 'credit_note', credit_of_number: inv.invoice_number, reason: text(reason, 300),
    amount_words: `Moins ${wordsFr(ttc)} francs CFA` };
  delete meta.discount_fcfa;
  const res = await runBatch(ctx, [
    counterStmt(ctx, key),
    ctx.db.prepare(`INSERT INTO invoices (id, company_id, invoice_number, order_id, vendor_id, status, credit_of, amount_ht, tva, amount_ttc, metadata, issued_at)
        VALUES (?, ?, ? || printf('%06d', (SELECT n FROM counters WHERE company_id = ? AND key = ?)), ?, ?, 'refunded', ?, ?, ?, ?, ?, ?) RETURNING invoice_number`)
      .bind(id, cid, `${key}-`, cid, key, inv.order_id, inv.vendor_id, inv.id, totalHt, r2(-ttc - totalHt), -ttc, JSON.stringify(meta), ctx.now),
    ...lines.map((l, i) => lineStmt(ctx, id, i + 1, l)),
    // jamais plus que ce qui a été facturé (moins ce qui a déjà été crédité), même si deux avoirs partent ensemble
    ...checks.map(([item, qty]) => guard(ctx.db, `(SELECT coalesce(sum(il.quantity), 0) FROM invoice_lines il JOIN invoices c ON c.id = il.invoice_id
        WHERE c.credit_of = ? AND il.order_item_id = ? AND il.kind = 'product') <= ?`, [inv.id, item, qty])),
    guard(ctx.db, '(SELECT sum(amount_ttc) FROM invoices WHERE id = ? OR credit_of = ?) >= 0', [inv.id, inv.id]),
    ctx.db.prepare(`UPDATE invoices SET status = CASE WHEN (SELECT sum(amount_ttc) FROM invoices WHERE id = ?1 OR credit_of = ?1) <= 0 THEN 'refunded' ELSE status END
        WHERE id = ?1`).bind(inv.id),
  ], 'credit_exceeds_invoice');
  const number = res[1].results[0].invoice_number;
  await audit(ctx, 'credit_note', 'invoice', number, { of: inv.invoice_number, ttc });
  return { ok: true, id, number, ttc: -ttc };
}

/** Avoir automatique pour le contenu d'un colis retourné (lg_credit_package), si la commande a été facturée. */
export async function creditPackage(ctx, packageId, reason) {
  const [inv, items] = await ctx.db.batch([
    ctx.db.prepare('SELECT i.id FROM invoices i JOIN packages p ON p.order_id = i.order_id WHERE p.id = ? AND i.company_id = ? AND i.credit_of IS NULL').bind(packageId, ctx.company.id),
    ctx.db.prepare('SELECT order_item_id, quantity FROM package_items WHERE package_id = ? AND company_id = ?').bind(packageId, ctx.company.id),
  ]);
  const id = inv.results[0]?.id;
  if (!id || !items.results.length) return null;
  try {
    return (await creditNote(ctx, id, items.results, reason)).number;
  } catch (e) {
    if (['credit_exceeds_invoice', 'unknown_line', 'empty_credit_note'].includes(e?.code)) return null;   // déjà crédité ou non facturé
    throw e;
  }
}

/** Document complet (lg_invoice_doc). */
export async function invoiceDoc(ctx, inv) {
  const [lines, credits, ord] = await ctx.db.batch([
    ctx.db.prepare('SELECT position, kind, order_item_id, label, quantity, unit_price_ht, tva_rate, total_ht FROM invoice_lines WHERE invoice_id = ? ORDER BY position').bind(inv.id),
    ctx.db.prepare('SELECT invoice_number AS number, amount_ttc AS ttc, issued_at AS at FROM invoices WHERE credit_of = ? ORDER BY issued_at').bind(inv.id),
    ctx.db.prepare('SELECT payment_status, paid_at, due_at, payment_terms_days, payment_ref, payment_via FROM orders WHERE id = ? AND company_id = ?').bind(inv.order_id, inv.company_id),
  ]);
  const o = ord.results[0];
  // état du règlement au moment de la lecture (la facture elle-même ne change jamais)
  const settlement = o?.payment_terms_days != null ? { paid: o.payment_status === 'paid', paid_at: o.paid_at, due_at: o.due_at, ref: o.payment_ref, via: o.payment_via } : null;
  return { ...inv, metadata: parseJson(inv.metadata, {}), lines: lines.results.map((l) => ({ ...l, total_ttc: Math.round(l.total_ht * (1 + l.tva_rate / 100)) })),
    credits: credits.results, settlement };
}

const isVendor = (ctx) => ctx.member === 'vendor';
const dayStart = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d ?? '')) ? `${d}T00:00:00.000Z` : null);
const dayAfter = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d ?? '')) ? new Date(Date.parse(`${d}T00:00:00.000Z`) + 86400000).toISOString() : null);

/** Relevés des vendeurs sur une période, regroupés en une passe (lg_vendor_statement / lg_vendor_statements). */
async function statements(ctx, from, to, vendorId = null) {
  const cid = ctx.company.id; const a = dayStart(from); const b = dayAfter(to);
  if (!a || !b) fail('invalid_period');
  const rate = Number(ctx.company.config.commission_pct ?? 0);
  const [ord, ded, vend] = await ctx.db.batch([
    ctx.db.prepare(
      `SELECT o.id, o.number, o.vendor_id, o.delivered_at, o.payment_method, o.payment_status, o.buyer_name, o.discount_fcfa,
              (SELECT sum(unit_price_fcfa * quantity) FROM order_items WHERE order_id = o.id) AS full_amt,
              (SELECT sum(unit_price_fcfa * CASE WHEN line_status = 'cancelled' THEN 0 WHEN line_status = 'short' THEN picked_qty ELSE quantity END)
                 FROM order_items WHERE order_id = o.id) AS eff,
              EXISTS (SELECT 1 FROM packages p JOIN trip_packages tp ON tp.package_id = p.id AND tp.outcome = 'delivered' JOIN trips t ON t.id = tp.trip_id
                       WHERE p.order_id = o.id AND t.status = 'reconciled') AS reconciled
         FROM orders o WHERE o.company_id = ?1 AND o.vendor_id IS NOT NULL AND (?2 IS NULL OR o.vendor_id = ?2)
          AND o.status = 'delivered' AND o.delivered_at >= ?3 AND o.delivered_at < ?4 ORDER BY o.delivered_at`,
    ).bind(cid, vendorId, a, b),
    ctx.db.prepare(
      `SELECT rc.vendor_id, rc.amount_fcfa, rc.classified_at, rc.cause, p.code FROM return_charges rc JOIN packages p ON p.id = rc.package_id
        WHERE rc.company_id = ?1 AND rc.vendor_id IS NOT NULL AND (?2 IS NULL OR rc.vendor_id = ?2) AND rc.payer = 'vendor' AND rc.amount_fcfa > 0
          AND rc.classified_at >= ?3 AND rc.classified_at < ?4 ORDER BY rc.classified_at`,
    ).bind(cid, vendorId, a, b),
    ctx.db.prepare("SELECT u.id, u.name FROM members m JOIN users u ON u.id = m.user_id WHERE m.company_id = ? AND m.role = 'vendor'").bind(cid),
  ]);
  const labels = new Map((await causesOf(ctx)).map((c) => [c.code, c.label]));
  const out = new Map();
  const get = (vid) => {
    if (!out.has(vid)) {
      const v = vend.results.find((x) => x.id === vid);
      out.set(vid, { vendor_id: vid, vendor: v?.name ?? null, member: Boolean(v), commission_rate: rate, from, to, orders: [], deductions: [] });
    }
    return out.get(vid);
  };
  for (const o of ord.results) {
    const goods = (o.eff ?? 0) - (o.discount_fcfa > 0 ? Math.round((o.discount_fcfa * (o.eff ?? 0)) / Math.max(o.full_amt ?? 0, 1)) : 0);
    const commission = Math.round((goods * rate) / 100);
    get(o.vendor_id).orders.push({ order_id: o.id, short: String(o.number), delivered_at: o.delivered_at, payment_method: o.payment_method, customer: o.buyer_name,
      goods_fcfa: goods, commission_fcfa: commission, net_fcfa: goods - commission,
      settled: o.payment_method === 'cod' ? Boolean(o.reconciled) : o.payment_status === 'paid' });
  }
  for (const d of ded.results) get(d.vendor_id).deductions.push({ package: d.code, cause: labels.get(d.cause) ?? d.cause, amount_fcfa: d.amount_fcfa, at: d.classified_at });
  for (const s of out.values()) {
    const sum = (f, xs = s.orders) => xs.reduce((t, x) => t + f(x), 0);
    const deductions = sum((d) => d.amount_fcfa, s.deductions);
    s.totals = {
      orders: s.orders.length, goods_fcfa: sum((o) => o.goods_fcfa), commission_fcfa: sum((o) => o.commission_fcfa), deductions_fcfa: deductions,
      // reversable : commandes réglées (espèces rapprochées), moins toutes les retenues de la période
      net_payable_fcfa: sum((o) => (o.settled ? o.net_fcfa : 0)) - deductions,
      pending_fcfa: sum((o) => (o.settled ? 0 : o.net_fcfa)), pending_orders: s.orders.filter((o) => !o.settled).length,
    };
  }
  return { list: [...out.values()].filter((s) => s.member), vendors: vend.results };
}

export default {
  lg_invoices_list: {
    roles: 'member',
    async handler(ctx, a) {
      const staff = ctx.isAdmin || ctx.roles.some((r) => ['accountant', 'support'].includes(r.role));
      if (!staff && !isVendor(ctx)) fail('forbidden', 403);
      const q = text(a.p_q, 60);
      const r = await ctx.db.prepare(
        `SELECT i.id, i.invoice_number, i.credit_of, i.amount_ttc, i.amount_ht, i.tva, i.status, i.issued_at, i.metadata, o.number,
                o.payment_terms_days, o.payment_status AS order_paid, o.due_at
           FROM invoices i JOIN orders o ON o.id = i.order_id
          WHERE i.company_id = ?1 AND (?2 IS NULL OR i.issued_at >= ?2) AND (?3 IS NULL OR i.issued_at < ?3)
            AND (?4 IS NULL OR i.invoice_number LIKE '%' || ?4 || '%' OR json_extract(i.metadata, '$.customer.name') LIKE '%' || ?4 || '%')
            AND (?5 IS NULL OR i.vendor_id = ?5)
          ORDER BY i.issued_at DESC LIMIT 500`,
      ).bind(ctx.company.id, dayStart(a.p_from), dayAfter(a.p_to), q, staff ? null : ctx.user.id).all();
      return r.results.map((i) => {
        const m = parseJson(i.metadata, {});
        // facture à terme pas encore réglée : « à régler » (ou « en retard » passé l'échéance), jamais « payée »
        const open = !i.credit_of && i.payment_terms_days != null && i.order_paid !== 'paid';
        const status = open ? (i.due_at && i.due_at < ctx.now ? 'overdue' : 'due') : i.status;
        return { due_at: i.due_at ?? m.due_at ?? null, id: i.id, number: i.invoice_number, kind: i.credit_of ? 'credit_note' : 'invoice', order_short: String(i.number), customer: m.customer?.name ?? null,
          seller: m.seller?.name ?? null, ttc: i.amount_ttc, ht: i.amount_ht, tva: i.tva, status, issued_at: i.issued_at, payment_method: m.payment_method ?? null,
          sent_whatsapp_at: null };
      });
    },
  },

  lg_invoice_get: {
    roles: 'member',
    async handler(ctx, a) {
      const staff = ctx.isAdmin || ctx.roles.some((r) => ['accountant', 'support'].includes(r.role));
      if (!staff && !isVendor(ctx)) fail('forbidden', 403);
      const i = await ctx.db.prepare('SELECT * FROM invoices WHERE id = ? AND company_id = ?').bind(String(a.p_invoice ?? ''), ctx.company.id).first();
      if (!i) fail('unknown_invoice', 404);
      if (!staff && i.vendor_id !== ctx.user.id) fail('forbidden', 403);
      return invoiceDoc(ctx, i);
    },
  },

  lg_credit_note_manual: {
    roles: ['accountant'],
    async handler(ctx, a) {
      if (!text(a.p_reason)) fail('reason_required');
      return creditNote(ctx, a.p_invoice, a.p_lines, a.p_reason, a.p_amount_fcfa ?? null);
    },
  },

  lg_accounting_export: {
    roles: ['accountant'],
    async handler(ctx, a) {
      const from = dayStart(a.p_from); const to = dayAfter(a.p_to);
      if (!from || !to) fail('invalid_period');
      const cid = ctx.company.id;
      const [inv, vat, col] = await ctx.db.batch([
        ctx.db.prepare(`SELECT i.issued_at, i.invoice_number, i.credit_of, o.number, i.metadata, i.amount_ht, i.tva, i.amount_ttc, i.commission
            FROM invoices i JOIN orders o ON o.id = i.order_id WHERE i.company_id = ? AND i.issued_at >= ? AND i.issued_at < ? ORDER BY i.issued_at, i.invoice_number`).bind(cid, from, to),
        ctx.db.prepare(`SELECT il.tva_rate, round(sum(il.total_ht), 2) AS ht FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
            WHERE i.company_id = ? AND i.issued_at >= ? AND i.issued_at < ? GROUP BY il.tva_rate ORDER BY il.tva_rate`).bind(cid, from, to),
        ctx.db.prepare(`SELECT method, sum(amount_collected_fcfa) AS amt, count(*) AS n FROM cod_collections
            WHERE company_id = ? AND created_at >= ? AND created_at < ? GROUP BY method ORDER BY method`).bind(cid, from, to),
      ]);
      return {
        period: { from: a.p_from, to: a.p_to },
        sales_journal: inv.results.map((i) => {
          const m = parseJson(i.metadata, {});
          return { date: i.issued_at.slice(0, 10), numero: i.invoice_number, type: i.credit_of ? 'Avoir' : 'Facture', commande: String(i.number),
            client: m.customer?.name ?? null, vendeur: m.seller?.name ?? null, ninea_vendeur: m.seller?.ninea ?? null,
            ht: i.amount_ht, tva: i.tva, ttc: i.amount_ttc, commission: i.commission, mode: m.payment_method ?? null };
        }),
        vat_by_rate: vat.results.map((v) => ({ taux: v.tva_rate, base_ht: v.ht, tva: r2((v.ht * v.tva_rate) / 100) })),
        collections_by_method: col.results.map((c) => ({ mode: c.method, montant: c.amt, nombre: c.n })),
      };
    },
  },

  // Relevé de reversement : un vendeur ne voit que le sien, le comptable choisit le vendeur.
  lg_vendor_statement: {
    roles: 'member',
    async handler(ctx, a) {
      const accountant = ctx.isAdmin || ctx.roles.some((r) => r.role === 'accountant');
      let vid;
      if (a.p_vendor && accountant) vid = String(a.p_vendor);
      else if (isVendor(ctx)) vid = ctx.user.id;
      else if (accountant) fail('vendor_required');
      else fail('forbidden', 403);
      const { list, vendors } = await statements(ctx, a.p_from, a.p_to, vid);
      const v = vendors.find((x) => x.id === vid);
      if (!v) fail('unknown_vendor', 404);
      const s = list[0] ?? { vendor_id: vid, vendor: v.name, commission_rate: Number(ctx.company.config.commission_pct ?? 0), from: a.p_from, to: a.p_to, orders: [], deductions: [],
        totals: { orders: 0, goods_fcfa: 0, commission_fcfa: 0, deductions_fcfa: 0, net_payable_fcfa: 0, pending_fcfa: 0, pending_orders: 0 } };
      const { member, ...rest } = s;
      return rest;
    },
  },

  lg_vendor_statements: {
    roles: ['accountant'],
    async handler(ctx, a) {
      const { list } = await statements(ctx, a.p_from, a.p_to);
      return list.map((s) => ({ ...s.totals, vendor_id: s.vendor_id, vendor: s.vendor })).sort((x, y) => String(x.vendor).localeCompare(String(y.vendor)));
    },
  },
};
