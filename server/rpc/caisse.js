// Cycle C6 — caisse (versements de fin de voyage et intermédiaires, écarts), rapprochement du voyage, gains des
// chauffeurs, incidents (ouverture, liste, résolution avec retenue ou indemnité, réponse du client).
// Portage de 20261007000400 (lg_remit_cash, lg_try_reconcile, lg_open_incident), cycle1 (lg_cash_drop,
// lg_cash_desk) et cycle14 (lg_incidents_list, lg_resolve_incident, plafond d'indemnisation, accord du client).
// Le voyage n'est « rapproché » que caisse versée sans écart ouvert ET colis rendus au quai ; les gains du chauffeur
// sont crédités à ce moment-là (une seule fois : passage conditionnel completed → reconciled dans le même lot).
import { fail, audit, idempotent, hasRole, text, int, uuid, parseJson, guard, runBatch, plusMinutes } from './core.js';
import { normCode } from './preparation.js';
import { tripFor } from './voyages.js';
import { alertStatement } from './flotte.js';
import { creditNote } from './factures.js';
import { notifyOrder, notifyPerson, sendLater, hhmm } from './messages.js';

/** Espèces encore portées pour un voyage (encaissées − versements intermédiaires), expression SQL sur l'alias t. */
export const OUTSTANDING_SQL = `((SELECT coalesce(sum(cc.amount_collected_fcfa), 0) FROM cod_collections cc JOIN trip_stops s ON s.id = cc.stop_id
    WHERE s.trip_id = t.id AND cc.method = 'cash') - (SELECT coalesce(sum(d.amount_fcfa), 0) FROM cash_drops d WHERE d.trip_id = t.id))`;

async function outstanding(ctx, tripId) {
  return ctx.db.prepare(`SELECT ${OUTSTANDING_SQL} AS n FROM trips t WHERE t.id = ? AND t.company_id = ?`).bind(tripId, ctx.company.id).first('n');
}

const dakar = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)} ${iso.slice(11, 16)}`;
const courierUser = (ctx, courierId) => (courierId ? ctx.db.prepare('SELECT user_id FROM couriers WHERE id = ? AND company_id = ?').bind(courierId, ctx.company.id).first('user_id') : null);

/**
 * Rapprochement (lg_try_reconcile) : caisse versée, pas d'écart ouvert, colis en échec rendus, collectes reçues.
 * Crédite les gains du chauffeur (réglages pay_fixed_trip, pay_per_package, bonus_zero_failure, bonus_on_time).
 */
export async function tryReconcile(ctx, tripId) {
  const cid = ctx.company.id;
  const k = await ctx.db.prepare(
    `SELECT t.id, t.status, t.vehicle_id, t.courier_id,
            EXISTS (SELECT 1 FROM cash_remittances WHERE trip_id = t.id) AS remitted,
            EXISTS (SELECT 1 FROM incidents WHERE trip_id = t.id AND kind = 'cash_gap' AND status IN ('open', 'investigating')) AS gap,
            EXISTS (SELECT 1 FROM trip_packages tp JOIN packages p ON p.id = tp.package_id WHERE tp.trip_id = t.id AND tp.outcome = 'failed' AND p.status = 'failed') AS to_return,
            EXISTS (SELECT 1 FROM trip_packages tp JOIN packages p ON p.id = tp.package_id
                     WHERE tp.trip_id = t.id AND tp.outcome IS NULL AND tp.loaded_at IS NOT NULL AND p.holder_type = 'driver') AS held,
            (SELECT count(*) FROM trip_packages WHERE trip_id = t.id AND outcome = 'delivered') AS delivered,
            (SELECT count(*) FROM trip_packages WHERE trip_id = t.id AND outcome = 'failed') AS failed,
            (SELECT count(*) FROM trip_stops s WHERE s.trip_id = t.id AND s.status = 'delivered'
               AND s.completed_at <= coalesce(s.window_end, strftime('%Y-%m-%dT%H:%M:%fZ', s.eta, '+30 minutes'))) AS on_time
       FROM trips t WHERE t.id = ? AND t.company_id = ?`,
  ).bind(tripId, cid).first();
  if (!k || k.status !== 'completed' || !k.remitted || k.gap || k.to_return || k.held) return false;
  const cfg = ctx.company.config; const n = (v) => Number(v ?? 0) || 0;
  const earn = [];
  if (k.courier_id) {
    const base = n(cfg.pay_fixed_trip) + k.delivered * n(cfg.pay_per_package);
    if (base > 0) earn.push([base, 'delivery', null]);
    if (k.failed === 0 && k.delivered > 0 && n(cfg.bonus_zero_failure) > 0) earn.push([n(cfg.bonus_zero_failure), 'bonus', 'zéro échec']);
    if (k.on_time > 0 && n(cfg.bonus_on_time) > 0) earn.push([k.on_time * n(cfg.bonus_on_time), 'bonus', 'ponctualité']);
  }
  const total = earn.reduce((s, e) => s + e[0], 0);
  try {
    await runBatch(ctx, [
      guard(ctx.db, "(SELECT status FROM trips WHERE id = ?) = 'completed'", [tripId]),
      ctx.db.prepare("UPDATE trips SET status = 'reconciled', updated_at = ? WHERE id = ? AND company_id = ? AND status = 'completed'").bind(ctx.now, tripId, cid),
      ctx.db.prepare("UPDATE vehicles SET status = 'available', updated_at = ? WHERE id = ? AND company_id = ? AND status = 'on_trip'").bind(ctx.now, k.vehicle_id, cid),
      ...earn.map(([amt, type, ref]) => ctx.db.prepare('INSERT INTO courier_earnings (id, company_id, courier_id, trip_id, amount_fcfa, type, ref) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(uuid(), cid, k.courier_id, tripId, amt, type, ref)),
      ...(total ? [ctx.db.prepare('UPDATE couriers SET total_earned = total_earned + ? WHERE id = ? AND company_id = ?').bind(total, k.courier_id, cid)] : []),
    ], 'already_reconciled');
  } catch (e) {
    if (e?.code === 'already_reconciled') return false;   // rapproché entre-temps par un autre appel
    throw e;
  }
  return true;
}

const INCIDENT_KINDS = ['damaged', 'lost', 'missing_item', 'wrong_product', 'refused', 'cash_gap', 'driver_behavior', 'vehicle_breakdown', 'accident', 'late', 'other'];
const incidentStmts = (ctx, id, fields) => {
  const cid = ctx.company.id;
  return [
    ctx.db.prepare("INSERT INTO counters (company_id, key, n) VALUES (?, 'incident', 1) ON CONFLICT (company_id, key) DO UPDATE SET n = n + 1").bind(cid),
    ctx.db.prepare(`INSERT INTO incidents (id, company_id, number, kind, severity, package_id, trip_id, order_id, description, photos, reported_by, responsible_type, responsible_id, due_at)
        VALUES (?, ?, (SELECT n FROM counters WHERE company_id = ? AND key = 'incident'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING number`)
      .bind(id, cid, cid, fields.kind, fields.severity ?? 'normal', fields.package_id ?? null, fields.trip_id ?? null, fields.order_id ?? null, fields.description,
        JSON.stringify(fields.photos ?? []), ctx.user?.id ?? null, fields.responsible_type ?? 'unknown', fields.responsible_id ?? null, fields.due_at),
  ];
};

/** Plafond d'indemnisation (lg_incident_cap) : valeur assurée, sinon le moindre du total et de uninsured_cap_fcfa. */
const capOf = (ctx, i) => (i.o_total == null ? null : i.insured_value_fcfa ?? Math.min(i.o_total, Number(ctx.company.config.uninsured_cap_fcfa ?? 50000)));

export default {
  // ----------------------------------------------------------------- caisse
  lg_cash_desk: {
    roles: ['cashier', 'accountant'],
    async handler(ctx) {
      const cid = ctx.company.id; const cfg = ctx.company.config;
      const [close, road, recent] = await ctx.db.batch([
        ctx.db.prepare(
          `SELECT t.id, t.number, t.label, t.status, t.ended_at, t.cod_expected_fcfa, c.name AS courier,
                  (SELECT count(*) FROM trip_stops s WHERE s.trip_id = t.id AND s.status = 'delivered') AS delivered,
                  (SELECT count(*) FROM trip_stops s WHERE s.trip_id = t.id AND s.status = 'failed') AS failed,
                  ${OUTSTANDING_SQL} AS cash,
                  (SELECT coalesce(sum(d.amount_fcfa), 0) FROM cash_drops d WHERE d.trip_id = t.id) AS dropped,
                  (SELECT coalesce(sum(cc.amount_collected_fcfa), 0) FROM cod_collections cc JOIN trip_stops s ON s.id = cc.stop_id WHERE s.trip_id = t.id AND cc.method <> 'cash') AS mobile,
                  EXISTS (SELECT 1 FROM cash_remittances r WHERE r.trip_id = t.id) AS remitted,
                  (SELECT json_group_array(p.code) FROM trip_packages tp JOIN packages p ON p.id = tp.package_id WHERE tp.trip_id = t.id AND tp.outcome = 'failed' AND p.status = 'failed') AS to_return,
                  (SELECT json_group_array(p.code) FROM trip_packages tp JOIN packages p ON p.id = tp.package_id
                    WHERE tp.trip_id = t.id AND tp.outcome IS NULL AND tp.loaded_at IS NOT NULL AND p.holder_type = 'driver' AND p.status = 'loaded') AS to_hub
             FROM trips t LEFT JOIN couriers c ON c.id = t.courier_id WHERE t.company_id = ? AND t.status = 'completed' ORDER BY t.ended_at`,
        ).bind(cid),
        // espèces portées : voyages pas encore versés en caisse, par chauffeur (plafond)
        ctx.db.prepare(
          `SELECT t.id, t.number, t.status, t.courier_id, c.name AS courier, c.cash_limit_fcfa, ${OUTSTANDING_SQL} AS outstanding
             FROM trips t JOIN couriers c ON c.id = t.courier_id
            WHERE t.company_id = ? AND t.status IN ('sealed', 'in_progress', 'completed') AND NOT EXISTS (SELECT 1 FROM cash_remittances r WHERE r.trip_id = t.id)`,
        ).bind(cid),
        ctx.db.prepare(
          `SELECT t.number AS trip_number, c.name AS courier, r.expected_fcfa, r.remitted_fcfa, r.gap_fcfa, r.validated_at, t.status AS trip_status
             FROM cash_remittances r JOIN trips t ON t.id = r.trip_id LEFT JOIN couriers c ON c.id = r.courier_id
            WHERE r.company_id = ? ORDER BY r.validated_at DESC LIMIT 30`,
        ).bind(cid),
      ]);
      const perCourier = new Map();
      for (const t of road.results) perCourier.set(t.courier_id, (perCourier.get(t.courier_id) ?? 0) + t.outstanding);
      return {
        to_close: close.results.map((t) => ({
          id: t.id, number: t.number, label: t.label, status: t.status, ended_at: t.ended_at, courier: t.courier,
          delivered: t.delivered, failed: t.failed, packages_to_return: parseJson(t.to_return, []), to_hub: parseJson(t.to_hub, []),
          cash_to_remit_fcfa: t.cash, cash_dropped_fcfa: t.dropped, mobile_collected_fcfa: t.mobile, cod_expected_fcfa: t.cod_expected_fcfa, remitted: Boolean(t.remitted),
        })),
        on_road: road.results.filter((t) => ['sealed', 'in_progress'].includes(t.status) && t.outstanding > 0).sort((a, b) => b.outstanding - a.outstanding).map((t) => {
          const limit = t.cash_limit_fcfa ?? Number(cfg.cash_limit_fcfa ?? 150000);
          return { id: t.id, number: t.number, courier: t.courier, outstanding_fcfa: t.outstanding, limit_fcfa: limit, over_limit: perCourier.get(t.courier_id) > limit };
        }),
        recent: recent.results,
      };
    },
  },

  // Versement intermédiaire : le chauffeur dépose une partie des espèces sans clôturer son voyage.
  lg_cash_drop: {
    roles: ['cashier'],
    async handler(ctx, a) {
      return idempotent(ctx, 'cash_drop', a.p_event, async () => {
        const t = await tripFor(ctx, a.p_trip);
        if (!['sealed', 'in_progress', 'completed'].includes(t.status)) fail('trip_not_on_road');
        if ((await courierUser(ctx, t.courier_id)) === ctx.user.id) fail('same_person', 403);
        const out = await outstanding(ctx, t.id); const amt = int(a.p_amount_fcfa);
        if (!(amt > 0) || amt > out) return { ok: false, error: 'exceeds_cash', outstanding: out };
        const cid = ctx.company.id;
        await runBatch(ctx, [
          guard(ctx.db, `(SELECT ${OUTSTANDING_SQL} FROM trips t WHERE t.id = ?) >= ?`, [t.id, amt]),
          guard(ctx.db, 'NOT EXISTS (SELECT 1 FROM cash_remittances WHERE trip_id = ?)', [t.id]),
          ctx.db.prepare('INSERT INTO cash_drops (id, company_id, trip_id, courier_id, amount_fcfa, cashier_id, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .bind(uuid(), cid, t.id, t.courier_id, amt, ctx.user.id, text(a.p_note, 300)),
          // l'alerte de plafond est levée : le chauffeur peut repartir
          ctx.db.prepare('UPDATE alerts SET acked_at = ?, acked_by = ?, dedupe_key = NULL WHERE company_id = ? AND dedupe_key = ? AND acked_at IS NULL')
            .bind(ctx.now, ctx.user.id, cid, `cash_limit:${t.id}`),
        ], 'exceeds_cash');
        await audit(ctx, 'cash_drop', 'trip', t.id, { amount: amt });
        return { ok: true, outstanding: out - amt, receipt: `Versement intermédiaire voyage ${t.number} — ${amt} F reçus le ${dakar(ctx.now)}` };
      });
    },
  },

  // Versement de fin de voyage, compté par le caissier : un écart ouvre un incident et bloque le rapprochement.
  lg_remit_cash: {
    roles: ['cashier'],
    async handler(ctx, a) {
      return idempotent(ctx, 'remit', a.p_event, async () => {
        const t = await tripFor(ctx, a.p_trip);
        if (t.status !== 'completed') fail('trip_not_completed');
        if ((await courierUser(ctx, t.courier_id)) === ctx.user.id) fail('same_person', 403);
        const paid = int(a.p_remitted_fcfa);
        if (paid == null || paid < 0) fail('invalid_amount');
        const exp = await outstanding(ctx, t.id);   // versements intermédiaires déduits
        const gap = paid - exp; const cid = ctx.company.id;
        const stmts = [
          ctx.db.prepare('INSERT INTO cash_remittances (id, company_id, trip_id, courier_id, expected_fcfa, remitted_fcfa, cashier_id, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(uuid(), cid, t.id, t.courier_id, exp, paid, ctx.user.id, text(a.p_note, 300)),
        ];
        if (gap !== 0) {
          stmts.push(
            ...incidentStmts(ctx, uuid(), { kind: 'cash_gap', severity: Math.abs(gap) >= 10000 ? 'high' : 'normal', trip_id: t.id,
              description: `Écart de caisse de ${gap} F sur le voyage ${t.number} (attendu ${exp} F, versé ${paid} F)`, responsible_type: 'driver', responsible_id: t.courier_id,
              due_at: plusMinutes(ctx.now, 24 * 60) }),
            alertStatement(ctx, cid, 'cash_gap', 'critical', `Écart de caisse ${gap} F, voyage ${t.number}`, { trip: t.id, dedupe: `gap:${t.id}` }),
          );
        }
        try { await ctx.db.batch(stmts); } catch (e) {
          if (/UNIQUE constraint failed: cash_remittances/i.test(String(e?.message))) fail('already_remitted', 409);
          throw e;
        }
        await audit(ctx, 'cash_remit', 'trip', t.id, { expected: exp, remitted: paid });
        const reconciled = await tryReconcile(ctx, t.id);
        return { ok: true, expected_fcfa: exp, remitted_fcfa: paid, gap_fcfa: gap, reconciled,
          receipt: `Reçu voyage ${t.number} — ${paid} F versés le ${dakar(ctx.now)}` };
      });
    },
  },

  // ----------------------------------------------------------------- incidents
  lg_incidents_list: {
    roles: ['support', 'dispatcher', 'dock_chief', 'cashier'],
    async handler(ctx, a) {
      const st = a.p_status === undefined ? 'open' : a.p_status;
      const r = await ctx.db.prepare(
        `SELECT i.*, p.code AS package, t.number AS trip_number, o.number AS order_number, o.total_fcfa AS o_total, o.insured_value_fcfa, inv.invoice_number AS credit_note
           FROM incidents i LEFT JOIN packages p ON p.id = i.package_id LEFT JOIN trips t ON t.id = i.trip_id
           LEFT JOIN orders o ON o.id = i.order_id LEFT JOIN invoices inv ON inv.id = i.credit_note_id
          WHERE i.company_id = ?1 AND (?2 IS NULL OR i.status = ?2 OR (?2 = 'open' AND i.status IN ('investigating', 'resolved')))
          ORDER BY i.created_at DESC LIMIT 300`,
      ).bind(ctx.company.id, st ?? null).all();
      return r.results.map((i) => ({
        id: i.id, number: i.number, kind: i.kind, severity: i.severity, status: i.status, description: i.description, package: i.package,
        trip_number: i.trip_number, order_short: i.order_number != null ? String(i.order_number) : null, responsible_type: i.responsible_type,
        created_at: i.created_at, due_at: i.due_at, overdue: Boolean(i.due_at && i.due_at < ctx.now && ['open', 'investigating'].includes(i.status)),
        resolution: i.resolution, compensation_fcfa: i.compensation_fcfa, cap_fcfa: capOf(ctx, i), insured_value_fcfa: i.insured_value_fcfa, has_order: Boolean(i.order_id),
        customer_agreed_at: i.customer_agreed_at, customer_refused_at: i.customer_refused_at, agreement_via: i.agreement_via,
        awaiting_customer: i.status === 'resolved' && i.compensation_fcfa > 0 && !i.customer_agreed_at, credit_note: i.credit_note, photos: parseJson(i.photos, []),
      }));
    },
  },

  lg_open_incident: {
    roles: 'member',
    async handler(ctx, a) {
      if (!hasRole(ctx, ['picker', 'dock_chief', 'dispatcher', 'support', 'cashier']) && !ctx.courierId) fail('forbidden', 403);
      if (!INCIDENT_KINDS.includes(a.p_kind)) fail('invalid_kind');
      const desc = text(a.p_description, 1000);
      if (!desc) fail('description_required');
      const cid = ctx.company.id;
      let p = null; let trip = null;
      if (a.p_code) {
        p = await ctx.db.prepare('SELECT * FROM packages WHERE company_id = ? AND code = ?').bind(cid, normCode(a.p_code)).first();
        if (!p) fail('unknown_package', 404);
      }
      if (a.p_trip) trip = (await tripFor(ctx, a.p_trip)).id;
      else if (p) trip = await ctx.db.prepare('SELECT trip_id FROM trip_packages WHERE package_id = ? ORDER BY loaded_at IS NULL, loaded_at DESC LIMIT 1').bind(p.id).first('trip_id');
      const id = uuid();
      const hours = { lost: 72, accident: 4 }[a.p_kind] ?? 48;
      const photos = (Array.isArray(a.p_photos) ? a.p_photos : []).map((x) => text(x, 300)).filter(Boolean).slice(0, 10);
      const stmts = incidentStmts(ctx, id, { kind: a.p_kind, severity: ['low', 'normal', 'high', 'critical'].includes(a.p_severity) ? a.p_severity : 'normal',
        package_id: p?.id, trip_id: trip, order_id: p?.order_id, description: desc, photos, responsible_type: p?.holder_type ?? 'unknown', responsible_id: p?.holder_id,
        due_at: plusMinutes(ctx.now, hours * 60) });
      if (p && ['damaged', 'lost'].includes(a.p_kind)) stmts.push(
        ctx.db.prepare("UPDATE packages SET status = ?, updated_at = ? WHERE id = ? AND company_id = ? AND status <> 'delivered'").bind(a.p_kind, ctx.now, p.id, cid),
        ctx.db.prepare("INSERT INTO scan_events (company_id, client_event_id, package_id, event, actor_id, device_at, meta) VALUES (?, ?, ?, 'damage', ?, ?, ?)")
          .bind(cid, uuid(), p.id, ctx.user.id, ctx.now, JSON.stringify({ kind: a.p_kind })),
      );
      if (['accident', 'vehicle_breakdown'].includes(a.p_kind)) stmts.push(alertStatement(ctx, cid, 'sos', 'critical', `Incident : ${desc}`, { trip, dedupe: `sos:${id}` }));
      const res = await ctx.db.batch(stmts);
      return { ok: true, id, number: res[1].results[0].number };
    },
  },

  // Résolution : retenue sur le chauffeur (gain négatif), indemnité plafonnée, avoir, accord du client exigé.
  lg_resolve_incident: {
    roles: ['support', 'dispatcher'],
    async handler(ctx, a) {
      const cid = ctx.company.id;
      const i = await ctx.db.prepare('SELECT i.*, o.total_fcfa AS o_total, o.insured_value_fcfa FROM incidents i LEFT JOIN orders o ON o.id = i.order_id WHERE i.id = ? AND i.company_id = ?')
        .bind(String(a.p_id ?? ''), cid).first();
      if (!i) fail('unknown_incident', 404);
      if (i.status === 'closed') return { ok: false, error: 'already_closed' };
      const comp = int(a.p_compensation_fcfa) ?? 0; const ded = int(a.p_deduction_fcfa) ?? 0;
      if (comp < 0 || ded < 0) fail('invalid_amount');
      const cap = capOf(ctx, i);
      if (comp > 0 && cap != null && comp > cap) return { ok: false, error: 'over_cap', cap_fcfa: cap, insured: i.insured_value_fcfa != null };
      const resolution = text(a.p_resolution, 1000);
      if (!resolution) fail('resolution_required');
      // accord du client exigé pour clore une indemnité qui lui revient
      const agreed = a.p_customer_agreed === true;
      const close = a.p_close !== false && (comp === 0 || !i.order_id || agreed || Boolean(i.customer_agreed_at));
      const stmts = [
        guard(ctx.db, "(SELECT status FROM incidents WHERE id = ?) <> 'closed'", [i.id]),
        ctx.db.prepare(`UPDATE incidents SET resolution = ?, compensation_fcfa = ?, deduction_fcfa = ?, status = ?, resolved_by = ?, resolved_at = ?,
            customer_agreed_at = CASE WHEN ? THEN coalesce(customer_agreed_at, ?) ELSE customer_agreed_at END,
            agreement_via = CASE WHEN ? THEN 'support' ELSE agreement_via END WHERE id = ? AND company_id = ?`)
          .bind(resolution, comp, ded, close ? 'closed' : 'resolved', ctx.user.id, ctx.now, agreed ? 1 : 0, ctx.now, agreed ? 1 : 0, i.id, cid),
      ];
      // une retenue sur le chauffeur est tracée comme gain négatif
      if (ded > 0 && i.responsible_type === 'driver' && i.responsible_id) stmts.push(
        ctx.db.prepare("INSERT INTO courier_earnings (id, company_id, courier_id, trip_id, amount_fcfa, type, ref) VALUES (?, ?, ?, ?, ?, 'payout', ?)")
          .bind(uuid(), cid, i.responsible_id, i.trip_id, -ded, `retenue incident ${i.number}`),
        ctx.db.prepare('UPDATE couriers SET total_earned = total_earned - ? WHERE id = ? AND company_id = ?').bind(ded, i.responsible_id, cid),
      );
      await runBatch(ctx, stmts, 'already_closed');
      // avoir de l'indemnité sur la facture de la commande (une seule fois)
      let credit = null;
      if (a.p_credit_note === true && comp > 0 && !i.credit_note_id && i.order_id) {
        const inv = await ctx.db.prepare('SELECT id FROM invoices WHERE order_id = ? AND company_id = ? AND credit_of IS NULL').bind(i.order_id, cid).first('id');
        if (inv) {
          const c = await creditNote(ctx, inv, null, `Indemnisation incident n° ${i.number}`, comp);
          credit = c.number;
          await ctx.db.prepare('UPDATE incidents SET credit_note_id = ? WHERE id = ? AND company_id = ?').bind(c.id, i.id, cid).run();
        }
      }
      // proposition au client, à accepter depuis sa page de suivi
      if (comp > 0 && i.order_id && !close) {
        const o = await ctx.db.prepare('SELECT * FROM orders WHERE id = ? AND company_id = ?').bind(i.order_id, cid).first();
        await sendLater(ctx, [await notifyOrder(ctx, 'lg_incident_proposal', o, { resolution, indemnite: ` (indemnité de ${comp.toLocaleString('fr-FR').replace(/[\u202f\u00a0]/g, ' ')} F)` })]);
      }
      if (i.kind === 'cash_gap' && close && i.trip_id) await tryReconcile(ctx, i.trip_id);
      await audit(ctx, 'incident_resolve', 'incident', i.number, { resolution, compensation: comp, closed: close });
      return { ok: true, closed: close, awaiting_customer: !close && a.p_close !== false, credit_note: credit, cap_fcfa: cap };
    },
  },
};
