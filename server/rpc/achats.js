// Achats de réassort : fournisseurs, bons de commande (brouillon → envoyé → reçu en partie → reçu, ou annulé),
// réception d'un bon (entrée en stock tracée avec le n° du bon, dernier prix d'achat mis à jour), propositions de
// bons depuis les produits sous leur seuil d'alerte (déduction de ce qui est déjà en commande).
// Numéro sans trou « BC-AAAA-000001 » : compteur incrémenté DANS le lot qui crée le bon (règle 6 du CLAUDE.md).
import { fail, audit, idempotent, hasRole, text, int, uuid, guard, runBatch } from './core.js';
import { receiveStatements, locationOf } from './produits.js';

const VIEW = ['dock_chief', 'accountant', 'dispatcher', 'support', 'picker'];
const WRITE = ['dock_chief', 'accountant'];
const RECEIVE = ['dock_chief', 'picker'];
const OPEN = ['draft', 'sent', 'partial'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LINES = 100;
const view = (ctx) => { if (!hasRole(ctx, VIEW)) fail('forbidden', 403); };
const write = (ctx) => { if (!hasRole(ctx, WRITE)) fail('forbidden', 403); };

async function supplierOf(ctx, id) {
  const s = await ctx.db.prepare('SELECT * FROM suppliers WHERE id = ? AND company_id = ?').bind(String(id ?? ''), ctx.company.id).first();
  if (!s) fail('unknown_supplier', 404);
  return s;
}
async function poOf(ctx, id) {
  const po = await ctx.db.prepare('SELECT * FROM purchase_orders WHERE id = ? AND company_id = ?').bind(String(id ?? ''), ctx.company.id).first();
  if (!po) fail('unknown_po', 404);
  return po;
}

/** Lignes vérifiées : produits de l'entreprise, quantités > 0, coût ≥ 0 (dernier prix d'achat par défaut). */
async function cleanLines(ctx, raw) {
  const lines = Array.isArray(raw) ? raw.filter((l) => l && l.product_id) : [];
  if (!lines.length) fail('no_lines');
  if (lines.length > MAX_LINES) fail('too_many_lines');
  const ids = [...new Set(lines.map((l) => String(l.product_id)))];
  const prods = (await ctx.db.prepare(`SELECT id, name, cost_fcfa FROM products WHERE company_id = ? AND id IN (${ids.map(() => '?').join(',')})`)
    .bind(ctx.company.id, ...ids).all()).results;
  if (prods.length !== ids.length) fail('unknown_product', 404);
  const byId = new Map(prods.map((p) => [p.id, p]));
  const merged = new Map(); // même produit deux fois : une seule ligne
  for (const l of lines) {
    const qty = int(l.qty ?? l.qty_ordered);
    const cost = l.unit_cost_fcfa == null || l.unit_cost_fcfa === '' ? byId.get(String(l.product_id)).cost_fcfa ?? 0 : int(l.unit_cost_fcfa);
    if (!(qty > 0 && qty <= 1000000)) fail('invalid_quantity');
    if (!(cost >= 0)) fail('invalid_amount');
    const prev = merged.get(String(l.product_id));
    merged.set(String(l.product_id), { product_id: String(l.product_id), qty: (prev?.qty ?? 0) + qty, cost });
  }
  return [...merged.values()];
}

/** Lot qui crée un bon : compteur annuel + bon numéroté depuis ce compteur + lignes (tout ou rien). */
function createStatements(ctx, { id, supplier, lines, expected, note, hub }) {
  const cid = ctx.company.id; const key = `bc-${ctx.now.slice(0, 4)}`;
  const total = lines.reduce((s, l) => s + l.qty * l.cost, 0);
  return [
    ctx.db.prepare("INSERT INTO counters (company_id, key, n) VALUES (?, ?, 1) ON CONFLICT (company_id, key) DO UPDATE SET n = n + 1").bind(cid, key),
    ctx.db.prepare(`INSERT INTO purchase_orders (id, company_id, number, supplier_id, hub_id, expected_on, note, total_fcfa, created_by, created_at, updated_at)
        SELECT ?, ?, 'BC-' || ? || '-' || printf('%06d', n), ?, ?, ?, ?, ?, ?, ?, ? FROM counters WHERE company_id = ? AND key = ?`)
      .bind(id, cid, ctx.now.slice(0, 4), supplier, hub, expected, note, total, ctx.user.id, ctx.now, ctx.now, cid, key),
    ...lines.map((l) => ctx.db.prepare('INSERT INTO purchase_order_lines (id, company_id, po_id, product_id, qty_ordered, unit_cost_fcfa) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(uuid(), cid, id, l.product_id, l.qty, l.cost)),
  ];
}

const dateOrNull = (v) => { if (v == null || v === '') return null; if (!DATE.test(String(v))) fail('invalid_date'); return String(v); };

/** Quantités déjà en commande (bons ouverts, pas encore reçues), par produit. */
async function onOrder(ctx) {
  const r = await ctx.db.prepare(`SELECT l.product_id, sum(l.qty_ordered - l.qty_received) AS qty FROM purchase_order_lines l JOIN purchase_orders p ON p.id = l.po_id
      WHERE l.company_id = ? AND p.status IN ('draft', 'sent', 'partial') GROUP BY l.product_id`).bind(ctx.company.id).all();
  return new Map(r.results.map((x) => [x.product_id, Math.max(x.qty, 0)]));
}

export default {
  // ----------------------------------------------------------------- fournisseurs
  lg_suppliers_list: {
    roles: 'member',
    async handler(ctx, a) {
      if (!hasRole(ctx, VIEW)) fail('forbidden', 403);
      const r = await ctx.db.prepare(`SELECT s.*,
            (SELECT count(*) FROM products p WHERE p.supplier_id = s.id AND p.active = 1) AS products,
            (SELECT count(*) FROM purchase_orders o WHERE o.supplier_id = s.id AND o.status IN ('draft', 'sent', 'partial')) AS open_orders,
            (SELECT max(created_at) FROM purchase_orders o WHERE o.supplier_id = s.id AND o.status <> 'cancelled') AS last_order_at,
            (SELECT coalesce(sum(total_fcfa), 0) FROM purchase_orders o WHERE o.supplier_id = s.id AND o.status IN ('partial', 'received') AND o.created_at >= ?) AS spent_365d
          FROM suppliers s WHERE s.company_id = ? AND (? = 1 OR s.active = 1) ORDER BY s.name`)
        .bind(new Date(Date.parse(ctx.now) - 365 * 86400000).toISOString(), ctx.company.id, a.p_all ? 1 : 0).all();
      return r.results.map((s) => ({ ...s, active: Boolean(s.active) }));
    },
  },

  lg_supplier_upsert: {
    roles: 'member',
    async handler(ctx, a) {
      write(ctx);
      const p = a.p && typeof a.p === 'object' ? a.p : {};
      const name = text(p.name, 120);
      if (!name) fail('invalid_name');
      const lead = p.lead_days == null || p.lead_days === '' ? null : int(p.lead_days);
      if (lead != null && !(lead >= 0 && lead <= 365)) fail('invalid_amount');
      const dup = await ctx.db.prepare('SELECT id FROM suppliers WHERE company_id = ? AND lower(name) = lower(?) AND id != ?').bind(ctx.company.id, name, String(p.id ?? '')).first();
      if (dup) return { ok: false, error: 'duplicate_supplier' };
      const vals = [name, text(p.contact_name, 80), text(p.phone, 30), text(p.email, 120), text(p.address, 200), text(p.payment_terms, 60), lead, text(p.note, 500)];
      if (p.id) {
        const r = await ctx.db.prepare(`UPDATE suppliers SET name = ?, contact_name = ?, phone = ?, email = ?, address = ?, payment_terms = ?, lead_days = ?, note = ?,
            active = ?, updated_at = ? WHERE id = ? AND company_id = ?`).bind(...vals, p.active === false ? 0 : 1, ctx.now, String(p.id), ctx.company.id).run();
        if (!r.meta.changes) fail('unknown_supplier', 404);
        // le nom affiché sur les fiches produit suit
        await ctx.db.prepare('UPDATE products SET supplier = ? WHERE supplier_id = ? AND company_id = ?').bind(name, String(p.id), ctx.company.id).run();
        await audit(ctx, 'supplier_update', 'supplier', p.id, { name });
        return { ok: true, id: p.id };
      }
      const id = uuid();
      await ctx.db.prepare('INSERT INTO suppliers (id, company_id, name, contact_name, phone, email, address, payment_terms, lead_days, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, ctx.company.id, ...vals).run();
      await audit(ctx, 'supplier_create', 'supplier', id, { name });
      return { ok: true, id };
    },
  },

  // ----------------------------------------------------------------- bons de commande
  lg_purchase_orders_list: {
    roles: 'member',
    async handler(ctx, a) {
      view(ctx);
      const st = a.p_status === 'open' ? null : ['draft', 'sent', 'partial', 'received', 'cancelled'].includes(a.p_status) ? a.p_status : null;
      const openOnly = a.p_status === 'open' ? 1 : 0;
      const r = await ctx.db.prepare(`SELECT o.*, s.name AS supplier, s.phone AS supplier_phone,
            (SELECT count(*) FROM purchase_order_lines l WHERE l.po_id = o.id) AS lines,
            (SELECT coalesce(sum(qty_ordered), 0) FROM purchase_order_lines l WHERE l.po_id = o.id) AS units,
            (SELECT coalesce(sum(qty_received), 0) FROM purchase_order_lines l WHERE l.po_id = o.id) AS units_received
          FROM purchase_orders o JOIN suppliers s ON s.id = o.supplier_id
          WHERE o.company_id = ? AND (? IS NULL OR o.status = ?) AND (? = 0 OR o.status IN ('draft', 'sent', 'partial')) AND (? IS NULL OR o.supplier_id = ?)
          ORDER BY o.created_at DESC LIMIT 300`)
        .bind(ctx.company.id, st, st, openOnly, a.p_supplier ?? null, a.p_supplier ?? null).all();
      const today = ctx.now.slice(0, 10);
      return r.results.map((o) => ({ ...o, late: ['sent', 'partial'].includes(o.status) && o.expected_on != null && o.expected_on < today }));
    },
  },

  lg_purchase_order_detail: {
    roles: 'member',
    async handler(ctx, a) {
      view(ctx);
      const po = await poOf(ctx, a.p_id);
      const [s, lines] = await ctx.db.batch([
        ctx.db.prepare('SELECT * FROM suppliers WHERE id = ?').bind(po.supplier_id),
        ctx.db.prepare(`SELECT l.*, p.name, p.sku, p.barcode, p.stock FROM purchase_order_lines l JOIN products p ON p.id = l.product_id
            WHERE l.po_id = ? AND l.company_id = ? ORDER BY p.name`).bind(po.id, ctx.company.id),
      ]);
      const c = ctx.company;
      return { ...po, supplier: s.results[0], lines: lines.results,
        company: { name: c.name, phone: c.phone, city: c.city, address: c.config.company_address, ninea: c.config.company_ninea, rc: c.config.company_rc } };
    },
  },

  lg_purchase_order_create: {
    roles: 'member',
    async handler(ctx, a) {
      write(ctx);
      const s = await supplierOf(ctx, a.p_supplier);
      if (!s.active) fail('unknown_supplier', 404);
      const lines = await cleanLines(ctx, a.p_lines);
      const id = uuid();
      await ctx.db.batch(createStatements(ctx, { id, supplier: s.id, lines, expected: dateOrNull(a.p_expected_on), note: text(a.p_note, 500), hub: a.p_hub ?? null }));
      const po = await poOf(ctx, id);
      await audit(ctx, 'po_create', 'purchase_order', id, { number: po.number, supplier: s.name, total: po.total_fcfa });
      return { ok: true, id, number: po.number, total_fcfa: po.total_fcfa };
    },
  },

  // Modifier un bon tant qu'il est en brouillon (lignes, date attendue, note).
  lg_purchase_order_update: {
    roles: 'member',
    async handler(ctx, a) {
      write(ctx);
      const po = await poOf(ctx, a.p_id);
      if (po.status !== 'draft') return { ok: false, error: 'po_not_draft' };
      const stmts = [guard(ctx.db, "(SELECT status FROM purchase_orders WHERE id = ?) = 'draft'", [po.id])];
      let total = po.total_fcfa;
      if (a.p_lines !== undefined) {
        const lines = await cleanLines(ctx, a.p_lines);
        total = lines.reduce((s, l) => s + l.qty * l.cost, 0);
        stmts.push(ctx.db.prepare('DELETE FROM purchase_order_lines WHERE po_id = ? AND company_id = ?').bind(po.id, ctx.company.id));
        stmts.push(...lines.map((l) => ctx.db.prepare('INSERT INTO purchase_order_lines (id, company_id, po_id, product_id, qty_ordered, unit_cost_fcfa) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(uuid(), ctx.company.id, po.id, l.product_id, l.qty, l.cost)));
      }
      stmts.push(ctx.db.prepare('UPDATE purchase_orders SET expected_on = ?, note = ?, total_fcfa = ?, updated_at = ? WHERE id = ? AND company_id = ?')
        .bind(a.p_expected_on === undefined ? po.expected_on : dateOrNull(a.p_expected_on), a.p_note === undefined ? po.note : text(a.p_note, 500), total, ctx.now, po.id, ctx.company.id));
      await runBatch(ctx, stmts, 'po_not_draft');
      return { ok: true, total_fcfa: total };
    },
  },

  // Envoi au fournisseur : le bon devient « envoyé » (l'écran ouvre WhatsApp ou l'impression).
  lg_purchase_order_send: {
    roles: 'member',
    async handler(ctx, a) {
      write(ctx);
      const po = await poOf(ctx, a.p_id);
      if (!['draft', 'sent'].includes(po.status)) return { ok: false, error: 'po_closed' };
      if (po.status === 'draft') {
        await ctx.db.prepare("UPDATE purchase_orders SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ? AND company_id = ? AND status = 'draft'")
          .bind(ctx.now, ctx.now, po.id, ctx.company.id).run();
        await audit(ctx, 'po_send', 'purchase_order', po.id, { number: po.number });
      }
      return { ok: true, status: 'sent' };
    },
  },

  lg_purchase_order_cancel: {
    roles: 'member',
    async handler(ctx, a) {
      write(ctx);
      const po = await poOf(ctx, a.p_id);
      if (!['draft', 'sent'].includes(po.status)) return { ok: false, error: 'po_closed' }; // reçu en partie : solder plutôt
      const reason = text(a.p_reason, 200);
      if (!reason) fail('reason_required');
      const r = await ctx.db.prepare("UPDATE purchase_orders SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?, updated_at = ? WHERE id = ? AND company_id = ? AND status IN ('draft', 'sent')")
        .bind(ctx.now, reason, ctx.now, po.id, ctx.company.id).run();
      if (!r.meta.changes) return { ok: false, error: 'po_closed' };
      await audit(ctx, 'po_cancel', 'purchase_order', po.id, { number: po.number, reason });
      return { ok: true };
    },
  },

  // Solder un bon reçu en partie : le reste ne viendra pas (le bon passe « reçu »).
  lg_purchase_order_close: {
    roles: 'member',
    async handler(ctx, a) {
      write(ctx);
      const po = await poOf(ctx, a.p_id);
      if (po.status !== 'partial') return { ok: false, error: 'po_not_partial' };
      await ctx.db.prepare("UPDATE purchase_orders SET status = 'received', received_at = ?, note = trim(coalesce(note, '') || ' ' || ?), updated_at = ? WHERE id = ? AND company_id = ? AND status = 'partial'")
        .bind(ctx.now, `[soldé : ${text(a.p_reason, 150) ?? 'reliquat abandonné'}]`, ctx.now, po.id, ctx.company.id).run();
      await audit(ctx, 'po_close', 'purchase_order', po.id, { number: po.number });
      return { ok: true };
    },
  },

  /**
   * Réception d'un bon : p_lines [{ line_id, qty, location_code?, lot?, expires_on? }] (une livraison peut être partielle).
   * Chaque quantité entre en stock (mouvement « in », réf. = n° du bon), le dernier prix d'achat du produit est mis à
   * jour, le bon passe « reçu en partie » ou « reçu ». Rejouer la même réception (p_event) ne compte rien deux fois.
   */
  lg_purchase_order_receive: {
    roles: RECEIVE,
    async handler(ctx, a) {
      return idempotent(ctx, 'po_receive', a.p_event, async () => {
        const po = await poOf(ctx, a.p_id);
        if (!OPEN.includes(po.status)) return { ok: false, error: 'po_closed' };
        const lines = (await ctx.db.prepare('SELECT * FROM purchase_order_lines WHERE po_id = ? AND company_id = ?').bind(po.id, ctx.company.id).all()).results;
        const byId = new Map(lines.map((l) => [l.id, l]));
        const asked = (Array.isArray(a.p_lines) ? a.p_lines : []).filter((x) => int(x?.qty) > 0);
        if (!asked.length) fail('no_lines');
        const stmts = [guard(ctx.db, "(SELECT status FROM purchase_orders WHERE id = ?) IN ('draft', 'sent', 'partial')", [po.id])];
        const done = new Map(lines.map((l) => [l.id, l.qty_received]));
        for (const x of asked) {
          const l = byId.get(String(x.line_id));
          if (!l) fail('unknown_line', 404);
          const qty = int(x.qty);
          if (done.get(l.id) + qty > l.qty_ordered) return { ok: false, error: 'over_receipt', line_id: l.id, left: l.qty_ordered - done.get(l.id) };
          done.set(l.id, done.get(l.id) + qty);
          const loc = await locationOf(ctx, x.location_code);
          const lot = text(x.lot, 60)?.toUpperCase() ?? null; const exp = dateOrNull(x.expires_on);
          if (exp && exp < ctx.now.slice(0, 10)) return { ok: false, error: 'expired_lot', line_id: l.id };
          if ((lot || exp) && !loc) fail('location_required');
          // garde : la ligne n'a pas bougé depuis la lecture (deux réceptions en même temps)
          stmts.push(guard(ctx.db, '(SELECT qty_received FROM purchase_order_lines WHERE id = ?) = ?', [l.id, l.qty_received]));
          stmts.push(ctx.db.prepare('UPDATE purchase_order_lines SET qty_received = qty_received + ? WHERE id = ? AND company_id = ?').bind(qty, l.id, ctx.company.id));
          stmts.push(...receiveStatements(ctx, { product: l.product_id, qty, loc, lot, exp, ref: po.number, reason: text(a.p_ref, 80) ? `BL ${text(a.p_ref, 80)}` : null, po: po.id }));
          if (l.unit_cost_fcfa > 0) stmts.push(ctx.db.prepare('UPDATE products SET cost_fcfa = ? WHERE id = ? AND company_id = ?').bind(l.unit_cost_fcfa, l.product_id, ctx.company.id));
        }
        const complete = lines.every((l) => done.get(l.id) >= l.qty_ordered);
        stmts.push(ctx.db.prepare('UPDATE purchase_orders SET status = ?, received_at = CASE WHEN ? = 1 THEN ? ELSE received_at END, updated_at = ? WHERE id = ? AND company_id = ?')
          .bind(complete ? 'received' : 'partial', complete ? 1 : 0, ctx.now, ctx.now, po.id, ctx.company.id));
        await runBatch(ctx, stmts, 'po_changed');
        await audit(ctx, 'po_receive', 'purchase_order', po.id, { number: po.number, lines: asked.length, complete });
        return { ok: true, status: complete ? 'received' : 'partial', units: asked.reduce((s, x) => s + int(x.qty), 0) };
      });
    },
  },

  /**
   * Bons proposés : un brouillon par fournisseur pour les produits sous leur seuil, quantité = de quoi revenir à deux
   * fois le seuil, moins ce qui est déjà commandé. Les produits sans fournisseur sont signalés à part.
   */
  lg_purchase_orders_from_alerts: {
    roles: 'member',
    async handler(ctx, a) {
      write(ctx);
      const cid = ctx.company.id;
      const [prods, res] = await ctx.db.batch([
        ctx.db.prepare('SELECT id, name, stock, min_stock, cost_fcfa, supplier_id FROM products WHERE company_id = ? AND active = 1 AND min_stock IS NOT NULL AND stock IS NOT NULL').bind(cid),
        ctx.db.prepare(`SELECT oi.product_id, sum(max(oi.quantity - coalesce(oi.picked_qty, 0), 0)) AS qty FROM order_items oi JOIN orders o ON o.id = oi.order_id
            WHERE oi.company_id = ? AND o.status IN ('pending', 'processing') AND oi.line_status = 'open' AND oi.product_id IS NOT NULL GROUP BY oi.product_id`).bind(cid),
      ]);
      const reserved = new Map(res.results.map((r) => [r.product_id, r.qty])); const ordered = await onOrder(ctx);
      const bySupplier = new Map(); const orphans = [];
      for (const p of prods.results) {
        const available = p.stock - (reserved.get(p.id) ?? 0);
        if (available > p.min_stock) continue;
        const qty = Math.max(p.min_stock * 2 - available, 1) - (ordered.get(p.id) ?? 0);
        if (qty <= 0) continue; // déjà commandé
        if (!p.supplier_id) { orphans.push(p.name); continue; }
        if (a.p_supplier && a.p_supplier !== p.supplier_id) continue;
        (bySupplier.get(p.supplier_id) ?? bySupplier.set(p.supplier_id, []).get(p.supplier_id)).push({ product_id: p.id, qty, cost: p.cost_fcfa ?? 0 });
      }
      const created = [];
      for (const [sid, lines] of bySupplier) {
        const s = await ctx.db.prepare('SELECT id, name, active, lead_days FROM suppliers WHERE id = ? AND company_id = ?').bind(sid, cid).first();
        if (!s?.active) continue;
        const id = uuid();
        const expected = s.lead_days != null ? new Date(Date.parse(ctx.now) + s.lead_days * 86400000).toISOString().slice(0, 10) : null;
        await ctx.db.batch(createStatements(ctx, { id, supplier: sid, lines: lines.slice(0, MAX_LINES), expected, note: 'Proposé depuis les alertes de stock', hub: null }));
        const po = await poOf(ctx, id);
        created.push({ id, number: po.number, supplier: s.name, lines: lines.length, total_fcfa: po.total_fcfa });
      }
      if (created.length) await audit(ctx, 'po_from_alerts', 'purchase_order', null, { created: created.map((c) => c.number) });
      return { ok: true, created, without_supplier: orphans };
    },
  },
};

export { onOrder };
