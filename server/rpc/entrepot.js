// Cycle C3 — entrepôt : emplacements, rangement par lot (date de péremption), recherche d'un produit,
// inventaire tournant, péremption et rebut, traçabilité d'un lot (rappel), fiche colis (chaîne de garde).
// Portage de 20261008000400_cycle4_entrepot.sql et 20261008000600_cycle6_lots_peremption.sql.
import { fail, audit, idempotent, hasRole, text, int, uuid, parseJson, today } from './core.js';
import { loadStock, clampStatements, lotState, locKey, stockMoveStatements } from './stock.js';
import { normCode } from './preparation.js';

const KINDS = ['shelf', 'floor', 'cold', 'bulk'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const alertDays = (ctx) => Number(ctx.company.config.expiry_alert_days ?? 30);
const plusDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
/** Lieu de rattachement d'un préparateur ou chef de quai (s'il en a un). */
const staffHub = (ctx) => ctx.roles.find((r) => r.hub_id && (r.role === 'picker' || r.role === 'dock_chief'))?.hub_id ?? null;

async function productByCode(ctx, code) {
  const c = String(code ?? '').trim().toUpperCase();
  if (!c) return null;
  return ctx.db.prepare("SELECT * FROM products WHERE company_id = ? AND (upper(barcode) = ? OR upper(sku) = ? OR 'NXI-' || upper(substr(id, 1, 8)) = ?) LIMIT 1")
    .bind(ctx.company.id, c, c, c).first();
}
const lotOut = (s, day, days) => ({ id: s.id, lot: s.lot_code, expires_on: s.expires_on, qty: s.qty, state: lotState(s.expires_on, day, days) });

export default {
  // ----------------------------------------------------------------- emplacements
  lg_location_upsert: {
    roles: ['dock_chief'],
    async handler(ctx, a) {
      const p = a.p && typeof a.p === 'object' ? a.p : {};
      const code = text(p.code, 30)?.toUpperCase();
      if (!code) fail('code_required');
      const kind = p.kind ?? 'shelf';
      if (!KINDS.includes(kind)) fail('invalid_kind');
      let hub = p.hub_id || staffHub(ctx);
      if (hub && !(await ctx.db.prepare('SELECT 1 AS x FROM hubs WHERE id = ? AND company_id = ?').bind(hub, ctx.company.id).first())) fail('unknown_hub', 404);
      hub = hub || (await ctx.db.prepare('SELECT id FROM hubs WHERE company_id = ? AND active = 1 ORDER BY created_at LIMIT 1').bind(ctx.company.id).first('id'));
      if (!hub) fail('unknown_hub', 404);
      const r = await ctx.db.prepare(
        `INSERT INTO stock_locations (id, company_id, hub_id, code, kind, label, active) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (company_id, hub_id, code) DO UPDATE SET kind = excluded.kind, label = excluded.label, active = excluded.active RETURNING id`,
      ).bind(uuid(), ctx.company.id, hub, code, kind, text(p.label, 80), p.active === false ? 0 : 1).first();
      return { ok: true, id: r.id };
    },
  },

  lg_locations_list: {
    roles: ['picker', 'dock_chief'],
    async handler(ctx, a) {
      const hub = a.p_hub ?? null;
      const [locs, contents, lots] = await ctx.db.batch([
        ctx.db.prepare('SELECT id, code, kind, label, active, last_counted_at FROM stock_locations WHERE company_id = ? AND (? IS NULL OR hub_id = ?)').bind(ctx.company.id, hub, hub),
        ctx.db.prepare(
          `SELECT pl.location_id, pl.qty, p.id AS product_id, p.name, p.barcode FROM product_locations pl JOIN products p ON p.id = pl.product_id
            WHERE pl.company_id = ? AND pl.qty > 0 ORDER BY p.name`).bind(ctx.company.id),
        ctx.db.prepare('SELECT * FROM stock_lots WHERE company_id = ? AND qty > 0 ORDER BY expires_on IS NULL, expires_on').bind(ctx.company.id),
      ]);
      const day = today(ctx); const days = alertDays(ctx);
      return locs.results.map((l) => ({
        ...l, active: Boolean(l.active),
        contents: contents.results.filter((c) => c.location_id === l.id).map((c) => ({ product_id: c.product_id, name: c.name, qty: c.qty, barcode: c.barcode,
          lots: lots.results.filter((s) => s.location_id === l.id && s.product_id === c.product_id).map((s) => lotOut(s, day, days)) })),
      })).sort((x, y) => locKey(x.code).localeCompare(locKey(y.code)));
    },
  },

  // Rangement : « ce produit, tant d'unités, à cet emplacement », avec lot et date de péremption facultatifs.
  lg_put_away: {
    roles: ['picker', 'dock_chief'],
    async handler(ctx, a) {
      return idempotent(ctx, 'put_away', a.p_event, async () => {
        const pr = await productByCode(ctx, a.p_product_code);
        if (!pr) return { ok: false, error: 'unknown_product' };
        const hub = staffHub(ctx);
        const loc = await ctx.db.prepare('SELECT * FROM stock_locations WHERE company_id = ? AND code = ? AND active = 1 ORDER BY (hub_id = ?) DESC LIMIT 1')
          .bind(ctx.company.id, String(a.p_location_code ?? '').trim().toUpperCase(), hub).first();
        if (!loc) return { ok: false, error: 'unknown_location' };
        const qty = int(a.p_qty);
        if (!(qty > 0)) fail('invalid_quantity');
        const lot = text(a.p_lot, 60)?.toUpperCase() ?? null;
        const exp = a.p_expires_on && DATE.test(String(a.p_expires_on)) ? String(a.p_expires_on) : null;
        if (a.p_expires_on && !exp) fail('invalid_date');
        // on ne range pas une marchandise déjà périmée : elle repart chez le vendeur
        if (exp && exp < today(ctx)) return { ok: false, error: 'expired_lot' };
        const stmts = [ctx.db.prepare(
          `INSERT INTO product_locations (company_id, product_id, location_id, qty, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (product_id, location_id) DO UPDATE SET qty = product_locations.qty + excluded.qty, updated_at = excluded.updated_at RETURNING qty`,
        ).bind(ctx.company.id, pr.id, loc.id, qty, ctx.now)];
        if (lot || exp) {
          stmts.push(ctx.db.prepare(
            `INSERT INTO stock_lots (id, company_id, product_id, location_id, lot_code, expires_on, qty) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (product_id, location_id, coalesce(lot_code, ''), coalesce(expires_on, '9999-12-31'))
             DO UPDATE SET qty = stock_lots.qty + excluded.qty, updated_at = ?`,
          ).bind(uuid(), ctx.company.id, pr.id, loc.id, lot, exp, qty, ctx.now));
          stmts.push(ctx.db.prepare(
            `INSERT INTO lot_moves (company_id, lot_id, kind, qty, by_user)
             SELECT ?, id, 'in', ?, ? FROM stock_lots WHERE product_id = ? AND location_id = ? AND coalesce(lot_code, '') = ? AND coalesce(expires_on, '9999-12-31') = ?`,
          ).bind(ctx.company.id, qty, ctx.user.id, pr.id, loc.id, lot ?? '', exp ?? '9999-12-31'));
        }
        stmts.push(...stockMoveStatements(ctx, { product: pr.id, delta: qty, kind: 'in', location: loc.id, ref: text(a.p_ref, 80), reason: text(a.p_note, 200) }));
        const [r] = await ctx.db.batch(stmts);
        await audit(ctx, 'put_away', 'product', pr.id, { location: loc.code, qty, lot, expires_on: exp });
        return { ok: true, product: pr.name, location: loc.code, qty: r.results[0]?.qty ?? qty, lot, expires_on: exp, state: lotState(exp, today(ctx), alertDays(ctx)) };
      });
    },
  },

  // Où est ce produit ? (code ou nom) — remplace la version C2 : emplacements et lots.
  lg_product_find: {
    roles: ['picker', 'dock_chief', 'support'],
    async handler(ctx, a) {
      const q = String(a.p_q ?? '').trim();
      if (q.length < 2) return [];
      const ps = (await ctx.db.prepare(
        `SELECT * FROM products WHERE company_id = ? AND (upper(barcode) = upper(?) OR upper(sku) = upper(?)
            OR 'NXI-' || upper(substr(id, 1, 8)) = upper(?) OR name LIKE ?) ORDER BY name LIMIT 20`,
      ).bind(ctx.company.id, q, q, q, `%${q.replace(/[%_]/g, '')}%`).all()).results;
      const stock = await loadStock(ctx, ps.map((p) => p.id));
      const day = today(ctx); const days = alertDays(ctx);
      return ps.map((p) => ({ id: p.id, name: p.name, barcode: p.barcode, sku: p.sku, stock: p.stock, vendor: p.vendor_name,
        locations: (stock.get(p.id) ?? []).filter((l) => l.qty > 0).sort((x, y) => y.qty - x.qty)
          .map((l) => ({ code: l.code, qty: l.qty, lots: l.lots.map((s) => lotOut(s, day, days)) })) }));
    },
  },

  // ----------------------------------------------------------------- inventaire tournant
  lg_inventory_today: {
    roles: ['picker', 'dock_chief'],
    async handler(ctx, a) {
      const n = Math.min(Math.max(int(a.p_limit) ?? 8, 1), 50);
      const locs = (await ctx.db.prepare(
        `SELECT id, code, last_counted_at FROM stock_locations l WHERE company_id = ? AND active = 1
            AND EXISTS (SELECT 1 FROM product_locations WHERE location_id = l.id) ORDER BY last_counted_at IS NOT NULL, last_counted_at LIMIT ?`,
      ).bind(ctx.company.id, n).all()).results;
      if (!locs.length) return [];
      const contents = (await ctx.db.prepare(
        `SELECT pl.location_id, pl.qty, p.id, p.name, p.barcode FROM product_locations pl JOIN products p ON p.id = pl.product_id
          WHERE pl.company_id = ? AND pl.location_id IN (${locs.map(() => '?').join(',')}) ORDER BY p.name`,
      ).bind(ctx.company.id, ...locs.map((l) => l.id)).all()).results;
      return locs.map((l) => ({ ...l, contents: contents.filter((c) => c.location_id === l.id).map((c) => ({ product_id: c.id, name: c.name, barcode: c.barcode, expected: c.qty })) }))
        .sort((x, y) => (x.last_counted_at ?? '').localeCompare(y.last_counted_at ?? '') || locKey(x.code).localeCompare(locKey(y.code)));
    },
  },

  // p_counts : [{ product_id, counted, reason? }]. L'emplacement prend la quantité comptée ; le stock affiché suit l'écart.
  lg_inventory_count: {
    roles: ['picker', 'dock_chief'],
    async handler(ctx, a) {
      return idempotent(ctx, 'inventory', a.p_event, async () => {
        const loc = await ctx.db.prepare('SELECT id, code FROM stock_locations WHERE id = ? AND company_id = ?').bind(String(a.p_location ?? ''), ctx.company.id).first();
        if (!loc) fail('unknown_location', 404);
        const counts = Array.isArray(a.p_counts) ? a.p_counts.slice(0, 80) : [];
        const ids = counts.map((c) => String(c?.product_id ?? ''));
        if (counts.some((c) => !(int(c?.counted) >= 0))) fail('invalid_quantity');
        const stock = await loadStock(ctx, ids);
        if (ids.length) {
          const known = (await ctx.db.prepare(`SELECT COUNT(*) AS n FROM products WHERE company_id = ? AND id IN (${ids.map(() => '?').join(',')})`)
            .bind(ctx.company.id, ...ids).first('n'));
          if (known !== new Set(ids).size) fail('unknown_product', 404);
        }
        const stmts = []; let totalGap = 0; const day = today(ctx);
        for (const c of counts) {
          const pid = String(c.product_id); const counted = int(c.counted);
          const here = (stock.get(pid) ?? []).find((l) => l.id === loc.id);
          const expected = here?.qty ?? 0; const gap = counted - expected;
          stmts.push(ctx.db.prepare('INSERT INTO inventory_counts (company_id, location_id, product_id, expected, counted, gap, reason, counted_by, counted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(ctx.company.id, loc.id, pid, expected, counted, gap, text(c.reason, 80), ctx.user.id, ctx.now));
          if (gap !== 0) {
            stmts.push(ctx.db.prepare(
              `INSERT INTO product_locations (company_id, product_id, location_id, qty, updated_at) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (product_id, location_id) DO UPDATE SET qty = excluded.qty, updated_at = excluded.updated_at`,
            ).bind(ctx.company.id, pid, loc.id, counted, ctx.now));
            stmts.push(...stockMoveStatements(ctx, { product: pid, delta: gap, kind: 'count', location: loc.id, reason: text(c.reason, 80) ?? `inventaire ${loc.code}` }));
            if (here && gap < 0) stmts.push(...clampStatements(ctx, here, counted, day));
            totalGap += Math.abs(gap);
          }
        }
        stmts.push(ctx.db.prepare('UPDATE stock_locations SET last_counted_at = ? WHERE id = ? AND company_id = ?').bind(ctx.now, loc.id, ctx.company.id));
        await ctx.db.batch(stmts);
        if (totalGap > 0) await audit(ctx, 'inventory_gap', 'location', loc.id, { gap_units: totalGap });
        return { ok: true, lines: counts.length, gap_units: totalGap };
      });
    },
  },

  lg_inventory_history: {
    roles: ['dock_chief', 'accountant'],
    async handler(ctx, a) {
      const since = new Date(Date.parse(ctx.now) - (Math.min(int(a.p_days) ?? 30, 366)) * 86400000).toISOString();
      return (await ctx.db.prepare(
        `SELECT c.counted_at AS at, l.code AS location, p.name AS product, c.expected, c.counted, c.gap, c.reason, u.name AS by
           FROM inventory_counts c JOIN stock_locations l ON l.id = c.location_id JOIN products p ON p.id = c.product_id LEFT JOIN users u ON u.id = c.counted_by
          WHERE c.company_id = ? AND c.counted_at > ? AND c.gap <> 0 ORDER BY c.counted_at DESC LIMIT 500`,
      ).bind(ctx.company.id, since).all()).results;
    },
  },

  // ----------------------------------------------------------------- péremption
  // Lots périmés ou qui périment sous p_days jours ; un vendeur voit les lots de ses produits.
  lg_lots_expiring: {
    roles: 'member',
    async handler(ctx, a) {
      const staff = hasRole(ctx, ['picker', 'dock_chief', 'support']);
      if (!staff && ctx.member !== 'vendor') fail('forbidden', 403);
      const day = today(ctx); const days = int(a.p_days) ?? alertDays(ctx);
      const r = await ctx.db.prepare(
        `SELECT s.*, p.name AS product, p.barcode, p.vendor_name, l.code AS location FROM stock_lots s JOIN products p ON p.id = s.product_id
           JOIN stock_locations l ON l.id = s.location_id
          WHERE s.company_id = ? AND s.qty > 0 AND s.expires_on IS NOT NULL AND s.expires_on <= ? AND (? = 1 OR p.vendor_id = ?)
          ORDER BY s.expires_on, p.name`,
      ).bind(ctx.company.id, plusDays(day, days), staff ? 1 : 0, ctx.user.id).all();
      return r.results.map((s) => ({ id: s.id, product_id: s.product_id, product: s.product, barcode: s.barcode, vendor: s.vendor_name, location: s.location,
        lot: s.lot_code, expires_on: s.expires_on, qty: s.qty, days_left: daysBetween(day, s.expires_on), state: lotState(s.expires_on, day, alertDays(ctx)) }));
    },
  },

  // Sortie (rebut) motivée d'un lot : l'emplacement et le stock affiché suivent.
  lg_lot_discard: {
    roles: ['dock_chief'],
    async handler(ctx, a) {
      return idempotent(ctx, 'lot_discard', a.p_event, async () => {
        const reason = text(a.p_reason, 200);
        if (!reason) fail('reason_required');
        const s = await ctx.db.prepare('SELECT * FROM stock_lots WHERE id = ? AND company_id = ?').bind(String(a.p_lot ?? ''), ctx.company.id).first();
        if (!s) fail('unknown_lot', 404);
        const qty = int(a.p_qty);
        if (!(qty > 0)) fail('invalid_quantity');
        if (qty > s.qty) return { ok: false, error: 'qty_exceeds', available: s.qty };
        const [r] = await ctx.db.batch([
          ctx.db.prepare('UPDATE stock_lots SET qty = qty - ?, updated_at = ? WHERE id = ? AND company_id = ? AND qty >= ?').bind(qty, ctx.now, s.id, ctx.company.id, qty),
          ctx.db.prepare("INSERT INTO lot_moves (company_id, lot_id, kind, qty, reason, by_user) SELECT ?, ?, 'discard', ?, ?, ? WHERE changes() > 0")
            .bind(ctx.company.id, s.id, -qty, reason, ctx.user.id),
          ctx.db.prepare('UPDATE product_locations SET qty = max(qty - ?, 0), updated_at = ? WHERE product_id = ? AND location_id = ? AND company_id = ?')
            .bind(qty, ctx.now, s.product_id, s.location_id, ctx.company.id),
          ...stockMoveStatements(ctx, { product: s.product_id, delta: -qty, kind: 'discard', location: s.location_id, ref: s.lot_code, reason }),
        ]);
        if (!r.meta.changes) return { ok: false, error: 'qty_exceeds', available: 0 };
        await audit(ctx, 'lot_discard', 'product', s.product_id, { lot: s.lot_code, expires_on: s.expires_on, qty, reason });
        return { ok: true, left: s.qty - qty };
      });
    },
  },

  // Traçabilité : quelles commandes ont reçu ce lot ? (rappel de produit)
  lg_lot_trace: {
    roles: ['dock_chief', 'support', 'accountant'],
    async handler(ctx, a) {
      const q = String(a.p_lot ?? '').trim().toUpperCase();
      if (q.length < 2) return [];
      const lots = (await ctx.db.prepare(
        `SELECT s.*, p.name AS product, l.code AS location,
                (SELECT coalesce(sum(qty), 0) FROM lot_moves WHERE lot_id = s.id AND kind = 'in') AS received,
                (SELECT coalesce(-sum(qty), 0) FROM lot_moves WHERE lot_id = s.id AND kind = 'discard') AS discarded
           FROM stock_lots s JOIN products p ON p.id = s.product_id JOIN stock_locations l ON l.id = s.location_id
          WHERE s.company_id = ? AND upper(s.lot_code) = ? ORDER BY s.expires_on IS NULL, s.expires_on, p.name`,
      ).bind(ctx.company.id, q).all()).results;
      if (!lots.length) return [];
      const orders = (await ctx.db.prepare(
        `SELECT m.lot_id, o.id AS order_id, o.number, o.buyer_name, o.buyer_phone, o.delivery_zone, o.status, o.delivered_at, -sum(m.qty) AS qty, max(m.at) AS at
           FROM lot_moves m JOIN pick_lines pl ON pl.id = m.pick_line_id JOIN pick_tasks t ON t.id = pl.task_id JOIN orders o ON o.id = t.order_id
          WHERE m.company_id = ? AND m.kind = 'pick' AND m.lot_id IN (${lots.map(() => '?').join(',')}) GROUP BY m.lot_id, o.id ORDER BY at`,
      ).bind(ctx.company.id, ...lots.map((s) => s.id)).all()).results;
      return lots.map((s) => ({ lot_id: s.id, lot: s.lot_code, expires_on: s.expires_on, product: s.product, location: s.location, in_stock: s.qty,
        received: s.received, discarded: s.discarded,
        orders: orders.filter((o) => o.lot_id === s.id).map((o) => ({ order_id: o.order_id, order_short: String(o.number), customer: o.buyer_name, phone: o.buyer_phone,
          zone: o.delivery_zone, status: o.status, delivered_at: o.delivered_at, qty: o.qty, picked_at: o.at })) }));
    },
  },

  // ----------------------------------------------------------------- fiche colis (chaîne de garde)
  lg_package_card: {
    roles: 'member',
    async handler(ctx, a) {
      const p = await ctx.db.prepare('SELECT * FROM packages WHERE company_id = ? AND code = ?').bind(ctx.company.id, normCode(a.p_code)).first();
      if (!p) fail('unknown_package', 404);
      const o = await ctx.db.prepare('SELECT * FROM orders WHERE id = ? AND company_id = ?').bind(p.order_id, ctx.company.id).first();
      if (!hasRole(ctx, ['picker', 'dock_chief', 'dispatcher', 'support', 'cashier', 'accountant']) && !(o.vendor_id && o.vendor_id === ctx.user.id)) fail('forbidden', 403);
      const holderSql = { driver: 'SELECT name FROM couriers WHERE id = ? AND company_id = ?', hub: 'SELECT name FROM hubs WHERE id = ? AND company_id = ?',
        vendor: 'SELECT u.name FROM users u JOIN members m ON m.user_id = u.id WHERE u.id = ? AND m.company_id = ?' }[p.holder_type];
      const [holder, events, incidents, proofs] = await ctx.db.batch([
        ctx.db.prepare(holderSql ?? "SELECT 'Client' AS name WHERE ? IS NOT NULL OR ? IS NOT NULL").bind(p.holder_id, ctx.company.id),
        ctx.db.prepare(
          `SELECT e.event, e.server_at AS at, e.device_at, u.name AS actor, e.manual_entry AS manual, e.trip_id, t.number AS trip_number, e.lat, e.lng, e.meta
             FROM scan_events e LEFT JOIN users u ON u.id = e.actor_id LEFT JOIN trips t ON t.id = e.trip_id
            WHERE e.package_id = ? AND e.company_id = ? ORDER BY e.server_at, e.id`,
        ).bind(p.id, ctx.company.id),
        ctx.db.prepare('SELECT number, kind, status FROM incidents WHERE package_id = ? AND company_id = ? ORDER BY number').bind(p.id, ctx.company.id),
        ctx.db.prepare(`SELECT pf.kind, pf.file_path, pf.recipient_name AS recipient, pf.distance_m, pf.created_at AS at FROM proofs pf
            JOIN trip_packages tp ON tp.stop_id = pf.stop_id WHERE tp.package_id = ? AND pf.company_id = ? ORDER BY pf.created_at`).bind(p.id, ctx.company.id),
      ]);
      const { holder_id, ...pkg } = p;
      return {
        package: { ...pkg, handling: parseJson(p.handling, []), check_required: Boolean(p.check_required) },
        order: { id: o.id, short: String(o.number), status: o.status, zone: o.delivery_zone, payment_method: o.payment_method, vendor_name: o.vendor_name },
        holder: { type: p.holder_type, name: p.holder_type === 'customer' ? 'Client' : holder.results[0]?.name ?? (p.holder_type === 'vendor' ? o.vendor_name : null) },
        timeline: events.results.map((e) => ({ ...e, manual: Boolean(e.manual), meta: parseJson(e.meta, {}) })),
        proofs: proofs.results,
        incidents: incidents.results,
      };
    },
  },
};
