// Stock par emplacement et lots datés (FEFO) : lecture groupée et calcul des mouvements en JavaScript.
// Remplace les déclencheurs Postgres lg_trg_pick_location / lg_trg_location_lots_clamp (cycle 6) :
// les fonctions renvoient des instructions à mettre dans le MÊME lot que l'écriture qui les cause.
import { chunks } from '../http.js';

/** Clé de tri naturel d'un code d'emplacement (A-2 avant A-10), équivalent de lg_loc_key. */
export const locKey = (code) => (code == null ? 'ZZZZZZ' : String(code).match(/\d+|[^\d-]+/g)?.map((m) => (/^\d+$/.test(m) ? m.padStart(6, '0') : m)).join('-') ?? 'ZZZZZZ');

export function lotState(expires, today, alertDays) {
  if (!expires) return 'ok';
  if (expires < today) return 'expired';
  const limit = new Date(Date.parse(today + 'T00:00:00Z') + alertDays * 86400000).toISOString().slice(0, 10);
  return expires <= limit ? 'soon' : 'ok';
}

/**
 * Stock des produits demandés : { produit → [{ id, code, hub_id, active, qty, lots:[…] }] } (2 requêtes groupées).
 * Lots : seulement ceux qui ont encore des unités.
 */
export async function loadStock(ctx, productIds) {
  const ids = [...new Set(productIds.filter(Boolean))];
  const out = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return out;
  const stmts = [];
  for (const c of chunks(ids, 90)) {
    const marks = c.map(() => '?').join(',');
    stmts.push(ctx.db.prepare(
      `SELECT pl.product_id, pl.qty, l.id, l.code, l.hub_id, l.active FROM product_locations pl JOIN stock_locations l ON l.id = pl.location_id
        WHERE pl.company_id = ? AND pl.product_id IN (${marks})`).bind(ctx.company.id, ...c));
    stmts.push(ctx.db.prepare(
      `SELECT id, product_id, location_id, lot_code, expires_on, qty, received_at FROM stock_lots
        WHERE company_id = ? AND qty > 0 AND product_id IN (${marks})`).bind(ctx.company.id, ...c));
  }
  const res = await ctx.db.batch(stmts);
  const lots = [];
  res.forEach((r, i) => {
    if (i % 2 === 0) r.results.forEach((x) => out.get(x.product_id)?.push({ id: x.id, product_id: x.product_id, code: x.code, hub_id: x.hub_id, active: Boolean(x.active), qty: x.qty, lots: [] }));
    else lots.push(...r.results);
  });
  for (const s of lots) out.get(s.product_id)?.find((l) => l.id === s.location_id)?.lots.push(s);
  return out;
}

const lotSum = (loc) => loc.lots.reduce((s, x) => s + x.qty, 0);
const sellable = (loc, today) => Math.max(loc.qty - loc.lots.filter((x) => x.expires_on && x.expires_on < today).reduce((s, x) => s + x.qty, 0), 0);
const nextValidExpiry = (loc, today) => loc.lots.filter((x) => x.expires_on && x.expires_on >= today).map((x) => x.expires_on).sort()[0] ?? null;

/** Emplacement où prélever (lg_pick_location_id) : du vendable, le lot valide qui périme le plus tôt, puis le plus garni. */
export function pickLocation(locs, hubId, today) {
  const cand = (locs ?? []).filter((l) => l.active && (!hubId || l.hub_id === hubId));
  cand.sort((a, b) => (b.qty > 0) - (a.qty > 0) || (sellable(b, today) > 0) - (sellable(a, today) > 0)
    || (nextValidExpiry(a, today) ?? '9999').localeCompare(nextValidExpiry(b, today) ?? '9999')
    || b.qty - a.qty || a.code.localeCompare(b.code));
  return cand[0] ?? null;
}

/** Le lot à prendre en premier dans un emplacement (lg_lot_hint). */
export function lotHint(loc, today, alertDays) {
  if (!loc) return null;
  const s = loc.lots.filter((x) => x.qty > 0 && (!x.expires_on || x.expires_on >= today))
    .sort((a, b) => (a.expires_on ?? '9999').localeCompare(b.expires_on ?? '9999') || a.received_at.localeCompare(b.received_at))[0];
  return s ? { lot: s.lot_code, expires_on: s.expires_on, state: lotState(s.expires_on, today, alertDays) } : null;
}

/**
 * Prélèvement de n unités (lg_trg_pick_location) : lots datés valides du plus proche de sa date, puis le stock non
 * loti ; un lot périmé n'est pris qu'en dernier recours (mouvement « expired_picked »). Met à jour `loc` en mémoire.
 */
export function consumeStatements(ctx, loc, n, pickLineId, today) {
  if (!loc || loc.qty <= 0 || n <= 0) return [];
  const db = ctx.db; const cid = ctx.company.id; const stmts = [];
  let need = n; let free = Math.max(loc.qty - lotSum(loc), 0);
  const order = [...loc.lots].filter((x) => x.qty > 0).sort((a, b) =>
    ((a.expires_on && a.expires_on < today) ? 1 : 0) - ((b.expires_on && b.expires_on < today) ? 1 : 0)
    || (a.expires_on ?? '9999').localeCompare(b.expires_on ?? '9999') || a.received_at.localeCompare(b.received_at));
  for (const s of order) {
    if (need <= 0) break;
    const expired = s.expires_on && s.expires_on < today;
    if (expired) { need -= Math.min(free, need); free = 0; if (need <= 0) break; }
    const take = Math.min(s.qty, need);
    s.qty -= take; need -= take;
    stmts.push(db.prepare('UPDATE stock_lots SET qty = max(qty - ?, 0), updated_at = ? WHERE id = ? AND company_id = ?').bind(take, ctx.now, s.id, cid));
    stmts.push(db.prepare('INSERT INTO lot_moves (company_id, lot_id, kind, qty, pick_line_id, reason, by_user) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(cid, s.id, 'pick', -take, pickLineId, expired ? 'expired_picked' : null, ctx.user?.id ?? null));
  }
  loc.qty = Math.max(loc.qty - n, 0);
  stmts.push(db.prepare('UPDATE product_locations SET qty = max(qty - ?, 0), updated_at = ? WHERE product_id = ? AND location_id = ? AND company_id = ?')
    .bind(n, ctx.now, loc.product_id, loc.id, cid));
  return stmts;
}

/**
 * Un emplacement qui baisse (inventaire, rebut) ne garde pas plus de lots que d'unités (lg_trg_location_lots_clamp) :
 * périmés d'abord, puis du plus ancien au plus récent.
 */
export function clampStatements(ctx, loc, newQty, today) {
  let over = lotSum(loc) - newQty; const stmts = [];
  if (over <= 0) return stmts;
  const order = [...loc.lots].filter((x) => x.qty > 0).sort((a, b) =>
    ((b.expires_on && b.expires_on < today) ? 1 : 0) - ((a.expires_on && a.expires_on < today) ? 1 : 0)
    || (a.expires_on ?? '9999').localeCompare(b.expires_on ?? '9999') || a.received_at.localeCompare(b.received_at));
  for (const s of order) {
    if (over <= 0) break;
    const take = Math.min(s.qty, over); s.qty -= take; over -= take;
    stmts.push(ctx.db.prepare('UPDATE stock_lots SET qty = max(qty - ?, 0), updated_at = ? WHERE id = ? AND company_id = ?').bind(take, ctx.now, s.id, ctx.company.id));
    stmts.push(ctx.db.prepare("INSERT INTO lot_moves (company_id, lot_id, kind, qty, reason, by_user) VALUES (?, ?, 'adjust', ?, 'inventory', ?)")
      .bind(ctx.company.id, s.id, -take, ctx.user?.id ?? null));
  }
  return stmts;
}


/**
 * Mouvement de stock d'un produit : met à jour products.stock (LE chiffre de stock) et écrit la ligne d'historique
 * (stock_moves), dans le MÊME lot que l'écriture qui le cause. `delta` signé. `track` : une entrée, une correction ou
 * un inventaire commence le suivi d'un produit jusque-là non suivi (stock NULL) ; une sortie ne le fait pas.
 * L'emplacement (product_locations) est tenu à part par l'appelant (rangement, prélèvement, inventaire).
 */
export function stockMoveStatements(ctx, { product, delta, kind, location = null, order = null, ref = null, reason = null, po = null }) {
  const track = ['in', 'initial', 'adjust', 'count'].includes(kind) ? 1 : 0;
  const db = ctx.db; const cid = ctx.company.id;
  return [
    db.prepare(`UPDATE products SET stock = CASE WHEN stock IS NULL AND ? = 0 THEN NULL ELSE max(coalesce(stock, 0) + ?, 0) END, updated_at = ?
      WHERE id = ? AND company_id = ?`).bind(track, delta, ctx.now, product, cid),
    db.prepare(`INSERT INTO stock_moves (company_id, product_id, location_id, kind, qty, stock_after, order_id, po_id, ref, reason, by_user, at)
      SELECT ?, id, ?, ?, ?, stock, ?, ?, ?, ?, ?, ? FROM products WHERE id = ? AND company_id = ?`)
      .bind(cid, location, kind, delta, order, po, ref, reason, ctx.user?.id ?? null, ctx.now, product, cid),
  ];
}
