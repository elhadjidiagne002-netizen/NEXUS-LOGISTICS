// Produits et stock (08/10/2026) : vue d'ensemble du stock (réservé, disponible, seuil d'alerte, emplacements),
// réception de marchandise, correction motivée, transfert entre emplacements, historique des mouvements,
// import d'un catalogue (fichier Excel / CSV converti par l'écran), « premiers pas » d'une entreprise.
// LE chiffre de stock est products.stock, tenu par stockMoveStatements (server/rpc/stock.js) dans chaque flux.
// Un vendeur (membre « vendor » sans rôle d'équipe) ne voit et ne gère que SES produits, sans emplacement d'entrepôt.
import { fail, audit, idempotent, hasRole, text, int, uuid } from './core.js';
import { stockMoveStatements, lotState } from './stock.js';
import { chunks } from '../http.js';

const VIEW = ['picker', 'dock_chief', 'support', 'dispatcher', 'accountant'];
const WRITE = ['picker', 'dock_chief'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const IMPORT_MAX = 200;
const vendorOnly = (ctx) => ctx.member === 'vendor' && !ctx.isAdmin && !ctx.roles.length;
const like = (q) => `%${String(q).replace(/[%_]/g, '')}%`;
const today = (ctx) => ctx.now.slice(0, 10);

function canView(ctx) { if (!hasRole(ctx, VIEW) && !vendorOnly(ctx)) fail('forbidden', 403); }
function canWrite(ctx) { if (!hasRole(ctx, WRITE) && !vendorOnly(ctx)) fail('forbidden', 403); }

/** Produit de l'entreprise (par id ou par code-barres / référence / code NXI) ; un vendeur n'atteint que les siens. */
async function productOf(ctx, { id, code }) {
  const own = vendorOnly(ctx) ? ctx.user.id : null;
  const c = String(code ?? '').trim().toUpperCase();
  const p = id
    ? await ctx.db.prepare('SELECT * FROM products WHERE id = ? AND company_id = ? AND (? IS NULL OR vendor_id = ?)').bind(String(id), ctx.company.id, own, own).first()
    : c ? await ctx.db.prepare(`SELECT * FROM products WHERE company_id = ? AND (? IS NULL OR vendor_id = ?)
          AND (upper(barcode) = ? OR upper(sku) = ? OR 'NXI-' || upper(substr(id, 1, 8)) = ?) LIMIT 1`).bind(ctx.company.id, own, own, c, c, c).first() : null;
  if (!p) fail('unknown_product', 404);
  return p;
}

async function locationOf(ctx, code) {
  const c = String(code ?? '').trim().toUpperCase();
  if (!c) return null;
  if (vendorOnly(ctx)) fail('forbidden', 403); // les emplacements d'entrepôt ne concernent pas les vendeurs
  const hub = ctx.roles.find((r) => r.hub_id)?.hub_id ?? null;
  const l = await ctx.db.prepare('SELECT * FROM stock_locations WHERE company_id = ? AND code = ? AND active = 1 ORDER BY (hub_id = ?) DESC LIMIT 1')
    .bind(ctx.company.id, c, hub).first();
  if (!l) fail('unknown_location', 404);
  return l;
}

export function stockState(p, available) {
  if (p.stock == null) return 'untracked';
  if (p.stock <= 0) return 'out';
  if (p.min_stock != null && available <= p.min_stock) return 'low';
  return 'ok';
}

export default {
  // Vue d'ensemble : stock, réservé (commandes pas encore préparées), disponible, seuil, emplacements, valeur.
  lg_stock_overview: {
    roles: 'member',
    async handler(ctx, a) {
      canView(ctx);
      const own = vendorOnly(ctx) ? ctx.user.id : null; const cid = ctx.company.id;
      const q = text(a.p_q, 60);
      const [prods, reserved, locs] = await ctx.db.batch([
        ctx.db.prepare(`SELECT * FROM products WHERE company_id = ? AND (? IS NULL OR vendor_id = ?) AND (? = 1 OR active = 1)
            AND (? IS NULL OR name LIKE ? OR upper(sku) = upper(?) OR upper(barcode) = upper(?)) ORDER BY name LIMIT 1000`)
          .bind(cid, own, own, a.p_inactive ? 1 : 0, q, q && like(q), q, q),
        ctx.db.prepare(`SELECT oi.product_id, sum(max(oi.quantity - coalesce(oi.picked_qty, 0), 0)) AS qty FROM order_items oi JOIN orders o ON o.id = oi.order_id
            WHERE oi.company_id = ? AND o.status IN ('pending', 'processing') AND oi.line_status = 'open' AND oi.product_id IS NOT NULL GROUP BY oi.product_id`).bind(cid),
        ctx.db.prepare(`SELECT pl.product_id, l.code, pl.qty FROM product_locations pl JOIN stock_locations l ON l.id = pl.location_id
            WHERE pl.company_id = ? AND pl.qty > 0 ORDER BY l.code`).bind(cid),
      ]);
      const res = new Map(reserved.results.map((r) => [r.product_id, r.qty]));
      const where = new Map();
      for (const l of locs.results) (where.get(l.product_id) ?? where.set(l.product_id, []).get(l.product_id)).push({ code: l.code, qty: l.qty });
      const rows = prods.results.map((p) => {
        const r = res.get(p.id) ?? 0; const available = p.stock == null ? null : p.stock - r;
        const state = stockState(p, available ?? 0);
        return { id: p.id, name: p.name, sku: p.sku, barcode: p.barcode, vendor: p.vendor_name, supplier: p.supplier, active: Boolean(p.active),
          price_fcfa: p.price_fcfa, cost_fcfa: p.cost_fcfa, weight_g: p.weight_g, stock: p.stock, reserved: r, available, min_stock: p.min_stock, state,
          to_order: p.min_stock != null && available != null && available <= p.min_stock ? Math.max(p.min_stock * 2 - available, 1) : 0,
          locations: where.get(p.id) ?? [], value_fcfa: p.stock > 0 ? p.stock * (p.cost_fcfa ?? p.price_fcfa ?? 0) : 0, updated_at: p.updated_at };
      });
      const f = a.p_filter;
      const list = !f || f === 'all' ? rows : rows.filter((x) => (f === 'alert' ? ['low', 'out'].includes(x.state) : x.state === f));
      const count = (s) => rows.filter((x) => x.state === s).length;
      return { products: list, totals: { products: rows.length, out: count('out'), low: count('low'), untracked: count('untracked'),
        units: rows.reduce((s, x) => s + Math.max(x.stock ?? 0, 0), 0), value_fcfa: rows.reduce((s, x) => s + x.value_fcfa, 0) } };
    },
  },

  // Réception de marchandise : + quantité, à un emplacement d'entrepôt (facultatif), lot et date facultatifs.
  lg_stock_receive: {
    roles: 'member',
    async handler(ctx, a) {
      canWrite(ctx);
      return idempotent(ctx, 'stock_receive', a.p_event, async () => {
        const p = await productOf(ctx, { id: a.p_product, code: a.p_code });
        const qty = int(a.p_qty);
        if (!(qty > 0 && qty <= 1000000)) fail('invalid_quantity');
        const loc = await locationOf(ctx, a.p_location_code);
        const lot = text(a.p_lot, 60)?.toUpperCase() ?? null;
        const exp = a.p_expires_on ? String(a.p_expires_on) : null;
        if (exp && !DATE.test(exp)) fail('invalid_date');
        if (exp && exp < today(ctx)) return { ok: false, error: 'expired_lot' };
        if ((lot || exp) && !loc) fail('location_required'); // un lot daté se range à un emplacement (prélèvement FEFO)
        const cid = ctx.company.id; const stmts = [];
        if (loc) {
          stmts.push(ctx.db.prepare(`INSERT INTO product_locations (company_id, product_id, location_id, qty, updated_at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT (product_id, location_id) DO UPDATE SET qty = product_locations.qty + excluded.qty, updated_at = excluded.updated_at`)
            .bind(cid, p.id, loc.id, qty, ctx.now));
          if (lot || exp) {
            stmts.push(ctx.db.prepare(`INSERT INTO stock_lots (id, company_id, product_id, location_id, lot_code, expires_on, qty) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (product_id, location_id, coalesce(lot_code, ''), coalesce(expires_on, '9999-12-31')) DO UPDATE SET qty = stock_lots.qty + excluded.qty, updated_at = ?`)
              .bind(uuid(), cid, p.id, loc.id, lot, exp, qty, ctx.now));
            stmts.push(ctx.db.prepare(`INSERT INTO lot_moves (company_id, lot_id, kind, qty, by_user)
                SELECT ?, id, 'in', ?, ? FROM stock_lots WHERE product_id = ? AND location_id = ? AND coalesce(lot_code, '') = ? AND coalesce(expires_on, '9999-12-31') = ?`)
              .bind(cid, qty, ctx.user.id, p.id, loc.id, lot ?? '', exp ?? '9999-12-31'));
          }
        }
        stmts.push(...stockMoveStatements(ctx, { product: p.id, delta: qty, kind: 'in', location: loc?.id ?? null, ref: text(a.p_ref, 80), reason: text(a.p_note, 200) }));
        await ctx.db.batch(stmts);
        const after = await ctx.db.prepare('SELECT stock FROM products WHERE id = ?').bind(p.id).first('stock');
        await audit(ctx, 'stock_receive', 'product', p.id, { qty, location: loc?.code ?? null, lot, ref: a.p_ref ?? null });
        return { ok: true, product: p.name, qty, stock: after, location: loc?.code ?? null, lot, expires_on: exp, state: exp ? lotState(exp, today(ctx), Number(ctx.company.config.expiry_alert_days ?? 30)) : null };
      });
    },
  },

  // Correction du stock : nouveau chiffre (ou écart), motif OBLIGATOIRE (casse, vol, erreur de saisie, cadeau…).
  lg_stock_adjust: {
    roles: 'member',
    async handler(ctx, a) {
      if (!hasRole(ctx, ['dock_chief']) && !vendorOnly(ctx)) fail('forbidden', 403);
      return idempotent(ctx, 'stock_adjust', a.p_event, async () => {
        const p = await productOf(ctx, { id: a.p_product });
        const reason = text(a.p_reason, 200);
        if (!reason) fail('reason_required');
        const target = a.p_new_qty == null || a.p_new_qty === '' ? null : int(a.p_new_qty);
        const delta = target != null ? target - (p.stock ?? 0) : int(a.p_delta);
        if (target != null && target < 0) fail('invalid_quantity');
        if (delta == null || Number.isNaN(delta)) fail('invalid_quantity');
        if (delta === 0 && p.stock != null) return { ok: true, stock: p.stock, unchanged: true };
        await ctx.db.batch(stockMoveStatements(ctx, { product: p.id, delta, kind: 'adjust', reason }));
        const after = await ctx.db.prepare('SELECT stock FROM products WHERE id = ?').bind(p.id).first('stock');
        await audit(ctx, 'stock_adjust', 'product', p.id, { delta, reason });
        return { ok: true, stock: after, delta };
      });
    },
  },

  // Transfert entre deux emplacements d'entrepôt : le stock du produit ne change pas, l'historique le note.
  lg_stock_transfer: {
    roles: WRITE,
    async handler(ctx, a) {
      return idempotent(ctx, 'stock_transfer', a.p_event, async () => {
        const p = await productOf(ctx, { id: a.p_product, code: a.p_code });
        const from = await locationOf(ctx, a.p_from_code); const to = await locationOf(ctx, a.p_to_code);
        if (!from || !to) fail('unknown_location', 404);
        if (from.id === to.id) fail('same_location');
        const qty = int(a.p_qty);
        if (!(qty > 0)) fail('invalid_quantity');
        const cid = ctx.company.id;
        const here = await ctx.db.prepare('SELECT qty FROM product_locations WHERE product_id = ? AND location_id = ? AND company_id = ?').bind(p.id, from.id, cid).first('qty');
        if ((here ?? 0) < qty) return { ok: false, error: 'qty_exceeds', available: here ?? 0 };
        const r = await ctx.db.batch([
          ctx.db.prepare('UPDATE product_locations SET qty = qty - ?, updated_at = ? WHERE product_id = ? AND location_id = ? AND company_id = ? AND qty >= ?')
            .bind(qty, ctx.now, p.id, from.id, cid, qty),
          ctx.db.prepare(`INSERT INTO product_locations (company_id, product_id, location_id, qty, updated_at) SELECT ?, ?, ?, ?, ? WHERE changes() > 0
              ON CONFLICT (product_id, location_id) DO UPDATE SET qty = product_locations.qty + excluded.qty, updated_at = excluded.updated_at`)
            .bind(cid, p.id, to.id, qty, ctx.now),
          ctx.db.prepare(`INSERT INTO stock_moves (company_id, product_id, location_id, kind, qty, stock_after, reason, by_user, at)
              SELECT ?, id, ?, 'transfer', ?, stock, ?, ?, ? FROM products WHERE id = ? AND company_id = ?`)
            .bind(cid, to.id, qty, `${from.code} → ${to.code}`, ctx.user.id, ctx.now, p.id, cid),
        ]);
        if (!r[0].meta.changes) return { ok: false, error: 'qty_exceeds', available: 0 };
        // les lots datés suivent : on déplace d'abord ceux qui périment le plus tôt
        const lots = (await ctx.db.prepare('SELECT * FROM stock_lots WHERE product_id = ? AND location_id = ? AND company_id = ? AND qty > 0 ORDER BY expires_on IS NULL, expires_on')
          .bind(p.id, from.id, cid).all()).results;
        let left = qty; const stmts = [];
        for (const s of lots) {
          if (left <= 0) break;
          const take = Math.min(s.qty, left); left -= take;
          stmts.push(ctx.db.prepare('UPDATE stock_lots SET qty = qty - ?, updated_at = ? WHERE id = ?').bind(take, ctx.now, s.id));
          stmts.push(ctx.db.prepare(`INSERT INTO stock_lots (id, company_id, product_id, location_id, lot_code, expires_on, qty) VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (product_id, location_id, coalesce(lot_code, ''), coalesce(expires_on, '9999-12-31')) DO UPDATE SET qty = stock_lots.qty + excluded.qty, updated_at = ?`)
            .bind(uuid(), cid, p.id, to.id, s.lot_code, s.expires_on, take, ctx.now));
        }
        if (stmts.length) await ctx.db.batch(stmts);
        await audit(ctx, 'stock_transfer', 'product', p.id, { qty, from: from.code, to: to.code });
        return { ok: true, product: p.name, qty, from: from.code, to: to.code };
      });
    },
  },

  // Historique des mouvements (tous ou d'un produit), plus récents d'abord.
  lg_stock_moves: {
    roles: 'member',
    async handler(ctx, a) {
      canView(ctx);
      const own = vendorOnly(ctx) ? ctx.user.id : null;
      const since = new Date(Date.parse(ctx.now) - Math.min(Math.max(int(a.p_days) ?? 30, 1), 366) * 86400000).toISOString();
      const kind = ['in', 'pick', 'adjust', 'count', 'discard', 'return', 'transfer', 'initial'].includes(a.p_kind) ? a.p_kind : null;
      return (await ctx.db.prepare(`SELECT m.id, m.kind, m.qty, m.stock_after, m.ref, m.reason, m.at, p.id AS product_id, p.name AS product, p.sku,
            l.code AS location, o.number AS order_number, u.name AS by
          FROM stock_moves m JOIN products p ON p.id = m.product_id LEFT JOIN stock_locations l ON l.id = m.location_id
          LEFT JOIN orders o ON o.id = m.order_id LEFT JOIN users u ON u.id = m.by_user
          WHERE m.company_id = ? AND m.at >= ? AND (? IS NULL OR m.product_id = ?) AND (? IS NULL OR m.kind = ?) AND (? IS NULL OR p.vendor_id = ?)
          ORDER BY m.id DESC LIMIT 500`)
        .bind(ctx.company.id, since, a.p_product ?? null, a.p_product ?? null, kind, kind, own, own).all()).results;
    },
  },

  // Import d'un catalogue (lignes déjà lues du fichier par l'écran) : crée, ou met à jour si la référence ou le
  // code-barres existe déjà (p_update). Le stock d'une ligne n'est pris qu'à la création (stock de départ).
  lg_products_import: {
    roles: 'member',
    async handler(ctx, a) {
      if (!hasRole(ctx, ['support', 'dispatcher', 'dock_chief', 'picker']) && !vendorOnly(ctx)) fail('forbidden', 403);
      const rows = Array.isArray(a.p_rows) ? a.p_rows : [];
      if (!rows.length) fail('no_rows');
      if (rows.length > IMPORT_MAX) fail('too_many_rows');
      const own = vendorOnly(ctx) ? ctx.user.id : null; const cid = ctx.company.id;
      const up = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim().toUpperCase());
      const keys = [...new Set(rows.flatMap((r) => [up(r?.sku), up(r?.barcode)]).filter(Boolean))];
      const existing = new Map();
      for (const c of chunks(keys, 45)) {
        const marks = c.map(() => '?').join(',');
        const found = (await ctx.db.prepare(`SELECT id, sku, barcode, vendor_id FROM products WHERE company_id = ? AND (upper(sku) IN (${marks}) OR upper(barcode) IN (${marks}))`)
          .bind(cid, ...c, ...c).all()).results;
        for (const f of found) { if (f.sku) existing.set(up(f.sku), f); if (f.barcode) existing.set(up(f.barcode), f); }
      }
      const opt = (v) => (v == null || String(v).trim() === '' ? null : int(String(v).replace(/[\s ]/g, '').replace(',', '.')));
      const results = []; const stmts = [];
      rows.forEach((r, i) => {
        const line = i + 2; // ligne du fichier (en-tête = ligne 1)
        const name = text(r?.name, 120);
        if (!name) { results.push({ line, ok: false, error: 'invalid_name' }); return; }
        const price = opt(r.price_fcfa) ?? 0; const stock = opt(r.stock); const min = opt(r.min_stock); const cost = opt(r.cost_fcfa);
        const kg = r.weight_kg == null || String(r.weight_kg).trim() === '' ? null : Number(String(r.weight_kg).replace(',', '.'));
        const w = kg == null ? opt(r.weight_g) : Math.round(kg * 1000);
        if ([price, stock, min, cost].some((v) => v != null && (Number.isNaN(v) || v < 0)) || (w != null && !(w > 0))) { results.push({ line, ok: false, error: 'invalid_amount', name }); return; }
        const prev = existing.get(up(r.sku)) ?? existing.get(up(r.barcode));
        if (prev && own && prev.vendor_id !== own) { results.push({ line, ok: false, error: 'duplicate_code', name }); return; }
        if (prev) {
          if (!a.p_update) { results.push({ line, ok: true, skipped: true, name }); return; }
          stmts.push(ctx.db.prepare(`UPDATE products SET name = ?, price_fcfa = ?, weight_g = coalesce(?, weight_g), min_stock = coalesce(?, min_stock),
              cost_fcfa = coalesce(?, cost_fcfa), supplier = coalesce(?, supplier), sku = coalesce(?, sku), barcode = coalesce(?, barcode), updated_at = ? WHERE id = ? AND company_id = ?`)
            .bind(name, price, w, min, cost, text(r.supplier, 80), text(r.sku, 64), text(r.barcode, 64), ctx.now, prev.id, cid));
          results.push({ line, ok: true, updated: true, name });
          return;
        }
        const id = uuid();
        stmts.push(ctx.db.prepare(`INSERT INTO products (id, company_id, vendor_id, vendor_name, name, sku, barcode, price_fcfa, weight_g, min_stock, cost_fcfa, supplier, handling)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')`)
          .bind(id, cid, own, own ? ctx.user.name : text(r.vendor_name, 80), name, text(r.sku, 64), text(r.barcode, 64), price, w, min, cost, text(r.supplier, 80)));
        if (stock != null) stmts.push(...stockMoveStatements(ctx, { product: id, delta: stock, kind: 'initial', reason: 'import du catalogue' }));
        for (const k of [up(r.sku), up(r.barcode)].filter(Boolean)) existing.set(k, { id, vendor_id: own }); // doublon dans le même fichier
        results.push({ line, ok: true, created: true, name });
      });
      for (const c of chunks(stmts, 80)) await ctx.db.batch(c);
      const n = (k) => results.filter((x) => x[k]).length;
      await audit(ctx, 'products_import', 'product', null, { created: n('created'), updated: n('updated') });
      return { ok: true, created: n('created'), updated: n('updated'), skipped: n('skipped'), errors: results.filter((x) => !x.ok), results };
    },
  },

  // Premiers pas d'une entreprise (accueil du propriétaire tant que ce n'est pas terminé).
  lg_setup_status: {
    roles: 'admin',
    async handler(ctx) {
      const r = await ctx.db.prepare(`SELECT
          (SELECT count(*) FROM products WHERE company_id = ?1) AS products,
          (SELECT count(*) FROM zones WHERE company_id = ?1) AS zones,
          (SELECT count(*) FROM rate_cards WHERE company_id = ?1) AS rate_cards,
          (SELECT count(*) FROM couriers WHERE company_id = ?1 AND active = 1) AS couriers,
          (SELECT count(*) FROM members WHERE company_id = ?1) AS members,
          (SELECT count(*) FROM orders WHERE company_id = ?1) AS orders`).bind(ctx.company.id).first();
      return r;
    },
  },
};
