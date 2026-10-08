// Cycle C3 — préparation : file, prise (verrou), scan article par article, rupture, colisage multi-colis, pesée,
// mise à quai, étiquettes, double contrôle, vagues, productivité.
// Portage de 20261007000300_preparation.sql, cycle3 (double contrôle), cycle4 (vagues, chemin de prélèvement),
// cycle6 (FEFO) et cycle7 (productivité). Préparation chez le vendeur (tâche sans lieu, le vendeur prépare)
// OU au hub (préparateur) : les deux, selon le lieu de la commande.
// Pas de verrou SELECT … FOR UPDATE : transitions par UPDATE conditionnel + assertions de lot (guard/runBatch).
import { fail, audit, idempotent, hasRole, text, int, uuid, parseJson, guard, runBatch, today, plusMinutes } from './core.js';
import { loadStock, pickLocation, lotHint, consumeStatements, locKey } from './stock.js';

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const HANDLING = ['fragile', 'lourd', 'liquide', 'alimentaire', 'froid', 'vivant', 'chimique'];

/** Code colis saisi ou scanné → forme canonique NXP-XXXXXX (6 derniers caractères suffisent). */
export const normCode = (c) => 'NXP-' + String(c ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(-6);
const productCode = (c) => String(c ?? '').trim().toUpperCase();
const lockLimit = (ctx) => plusMinutes(ctx.now, -Number(ctx.company.config.pick_lock_minutes ?? 15));
const isStaff = (ctx) => hasRole(ctx, ['picker', 'dock_chief']);

/** Qui peut préparer cette tâche : préparateur / chef de quai, ou le vendeur lui-même (lg_can_pick). */
const canPick = (ctx, t) => isStaff(ctx) || (t && t.vendor_id && t.vendor_id === ctx.user?.id);

async function taskFor(ctx, id) {
  const t = await ctx.db.prepare('SELECT * FROM pick_tasks WHERE id = ? AND company_id = ?').bind(String(id ?? ''), ctx.company.id).first();
  if (!t) fail('unknown_task', 404);
  return t;
}

// ----------------------------------------------------------------- entrée en préparation (lg_release_order)
/**
 * Instructions qui ouvrent la préparation d'une commande prête (payée, ou paiement à la livraison confirmé),
 * à mettre dans le même lot que l'écriture qui la rend prête. Sans effet si une tâche existe déjà ou s'il n'y a
 * rien à transporter (articles non expédiables).
 */
export function releaseStatements(ctx, order) {
  const db = ctx.db; const cid = ctx.company.id; const taskId = uuid();
  // réglage prep_at_vendor : la commande d'un vendeur membre se prépare chez lui (tâche sans lieu)
  // départ limite : 3 h avant l'heure promise, sinon 24 h après la commande
  const base = order.created_at && order.created_at > ctx.now ? order.created_at : ctx.now;
  const cutoff = order.promised_at ? plusMinutes(order.promised_at, -180) : plusMinutes(base, 24 * 60);
  return [
    db.prepare(
      `INSERT INTO pick_tasks (id, company_id, order_id, hub_id, vendor_id, cutoff_at, created_at)
       SELECT ?, o.company_id, o.id,
              CASE WHEN json_extract(c.settings, '$.prep_at_vendor') = 1 AND o.vendor_id IS NOT NULL THEN NULL ELSE o.hub_id END,
              o.vendor_id, ?, ? FROM orders o JOIN companies c ON c.id = o.company_id
        WHERE o.id = ? AND o.company_id = ? AND o.status <> 'cancelled'
          AND (o.payment_status = 'paid' OR (o.payment_method = 'cod' AND o.cod_confirmed_at IS NOT NULL))
          AND NOT EXISTS (SELECT 1 FROM pick_tasks t WHERE t.order_id = o.id AND t.status <> 'cancelled')
          AND EXISTS (SELECT 1 FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
                       WHERE oi.order_id = o.id AND oi.line_status <> 'cancelled' AND coalesce(p.is_shippable, 1) = 1)`,
    ).bind(taskId, cutoff, ctx.now, order.id, cid),
    db.prepare(
      `INSERT INTO pick_lines (id, company_id, task_id, order_item_id, product_id, qty_ordered)
       SELECT lower(hex(randomblob(16))), oi.company_id, ?, oi.id, oi.product_id, oi.quantity
         FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = ? AND oi.company_id = ? AND oi.line_status <> 'cancelled' AND coalesce(p.is_shippable, 1) = 1
          AND EXISTS (SELECT 1 FROM pick_tasks WHERE id = ?)`,
    ).bind(taskId, order.id, cid, taskId),
  ];
}

// ----------------------------------------------------------------- scan (partagé par la préparation simple et la vague)
async function pickScan(ctx, taskId, code, manual, lineId) {
  const t = await taskFor(ctx, taskId);
  if (!canPick(ctx, t)) fail('forbidden', 403);
  if (t.status !== 'picking') fail('task_not_picking');
  if (t.picker_id !== ctx.user.id) fail('not_your_task', 403);
  const lines = (await ctx.db.prepare(
    `SELECT l.*, p.name AS pname, upper(p.barcode) AS barcode, upper(p.sku) AS sku, oi.unit_price_fcfa
       FROM pick_lines l JOIN order_items oi ON oi.id = l.order_item_id LEFT JOIN products p ON p.id = l.product_id
      WHERE l.task_id = ? AND l.company_id = ?`,
  ).bind(t.id, ctx.company.id).all()).results;
  const c = productCode(code);
  const matches = (l) => l.product_id && c && (l.barcode === c || l.sku === c || 'NXI-' + l.product_id.slice(0, 8).toUpperCase() === c);
  let l = manual ? lines.find((x) => x.id === lineId) : lines.filter(matches).sort((a, b) => (b.qty_picked < b.qty_ordered) - (a.qty_picked < a.qty_ordered) || a.id.localeCompare(b.id))[0];
  if (manual && !l) fail('unknown_line', 404);
  if (!l) {
    const p = c ? await ctx.db.prepare("SELECT name FROM products WHERE company_id = ? AND (upper(barcode) = ? OR upper(sku) = ? OR 'NXI-' || upper(substr(id, 1, 8)) = ?) LIMIT 1")
      .bind(ctx.company.id, c, c, c).first() : null;
    return { ok: false, error: 'unexpected_product', product: p?.name ?? null };
  }
  if (l.qty_picked >= l.qty_ordered) return { ok: false, error: 'line_complete', line_id: l.id };
  const qty = l.qty_picked + 1; const done = qty >= l.qty_ordered;
  // stock : l'emplacement du hub de la tâche, lot qui périme le plus tôt d'abord
  const stock = l.product_id ? await loadStock(ctx, [l.product_id]) : new Map();
  const loc = l.product_id ? pickLocation(stock.get(l.product_id), t.hub_id, today(ctx)) : null;
  await runBatch(ctx, [
    guard(ctx.db, '(SELECT qty_picked FROM pick_lines WHERE id = ?) = ?', [l.id, l.qty_picked]),
    ctx.db.prepare(`UPDATE pick_lines SET qty_picked = ?, status = ?, manual_entry = max(manual_entry, ?), picked_at = ? WHERE id = ? AND company_id = ?`)
      .bind(qty, done ? 'picked' : 'pending', manual ? 1 : 0, ctx.now, l.id, ctx.company.id),
    ctx.db.prepare('UPDATE order_items SET picked_qty = ?, line_status = CASE WHEN ? = 1 THEN \'picked\' ELSE line_status END WHERE id = ? AND company_id = ?')
      .bind(qty, done ? 1 : 0, l.order_item_id, ctx.company.id),
    ctx.db.prepare('UPDATE pick_tasks SET last_activity_at = ? WHERE id = ? AND company_id = ?').bind(ctx.now, t.id, ctx.company.id),
    ...consumeStatements(ctx, loc, 1, l.id, today(ctx)),
  ], 'line_complete');
  if (manual) await audit(ctx, 'pick_manual_confirm', 'pick_line', l.id, { task: t.id });
  return {
    ok: true, line_id: l.id, qty_picked: qty, qty_ordered: l.qty_ordered, line_done: done,
    task_done: !lines.some((x) => x.id !== l.id && x.status === 'pending') && done,
  };
}

const kindFor = (v) => (v == null ? 'unmeasured' : v < 5 ? 'small' : v < 30 ? 'medium' : 'large');

export default {
  // ----------------------------------------------------------------- file et détail
  lg_pick_queue: {
    roles: 'member',
    async handler(ctx, a) {
      const staff = hasRole(ctx, ['picker', 'dock_chief', 'dispatcher']);
      if (!staff && ctx.member !== 'vendor') fail('forbidden', 403);
      const r = await ctx.db.prepare(
        `SELECT t.id, t.order_id, t.status, t.cutoff_at, t.picker_id, t.last_activity_at, o.number, o.delivery_zone AS zone, o.vendor_name,
                o.payment_method, u.name AS picker_name,
                (SELECT COUNT(*) FROM pick_lines l WHERE l.task_id = t.id) AS lines,
                (SELECT coalesce(sum(qty_ordered), 0) FROM pick_lines l WHERE l.task_id = t.id) AS units
           FROM pick_tasks t JOIN orders o ON o.id = t.order_id LEFT JOIN users u ON u.id = t.picker_id
          WHERE t.company_id = ? AND t.status IN ('todo', 'picking') AND (? IS NULL OR t.hub_id = ?) AND (? = 1 OR t.vendor_id = ?)
          ORDER BY t.cutoff_at IS NULL, t.cutoff_at, o.delivery_zone LIMIT 300`,
      ).bind(ctx.company.id, a.p_hub ?? null, a.p_hub ?? null, staff ? 1 : 0, ctx.user.id).all();
      const limit = lockLimit(ctx);
      return r.results.map(({ last_activity_at, number, ...t }) => ({
        ...t, order_short: String(number), order_number: number,
        locked: Boolean(t.picker_id && t.picker_id !== ctx.user.id && last_activity_at && last_activity_at > limit),
      }));
    },
  },

  lg_pick_task_detail: {
    roles: 'member',
    async handler(ctx, a) {
      const t = await taskFor(ctx, a.p_task);
      if (!canPick(ctx, t) && !hasRole(ctx, ['dispatcher', 'support'])) fail('forbidden', 403);
      const [o, lines, pk] = await ctx.db.batch([
        ctx.db.prepare('SELECT id, number, delivery_zone, payment_method, vendor_name FROM orders WHERE id = ? AND company_id = ?').bind(t.order_id, ctx.company.id),
        ctx.db.prepare(
          `SELECT l.*, coalesce(oi.product_name, p.name) AS name, p.barcode, p.sku, p.handling, p.weight_g
             FROM pick_lines l JOIN order_items oi ON oi.id = l.order_item_id LEFT JOIN products p ON p.id = l.product_id
            WHERE l.task_id = ? AND l.company_id = ?`).bind(t.id, ctx.company.id),
        ctx.db.prepare('SELECT code, status, seq_in_order AS seq, count_in_order AS count, weight_g FROM packages WHERE pick_task_id = ? AND company_id = ? ORDER BY seq_in_order')
          .bind(t.id, ctx.company.id),
      ]);
      const order = o.results[0];
      const stock = await loadStock(ctx, lines.results.map((l) => l.product_id));
      const day = today(ctx); const alert = Number(ctx.company.config.expiry_alert_days ?? 30);
      const out = lines.results.map((l) => {
        const loc = l.product_id ? pickLocation(stock.get(l.product_id), t.hub_id, day) : null;
        return {
          id: l.id, order_item_id: l.order_item_id, product_id: l.product_id, name: l.name, barcode: l.barcode, sku: l.sku,
          internal_code: l.product_id ? 'NXI-' + l.product_id.slice(0, 8).toUpperCase() : null,
          qty_ordered: l.qty_ordered, qty_picked: l.qty_picked, status: l.status, handling: parseJson(l.handling, []), weight_g: l.weight_g,
          manual_entry: Boolean(l.manual_entry), location: loc?.code ?? null, lot: lotHint(loc, day, alert),
        };
      }).sort((x, y) => locKey(x.location).localeCompare(locKey(y.location)) || x.name.localeCompare(y.name));
      return {
        task: t,
        order: { id: order.id, short: String(order.number), number: order.number, zone: order.delivery_zone, payment_method: order.payment_method, vendor_name: order.vendor_name },
        lines: out, packages: pk.results,
      };
    },
  },

  // ----------------------------------------------------------------- prise (verrou) et libération
  lg_pick_take: {
    roles: 'member',
    async handler(ctx, a) {
      const t = await taskFor(ctx, a.p_task);
      if (!canPick(ctx, t)) fail('forbidden', 403);
      if (t.status !== 'todo' && t.status !== 'picking') fail('task_not_open');
      const [r] = await ctx.db.batch([
        ctx.db.prepare(
          `UPDATE pick_tasks SET picker_id = ?, status = 'picking', started_at = coalesce(started_at, ?), last_activity_at = ?
            WHERE id = ? AND company_id = ? AND status IN ('todo', 'picking')
              AND (picker_id IS NULL OR picker_id = ? OR last_activity_at IS NULL OR last_activity_at <= ?)`,
        ).bind(ctx.user.id, ctx.now, ctx.now, t.id, ctx.company.id, ctx.user.id, lockLimit(ctx)),
        ctx.db.prepare(
          `UPDATE orders SET status = 'processing', processing_at = coalesce(processing_at, ?), updated_at = ?
            WHERE id = ? AND company_id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM pick_tasks WHERE id = ? AND picker_id = ?)`,
        ).bind(ctx.now, ctx.now, t.order_id, ctx.company.id, t.id, ctx.user.id),
      ]);
      if (!r.meta.changes) fail('task_locked', 409);
      return { ok: true };
    },
  },

  lg_pick_release: {
    roles: 'member',
    async handler(ctx, a) {
      const r = await ctx.db.prepare(
        `UPDATE pick_tasks SET picker_id = NULL, last_activity_at = NULL
          WHERE id = ? AND company_id = ? AND status IN ('todo', 'picking') AND (picker_id = ? OR ? = 1)`,
      ).bind(String(a.p_task ?? ''), ctx.company.id, ctx.user.id, hasRole(ctx, ['dock_chief']) ? 1 : 0).run();
      return { ok: r.meta.changes > 0 };
    },
  },

  // ----------------------------------------------------------------- scan, rupture
  // p_code : code-barres, référence vendeur ou code interne NXI-XXXXXXXX ; p_line pour une confirmation manuelle.
  lg_pick_scan: {
    roles: 'member',
    async handler(ctx, a) {
      return idempotent(ctx, 'pick_scan', a.p_event, () => pickScan(ctx, a.p_task, a.p_code, Boolean(a.p_manual), a.p_line));
    },
  },

  // Rupture : p_qty_found = quantité réellement trouvée (0 = rien). Le stock affiché du produit passe à zéro.
  lg_pick_short: {
    roles: 'member',
    async handler(ctx, a) {
      return idempotent(ctx, 'pick_short', a.p_event, async () => {
        const t = await taskFor(ctx, a.p_task);
        if (!canPick(ctx, t)) fail('forbidden', 403);
        if (t.status !== 'picking') fail('task_not_picking');
        const l = await ctx.db.prepare(
          'SELECT l.*, oi.unit_price_fcfa FROM pick_lines l JOIN order_items oi ON oi.id = l.order_item_id WHERE l.id = ? AND l.task_id = ? AND l.company_id = ?',
        ).bind(String(a.p_line ?? ''), t.id, ctx.company.id).first();
        if (!l) fail('unknown_line', 404);
        const found = int(a.p_qty_found);
        if (found == null || found < 0 || found >= l.qty_ordered) fail('invalid_quantity');
        const before = l.status === 'short' ? l.qty_picked : l.qty_ordered;   // unités qui étaient facturables
        const extra = Math.max(found - l.qty_picked, 0);                       // unités prises en plus en rayon
        const stock = extra && l.product_id ? await loadStock(ctx, [l.product_id]) : new Map();
        const loc = extra && l.product_id ? pickLocation(stock.get(l.product_id), t.hub_id, today(ctx)) : null;
        await runBatch(ctx, [
          guard(ctx.db, "(SELECT status FROM pick_tasks WHERE id = ?) = 'picking'", [t.id]),
          ctx.db.prepare("UPDATE pick_lines SET qty_picked = ?, status = 'short', picked_at = ? WHERE id = ? AND company_id = ?").bind(found, ctx.now, l.id, ctx.company.id),
          ctx.db.prepare("UPDATE order_items SET picked_qty = ?, line_status = 'short' WHERE id = ? AND company_id = ?").bind(found, l.order_item_id, ctx.company.id),
          ctx.db.prepare('UPDATE products SET stock = 0, updated_at = ? WHERE id = ? AND company_id = ? AND coalesce(stock, 0) > 0').bind(ctx.now, l.product_id, ctx.company.id),
          ctx.db.prepare('UPDATE pick_tasks SET last_activity_at = ? WHERE id = ? AND company_id = ?').bind(ctx.now, t.id, ctx.company.id),
          // le montant à encaisser baisse d'autant (même chiffre pour le chauffeur et la facture)
          ctx.db.prepare('UPDATE orders SET shortage_fcfa = shortage_fcfa + ?, updated_at = ? WHERE id = ? AND company_id = ?')
            .bind((before - found) * l.unit_price_fcfa, ctx.now, t.order_id, ctx.company.id),
          ...consumeStatements(ctx, loc, extra, l.id, today(ctx)),
        ], 'task_not_picking');
        // message au client (remplacer, rembourser, attendre) : cycle C8 ; sa réponse arrive dans « Demandes »
        await audit(ctx, 'pick_short', 'pick_line', l.id, { ordered: l.qty_ordered, found });
        const pending = await ctx.db.prepare("SELECT COUNT(*) AS n FROM pick_lines WHERE task_id = ? AND company_id = ? AND status = 'pending'").bind(t.id, ctx.company.id).first('n');
        return { ok: true, line_id: l.id, missing: l.qty_ordered - found, task_done: pending === 0 };
      });
    },
  },

  // ----------------------------------------------------------------- colisage
  // p_packages : [{ weight_g, length_cm, width_cm, height_cm, handling:[…], items:[{ order_item_id, quantity }] }] ;
  // un seul colis sans « items » = tout ce qui a été prélevé.
  lg_pack: {
    roles: 'member',
    async handler(ctx, a) {
      return idempotent(ctx, 'pack', a.p_event, async () => {
        const t = await taskFor(ctx, a.p_task);
        if (!canPick(ctx, t)) fail('forbidden', 403);
        if (t.status !== 'picking') fail('task_not_picking');
        const [linesR, orderR] = await ctx.db.batch([
          ctx.db.prepare('SELECT l.*, p.handling FROM pick_lines l LEFT JOIN products p ON p.id = l.product_id WHERE l.task_id = ? AND l.company_id = ?').bind(t.id, ctx.company.id),
          ctx.db.prepare('SELECT * FROM orders WHERE id = ? AND company_id = ?').bind(t.order_id, ctx.company.id),
        ]);
        const lines = linesR.results; const o = orderR.results[0];
        if (lines.some((l) => l.status === 'pending')) fail('lines_pending');
        const picked = lines.filter((l) => l.qty_picked > 0);
        if (!picked.length) fail('nothing_to_pack');
        const pk = Array.isArray(a.p_packages) ? a.p_packages : [];
        if (pk.length < 1 || pk.length > 20) fail('invalid_package_count');
        if (o.status === 'cancelled') fail('order_cancelled');
        const cfg = ctx.company.config;
        if (pk.some((p) => !(int(p?.weight_g) > 0))) fail('weight_required');
        // chaque unité prélevée doit se trouver dans exactement un colis
        const contents = pk.map((p) => {
          if (p?.items == null) {
            if (pk.length > 1) fail('items_required_for_multi_package');
            return picked.map((l) => ({ order_item_id: l.order_item_id, quantity: l.qty_picked }));
          }
          if (!Array.isArray(p.items)) fail('package_contents_mismatch');
          const m = new Map();
          for (const it of p.items) {
            const q = int(it?.quantity);
            if (!(q > 0)) fail('invalid_quantity');
            m.set(String(it.order_item_id), (m.get(String(it.order_item_id)) ?? 0) + q);
          }
          return [...m].map(([order_item_id, quantity]) => ({ order_item_id, quantity }));
        });
        const sum = new Map();
        contents.flat().forEach((x) => sum.set(x.order_item_id, (sum.get(x.order_item_id) ?? 0) + x.quantity));
        if (lines.some((l) => (sum.get(l.order_item_id) ?? 0) !== l.qty_picked) || [...sum.keys()].some((k) => !lines.some((l) => l.order_item_id === k))) {
          fail('package_contents_mismatch');
        }
        // codes colis : tirés au hasard, vérifiés contre ceux de l'entreprise
        const codes = [];
        while (codes.length < pk.length) {
          const batch = Array.from({ length: pk.length - codes.length + 2 }, () => 'NXP-' + Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => ALPHABET[b % ALPHABET.length]).join(''));
          const taken = new Set((await ctx.db.prepare(`SELECT code FROM packages WHERE company_id = ? AND code IN (${batch.map(() => '?').join(',')})`)
            .bind(ctx.company.id, ...batch).all()).results.map((r) => r.code));
          for (const c of batch) if (!taken.has(c) && !codes.includes(c) && codes.length < pk.length) codes.push(c);
        }
        const checkRequired = Number(cfg.double_check_fcfa ?? 100000) > 0 && o.total_fcfa >= Number(cfg.double_check_fcfa ?? 100000) ? 1 : 0;
        const holder = t.hub_id ? ['hub', t.hub_id] : ['vendor', t.vendor_id];
        const stmts = [guard(ctx.db, "(SELECT status FROM pick_tasks WHERE id = ?) = 'picking'", [t.id])];
        const out = [];
        pk.forEach((p, i) => {
          const w = int(p?.weight_g);
          if (!(w > 0)) fail('weight_required');
          const id = uuid();
          // mentions : celles saisies + celles des fiches produit du colis ; « lourd » au-delà du seuil
          const hand = new Set((Array.isArray(p.handling) ? p.handling : []).filter((h) => HANDLING.includes(h)));
          for (const x of contents[i]) parseJson(lines.find((l) => l.order_item_id === x.order_item_id)?.handling, []).forEach((h) => hand.add(h));
          if (w >= Number(cfg.heavy_kg ?? 15) * 1000) hand.add('lourd');
          const dims = ['length_cm', 'width_cm', 'height_cm'].map((k) => { const v = p[k] == null || p[k] === '' ? null : Number(p[k]); return v != null && Number.isFinite(v) && v > 0 ? v : null; });
          const vol = dims.every((v) => v != null) ? Math.round((dims[0] * dims[1] * dims[2]) / 10) / 100 : null;
          stmts.push(ctx.db.prepare(
            `INSERT INTO packages (id, company_id, code, order_id, pick_task_id, hub_id, seq_in_order, count_in_order, weight_g, length_cm, width_cm, height_cm,
               volume_l, handling, zone, status, holder_type, holder_id, check_required, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'packed', ?, ?, ?, ?, ?)`,
          ).bind(id, ctx.company.id, codes[i], o.id, t.id, t.hub_id, i + 1, pk.length, w, ...dims, vol, JSON.stringify([...hand]), o.delivery_zone,
            holder[0], holder[1], checkRequired, ctx.now, ctx.now));
          for (const x of contents[i]) {
            stmts.push(ctx.db.prepare('INSERT INTO package_items (company_id, package_id, order_item_id, quantity) VALUES (?, ?, ?, ?)')
              .bind(ctx.company.id, id, x.order_item_id, x.quantity));
          }
          stmts.push(ctx.db.prepare("INSERT INTO scan_events (company_id, client_event_id, package_id, event, actor_id, hub_id, device_at, meta) VALUES (?, ?, ?, 'pack', ?, ?, ?, ?)")
            .bind(ctx.company.id, i === 0 && a.p_event ? String(a.p_event) : uuid(), id, ctx.user.id, t.hub_id, text(a.p_device_at, 40) ?? ctx.now, JSON.stringify({ task: t.id })));
          out.push({ id, code: codes[i], seq: i + 1, count: pk.length });
        });
        stmts.push(ctx.db.prepare("UPDATE pick_tasks SET status = 'packed', done_at = ?, last_activity_at = ? WHERE id = ? AND company_id = ?").bind(ctx.now, ctx.now, t.id, ctx.company.id));
        stmts.push(ctx.db.prepare("UPDATE orders SET status = 'processing', processing_at = coalesce(processing_at, ?), updated_at = ? WHERE id = ? AND company_id = ? AND status = 'pending'")
          .bind(ctx.now, ctx.now, o.id, ctx.company.id));
        await runBatch(ctx, stmts, 'task_not_picking');
        // message « commande préparée » au client : cycle C8
        return { ok: true, packages: out, zone: o.delivery_zone };
      });
    },
  },

  // ----------------------------------------------------------------- mise à quai (aussi pour un colis revenu au hub)
  lg_stage: {
    roles: 'member',
    async handler(ctx, a) {
      if (!isStaff(ctx) && ctx.member !== 'vendor') fail('forbidden', 403);
      return idempotent(ctx, 'stage', a.p_event, async () => {
        const hub = a.p_hub || ctx.roles.find((r) => (r.role === 'picker' || r.role === 'dock_chief') && r.hub_id)?.hub_id || null;
        const p = await ctx.db.prepare(
          `SELECT p.*, t.vendor_id AS task_vendor, o.status AS order_status, o.payment_method, o.payment_status, o.cod_confirmed_at
             FROM packages p JOIN orders o ON o.id = p.order_id LEFT JOIN pick_tasks t ON t.id = p.pick_task_id
            WHERE p.company_id = ? AND p.code = ?`,
        ).bind(ctx.company.id, normCode(a.p_code)).first();
        if (!p) return { ok: false, error: 'unknown_package' };
        if (!isStaff(ctx) && !(p.task_vendor && p.task_vendor === ctx.user.id)) fail('forbidden', 403);
        if (p.status === 'staged') return { ok: true, already: true, zone: p.zone, code: p.code };
        if (p.status !== 'packed' && p.status !== 'returned_hub') return { ok: false, error: 'bad_status', status: p.status };
        // double contrôle exigé au-delà du seuil de valeur, par une autre personne que le préparateur
        if (p.check_required && !p.checked_at) return { ok: false, error: 'double_check_required', code: p.code };
        if (p.status === 'returned_hub' && p.attempts >= Number(ctx.company.config.max_attempts ?? 2)) return { ok: false, error: 'max_attempts_reached' };
        if (p.order_status === 'cancelled') return { ok: false, error: 'order_blocked' };
        if (p.payment_method === 'cod' && p.payment_status !== 'paid' && !p.cod_confirmed_at) return { ok: false, error: 'cod_not_confirmed' };
        const where = hub ?? p.hub_id;
        await runBatch(ctx, [
          guard(ctx.db, '(SELECT status FROM packages WHERE id = ?) = ?', [p.id, p.status]),
          ctx.db.prepare(
            `UPDATE packages SET status = 'staged', hub_id = coalesce(?, hub_id),
               holder_type = CASE WHEN ? IS NULL THEN holder_type ELSE 'hub' END, holder_id = CASE WHEN ? IS NULL THEN holder_id ELSE ? END, updated_at = ?
             WHERE id = ? AND company_id = ?`,
          ).bind(where, where, where, where, ctx.now, p.id, ctx.company.id),
          ctx.db.prepare("INSERT INTO scan_events (company_id, client_event_id, package_id, event, actor_id, hub_id, manual_entry, device_at) VALUES (?, ?, ?, 'stage', ?, ?, ?, ?)")
            .bind(ctx.company.id, a.p_event ? String(a.p_event) : uuid(), p.id, ctx.user.id, where, a.p_manual ? 1 : 0, text(a.p_device_at, 40) ?? ctx.now),
          ctx.db.prepare(
            `UPDATE pick_tasks SET status = 'staged' WHERE id = ? AND company_id = ? AND status = 'packed'
               AND NOT EXISTS (SELECT 1 FROM packages WHERE pick_task_id = ? AND status = 'packed')`,
          ).bind(p.pick_task_id, ctx.company.id, p.pick_task_id),
        ], 'bad_status');
        const left = await ctx.db.prepare("SELECT COUNT(*) AS n FROM packages WHERE order_id = ? AND company_id = ? AND status IN ('created', 'packed')")
          .bind(p.order_id, ctx.company.id).first('n');
        return { ok: true, code: p.code, zone: p.zone, order_complete: left === 0 };
      });
    },
  },

  // Étiquette (annexe C) : rien de personnel, ni nom, ni téléphone, ni montant.
  lg_labels: {
    roles: 'member',
    async handler(ctx, a) {
      const t = a.p_task ? await taskFor(ctx, a.p_task) : null;
      if (!hasRole(ctx, ['picker', 'dock_chief', 'dispatcher']) && !(t && canPick(ctx, t))) fail('forbidden', 403);
      if (a.p_code) await audit(ctx, 'label_reprint', 'package', normCode(a.p_code));
      const r = await ctx.db.prepare(
        `SELECT p.code, coalesce(p.zone, 'SANS ZONE') AS zone, p.seq_in_order AS seq, p.count_in_order AS count, o.number, o.landmark AS quarter,
                p.weight_g, p.handling, (o.payment_method = 'cod' AND o.payment_status <> 'paid') AS cod, p.created_at AS packed_at, h.name AS hub
           FROM packages p JOIN orders o ON o.id = p.order_id LEFT JOIN hubs h ON h.id = p.hub_id AND h.company_id = p.company_id
          WHERE p.company_id = ? AND ((? IS NOT NULL AND p.pick_task_id = ?) OR (? IS NOT NULL AND p.code = ?))
          ORDER BY p.order_id, p.seq_in_order`,
      ).bind(ctx.company.id, t?.id ?? null, t?.id ?? null, a.p_code ? 1 : null, a.p_code ? normCode(a.p_code) : null).all();
      return r.results.map(({ number, ...x }) => ({ ...x, order_short: String(number), handling: parseJson(x.handling, []), cod: Boolean(x.cod), company: ctx.company.name }));
    },
  },

  // Double contrôle d'un colis de valeur, par une autre personne que le préparateur ; écart → incident.
  lg_double_check: {
    roles: ['picker', 'dock_chief'],
    async handler(ctx, a) {
      return idempotent(ctx, 'double_check', a.p_event, async () => {
        const p = await ctx.db.prepare('SELECT p.*, t.picker_id FROM packages p LEFT JOIN pick_tasks t ON t.id = p.pick_task_id WHERE p.company_id = ? AND p.code = ?')
          .bind(ctx.company.id, normCode(a.p_code)).first();
        if (!p) return { ok: false, error: 'unknown_package' };
        if (!p.check_required) return { ok: true, not_required: true };
        if (p.picker_id === ctx.user.id) return { ok: false, error: 'same_person' };
        if (a.p_ok === false) {
          await ctx.db.batch([
            ctx.db.prepare("INSERT INTO counters (company_id, key, n) VALUES (?, 'incident', 1) ON CONFLICT (company_id, key) DO UPDATE SET n = n + 1").bind(ctx.company.id),
            ctx.db.prepare(
              `INSERT INTO incidents (id, company_id, number, kind, package_id, order_id, description, photos, reported_by, responsible_type, responsible_id, due_at)
               VALUES (?, ?, (SELECT n FROM counters WHERE company_id = ? AND key = 'incident'), 'missing_item', ?, ?, ?, ?, ?, 'hub', ?, ?)`,
            ).bind(uuid(), ctx.company.id, ctx.company.id, p.id, p.order_id, text(a.p_note, 500) ?? 'Écart constaté au double contrôle',
              JSON.stringify(a.p_photo_path ? [String(a.p_photo_path)] : []), ctx.user.id, p.hub_id, plusMinutes(ctx.now, 240)),
          ]);
          return { ok: true, incident: true };
        }
        await ctx.db.batch([
          ctx.db.prepare('UPDATE packages SET checked_by = ?, checked_at = ?, check_photo = ?, updated_at = ? WHERE id = ? AND company_id = ?')
            .bind(ctx.user.id, ctx.now, text(a.p_photo_path, 300), ctx.now, p.id, ctx.company.id),
          ctx.db.prepare("INSERT INTO scan_events (company_id, client_event_id, package_id, event, actor_id, hub_id, device_at, meta) VALUES (?, ?, ?, 'inventory', ?, ?, ?, ?)")
            .bind(ctx.company.id, a.p_event ? String(a.p_event) : uuid(), p.id, ctx.user.id, p.hub_id, ctx.now, JSON.stringify({ double_check: true })),
        ]);
        return { ok: true, code: p.code };
      });
    },
  },

  // ----------------------------------------------------------------- vagues
  lg_wave_create: {
    roles: ['picker', 'dock_chief'],
    async handler(ctx, a) {
      const ids = Array.isArray(a.p_tasks) ? [...new Set(a.p_tasks.map(String))] : [];
      if (ids.length < 2 || ids.length > 12) fail('wave_size');
      const tasks = (await ctx.db.prepare(`SELECT * FROM pick_tasks WHERE company_id = ? AND id IN (${ids.map(() => '?').join(',')})`)
        .bind(ctx.company.id, ...ids).all()).results;
      if (tasks.length !== ids.length) fail('unknown_task', 404);
      const limit = lockLimit(ctx);
      for (const t of tasks) {
        if (t.status !== 'todo' && t.status !== 'picking') fail('task_not_open');
        if (t.picker_id && t.picker_id !== ctx.user.id && t.last_activity_at && t.last_activity_at > limit) fail('task_locked', 409);
      }
      // bacs : départ limite le plus proche d'abord, puis l'ordre choisi à l'écran
      tasks.sort((x, y) => (x.cutoff_at ?? '9999').localeCompare(y.cutoff_at ?? '9999') || ids.indexOf(x.id) - ids.indexOf(y.id));
      const id = uuid();
      const stmts = [
        ctx.db.prepare("INSERT INTO counters (company_id, key, n) VALUES (?, 'vague', 1) ON CONFLICT (company_id, key) DO UPDATE SET n = n + 1").bind(ctx.company.id),
        ctx.db.prepare("INSERT INTO waves (id, company_id, number, hub_id, picker_id, created_at) VALUES (?, ?, (SELECT n FROM counters WHERE company_id = ? AND key = 'vague'), ?, ?, ?) RETURNING number")
          .bind(id, ctx.company.id, ctx.company.id, tasks[0].hub_id, ctx.user.id, ctx.now),
      ];
      tasks.forEach((t, i) => {
        stmts.push(ctx.db.prepare(
          `UPDATE pick_tasks SET wave_id = ?, wave_bin = ?, picker_id = ?, status = 'picking', started_at = coalesce(started_at, ?), last_activity_at = ?
            WHERE id = ? AND company_id = ? AND status IN ('todo', 'picking') AND (picker_id IS NULL OR picker_id = ? OR last_activity_at IS NULL OR last_activity_at <= ?)`,
        ).bind(id, i + 1, ctx.user.id, ctx.now, ctx.now, t.id, ctx.company.id, ctx.user.id, limit));
        stmts.push(ctx.db.prepare("UPDATE orders SET status = 'processing', processing_at = coalesce(processing_at, ?), updated_at = ? WHERE id = ? AND company_id = ? AND status = 'pending'")
          .bind(ctx.now, ctx.now, t.order_id, ctx.company.id));
      });
      // pris entre-temps par quelqu'un d'autre : rien n'est écrit
      stmts.push(guard(ctx.db, '(SELECT COUNT(*) FROM pick_tasks WHERE wave_id = ?) = ?', [id, tasks.length]));
      const res = await runBatch(ctx, stmts, 'task_locked');
      return { ok: true, wave_id: id, number: res[1].results[0]?.number, bins: tasks.length };
    },
  },

  // Liste de prélèvement groupée par produit, dans l'ordre des rayons, avec la répartition par bac.
  lg_wave_detail: {
    roles: ['picker', 'dock_chief'],
    async handler(ctx, a) {
      const w = await ctx.db.prepare('SELECT * FROM waves WHERE id = ? AND company_id = ?').bind(String(a.p_wave ?? ''), ctx.company.id).first();
      if (!w) fail('unknown_wave', 404);
      const [tasks, lines] = await ctx.db.batch([
        ctx.db.prepare('SELECT t.*, o.number, o.delivery_zone FROM pick_tasks t JOIN orders o ON o.id = t.order_id WHERE t.wave_id = ? AND t.company_id = ? ORDER BY t.wave_bin')
          .bind(w.id, ctx.company.id),
        ctx.db.prepare(
          `SELECT l.*, t.wave_bin, coalesce(oi.product_name, p.name) AS name, p.barcode FROM pick_lines l JOIN pick_tasks t ON t.id = l.task_id
             JOIN order_items oi ON oi.id = l.order_item_id LEFT JOIN products p ON p.id = l.product_id WHERE t.wave_id = ? AND l.company_id = ?`,
        ).bind(w.id, ctx.company.id),
      ]);
      const stock = await loadStock(ctx, lines.results.map((l) => l.product_id));
      const groups = new Map();
      for (const l of lines.results) {
        const k = l.product_id ?? 'libre:' + l.name;
        if (!groups.has(k)) groups.set(k, { product_id: l.product_id, name: l.name, barcode: l.barcode, ordered: 0, picked: 0, split: [] });
        const g = groups.get(k); g.ordered += l.qty_ordered; g.picked += l.qty_picked;
        g.split.push({ bin: l.wave_bin, qty: l.qty_ordered, picked: l.qty_picked, line_id: l.id, task_id: l.task_id, status: l.status });
      }
      const day = today(ctx);
      const products = [...groups.values()].map((g) => ({ ...g, split: g.split.sort((x, y) => x.bin - y.bin),
        location: g.product_id ? pickLocation(stock.get(g.product_id), w.hub_id, day)?.code ?? null : null }))
        .sort((x, y) => locKey(x.location).localeCompare(locKey(y.location)) || x.name.localeCompare(y.name));
      return {
        wave: w,
        bins: tasks.results.map((t) => {
          const ls = lines.results.filter((l) => l.task_id === t.id);
          return { bin: t.wave_bin, task_id: t.id, order_short: String(t.number), zone: t.delivery_zone, status: t.status,
            done: !ls.some((l) => l.status === 'pending'), picked: ls.reduce((s, l) => s + l.qty_picked, 0), ordered: ls.reduce((s, l) => s + l.qty_ordered, 0) };
        }),
        products,
      };
    },
  },

  // Scan dans une vague : le produit va dans le bac de la commande la plus urgente qui en attend.
  lg_wave_scan: {
    roles: ['picker', 'dock_chief'],
    async handler(ctx, a) {
      return idempotent(ctx, 'wave_scan', a.p_event, async () => {
        const c = productCode(a.p_code);
        const pid = a.p_product || (c && (await ctx.db.prepare("SELECT id FROM products WHERE company_id = ? AND (upper(barcode) = ? OR upper(sku) = ? OR 'NXI-' || upper(substr(id, 1, 8)) = ?) LIMIT 1")
          .bind(ctx.company.id, c, c, c).first('id'))) || null;
        const lines = (await ctx.db.prepare(
          `SELECT l.id, l.task_id, l.product_id, l.status, l.qty_picked, l.qty_ordered, t.wave_bin, t.cutoff_at FROM pick_lines l JOIN pick_tasks t ON t.id = l.task_id
            WHERE t.wave_id = ? AND l.company_id = ?`,
        ).bind(String(a.p_wave ?? ''), ctx.company.id).all()).results;
        const target = lines.filter((l) => pid && l.product_id === pid && l.status === 'pending' && l.qty_picked < l.qty_ordered)
          .sort((x, y) => (x.cutoff_at ?? '9999').localeCompare(y.cutoff_at ?? '9999') || x.wave_bin - y.wave_bin)[0];
        if (!target) return { ok: false, error: pid && lines.some((l) => l.product_id === pid) ? 'line_complete' : 'unexpected_product' };
        const r = a.p_manual ? await pickScan(ctx, target.task_id, '', true, target.id) : await pickScan(ctx, target.task_id, c, false, null);
        const waveDone = r.ok && !lines.some((l) => l.status === 'pending' && !(l.id === r.line_id && r.line_done));
        return { ...r, bin: target.wave_bin, task_id: target.task_id, wave_done: waveDone };
      });
    },
  },

  lg_my_waves: {
    roles: 'member',
    async handler(ctx) {
      return (await ctx.db.prepare(
        `SELECT w.id, w.number, w.created_at, (SELECT COUNT(*) FROM pick_tasks WHERE wave_id = w.id) AS bins,
                (SELECT COUNT(*) FROM pick_tasks WHERE wave_id = w.id AND status = 'picking') AS open
           FROM waves w WHERE w.company_id = ? AND w.picker_id = ? AND w.status = 'picking'
            AND EXISTS (SELECT 1 FROM pick_tasks t WHERE t.wave_id = w.id AND t.status = 'picking') ORDER BY w.created_at DESC`,
      ).bind(ctx.company.id, ctx.user.id).all()).results;
    },
  },

  // ----------------------------------------------------------------- suite d'une rupture (choix du client)
  lg_resolve_short: {
    roles: ['support', 'dispatcher'],
    async handler(ctx, a) {
      const oi = await ctx.db.prepare('SELECT * FROM order_items WHERE id = ? AND company_id = ?').bind(String(a.p_order_item ?? ''), ctx.company.id).first();
      if (!oi || oi.line_status !== 'short') fail('not_short');
      if (!['replace', 'wait', 'refund'].includes(a.p_choice)) fail('invalid_choice');
      // remboursement par avoir sur la facture : cycle C6 (facturation)
      await audit(ctx, 'short_resolution', 'order_item', oi.id, { choice: a.p_choice });
      return { ok: true, choice: a.p_choice, credit_note: null };
    },
  },

  // ----------------------------------------------------------------- productivité (lecture seule)
  lg_pick_productivity: {
    roles: ['dock_chief', 'dispatcher', 'accountant', 'support'],
    async handler(ctx, a) {
      const to = /^\d{4}-\d{2}-\d{2}$/.test(a.p_to ?? '') ? a.p_to : today(ctx);
      const from = /^\d{4}-\d{2}-\d{2}$/.test(a.p_from ?? '') ? a.p_from : new Date(Date.parse(to + 'T00:00:00Z') - 6 * 86400000).toISOString().slice(0, 10);
      const f = from + 'T00:00:00.000Z'; const t2 = new Date(Date.parse(to + 'T00:00:00Z') + 86400000).toISOString();
      const cid = ctx.company.id;
      const [tasksR, linesR, wrongR, checksR, pkR] = await ctx.db.batch([
        ctx.db.prepare(
          `SELECT t.id, t.picker_id, t.vendor_id, t.wave_id, t.started_at, t.done_at, t.created_at, u.name AS picker, o.vendor_name
             FROM pick_tasks t JOIN orders o ON o.id = t.order_id LEFT JOIN users u ON u.id = t.picker_id
            WHERE t.company_id = ? AND t.done_at >= ? AND t.done_at < ? AND t.picker_id IS NOT NULL AND t.started_at IS NOT NULL`).bind(cid, f, t2),
        ctx.db.prepare(
          `SELECT l.task_id, l.status, l.qty_picked, l.manual_entry FROM pick_lines l JOIN pick_tasks t ON t.id = l.task_id
            WHERE t.company_id = ? AND t.done_at >= ? AND t.done_at < ? AND t.picker_id IS NOT NULL AND t.started_at IS NOT NULL AND l.status <> 'pending'`).bind(cid, f, t2),
        ctx.db.prepare(
          `SELECT actor_id, COUNT(*) AS n FROM action_log WHERE company_id = ? AND fn IN ('pick_scan', 'wave_scan')
              AND json_extract(result, '$.error') = 'unexpected_product' AND created_at >= ? AND created_at < ? GROUP BY actor_id`).bind(cid, f, t2),
        ctx.db.prepare(
          `SELECT t.picker_id, COUNT(DISTINCT i.id) AS n FROM incidents i JOIN packages p ON p.id = i.package_id JOIN pick_tasks t ON t.id = p.pick_task_id
            WHERE i.company_id = ? AND i.kind = 'missing_item' AND t.done_at >= ? AND t.done_at < ? GROUP BY t.picker_id`).bind(cid, f, t2),
        ctx.db.prepare(
          `SELECT volume_l, weight_g FROM packages WHERE company_id = ? AND direction = 'outbound' AND created_at >= ? AND created_at < ? AND status <> 'cancelled'`).bind(cid, f, t2),
      ]);
      const tasks = tasksR.results; const lines = linesR.results;
      const byTask = new Map(tasks.map((t) => [t.id, t]));
      // temps de travail : une vague compte une fois, de la première prise à la dernière fermeture, plafonné à 3 h
      const spans = new Map();
      for (const t of tasks) {
        const k = t.picker_id + '|' + (t.wave_id ?? t.id);
        const s = spans.get(k) ?? { picker: t.picker_id, start: t.started_at, end: t.done_at };
        if (t.started_at < s.start) s.start = t.started_at; if (t.done_at > s.end) s.end = t.done_at;
        spans.set(k, s);
      }
      const minutes = new Map();
      for (const s of spans.values()) minutes.set(s.picker, (minutes.get(s.picker) ?? 0) + Math.min((Date.parse(s.end) - Date.parse(s.start)) / 60000, 180));
      const wrong = new Map(wrongR.results.map((r) => [r.actor_id, r.n])); const checks = new Map(checksR.results.map((r) => [r.picker_id, r.n]));
      const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);
      const pickers = [...new Set(tasks.map((t) => t.picker_id))].map((pid) => {
        const ts = tasks.filter((t) => t.picker_id === pid); const ls = lines.filter((l) => byTask.get(l.task_id)?.picker_id === pid);
        const mins = minutes.get(pid) ?? 0; const w = wrong.get(pid) ?? 0; const c = checks.get(pid) ?? 0;
        return { picker_id: pid, name: ts[0].picker ?? '—', orders: ts.length, lines: ls.length, units: ls.reduce((s, l) => s + l.qty_picked, 0), minutes: Math.round(mins),
          lines_per_hour: mins >= 1 ? Math.round((10 * ls.length) / (mins / 60)) / 10 : null,
          manual_pct: pct(ls.filter((l) => l.manual_entry).length, ls.length), short_pct: pct(ls.filter((l) => l.status === 'short').length, ls.length),
          wrong_scans: w, check_errors: c, error_pct: pct(w + c, ls.length) };
      }).sort((x, y) => y.lines - x.lines);
      const vendors = [...new Set(tasks.map((t) => t.vendor_id ?? ''))].map((v) => {
        const ts = tasks.filter((t) => (t.vendor_id ?? '') === v); const ls = lines.filter((l) => (byTask.get(l.task_id)?.vendor_id ?? '') === v);
        return { vendor_id: v || null, name: ts.find((t) => t.vendor_name)?.vendor_name ?? '—', orders: ts.length, lines: ls.length,
          short_pct: pct(ls.filter((l) => l.status === 'short').length, ls.length),
          prep_hours: Math.round((10 * ts.reduce((s, t) => s + (Date.parse(t.done_at) - Date.parse(t.created_at)), 0)) / ts.length / 3600000) / 10 };
      }).sort((x, y) => (y.short_pct ?? -1) - (x.short_pct ?? -1) || x.name.localeCompare(y.name));
      const sizes = ['small', 'medium', 'large', 'unmeasured'];
      const packaging = sizes.map((size) => {
        const ps = pkR.results.filter((p) => kindFor(p.volume_l) === size);
        return ps.length ? { size, count: ps.length, avg_weight_g: Math.round(ps.reduce((s, p) => s + (p.weight_g ?? 0), 0) / ps.length) } : null;
      }).filter(Boolean);
      const totalMin = [...minutes.values()].reduce((s, m) => s + m, 0);
      return {
        from, to, pickers, vendors, packaging,
        totals: { orders: tasks.length, lines: lines.length, units: lines.reduce((s, l) => s + l.qty_picked, 0), hours: Math.round(totalMin / 6) / 10,
          // moins d'une minute cumulée : pas de cadence
          lines_per_hour: totalMin >= 1 ? Math.round((10 * lines.length) / (totalMin / 60)) / 10 : null,
          short_pct: pct(lines.filter((l) => l.status === 'short').length, lines.length), packages: pkR.results.length },
      };
    },
  },
};
