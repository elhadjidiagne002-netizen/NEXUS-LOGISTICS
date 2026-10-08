// Cycle C5 — retours : colis rapporté au quai (par une autre personne que le chauffeur), retour au vendeur, causes de
// retour et qui paie les frais, contrôle d'un retour client (remise en vente, vendeur, rebut), reprise chez le client.
// Portage de 20261007000400 (lg_return_hub, lg_return_vendor), cycle1 (reprises), cycle5 (contrôle), cycle8 (causes)
// et cycle20 (colis attendus au quai). Avoirs sur facture : cycle C6.
import { fail, audit, idempotent, text, int, uuid, guard, runBatch, plusMinutes } from './core.js';
import { normCode } from './preparation.js';
import { tripFor, refreshStatement } from './voyages.js';
import { UNRETURNED_SQL, FAILURE_REASONS } from './terrain.js';
import { stockMoveStatements } from './stock.js';
import { tryReconcile } from './caisse.js';
import { creditPackage } from './factures.js';
import { notifyOrder, notifyPerson, sendLater, hhmm } from './messages.js';

// Causes de retour par défaut (cycle 8, « à valider ») : une ligne n'est écrite que si l'entreprise les modifie.
export const DEFAULT_CAUSES = [
  { code: 'vendor_error', label: 'Erreur du vendeur (mauvais produit, taille, couleur)', payer: 'vendor', fee_mode: 'delivery', fee_fcfa: 0, active: true, position: 1 },
  { code: 'defective', label: 'Produit défectueux ou non conforme', payer: 'vendor', fee_mode: 'delivery', fee_fcfa: 0, active: true, position: 2 },
  { code: 'transport_damage', label: 'Abîmé pendant le transport', payer: 'company', fee_mode: 'none', fee_fcfa: 0, active: true, position: 3 },
  { code: 'changed_mind', label: "Changement d'avis du client", payer: 'customer', fee_mode: 'delivery', fee_fcfa: 0, active: true, position: 4 },
  { code: 'refused_at_door', label: 'Refus à la porte', payer: 'customer', fee_mode: 'delivery', fee_fcfa: 0, active: true, position: 5 },
  { code: 'customer_absent', label: 'Client absent ou injoignable', payer: 'customer', fee_mode: 'delivery', fee_fcfa: 0, active: true, position: 6 },
  { code: 'other', label: 'Autre', payer: 'none', fee_mode: 'none', fee_fcfa: 0, active: true, position: 7 },
];
export async function causesOf(ctx) {
  const rows = (await ctx.db.prepare('SELECT * FROM return_causes WHERE company_id = ?').bind(ctx.company.id).all()).results;
  const m = new Map(DEFAULT_CAUSES.map((c) => [c.code, { ...c }]));
  for (const r of rows) m.set(r.code, { code: r.code, label: r.label, payer: r.payer, fee_mode: r.fee_mode, fee_fcfa: r.fee_fcfa, active: Boolean(r.active), position: r.position });
  return [...m.values()].sort((a, b) => a.position - b.position || a.code.localeCompare(b.code));
}

/** Cause proposée d'après le motif d'échec ou la demande de retour (lg_return_suggest). */
function suggest(p) {
  if (p.direction === 'return') {
    const txt = `${p.r_category ?? ''} ${p.r_description ?? ''}`;
    if (/(d[ée]fect|cass|panne|ne marche|non conforme)/i.test(txt)) return 'defective';
    if (/(mauvais|erreur|taille|couleur|pas le bon)/i.test(txt)) return 'vendor_error';
    if (/(avis|plus besoin|ne veu)/i.test(txt)) return 'changed_mind';
    return null;
  }
  return { refused: 'refused_at_door', damaged: 'transport_damage', wrong_product: 'vendor_error', absent: 'customer_absent', unreachable: 'customer_absent' }[p.failure_reason] ?? null;
}

/** Retour au vendeur (lg_return_vendor) : stock rétabli, commande annulée si plus rien ne part. */
async function returnToVendor(ctx, p, reason, extra = []) {
  const cid = ctx.company.id;
  const o = await ctx.db.prepare('SELECT vendor_id FROM orders WHERE id = ? AND company_id = ?').bind(p.order_id, cid).first();
  const back = (await ctx.db.prepare('SELECT oi.product_id, sum(pi.quantity) AS qty FROM package_items pi JOIN order_items oi ON oi.id = pi.order_item_id WHERE pi.package_id = ? AND oi.product_id IS NOT NULL GROUP BY oi.product_id')
    .bind(p.id).all()).results;
  await runBatch(ctx, [
    guard(ctx.db, "(SELECT status FROM packages WHERE id = ?) = 'returned_hub'", [p.id]),
    ...extra,
    ctx.db.prepare("UPDATE packages SET status = 'returned_vendor', holder_type = 'vendor', holder_id = ?, updated_at = ? WHERE id = ? AND company_id = ?").bind(o?.vendor_id ?? null, ctx.now, p.id, cid),
    ctx.db.prepare("UPDATE order_items SET line_status = 'cancelled' WHERE company_id = ? AND id IN (SELECT order_item_id FROM package_items WHERE package_id = ?)").bind(cid, p.id),
    ...back.flatMap((it) => stockMoveStatements(ctx, { product: it.product_id, delta: it.qty, kind: 'return', order: p.order_id, ref: p.code, reason: `retour au vendeur : ${reason}` })),
    ctx.db.prepare("INSERT INTO scan_events (company_id, client_event_id, package_id, event, actor_id, hub_id, device_at, meta) VALUES (?, ?, ?, 'return_vendor', ?, ?, ?, ?)")
      .bind(cid, uuid(), p.id, ctx.user.id, p.hub_id, ctx.now, JSON.stringify({ reason })),
    ctx.db.prepare(`UPDATE orders SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?, updated_at = ? WHERE id = ? AND company_id = ? AND status <> 'delivered'
        AND NOT EXISTS (SELECT 1 FROM packages WHERE order_id = ? AND status NOT IN ('returned_vendor', 'cancelled', 'lost'))`).bind(ctx.now, reason, ctx.now, p.order_id, cid, p.order_id),
  ], 'bad_status');
  await audit(ctx, 'return_vendor', 'package', p.code, { reason });
  return creditPackage(ctx, p.id, reason);   // avoir sur la facture (retour d'un client livré)
}

async function packageByCode(ctx, code) {
  return ctx.db.prepare('SELECT * FROM packages WHERE company_id = ? AND code = ?').bind(ctx.company.id, normCode(code)).first();
}

export default {
  // Réception au quai d'un colis non livré, par une autre personne que le chauffeur qui le détenait.
  lg_return_hub: {
    roles: ['dock_chief'],
    async handler(ctx, a) {
      return idempotent(ctx, 'return_hub', a.p_event, async () => {
        const p = await packageByCode(ctx, a.p_code);
        if (!p) return { ok: false, error: 'unknown_package' };
        if (!['failed', 'loaded', 'out_for_delivery'].includes(p.status)) return { ok: false, error: 'bad_status', status: p.status };
        if (p.holder_type === 'driver' && await ctx.db.prepare('SELECT 1 AS x FROM couriers WHERE id = ? AND user_id = ?').bind(p.holder_id, ctx.user.id).first()) {
          return { ok: false, error: 'same_person' };
        }
        const tp = await ctx.db.prepare(
          `SELECT tp.trip_id, tp.stop_id, t.hub_id, t.number, s.failure_reason FROM trip_packages tp JOIN trips t ON t.id = tp.trip_id LEFT JOIN trip_stops s ON s.id = tp.stop_id
            WHERE tp.package_id = ? ORDER BY tp.loaded_at IS NULL, tp.loaded_at DESC LIMIT 1`).bind(p.id).first();
        const hub = a.p_hub || tp?.hub_id || p.hub_id;
        const cid = ctx.company.id;
        const stmts = [
          guard(ctx.db, "(SELECT status FROM packages WHERE id = ?) IN ('failed', 'loaded', 'out_for_delivery')", [p.id]),
          ctx.db.prepare("UPDATE trip_packages SET outcome = 'returned' WHERE package_id = ? AND outcome IS NULL").bind(p.id),
          ctx.db.prepare("UPDATE packages SET status = 'returned_hub', holder_type = 'hub', holder_id = ?, hub_id = ?, updated_at = ? WHERE id = ? AND company_id = ?").bind(hub, hub, ctx.now, p.id, cid),
          ctx.db.prepare("INSERT INTO scan_events (company_id, client_event_id, package_id, event, actor_id, trip_id, hub_id, device_at) VALUES (?, ?, ?, 'return_hub', ?, ?, ?, ?)")
            .bind(cid, a.p_event ? String(a.p_event) : uuid(), p.id, ctx.user.id, tp?.trip_id ?? null, hub, text(a.p_device_at, 40) ?? ctx.now),
        ];
        if (tp?.trip_id) stmts.push(refreshStatement(ctx, tp.trip_id));
        await runBatch(ctx, stmts, 'bad_status');
        // dernier colis rapporté : l'alerte « colis à rapporter » se lève toute seule
        if (tp?.trip_id && !(await ctx.db.prepare(UNRETURNED_SQL).bind(tp.trip_id, cid).first())) {
          await ctx.db.prepare('UPDATE alerts SET acked_at = ?, dedupe_key = NULL WHERE company_id = ? AND dedupe_key = ? AND acked_at IS NULL').bind(ctx.now, cid, `unreturned:${tp.trip_id}`).run();
        }
        if (tp?.trip_id) await tryReconcile(ctx, tp.trip_id);
        return { ok: true, code: p.code, attempts: p.attempts, can_retry: p.attempts < Number(ctx.company.config.max_attempts ?? 2),
          to_vendor: Boolean(tp?.failure_reason && FAILURE_REASONS[tp.failure_reason]?.vendor) };
      });
    },
  },

  lg_return_vendor: {
    roles: ['dock_chief', 'support'],
    async handler(ctx, a) {
      return idempotent(ctx, 'return_vendor', a.p_event, async () => {
        const p = await packageByCode(ctx, a.p_code);
        if (!p) return { ok: false, error: 'unknown_package' };
        if (p.status !== 'returned_hub') return { ok: false, error: 'bad_status', status: p.status };
        const credit = await returnToVendor(ctx, p, text(a.p_reason, 200) ?? 'Retour au vendeur');
        return { ok: true, credit_note: credit };
      });
    },
  },

  // Voyages clôturés dont des colis n'ont pas encore été rapportés au quai (7 derniers jours).
  lg_returns_expected: {
    roles: ['dock_chief', 'dispatcher', 'cashier'],
    async handler(ctx) {
      const since = new Date(Date.parse(ctx.now) - 7 * 86400000).toISOString();
      const r = await ctx.db.prepare(
        `SELECT t.id AS trip_id, t.number, t.ended_at, c.name AS courier, c.phone, p.code FROM trips t LEFT JOIN couriers c ON c.id = t.courier_id
           JOIN trip_packages tp ON tp.trip_id = t.id JOIN packages p ON p.id = tp.package_id
          WHERE t.company_id = ? AND t.status IN ('completed', 'reconciled') AND t.ended_at > ?
            AND ((tp.outcome = 'failed' AND p.status = 'failed') OR (tp.outcome IS NULL AND tp.loaded_at IS NOT NULL AND p.holder_type = 'driver' AND p.status IN ('loaded', 'out_for_delivery')))
          ORDER BY t.ended_at, p.code`,
      ).bind(ctx.company.id, since).all();
      const m = new Map();
      for (const x of r.results) {
        if (!m.has(x.trip_id)) m.set(x.trip_id, { trip_id: x.trip_id, number: x.number, courier: x.courier, phone: x.phone, ended_at: x.ended_at,
          minutes: Math.round((Date.parse(ctx.now) - Date.parse(x.ended_at)) / 60000), codes: [] });
        m.get(x.trip_id).codes.push(x.code);
      }
      return [...m.values()];
    },
  },

  // Retours à contrôler : colis client rapportés, ou colis dont les présentations sont épuisées.
  lg_returns_to_inspect: {
    roles: ['dock_chief', 'support'],
    async handler(ctx) {
      const r = await ctx.db.prepare(
        `SELECT p.id, p.code, p.direction, p.attempts, p.updated_at AS since, o.number, o.vendor_name AS vendor, rc.cause,
                (SELECT s.failure_reason FROM trip_packages tp JOIN trip_stops s ON s.id = tp.stop_id WHERE tp.package_id = p.id AND s.failure_reason IS NOT NULL
                  ORDER BY s.completed_at DESC LIMIT 1) AS failure_reason,
                (SELECT category FROM return_requests WHERE order_id = p.order_id ORDER BY created_at DESC LIMIT 1) AS r_category,
                (SELECT description FROM return_requests WHERE order_id = p.order_id ORDER BY created_at DESC LIMIT 1) AS r_description,
                (SELECT group_concat(coalesce(oi.product_name, '?') || ' × ' || pi.quantity, ', ') FROM package_items pi JOIN order_items oi ON oi.id = pi.order_item_id WHERE pi.package_id = p.id) AS items
           FROM packages p JOIN orders o ON o.id = p.order_id LEFT JOIN return_charges rc ON rc.package_id = p.id
          WHERE p.company_id = ? AND p.status = 'returned_hub' AND (p.direction = 'return' OR p.attempts >= ?) ORDER BY p.updated_at`,
      ).bind(ctx.company.id, Number(ctx.company.config.max_attempts ?? 2)).all();
      return r.results.map((p) => ({ code: p.code, direction: p.direction, order_short: String(p.number), attempts: p.attempts, since: p.since, vendor: p.vendor,
        cause: p.cause, suggested_cause: suggest(p), items: p.items }));
    },
  },

  lg_return_causes: {
    roles: ['dock_chief', 'support', 'accountant', 'dispatcher'],
    async handler(ctx) { return causesOf(ctx); },
  },

  lg_return_cause_save: {
    roles: 'admin',
    async handler(ctx, a) {
      const p = a.p && typeof a.p === 'object' ? a.p : {};
      const code = String(p.code ?? '').trim().toLowerCase();
      if (!/^[a-z_]{2,40}$/.test(code)) fail('invalid_code');
      const payer = p.payer ?? 'none'; const mode = p.fee_mode ?? 'none';
      if (!['vendor', 'customer', 'company', 'none'].includes(payer) || !['none', 'delivery', 'fixed'].includes(mode)) fail('invalid_kind');
      const fee = int(p.fee_fcfa) ?? 0;
      if (fee < 0) fail('invalid_amount');
      const def = DEFAULT_CAUSES.find((c) => c.code === code);
      const pos = int(p.position) ?? def?.position ?? (Math.max(0, ...(await causesOf(ctx)).map((c) => c.position)) + 1);
      await ctx.db.prepare(
        `INSERT INTO return_causes (company_id, code, label, payer, fee_mode, fee_fcfa, active, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (company_id, code) DO UPDATE SET label = excluded.label, payer = excluded.payer, fee_mode = excluded.fee_mode, fee_fcfa = excluded.fee_fcfa,
           active = excluded.active, position = excluded.position`,
      ).bind(ctx.company.id, code, text(p.label, 120) ?? def?.label ?? code, payer, mode, fee, p.active === false ? 0 : 1, pos).run();
      await audit(ctx, 'return_cause', 'return_cause', code, p);
      return { ok: true, code };
    },
  },

  // Cause d'un retour et qui paie les frais (vendeur, client, entreprise).
  lg_return_classify: {
    roles: ['dock_chief', 'support'],
    async handler(ctx, a) {
      return idempotent(ctx, 'return_classify', a.p_event, async () => {
        const p = await ctx.db.prepare('SELECT p.*, o.vendor_id, o.delivery_zone, o.delivery_fee_fcfa FROM packages p JOIN orders o ON o.id = p.order_id WHERE p.company_id = ? AND p.code = ?')
          .bind(ctx.company.id, normCode(a.p_code)).first();
        if (!p) return { ok: false, error: 'unknown_package' };
        if (!(p.direction === 'return' || p.attempts > 0 || ['returned_hub', 'returned_vendor'].includes(p.status))) return { ok: false, error: 'not_a_return' };
        const c = (await causesOf(ctx)).find((x) => x.code === a.p_cause && x.active);
        if (!c) return { ok: false, error: 'unknown_cause' };
        const amount = c.payer === 'none' ? 0 : c.fee_mode === 'fixed' ? c.fee_fcfa : c.fee_mode === 'delivery' ? p.delivery_fee_fcfa : 0;
        await ctx.db.prepare(
          `INSERT INTO return_charges (company_id, package_id, order_id, cause, payer, amount_fcfa, vendor_id, zone, note, classified_by, classified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (package_id) DO UPDATE SET cause = excluded.cause, payer = excluded.payer, amount_fcfa = excluded.amount_fcfa, note = excluded.note,
             classified_by = excluded.classified_by, classified_at = excluded.classified_at`,
        ).bind(ctx.company.id, p.id, p.order_id, c.code, c.payer, amount, p.vendor_id, p.delivery_zone, text(a.p_note, 300), ctx.user.id, ctx.now).run();
        await audit(ctx, 'return_classify', 'package', p.code, { cause: c.code, payer: c.payer, amount_fcfa: amount });
        return { ok: true, cause: c.code, payer: c.payer, amount_fcfa: amount };
      });
    },
  },

  // Contrôle d'un retour : remise en vente (neuf ou bon état), rendu au vendeur, ou rebut (incident).
  lg_return_inspect: {
    roles: ['dock_chief', 'support'],
    async handler(ctx, a) {
      return idempotent(ctx, 'inspect', a.p_event, async () => {
        const p = await packageByCode(ctx, a.p_code);
        if (!p || p.status !== 'returned_hub') return { ok: false, error: 'bad_status', status: p?.status ?? null };
        if (!['neuf', 'bon', 'abime', 'inutilisable'].includes(a.p_condition) || !['restock', 'vendor', 'scrap'].includes(a.p_decision)) fail('invalid_choice');
        if (a.p_decision === 'restock' && !['neuf', 'bon'].includes(a.p_condition)) return { ok: false, error: 'not_resellable' };
        const cid = ctx.company.id; const note = text(a.p_note, 300); const photo = text(a.p_photo_path, 300);
        const inspection = ctx.db.prepare('INSERT INTO return_inspections (id, company_id, package_id, condition, decision, note, photo_path, inspected_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(uuid(), cid, p.id, a.p_condition, a.p_decision, note, photo, ctx.user.id);
        if (a.p_decision === 'vendor') {
          const credit = await returnToVendor(ctx, p, note ?? `Retour client contrôlé : ${a.p_condition}`, [inspection]);
          return { ok: true, decision: 'vendor', credit_note: credit };
        }
        const stmts = [
          guard(ctx.db, "(SELECT status FROM packages WHERE id = ?) = 'returned_hub'", [p.id]),
          inspection,
          ctx.db.prepare("UPDATE order_items SET line_status = 'cancelled' WHERE company_id = ? AND id IN (SELECT order_item_id FROM package_items WHERE package_id = ?)").bind(cid, p.id),
          ctx.db.prepare('UPDATE packages SET status = ?, updated_at = ? WHERE id = ? AND company_id = ?').bind(a.p_decision === 'scrap' ? 'damaged' : 'cancelled', ctx.now, p.id, cid),
          ctx.db.prepare("INSERT INTO scan_events (company_id, client_event_id, package_id, event, actor_id, hub_id, device_at, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(cid, uuid(), p.id, a.p_decision === 'scrap' ? 'damage' : 'inventory', ctx.user.id, p.hub_id, ctx.now, JSON.stringify({ inspection: a.p_decision, condition: a.p_condition })),
        ];
        if (a.p_decision === 'restock') {
          // remise en vente : stock du site et rayon le plus garni du hub
          const items = (await ctx.db.prepare('SELECT oi.product_id, pi.quantity FROM package_items pi JOIN order_items oi ON oi.id = pi.order_item_id WHERE pi.package_id = ? AND oi.product_id IS NOT NULL').bind(p.id).all()).results;
          for (const it of items) {
            stmts.push(...stockMoveStatements(ctx, { product: it.product_id, delta: it.quantity, kind: 'return', order: p.order_id, ref: p.code, reason: 'remis en stock après contrôle' }));
            stmts.push(ctx.db.prepare(`UPDATE product_locations SET qty = qty + ?, updated_at = ? WHERE product_id = ? AND company_id = ? AND location_id = (
                SELECT pl.location_id FROM product_locations pl JOIN stock_locations l ON l.id = pl.location_id WHERE pl.product_id = ? AND l.hub_id = ? ORDER BY pl.qty DESC LIMIT 1)`)
              .bind(it.quantity, ctx.now, it.product_id, cid, it.product_id, p.hub_id));
          }
        } else {
          stmts.push(
            ctx.db.prepare("INSERT INTO counters (company_id, key, n) VALUES (?, 'incident', 1) ON CONFLICT (company_id, key) DO UPDATE SET n = n + 1").bind(cid),
            ctx.db.prepare(`INSERT INTO incidents (id, company_id, number, kind, package_id, order_id, description, photos, reported_by, responsible_type, due_at)
                VALUES (?, ?, (SELECT n FROM counters WHERE company_id = ? AND key = 'incident'), 'damaged', ?, ?, ?, ?, ?, 'unknown', ?)`)
              .bind(uuid(), cid, cid, p.id, p.order_id, note ?? 'Retour inutilisable, mis au rebut', JSON.stringify(photo ? [photo] : []), ctx.user.id, plusMinutes(ctx.now, 72 * 60)),
          );
        }
        await runBatch(ctx, stmts, 'bad_status');
        // remboursement du client par avoir
        const credit = await creditPackage(ctx, p.id, a.p_decision === 'scrap' ? 'Retour mis au rebut' : 'Retour remis en vente');
        return { ok: true, decision: a.p_decision, credit_note: credit };
      });
    },
  },

  // ----------------------------------------------------------------- reprises chez le client
  // Demande de retour d'un client livré, saisie par le service client.
  lg_return_request: {
    roles: ['support', 'dispatcher'],
    async handler(ctx, a) {
      const o = await ctx.db.prepare('SELECT id, status FROM orders WHERE id = ? AND company_id = ?').bind(String(a.p_order ?? ''), ctx.company.id).first();
      if (!o) fail('unknown_order', 404);
      if (o.status !== 'delivered') return { ok: false, error: 'not_delivered' };
      if (await ctx.db.prepare("SELECT 1 AS x FROM return_requests WHERE order_id = ? AND status IN ('pending', 'approved')").bind(o.id).first()) return { ok: false, error: 'already_scheduled' };
      const id = uuid();
      await ctx.db.prepare('INSERT INTO return_requests (id, company_id, order_id, category, description, created_by) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, ctx.company.id, o.id, text(a.p_category, 80), text(a.p_description, 500), ctx.user.id).run();
      await audit(ctx, 'return_request', 'order', o.id, { category: a.p_category ?? null });
      return { ok: true, id };
    },
  },

  lg_returns_pending: {
    roles: ['dispatcher', 'dock_chief', 'support'],
    async handler(ctx) {
      const r = await ctx.db.prepare(
        `SELECT r.id, r.order_id, o.number, o.buyer_name AS customer, o.delivery_zone AS zone, r.category, r.description, r.created_at
           FROM return_requests r JOIN orders o ON o.id = r.order_id
          WHERE r.company_id = ? AND r.status = 'approved' AND NOT EXISTS (SELECT 1 FROM packages p WHERE p.order_id = r.order_id AND p.direction = 'return')
          ORDER BY r.created_at`,
      ).bind(ctx.company.id).all();
      return r.results.map((x) => ({ id: x.id, order_id: x.order_id, order_short: String(x.number), customer: x.customer, zone: x.zone,
        reason: [x.category, x.description].filter(Boolean).join(' — '), created_at: x.created_at }));
    },
  },

  // Arrêt de reprise : un colis « retour » est créé ; le chauffeur colle l'étiquette sur place.
  lg_trip_add_return: {
    roles: ['dispatcher', 'dock_chief'],
    async handler(ctx, a) {
      const t = await tripFor(ctx, a.p_trip);
      if (!['planned', 'loading', 'sealed', 'in_progress'].includes(t.status)) fail('trip_not_open');
      const r = await ctx.db.prepare('SELECT * FROM return_requests WHERE id = ? AND company_id = ?').bind(String(a.p_return ?? ''), ctx.company.id).first();
      if (!r || r.status !== 'approved') fail('return_not_approved');
      const o = await ctx.db.prepare('SELECT o.*, c.lat AS c_lat, c.lng AS c_lng FROM orders o LEFT JOIN customers c ON c.id = o.customer_id WHERE o.id = ? AND o.company_id = ?')
        .bind(r.order_id, ctx.company.id).first();
      const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
      const code = 'NXP-' + Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => ALPHABET[b % ALPHABET.length]).join('');
      const pkg = uuid(); const stop = uuid(); const cid = ctx.company.id;
      try {
        await runBatch(ctx, [
          guard(ctx.db, "NOT EXISTS (SELECT 1 FROM packages WHERE order_id = ? AND direction = 'return')", [o.id]),
          ctx.db.prepare("INSERT INTO packages (id, company_id, code, order_id, direction, zone, status, holder_type, hub_id) VALUES (?, ?, ?, ?, 'return', ?, 'created', 'customer', ?)")
            .bind(pkg, cid, code, o.id, o.delivery_zone, t.hub_id),
          ctx.db.prepare(`INSERT INTO package_items (company_id, package_id, order_item_id, quantity)
              SELECT ?, ?, id, max(CASE WHEN picked_qty > 0 THEN picked_qty ELSE quantity END, 1) FROM order_items WHERE order_id = ? AND line_status <> 'cancelled'`).bind(cid, pkg, o.id),
          ctx.db.prepare(`INSERT INTO trip_stops (id, company_id, trip_id, seq, kind, order_id, contact_name, contact_phone, address, landmark, lat, lng)
              SELECT ?, ?, ?, (SELECT coalesce(max(seq), 0) + 1 FROM trip_stops WHERE trip_id = ?), 'return', ?, ?, ?, ?, ?, ?, ?`)
            .bind(stop, cid, t.id, t.id, o.id, o.buyer_name, o.buyer_phone, [o.delivery_zone, o.buyer_address].filter(Boolean).join(', ') || null, o.landmark,
              o.delivery_lat ?? o.c_lat, o.delivery_lng ?? o.c_lng),
          ctx.db.prepare('INSERT INTO trip_packages (company_id, trip_id, package_id, stop_id) VALUES (?, ?, ?, ?)').bind(cid, t.id, pkg, stop),
        ], 'already_scheduled');
      } catch (e) {
        if (e?.code === 'already_scheduled') fail('already_scheduled', 409);
        throw e;
      }
      await sendLater(ctx, [await notifyOrder(ctx, 'lg_return_scheduled', o)]);
      return { ok: true, stop_id: stop, code };
    },
  },
};

