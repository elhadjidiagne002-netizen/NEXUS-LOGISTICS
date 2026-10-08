// Cycle C2 — commandes, clients, catalogue logistique, confirmation du paiement à la livraison,
// annulation, assurance, demandes des clients, clés d'API des boutiques.
// Portage de lg_confirm_cod / lg_cancel_unconfirmed / lg_cod_pending (20261007000300), lg_order_insure
// (20261008001400), lg_product_logistics / lg_products_to_complete / lg_vendor_overview (20261007000700),
// lg_product_find (20261008000600), lg_requests_list / lg_request_done (20261007000600).
// Nouveau dans la version Cloudflare : la commande naît ICI (saisie, import, API), plus sur le site NEXUS.
import { fail, audit, idempotent, hasRole, text, num, int, uuid, phoneKey, parseJson } from './core.js';
import { stockMoveStatements } from './stock.js';
import { randomToken, sha256Hex } from '../crypto.js';
import { chunks } from '../http.js';
import { loadPricing, computeQuote, insuranceFee, zoneAt, SERVICES } from './tarifs.js';
import { releaseStatements } from './preparation.js';
import { checkQuota } from './offre.js';
import { webhookStatement } from './webhooks.js';
import { notifyOrder, notifyPerson, sendLater, hhmm } from './messages.js';

export const IMPORT_MAX = 50;          // commandes par appel (import CSV, API) : budget de requêtes D1
const MAX_ITEMS = 50;                  // lignes par commande
const HANDLING = ['fragile', 'lourd', 'liquide', 'alimentaire', 'froid', 'vivant', 'chimique'];
const EDITABLE = ['pending', 'processing'];   // rien n'est encore parti : adresse, assurance, annulation possibles

export const orderShort = (id) => String(id).slice(0, 8).toUpperCase();
export const trackingUrl = (ctx, token) => `${new URL(ctx.request.url).origin}/suivi/${token}`;
/**
 * Montant à encaisser à la livraison (équivalent de lg_order_due_fcfa) : 0 si payé d'avance.
 * Le même chiffre pour le chauffeur, la page de suivi et la facture. Les ruptures (C3) le réduiront.
 */
export const amountDue = (o) => {
  if (o.payment_method !== 'cod' || o.payment_status === 'paid') return 0;
  // ruptures exclues, remise au prorata de ce qui reste (lg_order_due_fcfa)
  const short = o.shortage_fcfa ?? 0;
  return o.total_fcfa - short + (o.subtotal_fcfa ? Math.round(((o.discount_fcfa ?? 0) * short) / o.subtotal_fcfa) : 0);
};
/** Colis déjà partis (chargés, en livraison, livrés) : plus d'annulation, d'assurance ni de changement d'adresse. */
export const SHIPPED_SQL = "EXISTS (SELECT 1 FROM packages p WHERE p.order_id = orders.id AND p.status IN ('loaded', 'out_for_delivery', 'delivered'))";

const isOps = (ctx) => hasRole(ctx, ['support', 'dispatcher']);
const vendorOnly = (ctx) => ctx.member === 'vendor' && !ctx.isAdmin && !ctx.roles.length;
const like = (q) => `%${String(q).replace(/[%_]/g, '')}%`;

// ----------------------------------------------------------------- création (saisie, import, API)
/** Lectures groupées d'un lot de commandes : références déjà connues, produits cités, numéros bannis. */
async function lookups(db, cid, inputs) {
  const refs = [...new Set(inputs.map((i) => text(i?.external_ref, 80)).filter(Boolean))];
  const items = inputs.flatMap((i) => (Array.isArray(i?.items) ? i.items : []));
  const ids = [...new Set(items.map((x) => text(x?.product_id, 64)).filter(Boolean))];
  const skus = [...new Set(items.map((x) => text(x?.sku, 64)).filter(Boolean))];
  const keys = [...new Set(inputs.map((i) => phoneKey(i?.customer?.phone)).filter(Boolean))];
  const stmts = [];
  const q = (sql, list) => chunks(list, 90).forEach((c) => stmts.push(['' + sql, db.prepare(sql.replace('$', c.map(() => '?').join(','))).bind(cid, ...c)]));
  q('SELECT external_ref, id, number FROM orders WHERE company_id = ? AND external_ref IN ($)', refs);
  q('SELECT id, sku, name, price_fcfa, weight_g FROM products WHERE company_id = ? AND id IN ($)', ids);
  q('SELECT id, sku, name, price_fcfa, weight_g FROM products WHERE company_id = ? AND sku IN ($)', skus);
  q('SELECT phone_key FROM banned_numbers WHERE company_id = ? AND phone_key IN ($)', keys);
  const res = stmts.length ? await db.batch(stmts.map((s) => s[1])) : [];
  const out = { refs: new Map(), byId: new Map(), bySku: new Map(), banned: new Set() };
  res.forEach((r, i) => {
    const sql = stmts[i][0];
    for (const row of r.results) {
      if (sql.includes('external_ref IN')) out.refs.set(row.external_ref, row);
      else if (sql.includes('AND id IN')) out.byId.set(row.id, row);
      else if (sql.includes('sku IN')) out.bySku.set(row.sku, row);
      else out.banned.add(row.phone_key);
    }
  });
  return out;
}

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Vérifie et chiffre une commande ; renvoie { error } ou la commande prête à écrire. */
function buildOrder(ctx, pricing, look, input, source) {
  const cfg = ctx.company.config;
  const c = input?.customer && typeof input.customer === 'object' ? input.customer : {};
  const name = text(c.name, 80); const phone = text(c.phone, 30); const key = phoneKey(phone);
  if (!name || name.length < 2 || !key) return { error: 'invalid_customer' };
  if (look.banned.has(key)) return { error: 'banned_number' };
  const lat = num(c.lat); const lng = num(c.lng);
  if ((lat == null) !== (lng == null) || (lat != null && (Math.abs(lat) > 90 || Math.abs(lng) > 180))) return { error: 'invalid_position' };
  const rawItems = Array.isArray(input.items) ? input.items : [];
  if (!rawItems.length) return { error: 'no_items' };
  if (rawItems.length > MAX_ITEMS) return { error: 'too_many_items' };
  const items = [];
  for (const x of rawItems) {
    const p = (x?.product_id && look.byId.get(String(x.product_id))) || (x?.sku && look.bySku.get(String(x.sku))) || null;
    if (x?.product_id && !p) return { error: 'unknown_product' };
    // prix unitaire : unit_price_fcfa (nom canonique) ou price_fcfa (nom utilisé par l'ancienne notice de l'API)
    const given = x?.unit_price_fcfa ?? x?.price_fcfa;
    const qty = int(x?.quantity ?? 1); const price = given == null || given === '' ? p?.price_fcfa ?? 0 : int(given);
    const w = x?.weight_g == null || x.weight_g === '' ? p?.weight_g ?? null : int(x.weight_g);
    const pname = text(x?.name, 120) ?? p?.name;
    if (!pname) return { error: 'invalid_item' };
    if (!(qty > 0) || qty > 10000) return { error: 'invalid_quantity' };
    if (price == null || price < 0 || (w != null && w <= 0)) return { error: 'invalid_amount' };
    items.push({ id: uuid(), product_id: p?.id ?? null, name: pname, qty, price, weight: w });
  }
  // zone : nommée (sans tenir compte des accents ni de la casse), sinon déduite de la position
  const zName = text(input.zone, 80);
  const zone = zName ? pricing.zones.find((z) => norm(z.name) === norm(zName)) : zoneAt(pricing.zones, lat, lng);
  if (!zone) return { error: 'unknown_zone' };
  if (!zone.served) return { error: 'zone_not_served' };
  const service = input.service || 'standard';
  if (!SERVICES.includes(service)) return { error: 'invalid_service' };
  const method = input.payment_method === 'prepaid' ? 'prepaid' : input.payment_method == null || input.payment_method === 'cod' ? 'cod' : null;
  if (!method) return { error: 'invalid_payment' };
  const subtotal = items.reduce((s, x) => s + x.qty * x.price, 0);
  const discount = int(input.discount_fcfa) ?? 0;
  if (discount < 0 || discount > subtotal) return { error: 'invalid_amount' };
  const known = items.filter((x) => x.weight != null);
  const weight = int(input.weight_g) ?? (known.length ? known.reduce((s, x) => s + x.weight * x.qty, 0) : null);
  const declared = int(input.declared_value_fcfa);
  const q = computeQuote(pricing, cfg, { zone: zone.name, weight_g: weight, subtotal_fcfa: subtotal - discount, service, declared_value_fcfa: declared, lat, lng }, ctx.now);
  const override = input.delivery_fee_fcfa == null || input.delivery_fee_fcfa === '' ? null : int(input.delivery_fee_fcfa);
  if (override != null && override < 0) return { error: 'invalid_amount' };
  if (override == null && !q.ok) return { error: q.error };
  const insurance = insuranceFee(cfg, declared);
  if (insurance == null) return { error: 'value_too_high' };
  const fee = override ?? q.price_fcfa;
  const vendor = vendorOnly(ctx) ? { id: ctx.user.id, name: ctx.user.name } : { id: null, name: text(input.vendor_name, 80) };
  const hub = pricing.hubs.find((h) => h.id === zone.hub_id) ?? pricing.hubs[0] ?? null;
  return {
    id: uuid(), token: randomToken(18), ref: text(input.external_ref, 80), source, method, name, phone, key,
    email: text(c.email, 120), address: text(c.address, 200), landmark: text(c.landmark, 200), lat, lng,
    zone: zone.name, vendor, hub: hub?.id ?? null, service, weight, subtotal, discount, fee, declared: declared > 0 ? declared : null,
    insurance, total: subtotal - discount + fee + insurance, promised: q.ok ? q.promised_at : null, note: text(input.note, 500), items,
  };
}

function orderStatements(ctx, o) {
  const db = ctx.db; const cid = ctx.company.id; const now = ctx.now; const paid = o.method === 'prepaid';
  return [
    db.prepare("INSERT INTO counters (company_id, key, n) VALUES (?, 'commande', 1) ON CONFLICT (company_id, key) DO UPDATE SET n = n + 1").bind(cid),
    db.prepare(
      `INSERT INTO customers (id, company_id, name, phone, phone_key, address, landmark, lat, lng, zone, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (company_id, phone_key) DO UPDATE SET name = excluded.name, phone = excluded.phone,
         address = coalesce(excluded.address, customers.address), landmark = coalesce(excluded.landmark, customers.landmark),
         lat = coalesce(excluded.lat, customers.lat), lng = coalesce(excluded.lng, customers.lng), zone = excluded.zone, updated_at = excluded.updated_at`,
    ).bind(uuid(), cid, o.name, o.phone, o.key, o.address, o.landmark, o.lat, o.lng, o.zone, now, now),
    // numéro sans trou : lu dans le compteur incrémenté par l'instruction précédente du MÊME lot (atomique)
    db.prepare(
      `INSERT INTO orders (id, company_id, number, external_ref, source, payment_method, payment_status, paid_at, customer_id,
         buyer_name, buyer_phone, buyer_email, buyer_address, landmark, delivery_lat, delivery_lng, delivery_zone, vendor_id, vendor_name,
         hub_id, service, weight_g, subtotal_fcfa, discount_fcfa, delivery_fee_fcfa, insured_value_fcfa, insurance_fee_fcfa, total_fcfa,
         promised_at, tracking_token, note, created_by, created_at, updated_at)
       VALUES (?, ?, (SELECT n FROM counters WHERE company_id = ? AND key = 'commande'), ?, ?, ?, ?, ?,
         (SELECT id FROM customers WHERE company_id = ? AND phone_key = ?),
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING number`,
    ).bind(o.id, cid, cid, o.ref, o.source, o.method, paid ? 'paid' : 'pending', paid ? now : null, cid, o.key,
      o.name, o.phone, o.email, o.address, o.landmark, o.lat, o.lng, o.zone, o.vendor.id, o.vendor.name,
      o.hub, o.service, o.weight, o.subtotal, o.discount, o.fee, o.declared, o.insurance, o.total,
      o.promised, o.token, o.note, ctx.user?.id ?? null, now, now),
    ...o.items.map((x) => db.prepare('INSERT INTO order_items (id, company_id, order_id, product_id, product_name, quantity, unit_price_fcfa, weight_g) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(x.id, cid, o.id, x.product_id, x.name, x.qty, x.price, x.weight)),
    // payée d'avance : la préparation s'ouvre tout de suite
    ...(paid ? releaseStatements(ctx, { id: o.id, promised_at: o.promised, created_at: now }) : []),
  ];
}

/**
 * Crée jusqu'à IMPORT_MAX commandes en un seul lot atomique (lectures groupées, un seul env.DB.batch).
 * Renvoie une ligne par entrée : { line, ok:true, id, number… } | { line, ok:false, error } | { line, ok:true, duplicate:true… }.
 */
export async function createOrders(ctx, inputs, source) {
  if (!Array.isArray(inputs) || !inputs.length) fail('no_orders');
  if (inputs.length > IMPORT_MAX) fail('too_many_orders');
  const [pricing, look] = await Promise.all([loadPricing(ctx.db, ctx.company.id), lookups(ctx.db, ctx.company.id, inputs)]);
  const results = []; const built = []; const stmts = []; const seen = new Set();
  inputs.forEach((input, i) => {
    const line = i + 1;
    const ref = text(input?.external_ref, 80);
    const prev = ref && look.refs.get(ref);
    if (prev) { results.push({ line, ok: true, duplicate: true, id: prev.id, number: prev.number, external_ref: ref }); return; }
    if (ref && seen.has(ref)) { results.push({ line, ok: false, error: 'duplicate_ref', external_ref: ref }); return; }
    const o = buildOrder(ctx, pricing, look, input ?? {}, source);
    if (o.error) { results.push({ line, ok: false, error: o.error, external_ref: ref }); return; }
    if (ref) seen.add(ref);
    const s = orderStatements(ctx, o);
    built.push({ o, line, at: stmts.length + 2 });
    stmts.push(...s);
    results.push(null);
  });
  if (stmts.length) {
    await checkQuota(ctx, 'orders_month', built.length);
    let res;
    try { res = await ctx.db.batch(stmts); } catch (e) {
      if (/UNIQUE/i.test(String(e?.message))) fail('duplicate_ref', 409); // envoi simultané de la même référence
      throw e;
    }
    for (const b of built) {
      const o = b.o;
      results[results.indexOf(null)] = {
        line: b.line, ok: true, id: o.id, number: res[b.at].results[0]?.number ?? null, short: orderShort(o.id), external_ref: o.ref,
        zone: o.zone, delivery_fee_fcfa: o.fee, insurance_fee_fcfa: o.insurance, total_fcfa: o.total,
        amount_due_fcfa: amountDue({ payment_method: o.method, payment_status: o.method === 'prepaid' ? 'paid' : 'pending', total_fcfa: o.total }),
        promised_at: o.promised, tracking_token: o.token, tracking_url: trackingUrl(ctx, o.token),
      };
    }
    // message au client : demande de confirmation (paiement à la livraison) ou commande confirmée (payée d'avance)
    await sendLater(ctx, await Promise.all(built.map((b) => notifyOrder(ctx, b.o.method === 'cod' ? 'lg_cod_confirm' : 'lg_order_confirmed', {
      id: b.o.id, number: res[b.at].results[0]?.number, buyer_name: b.o.name, buyer_phone: b.o.phone, buyer_email: b.o.email, vendor_name: b.o.vendor.name,
      payment_method: b.o.method, payment_status: b.o.method === 'prepaid' ? 'paid' : 'pending', total_fcfa: b.o.total, tracking_token: b.o.token,
    }))));
  }
  return results;
}

// ----------------------------------------------------------------- confirmation, annulation (partagées avec la page de suivi)
/** Confirmation du paiement à la livraison (lg_confirm_cod_internal). Refus = { ok:false, error }. */
export async function confirmCod(ctx, companyId, orderId, via) {
  const o = await ctx.db.prepare(
    `SELECT o.payment_method, o.status, o.cod_confirmed_at, o.promised_at, o.created_at,
            EXISTS (SELECT 1 FROM banned_numbers b JOIN customers c ON c.id = o.customer_id AND c.company_id = o.company_id
                     WHERE b.company_id = o.company_id AND b.phone_key = c.phone_key) AS banned
       FROM orders o WHERE o.id = ? AND o.company_id = ?`,
  ).bind(orderId, companyId).first();
  if (!o) return { ok: false, error: 'unknown_order' };
  if (o.payment_method !== 'cod') return { ok: false, error: 'not_cod' };
  if (o.status === 'cancelled') return { ok: false, error: 'order_cancelled' };
  if (o.banned) {
    await audit(ctx, 'cod_confirm_refused_banned', 'order', orderId, { via });
    return { ok: false, error: 'banned_number' };
  }
  // confirmation + ouverture de la préparation dans le même lot (sans effet si elle est déjà ouverte)
  // page de suivi publique : pas d'entreprise active, c'est celle de la commande
  const c = ctx.company?.id === companyId ? ctx : { ...ctx, company: { ...(ctx.company ?? {}), id: companyId } };
  await ctx.db.batch([
    ctx.db.prepare('UPDATE orders SET cod_confirmed_at = ?, cod_confirmed_via = ?, updated_at = ? WHERE id = ? AND company_id = ? AND cod_confirmed_at IS NULL')
      .bind(ctx.now, via, ctx.now, orderId, companyId),
    ...releaseStatements(c, { id: orderId, promised_at: o.promised_at, created_at: o.created_at }),
  ]);
  if (!o.cod_confirmed_at) {
    const row = await ctx.db.prepare('SELECT * FROM orders WHERE id = ? AND company_id = ?').bind(orderId, companyId).first();
    const tc = c.company.name ? c : { ...c, company: { ...c.company, ...(await ctx.db.prepare('SELECT id, name FROM companies WHERE id = ?').bind(companyId).first()), config: c.company.config ?? {} } };
    await sendLater(tc, [await notifyOrder(tc, 'lg_order_confirmed', row), webhookStatement(tc, orderId, 'order.confirmed', { via })]);
  }
  return { ok: true, confirmed: true };
}

/** Annulation tant que rien n'est parti (lg_cancel_unconfirmed) : transition conditionnelle, pas de verrou. */
export async function cancelOrder(ctx, companyId, orderId, reason) {
  const [r] = await ctx.db.batch([
    ctx.db.prepare(
      `UPDATE orders SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?, updated_at = ?
        WHERE id = ? AND company_id = ? AND status IN ('pending', 'processing') AND NOT ${SHIPPED_SQL}`,
    ).bind(ctx.now, text(reason, 200), ctx.now, orderId, companyId),
    // la préparation et les colis pas encore partis suivent (même lot)
    ctx.db.prepare("UPDATE pick_tasks SET status = 'cancelled' WHERE order_id = ? AND company_id = ? AND status <> 'cancelled' AND (SELECT status FROM orders WHERE id = ?) = 'cancelled'")
      .bind(orderId, companyId, orderId),
    ctx.db.prepare(
      `UPDATE packages SET status = 'cancelled', updated_at = ? WHERE order_id = ? AND company_id = ? AND status IN ('created', 'packed', 'staged')
          AND (SELECT status FROM orders WHERE id = ?) = 'cancelled'`,
    ).bind(ctx.now, orderId, companyId, orderId),
  ]);
  if (r.meta.changes) {
    const c = ctx.company?.id === companyId ? ctx : { ...ctx, company: { ...(ctx.company ?? {}), id: companyId } };
    await sendLater(c, [webhookStatement(c, orderId, 'order.cancelled', { reason: text(reason, 200) })]);
    return { ok: true };
  }
  const o = await ctx.db.prepare('SELECT status FROM orders WHERE id = ? AND company_id = ?').bind(orderId, companyId).first();
  if (!o) return { ok: false, error: 'unknown_order' };
  if (o.status === 'cancelled') return { ok: true, already: true };
  return { ok: false, error: 'already_shipped' };
}

const orderRow = (ctx, o) => ({
  id: o.id, number: o.number, short: orderShort(o.id), order_short: orderShort(o.id), external_ref: o.external_ref, source: o.source,
  status: o.status, customer: o.buyer_name, phone: o.buyer_phone, address: o.buyer_address, landmark: o.landmark, zone: o.delivery_zone,
  vendor: o.vendor_name, service: o.service, payment_method: o.payment_method, paid: o.payment_status === 'paid',
  cod_confirmed_at: o.cod_confirmed_at, subtotal_fcfa: o.subtotal_fcfa, delivery_fee_fcfa: o.delivery_fee_fcfa,
  insurance_fee_fcfa: o.insurance_fee_fcfa, insured_value_fcfa: o.insured_value_fcfa, total_fcfa: o.total_fcfa, amount_due_fcfa: amountDue(o),
  promised_at: o.promised_at, created_at: o.created_at, cancel_reason: o.cancel_reason, has_position: o.delivery_lat != null,
  tracking_url: trackingUrl(ctx, o.tracking_token),
});

async function productFor(ctx, id) {
  const p = await ctx.db.prepare('SELECT * FROM products WHERE id = ? AND company_id = ?').bind(String(id ?? ''), ctx.company.id).first();
  if (!p) fail('unknown_product', 404);
  return p;
}
const productOut = (p) => ({
  id: p.id, name: p.name, sku: p.sku, barcode: p.barcode, price_fcfa: p.price_fcfa, stock: p.stock, weight_g: p.weight_g,
  length_cm: p.length_cm, width_cm: p.width_cm, height_cm: p.height_cm, handling: parseJson(p.handling, []),
  is_shippable: Boolean(p.is_shippable), active: Boolean(p.active), vendor: p.vendor_name, vendor_id: p.vendor_id,
  internal_code: 'NXI-' + orderShort(p.id), min_stock: p.min_stock ?? null, cost_fcfa: p.cost_fcfa ?? null, supplier: p.supplier ?? null,
});
const handlingOf = (v) => (Array.isArray(v) ? JSON.stringify([...new Set(v.filter((h) => HANDLING.includes(h)))]) : null);
const dim = (v) => { const n = num(v); if (n != null && (n <= 0 || n > 1000)) fail('invalid_amount'); return n; };

export default {
  // ----------------------------------------------------------------- commandes
  // Saisie d'une commande (service client, répartiteur ; un vendeur pour lui-même). Rejouable (p_event).
  lg_order_create: {
    roles: 'member',
    async handler(ctx, a) {
      if (!isOps(ctx) && !vendorOnly(ctx)) fail('forbidden', 403);
      return idempotent(ctx, 'lg_order_create', a.p_event, async () => {
        const [r] = await createOrders(ctx, [{
          customer: a.p_customer, zone: a.p_zone, items: a.p_items, payment_method: a.p_payment_method, service: a.p_service,
          delivery_fee_fcfa: a.p_delivery_fee_fcfa, declared_value_fcfa: a.p_declared_value_fcfa, discount_fcfa: a.p_discount_fcfa,
          weight_g: a.p_weight_g, external_ref: a.p_external_ref, note: a.p_note, vendor_name: a.p_vendor_name,
        }], 'manual');
        if (!r.ok) fail(r.error);
        if (!r.duplicate) await audit(ctx, 'order_create', 'order', r.id, { number: r.number, total: r.total_fcfa });
        return r;
      });
    },
  },

  // Import par fichier (gabarit CSV lu par l'écran, envoyé par paquets de IMPORT_MAX lignes).
  lg_order_import: {
    roles: ['support', 'dispatcher'],
    async handler(ctx, a) {
      const results = await createOrders(ctx, a.p_orders, 'csv');
      const created = results.filter((r) => r.ok && !r.duplicate).length;
      await audit(ctx, 'order_import', 'order', null, { created, rows: results.length });
      return { ok: true, created, duplicates: results.filter((r) => r.duplicate).length, errors: results.filter((r) => !r.ok), results };
    },
  },

  lg_orders_list: {
    roles: 'member',
    async handler(ctx, a) {
      if (!isOps(ctx) && !vendorOnly(ctx) && !hasRole(ctx, ['dock_chief'])) fail('forbidden', 403);
      const st = a.p_status ?? 'open';
      const q = text(a.p_q, 60);
      const limit = Math.min(Math.max(int(a.p_limit) ?? 100, 1), 200);
      const r = await ctx.db.prepare(
        `SELECT * FROM orders WHERE company_id = ?
           AND (? = 'all' OR (? = 'open' AND status IN ('pending', 'processing', 'in_transit')) OR status = ?)
           AND (? IS NULL OR vendor_id = ?)
           AND (? IS NULL OR buyer_name LIKE ? OR buyer_phone LIKE ? OR external_ref = ? OR CAST(number AS TEXT) = ? OR upper(substr(id, 1, 8)) = upper(?))
         ORDER BY created_at DESC LIMIT ?`,
      ).bind(ctx.company.id, st, st, st, vendorOnly(ctx) ? ctx.user.id : null, vendorOnly(ctx) ? ctx.user.id : null,
        q, q && like(q), q && like(q), q, q, q, limit).all();
      return r.results.map((o) => orderRow(ctx, o));
    },
  },

  lg_order_detail: {
    roles: 'member',
    async handler(ctx, a) {
      if (!isOps(ctx) && !vendorOnly(ctx) && !hasRole(ctx, ['dock_chief'])) fail('forbidden', 403);
      const o = await ctx.db.prepare('SELECT * FROM orders WHERE id = ? AND company_id = ? AND (? IS NULL OR vendor_id = ?)')
        .bind(String(a.p_order ?? ''), ctx.company.id, vendorOnly(ctx) ? ctx.user.id : null, vendorOnly(ctx) ? ctx.user.id : null).first();
      if (!o) fail('unknown_order', 404);
      const [items, reqs] = await ctx.db.batch([
        ctx.db.prepare('SELECT id, product_id, product_name, quantity, unit_price_fcfa, weight_g, line_status FROM order_items WHERE order_id = ? AND company_id = ?').bind(o.id, ctx.company.id),
        ctx.db.prepare('SELECT id, kind, payload, channel, status, created_at FROM customer_requests WHERE order_id = ? AND company_id = ? ORDER BY created_at DESC').bind(o.id, ctx.company.id),
      ]);
      return { ...orderRow(ctx, o), email: o.buyer_email, note: o.note, recipient_name: o.recipient_name, recipient_phone: o.recipient_phone,
        discount_fcfa: o.discount_fcfa, weight_g: o.weight_g, items: items.results,
        requests: reqs.results.map((r) => ({ ...r, payload: parseJson(r.payload, {}) })) };
    },
  },

  // Paiement à la livraison sans réponse au message : à appeler avant toute préparation.
  lg_cod_pending: {
    roles: ['support', 'dispatcher'],
    async handler(ctx) {
      const r = await ctx.db.prepare(
        `SELECT o.*, (SELECT COUNT(*) FROM orders o2 WHERE o2.company_id = o.company_id AND o2.customer_id = o.customer_id
                         AND o2.id <> o.id AND o2.status = 'delivered') AS previous_orders
           FROM orders o WHERE o.company_id = ? AND o.payment_method = 'cod' AND o.cod_confirmed_at IS NULL
            AND o.status IN ('pending', 'processing') AND o.payment_status <> 'paid'
          ORDER BY o.created_at LIMIT 200`,
      ).bind(ctx.company.id).all();
      return r.results.map((o) => ({
        order_id: o.id, order_short: orderShort(o.id), number: o.number, customer: o.buyer_name, phone: o.buyer_phone, zone: o.delivery_zone,
        amount_fcfa: amountDue(o), created_at: o.created_at, tracking_url: trackingUrl(ctx, o.tracking_token),
        hours_waiting: Math.round((Date.parse(ctx.now) - Date.parse(o.created_at)) / 360000) / 10,
        previous_orders: o.previous_orders, previous_refusals: 0, // refus à la porte : comptés à partir du cycle C5
      }));
    },
  },

  lg_confirm_cod: {
    roles: ['support', 'dispatcher'],
    async handler(ctx, a) {
      const via = ['appel', 'whatsapp', 'support'].includes(a.p_via) ? a.p_via : 'appel';
      const r = await confirmCod(ctx, ctx.company.id, String(a.p_order ?? ''), via);
      if (r.ok) await audit(ctx, 'cod_confirm', 'order', a.p_order, { via });
      return r;
    },
  },

  lg_cancel_unconfirmed: {
    roles: ['support', 'dispatcher'],
    async handler(ctx, a) {
      const r = await cancelOrder(ctx, ctx.company.id, String(a.p_order ?? ''), a.p_reason ?? 'Non confirmée par le client');
      if (r.ok && !r.already) await audit(ctx, 'order_cancel', 'order', a.p_order, { reason: a.p_reason ?? null });
      return r;
    },
  },

  // Assurer une commande déjà passée (commande par téléphone), tant que rien n'est chargé.
  lg_order_insure: {
    roles: ['support', 'dispatcher'],
    async handler(ctx, a) {
      const value = int(a.p_value) ?? 0;
      if (value < 0) fail('invalid_amount');
      const fee = insuranceFee(ctx.company.config, value);
      if (fee == null) return { ok: false, error: 'value_too_high' };
      const r = await ctx.db.prepare(
        `UPDATE orders SET insured_value_fcfa = ?, total_fcfa = total_fcfa - insurance_fee_fcfa + ?, insurance_fee_fcfa = ?, updated_at = ?
          WHERE id = ? AND company_id = ? AND status IN ('pending', 'processing') AND NOT ${SHIPPED_SQL}`,
      ).bind(value > 0 ? value : null, fee, fee, ctx.now, String(a.p_order ?? ''), ctx.company.id).run();
      if (!r.meta.changes) {
        const o = await ctx.db.prepare('SELECT status FROM orders WHERE id = ? AND company_id = ?').bind(String(a.p_order ?? ''), ctx.company.id).first();
        if (!o) fail('unknown_order', 404);
        return { ok: false, error: 'already_loaded' };
      }
      await audit(ctx, 'order_insure', 'order', a.p_order, { value, fee });
      return { ok: true, insured_value_fcfa: value > 0 ? value : null, insurance_fee_fcfa: fee };
    },
  },

  // Numéros bannis (refus répétés, fraude) : toute nouvelle commande ou confirmation est refusée.
  lg_ban_number: {
    roles: ['support'],
    async handler(ctx, a) {
      const key = phoneKey(a.p_phone);
      if (!key) fail('invalid_phone');
      if (a.p_banned === false) {
        await ctx.db.prepare('DELETE FROM banned_numbers WHERE company_id = ? AND phone_key = ?').bind(ctx.company.id, key).run();
      } else {
        await ctx.db.prepare('INSERT OR REPLACE INTO banned_numbers (company_id, phone_key, phone, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(ctx.company.id, key, text(a.p_phone, 30), text(a.p_reason, 200), ctx.user.id, ctx.now).run();
      }
      await audit(ctx, a.p_banned === false ? 'unban_number' : 'ban_number', 'phone', key, { reason: a.p_reason ?? null });
      return { ok: true, banned: a.p_banned !== false };
    },
  },

  // ----------------------------------------------------------------- demandes des clients
  lg_requests_list: {
    roles: ['support', 'dispatcher'],
    async handler(ctx, a) {
      const r = await ctx.db.prepare(
        `SELECT r.*, o.buyer_name, o.buyer_phone, o.status AS order_status, o.delivery_zone, o.tracking_token
           FROM customer_requests r JOIN orders o ON o.id = r.order_id AND o.company_id = r.company_id
          WHERE r.company_id = ? AND (? IS NULL OR r.status = ?) ORDER BY r.created_at LIMIT 300`,
      ).bind(ctx.company.id, a.p_status ?? null, a.p_status ?? null).all();
      return r.results.map((x) => ({
        id: x.id, kind: x.kind, payload: parseJson(x.payload, {}), channel: x.channel, status: x.status, created_at: x.created_at,
        order_id: x.order_id, order_short: orderShort(x.order_id), customer: x.buyer_name, phone: x.buyer_phone,
        order_status: x.order_status, zone: x.delivery_zone, tracking_url: trackingUrl(ctx, x.tracking_token),
      }));
    },
  },

  lg_request_done: {
    roles: ['support', 'dispatcher'],
    async handler(ctx, a) {
      const r = await ctx.db.prepare(
        "UPDATE customer_requests SET status = 'done', handled_by = ?, handled_at = ?, payload = json_set(payload, '$.note', ?) WHERE id = ? AND company_id = ? AND status = 'open'",
      ).bind(ctx.user.id, ctx.now, text(a.p_note, 300), String(a.p_id ?? ''), ctx.company.id).run();
      return { ok: r.meta.changes > 0 };
    },
  },

  // ----------------------------------------------------------------- catalogue logistique
  lg_products_list: {
    roles: 'member',
    async handler(ctx, a) {
      if (!vendorOnly(ctx) && !hasRole(ctx, ['support', 'dispatcher', 'picker', 'dock_chief'])) fail('forbidden', 403);
      const q = text(a.p_q, 60);
      const own = vendorOnly(ctx) ? ctx.user.id : null;
      const r = await ctx.db.prepare(
        `SELECT * FROM products WHERE company_id = ? AND (? IS NULL OR vendor_id = ?) AND (? = 1 OR active = 1)
           AND (? IS NULL OR name LIKE ? OR sku = ? OR barcode = ?) ORDER BY name LIMIT 300`,
      ).bind(ctx.company.id, own, own, a.p_all ? 1 : 0, q, q && like(q), q, q).all();
      return r.results.map(productOut);
    },
  },

  // Fiche produit. Le stock n'est saisi qu'à la CRÉATION (stock de départ, tracé « initial ») ; ensuite il ne bouge
  // que par des mouvements (réception, préparation, correction motivée, inventaire…), cf. server/rpc/produits.js.
  lg_product_upsert: {
    roles: 'member',
    async handler(ctx, a) {
      const staff = hasRole(ctx, ['support', 'dispatcher', 'dock_chief', 'picker']);
      if (!staff && !vendorOnly(ctx)) fail('forbidden', 403);
      const p = a.p && typeof a.p === 'object' ? a.p : {};
      const name = text(p.name, 120);
      if (!name) fail('invalid_name');
      const price = int(p.price_fcfa) ?? 0; const w = p.weight_g == null || p.weight_g === '' ? null : int(p.weight_g);
      const opt = (v) => (v == null || v === '' ? null : int(v));
      const minStock = opt(p.min_stock); const cost = opt(p.cost_fcfa);
      if (price < 0 || (w != null && w <= 0) || (minStock != null && minStock < 0) || (cost != null && cost < 0)) fail('invalid_amount');
      const vals = [name, text(p.sku, 64), text(p.barcode, 64), price, w, dim(p.length_cm), dim(p.width_cm), dim(p.height_cm),
        handlingOf(p.handling) ?? '[]', p.is_shippable === false ? 0 : 1, p.active === false ? 0 : 1, minStock, cost, text(p.supplier, 80)];
      // même code-barres ou même référence qu'un autre produit de l'entreprise : refusé (le scan doit être sans ambiguïté)
      const code = (v) => (v == null ? null : String(v).trim().toUpperCase());
      const dup = await ctx.db.prepare(`SELECT name FROM products WHERE company_id = ? AND id != ? AND
          ((? IS NOT NULL AND upper(barcode) = ?) OR (? IS NOT NULL AND upper(sku) = ?)) LIMIT 1`)
        .bind(ctx.company.id, String(p.id ?? ''), code(vals[2]), code(vals[2]), code(vals[1]), code(vals[1])).first();
      if (dup) return { ok: false, error: 'duplicate_code', product: dup.name };
      if (p.id) {
        const own = vendorOnly(ctx) ? ctx.user.id : null;
        const r = await ctx.db.prepare(
          `UPDATE products SET name = ?, sku = ?, barcode = ?, price_fcfa = ?, weight_g = ?, length_cm = ?, width_cm = ?, height_cm = ?,
             handling = ?, is_shippable = ?, active = ?, min_stock = ?, cost_fcfa = ?, supplier = ?, vendor_name = coalesce(?, vendor_name), updated_at = ?
           WHERE id = ? AND company_id = ? AND (? IS NULL OR vendor_id = ?)`,
        ).bind(...vals, staff ? text(p.vendor_name, 80) : null, ctx.now, String(p.id), ctx.company.id, own, own).run();
        if (!r.meta.changes) fail('unknown_product', 404);
        await audit(ctx, 'product_update', 'product', p.id, { name });
        return { ok: true, id: p.id };
      }
      const id = uuid();
      const initial = p.stock == null || p.stock === '' ? null : int(p.stock);
      if (initial != null && initial < 0) fail('invalid_quantity');
      await ctx.db.batch([
        ctx.db.prepare(
          `INSERT INTO products (name, sku, barcode, price_fcfa, weight_g, length_cm, width_cm, height_cm, handling, is_shippable, active, min_stock, cost_fcfa, supplier,
             id, company_id, vendor_id, vendor_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(...vals, id, ctx.company.id, vendorOnly(ctx) ? ctx.user.id : null, vendorOnly(ctx) ? ctx.user.name : text(p.vendor_name, 80)),
        ...(initial != null ? stockMoveStatements(ctx, { product: id, delta: initial, kind: 'initial', reason: 'stock de départ' }) : []),
      ]);
      await audit(ctx, 'product_create', 'product', id, { name, stock: initial });
      return { ok: true, id };
    },
  },

  // Fiche logistique : code, poids, taille, manutention (import par fichier côté écran → appels successifs).
  lg_product_logistics: {
    roles: 'member',
    async handler(ctx, a) {
      const pr = await productFor(ctx, a.p_product);
      if (pr.vendor_id !== ctx.user.id && !hasRole(ctx, ['picker', 'dock_chief'])) fail('forbidden', 403);
      const w = a.p_weight_g == null ? null : int(a.p_weight_g);
      if (w != null && w <= 0) fail('invalid_amount');
      await ctx.db.prepare(
        `UPDATE products SET barcode = coalesce(?, barcode), sku = coalesce(?, sku), weight_g = coalesce(?, weight_g),
           length_cm = coalesce(?, length_cm), width_cm = coalesce(?, width_cm), height_cm = coalesce(?, height_cm),
           handling = coalesce(?, handling), is_shippable = coalesce(?, is_shippable), updated_at = ?
         WHERE id = ? AND company_id = ?`,
      ).bind(text(a.p_barcode, 64), text(a.p_sku, 64), w, dim(a.p_length_cm), dim(a.p_width_cm), dim(a.p_height_cm),
        handlingOf(a.p_handling), a.p_is_shippable == null ? null : a.p_is_shippable ? 1 : 0, ctx.now, pr.id, ctx.company.id).run();
      return { ok: true };
    },
  },

  lg_products_to_complete: {
    roles: 'member',
    async handler(ctx, a) {
      const staff = hasRole(ctx, ['picker', 'dock_chief']);
      if (!staff && ctx.member !== 'vendor') fail('forbidden', 403);
      // un vendeur voit ses fiches ; l'équipe voit celles d'un vendeur, ou tout le catalogue
      const v = staff ? a.p_vendor ?? null : ctx.user.id;
      const r = await ctx.db.prepare(
        'SELECT * FROM products WHERE company_id = ? AND (? IS NULL OR vendor_id = ?) AND is_shippable = 1 AND active = 1 ORDER BY name LIMIT 500',
      ).bind(ctx.company.id, v, v).all();
      return r.results.map(productOut);
    },
  },

  // Espace vendeur : suivre ses colis sans appeler, ses délais de préparation et ses ruptures (lg_vendor_overview).
  lg_vendor_overview: {
    roles: 'member',
    async handler(ctx) {
      if (ctx.member !== 'vendor' && !ctx.isAdmin) fail('forbidden', 403);
      const v = ctx.isAdmin ? null : ctx.user.id;   // l'administrateur voit toute l'entreprise
      const since = new Date(Date.parse(ctx.now) - 30 * 86400000).toISOString();
      const [k, pk] = await ctx.db.batch([
        ctx.db.prepare(
          `SELECT (SELECT COUNT(*) FROM pick_tasks WHERE company_id = ?1 AND (?2 IS NULL OR vendor_id = ?2) AND status IN ('todo', 'picking')) AS to_prepare,
                  (SELECT COUNT(*) FROM packages p JOIN orders o ON o.id = p.order_id WHERE p.company_id = ?1 AND (?2 IS NULL OR o.vendor_id = ?2)
                      AND p.status IN ('staged', 'loaded', 'out_for_delivery')) AS in_transit,
                  (SELECT COUNT(*) FROM packages p JOIN orders o ON o.id = p.order_id WHERE p.company_id = ?1 AND (?2 IS NULL OR o.vendor_id = ?2)
                      AND p.status IN ('failed', 'returned_hub')) AS returns,
                  (SELECT round(avg((julianday(done_at) - julianday(created_at)) * 24), 1) FROM pick_tasks
                    WHERE company_id = ?1 AND (?2 IS NULL OR vendor_id = ?2) AND done_at > ?3) AS avg_prep_hours_30d,
                  (SELECT round(100.0 * sum(l.status = 'short') / nullif(count(*), 0), 1) FROM pick_lines l JOIN pick_tasks t ON t.id = l.task_id
                    WHERE t.company_id = ?1 AND (?2 IS NULL OR t.vendor_id = ?2) AND t.done_at > ?3) AS stockout_pct_30d,
                  (SELECT COUNT(*) FROM products WHERE company_id = ?1 AND (?2 IS NULL OR vendor_id = ?2) AND is_shippable = 1 AND active = 1
                      AND (weight_g IS NULL OR (barcode IS NULL AND sku IS NULL))) AS products_missing_data`,
        ).bind(ctx.company.id, v, since),
        ctx.db.prepare(
          `SELECT p.code, p.status, o.number, p.zone, p.updated_at, p.attempts FROM packages p JOIN orders o ON o.id = p.order_id
            WHERE p.company_id = ? AND (? IS NULL OR o.vendor_id = ?) AND p.updated_at > ? ORDER BY p.updated_at DESC LIMIT 200`,
        ).bind(ctx.company.id, v, v, since),
      ]);
      return { ...k.results[0], packages: pk.results.map(({ number, ...p }) => ({ ...p, order_short: String(number) })) };
    },
  },

  // ----------------------------------------------------------------- clés d'API (boutiques en ligne)
  lg_api_key_create: {
    roles: 'admin',
    async handler(ctx, a) {
      const name = text(a.p_name, 60) ?? 'Boutique en ligne';
      const n = await ctx.db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE company_id = ? AND revoked_at IS NULL').bind(ctx.company.id).first('n');
      if (n >= 10) fail('too_many_keys');
      const key = 'nxl_' + randomToken(24);
      const id = uuid();
      await ctx.db.prepare('INSERT INTO api_keys (id, company_id, name, prefix, key_hash, created_by) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, ctx.company.id, name, key.slice(0, 10), await sha256Hex(key), ctx.user.id).run();
      await audit(ctx, 'api_key_create', 'api_key', id, { name });
      // la clé n'est montrée qu'une fois : seule son empreinte est gardée
      return { ok: true, id, name, key, prefix: key.slice(0, 10), endpoint: new URL(ctx.request.url).origin + '/api/v1/orders' };
    },
  },

  lg_api_keys_list: {
    roles: 'admin',
    async handler(ctx) {
      return (await ctx.db.prepare('SELECT id, name, prefix, created_at, last_used_at, revoked_at FROM api_keys WHERE company_id = ? ORDER BY created_at DESC')
        .bind(ctx.company.id).all()).results;
    },
  },

  lg_api_key_revoke: {
    roles: 'admin',
    async handler(ctx, a) {
      const r = await ctx.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND company_id = ? AND revoked_at IS NULL')
        .bind(ctx.now, String(a.p_id ?? ''), ctx.company.id).run();
      if (!r.meta.changes) fail('unknown_key', 404);
      await audit(ctx, 'api_key_revoke', 'api_key', a.p_id);
      return { ok: true };
    },
  },
};
