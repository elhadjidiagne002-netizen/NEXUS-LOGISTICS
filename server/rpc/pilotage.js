// Cycle C7 — pilotage : tour de contrôle (lg_dashboard, lg_ack_alert), indicateurs (lg_kpis, lg_kpis_by_axis),
// coûts et marges (lg_costs), prévision (lg_forecast), anomalies (lg_anomalies), classement des chauffeurs
// (lg_leaderboard), retours par cause (lg_return_stats), renforts des jours de pic (cycle 22).
// Tout est calculé à la lecture par des requêtes groupées (une seule aller-retour D1 par écran quand c'est possible) :
// aucune écriture, donc rien sur le budget de 100 000 écritures par jour.
import { fail, audit, hasRole, text, int, uuid, parseJson, today } from './core.js';
import { gaugeOf } from './voyages.js';
import { OUTSTANDING_SQL } from './caisse.js';
import { FAILURE_REASONS } from './terrain.js';
import { causesOf } from './retours.js';
import { amountDue } from './commandes.js';
import { notifyOrder, notifyPerson, sendLater, hhmm } from './messages.js';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00.000Z`) + n * 86400000).toISOString().slice(0, 10);
/** Période [début, fin[ en ISO, à partir de deux jours AAAA-MM-JJ (heure de Dakar = UTC). */
function period(from, to) {
  if (!ISO_DAY.test(String(from ?? '')) || !ISO_DAY.test(String(to ?? ''))) fail('invalid_period');
  return [`${from}T00:00:00.000Z`, `${addDays(to, 1)}T00:00:00.000Z`];
}
const pct = (a, b, digits = 0) => (b ? Math.round((10 ** digits * 100 * a) / b) / 10 ** digits : null);
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const hoursBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / 3600000;
const ON_TIME = "coalesce(s.window_end, strftime('%Y-%m-%dT%H:%M:%fZ', s.eta, '+30 minutes'))";

/** Classement des chauffeurs (lg_driver_scores) : volume 40 + 1re présentation 30 + ponctualité 20 + note 10. */
async function driverScores(ctx, days) {
  const since = new Date(Date.parse(ctx.now) - days * 86400000).toISOString();
  const r = await ctx.db.prepare(
    `SELECT c.id AS courier_id, c.name, c.rating_avg AS rating, coalesce(x.delivered, 0) AS delivered, coalesce(x.failed, 0) AS failed,
            coalesce(x.on_time, 0) AS on_time, coalesce(x.first_ok, 0) AS first_ok,
            (SELECT coalesce(sum(amount_fcfa), 0) FROM courier_earnings e WHERE e.courier_id = c.id AND e.created_at > ?2) AS earnings
       FROM couriers c LEFT JOIN (
         SELECT t.courier_id, sum(s.status = 'delivered') AS delivered, sum(s.status = 'failed') AS failed,
                sum(s.status = 'delivered' AND s.completed_at <= ${ON_TIME}) AS on_time,
                sum(s.status = 'delivered' AND NOT EXISTS (SELECT 1 FROM trip_stops s2 WHERE s2.order_id = s.order_id AND s2.status = 'failed'
                    AND s2.completed_at < s.completed_at)) AS first_ok
           FROM trip_stops s JOIN trips t ON t.id = s.trip_id
          WHERE s.company_id = ?1 AND s.completed_at > ?2 AND s.kind = 'delivery' GROUP BY t.courier_id) x ON x.courier_id = c.id
      WHERE c.company_id = ?1 AND c.active = 1`,
  ).bind(ctx.company.id, since).all();
  const rows = r.results.map((c) => {
    const first = pct(c.first_ok, c.delivered + c.failed); const onTime = pct(c.on_time, c.delivered);
    const score = Math.round((40 * Math.min(c.delivered / 40, 1) + 0.3 * (first ?? 0) + 0.2 * (onTime ?? 0) + 2 * (c.rating ?? 0)) * 10) / 10;
    return { courier_id: c.courier_id, name: c.name, delivered: c.delivered, failed: c.failed, first_attempt_pct: first, on_time_pct: onTime,
      rating: c.rating, earnings: c.earnings, score };
  }).sort((a, b) => b.score - a.score);
  // rang olympique : ex aequo au même rang
  rows.forEach((x, i) => { x.rank = i > 0 && rows[i - 1].score === x.score ? rows[i - 1].rank : i + 1; });
  return rows;
}

const PRES_SQL = `SELECT e.event, e.server_at, e.trip_id, p.attempts, p.zone, o.vendor_name, o.vendor_id, o.promised_at, o.delivery_fee_fcfa,
    coalesce(o.cod_confirmed_at, o.paid_at, o.created_at) AS confirmed_at, s.eta, t.courier_id, t.vehicle_id, c.name AS courier,
    v.plate, v.kind AS vehicle_kind, e.meta
  FROM scan_events e JOIN packages p ON p.id = e.package_id JOIN orders o ON o.id = p.order_id
  LEFT JOIN trip_packages tp ON tp.package_id = p.id AND tp.trip_id = e.trip_id LEFT JOIN trip_stops s ON s.id = tp.stop_id
  LEFT JOIN trips t ON t.id = e.trip_id LEFT JOIN couriers c ON c.id = t.courier_id LEFT JOIN vehicles v ON v.id = t.vehicle_id
  WHERE e.company_id = ? AND e.event IN ('deliver', 'fail') AND e.server_at >= ? AND e.server_at < ?`;
const onTime = (x) => x.event === 'deliver' && (x.promised_at || x.eta)
  && x.server_at <= (x.promised_at ?? new Date(Date.parse(x.eta) + 30 * 60000).toISOString());

export default {
  // ----------------------------------------------------------------- tour de contrôle
  lg_dashboard: {
    roles: ['dispatcher', 'dock_chief', 'support', 'cashier'],
    async handler(ctx, a) {
      const day = ISO_DAY.test(String(a.p_day ?? '')) ? a.p_day : today(ctx);
      const [from, to] = period(day, day); const cid = ctx.company.id; const cfg = ctx.company.config;
      const staleBefore = new Date(Date.parse(ctx.now) - Number(cfg.staged_max_hours ?? 24) * 3600000).toISOString();
      const lateBefore = new Date(Date.parse(ctx.now) - 15 * 60000).toISOString();
      const posAfter = new Date(Date.parse(ctx.now) - 30 * 60000).toISOString();
      const [k, trips, stops, alerts, assign] = await ctx.db.batch([
        ctx.db.prepare(
          `SELECT (SELECT count(DISTINCT tp.package_id) FROM trip_packages tp JOIN trips t ON t.id = tp.trip_id WHERE t.company_id = ?1
                    AND coalesce(t.started_at, t.planned_departure) >= ?2 AND coalesce(t.started_at, t.planned_departure) < ?3 AND coalesce(tp.outcome, '') <> 'removed') AS packages_today,
                  (SELECT count(*) FROM scan_events WHERE company_id = ?1 AND event = 'deliver' AND server_at >= ?2 AND server_at < ?3) AS delivered,
                  (SELECT count(*) FROM scan_events WHERE company_id = ?1 AND event = 'fail' AND server_at >= ?2 AND server_at < ?3) AS failed,
                  (SELECT count(*) FROM pick_tasks WHERE company_id = ?1 AND status IN ('todo', 'picking')) AS to_pick,
                  (SELECT count(*) FROM packages WHERE company_id = ?1 AND status = 'staged') AS staged,
                  (SELECT count(*) FROM packages WHERE company_id = ?1 AND status = 'staged' AND updated_at < ?4) AS staged_old,
                  (SELECT count(*) FROM packages WHERE company_id = ?1 AND status = 'returned_hub') AS returns_waiting,
                  (SELECT count(DISTINCT s.trip_id) FROM trip_stops s JOIN trips t ON t.id = s.trip_id WHERE t.company_id = ?1 AND t.status = 'in_progress'
                    AND s.status IN ('pending', 'en_route', 'arrived') AND s.eta < ?5) AS trips_late,
                  (SELECT coalesce(sum(${OUTSTANDING_SQL}), 0) FROM trips t WHERE t.company_id = ?1 AND t.status IN ('sealed', 'in_progress', 'completed')
                    AND NOT EXISTS (SELECT 1 FROM cash_remittances r WHERE r.trip_id = t.id)) AS cash_out_fcfa,
                  (SELECT count(*) FROM packages WHERE company_id = ?1 AND status = 'staged' AND hub_id IS NULL) AS to_collect,
                  (SELECT coalesce(sum(s.cod_due_fcfa), 0) FROM trip_stops s JOIN trips t ON t.id = s.trip_id WHERE t.company_id = ?1
                    AND t.status IN ('sealed', 'in_progress') AND s.status IN ('pending', 'en_route', 'arrived')) AS cod_to_collect_fcfa,
                  (SELECT count(*) FROM incidents WHERE company_id = ?1 AND status IN ('open', 'investigating')) AS open_incidents,
                  (SELECT count(*) FROM customer_requests WHERE company_id = ?1 AND status = 'open') AS open_requests`,
        ).bind(cid, from, to, staleBefore, lateBefore),
        ctx.db.prepare(
          `SELECT t.*, v.kind AS vehicle_kind, v.plate, v.capacity_kg, v.capacity_l, v.max_packages, c.name AS courier, c.phone AS courier_phone,
                  c.last_lat, c.last_lng, c.last_seen_at,
                  (SELECT count(*) FROM trip_packages WHERE trip_id = t.id AND outcome IS NULL) AS planned,
                  (SELECT count(*) FROM trip_packages WHERE trip_id = t.id AND outcome IS NULL AND loaded_at IS NOT NULL) AS loaded,
                  (SELECT count(*) FROM alerts al WHERE al.trip_id = t.id AND al.acked_at IS NULL) AS open_alerts
             FROM trips t JOIN vehicles v ON v.id = t.vehicle_id LEFT JOIN couriers c ON c.id = t.courier_id
            WHERE t.company_id = ?1 AND (t.status IN ('planned', 'loading', 'sealed', 'in_progress', 'completed') OR (t.status = 'reconciled' AND t.ended_at >= ?2))`,
        ).bind(cid, from),
        ctx.db.prepare(
          `SELECT s.trip_id, s.seq, s.status, s.lat, s.lng, s.contact_name AS name, s.eta, s.arrived_at FROM trip_stops s JOIN trips t ON t.id = s.trip_id
            WHERE t.company_id = ?1 AND s.status <> 'skipped' AND (t.status IN ('planned', 'loading', 'sealed', 'in_progress', 'completed') OR (t.status = 'reconciled' AND t.ended_at >= ?2))
            ORDER BY s.seq`,
        ).bind(cid, from),
        ctx.db.prepare('SELECT id, kind, severity, message, trip_id, created_at FROM alerts WHERE company_id = ? AND acked_at IS NULL ORDER BY created_at DESC LIMIT 50').bind(cid),
        ctx.db.prepare(
          `SELECT o.id AS order_id, o.number, o.delivery_zone AS zone, o.delivery_lat AS lat, o.delivery_lng AS lng, o.promised_at,
                  o.payment_method, o.payment_status, o.total_fcfa, o.subtotal_fcfa, o.discount_fcfa, o.shortage_fcfa, x.n, x.w, x.oldest
             FROM (SELECT p.order_id, count(*) AS n, sum(p.weight_g) AS w, min(p.updated_at) AS oldest FROM packages p
                    WHERE p.company_id = ? AND p.status = 'staged' AND p.hub_id IS NOT NULL AND p.direction = 'outbound'
                      AND NOT EXISTS (SELECT 1 FROM trip_packages tp WHERE tp.package_id = p.id AND tp.outcome IS NULL) GROUP BY p.order_id) x
             JOIN orders o ON o.id = x.order_id ORDER BY x.oldest`,
        ).bind(cid),
      ]);
      const nowMs = Date.parse(ctx.now);
      return {
        day,
        kpis: k.results[0],
        trips: trips.results.map((t) => {
          const ts = stops.results.filter((s) => s.trip_id === t.id);
          const open = ts.filter((s) => ['pending', 'en_route', 'arrived'].includes(s.status));
          const late = open.filter((s) => s.eta && s.eta < ctx.now).map((s) => Date.parse(s.eta));
          const arrived = ts.filter((s) => s.status === 'arrived' && s.arrived_at).map((s) => Date.parse(s.arrived_at));
          return {
            id: t.id, number: t.number, label: t.label, status: t.status, kind: t.kind, planned_departure: t.planned_departure, started_at: t.started_at,
            cod_expected_fcfa: t.cod_expected_fcfa, vehicle_kind: t.vehicle_kind, plate: t.plate, courier: t.courier, courier_phone: t.courier_phone,
            stops_total: ts.length, stops_done: ts.filter((s) => ['delivered', 'failed'].includes(s.status)).length, failures: ts.filter((s) => s.status === 'failed').length,
            late_min: late.length ? Math.max(0, Math.round((nowMs - Math.min(...late)) / 60000)) : null,
            stopped_min: arrived.length ? Math.round((nowMs - Math.max(...arrived)) / 60000) : null,
            gauge: gaugeOf(t, t, t.planned, t.loaded),
            position: t.last_seen_at && t.last_seen_at > posAfter ? { lat: t.last_lat, lng: t.last_lng, at: t.last_seen_at } : null,
            stops: ts.map((s) => ({ seq: s.seq, status: s.status, lat: s.lat, lng: s.lng, name: s.name, eta: s.eta })),
            urgency: (t.status === 'in_progress' ? 2 : ['loading', 'sealed'].includes(t.status) ? 1 : 0) + t.open_alerts * 3,
          };
        }).sort((x, y) => y.urgency - x.urgency || x.number - y.number),
        alerts: alerts.results,
        to_assign: assign.results.map((o) => ({ order_id: o.order_id, order_short: String(o.number), zone: o.zone, packages: o.n, weight_g: o.w,
          cod_fcfa: amountDue(o), lat: o.lat, lng: o.lng, promised_at: o.promised_at, oldest: o.oldest })),
      };
    },
  },

  lg_ack_alert: {
    roles: ['dispatcher', 'dock_chief', 'support', 'cashier'],
    async handler(ctx, a) {
      const r = await ctx.db.prepare('UPDATE alerts SET acked_by = ?, acked_at = ?, dedupe_key = NULL WHERE id = ? AND company_id = ? AND acked_at IS NULL')
        .bind(ctx.user.id, ctx.now, int(a.p_id) ?? -1, ctx.company.id).run();
      return { ok: r.meta.changes > 0 };
    },
  },

  // ----------------------------------------------------------------- indicateurs
  lg_kpis: {
    roles: ['dispatcher', 'accountant', 'support'],
    async handler(ctx, a) {
      const [from, to] = period(a.p_from, a.p_to); const cid = ctx.company.id;
      const [pres, picks, trips, cash, inc, cost, staged] = await ctx.db.batch([
        ctx.db.prepare(PRES_SQL).bind(cid, from, to),
        ctx.db.prepare(
          `SELECT t.id, t.vendor_id, u.name AS vendor, t.created_at, t.done_at, coalesce(o.cod_confirmed_at, o.paid_at, o.created_at) AS conf,
                  (SELECT count(*) FROM pick_lines WHERE task_id = t.id) AS lines, (SELECT count(*) FROM pick_lines WHERE task_id = t.id AND status = 'short') AS short
             FROM pick_tasks t JOIN orders o ON o.id = t.order_id LEFT JOIN users u ON u.id = t.vendor_id
            WHERE t.company_id = ? AND t.done_at >= ? AND t.done_at < ?`,
        ).bind(cid, from, to),
        ctx.db.prepare(
          `SELECT t.id, t.started_at, t.ended_at, t.load_weight_g, t.load_volume_l, t.load_count, v.capacity_kg, v.capacity_l, v.max_packages,
                  (SELECT count(*) FROM trip_packages WHERE trip_id = t.id AND outcome = 'delivered') AS delivered
             FROM trips t JOIN vehicles v ON v.id = t.vehicle_id
            WHERE t.company_id = ? AND t.started_at >= ? AND t.started_at < ? AND t.status IN ('completed', 'reconciled', 'in_progress')`,
        ).bind(cid, from, to),
        ctx.db.prepare(`SELECT coalesce(sum(abs(gap_fcfa)), 0) AS gap, coalesce(sum(expected_fcfa), 0) AS exp, coalesce(sum(gap_fcfa <> 0), 0) AS n
            FROM cash_remittances WHERE company_id = ? AND validated_at >= ? AND validated_at < ?`).bind(cid, from, to),
        ctx.db.prepare("SELECT count(*) AS n FROM incidents WHERE company_id = ? AND kind IN ('wrong_product', 'missing_item') AND created_at >= ? AND created_at < ?").bind(cid, from, to),
        ctx.db.prepare(`SELECT (SELECT coalesce(sum(amount_fcfa), 0) FROM trip_expenses WHERE company_id = ?1 AND status <> 'rejected' AND created_at >= ?2 AND created_at < ?3)
            + (SELECT coalesce(sum(amount_fcfa), 0) FROM courier_earnings WHERE company_id = ?1 AND type IN ('delivery', 'bonus') AND created_at >= ?2 AND created_at < ?3) AS cost`).bind(cid, from, to),
        ctx.db.prepare("SELECT count(*) AS n FROM packages WHERE company_id = ? AND status = 'staged' AND updated_at < ?").bind(cid, new Date(Date.parse(ctx.now) - 86400000).toISOString()),
      ]);
      const P = pres.results; const deliv = P.filter((x) => x.event === 'deliver'); const fails = P.filter((x) => x.event === 'fail');
      const timed = deliv.filter((x) => x.promised_at || x.eta);
      const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
      const lines = picks.results.reduce((s, x) => s + x.lines, 0); const short = picks.results.reduce((s, x) => s + x.short, 0);
      const tripHours = trips.results.reduce((s, t) => s + hoursBetween(t.started_at, t.ended_at ?? ctx.now), 0);
      const reasons = new Map();
      for (const f of fails) { const code = parseJson(f.meta, {}).reason; reasons.set(code, (reasons.get(code) ?? 0) + 1); }
      const c = cash.results[0];
      const group = (key) => {
        const m = new Map();
        for (const x of P) { const g = m.get(key(x)) ?? { d: 0, f: 0 }; g[x.event === 'deliver' ? 'd' : 'f'] += 1; m.set(key(x), g); }
        return m;
      };
      const byCourier = new Map();
      for (const x of P.filter((y) => y.courier_id)) {
        const g = byCourier.get(x.courier_id) ?? { courier: x.courier, d: 0, f: 0 }; g[x.event === 'deliver' ? 'd' : 'f'] += 1; byCourier.set(x.courier_id, g);
      }
      const ratings = new Map((await ctx.db.prepare('SELECT id, rating_avg FROM couriers WHERE company_id = ?').bind(cid).all()).results.map((r) => [r.id, r.rating_avg]));
      const byVendor = new Map();
      for (const t of picks.results) {
        const g = byVendor.get(t.vendor_id ?? '') ?? { vendor: t.vendor ?? ctx.company.name, tasks: 0, h: [], s: 0 };
        g.tasks += 1; g.h.push(hoursBetween(t.created_at, t.done_at)); g.s += t.short; byVendor.set(t.vendor_id ?? '', g);
      }
      return {
        from: a.p_from, to: a.p_to,
        kpis: {
          delivered: deliv.length, failed: fails.length,
          first_attempt_pct: pct(deliv.filter((x) => x.attempts === 0).length, deliv.length),
          on_time_pct: pct(timed.filter(onTime).length, timed.length),
          end_to_end_hours: r1(avg(deliv.map((x) => hoursBetween(x.confirmed_at, x.server_at)))),
          prep_hours: r1(avg(picks.results.map((x) => hoursBetween(x.conf, x.done_at)))),
          stockout_pct: pct(short, lines, 1), prep_error_pct: pct(inc.results[0].n, deliv.length, 1),
          fill_pct: trips.results.length ? Math.round(avg(trips.results.map((t) => gaugeOf(t, t, 0, 0).fill_pct))) : null,
          packages_per_trip: r1(avg(trips.results.map((t) => t.delivered))),
          // moins de 30 min de tournée cumulée : pas de cadence (« 934 colis par heure » vu en démo)
          packages_per_hour: tripHours >= 0.5 ? r1(trips.results.reduce((s, t) => s + t.delivered, 0) / tripHours) : null,
          failure_rate_pct: pct(fails.length, P.length, 1),
          failure_reasons: [...reasons].map(([code, n]) => ({ reason: FAILURE_REASONS[code]?.label ?? code ?? 'Autre', count: n })).sort((x, y) => y.count - x.count),
          cash_gap_fcfa: c.gap, cash_gap_pct: pct(c.gap, c.exp, 2), trips_with_gap: c.n, staged_over_24h: staged.results[0].n,
          cost_per_delivery_fcfa: deliv.length ? Math.round(cost.results[0].cost / deliv.length) : null,
        },
        by_zone: [...group((x) => x.zone ?? '?')].map(([zone, g]) => ({ zone, delivered: g.d, failed: g.f, failure_pct: pct(g.f, g.d + g.f) }))
          .sort((x, y) => y.delivered + y.failed - (x.delivered + x.failed)),
        by_courier: [...byCourier].map(([id, g]) => ({ courier: g.courier, delivered: g.d, failed: g.f, rating: ratings.get(id) ?? null })).sort((x, y) => y.delivered - x.delivered),
        by_vendor: [...byVendor.values()].map((g) => ({ vendor: g.vendor, tasks: g.tasks, prep_hours: r1(avg(g.h)), stockout_lines: g.s })).sort((x, y) => y.tasks - x.tasks),
      };
    },
  },

  lg_kpis_by_axis: {
    roles: ['dispatcher', 'accountant', 'support'],
    async handler(ctx, a) {
      const axis = a.p_axis;
      if (!['zone', 'vendor', 'courier', 'vehicle', 'weekday', 'hour'].includes(axis)) fail('invalid_axis');
      const [from, to] = period(a.p_from, a.p_to);
      const P = (await ctx.db.prepare(PRES_SQL).bind(ctx.company.id, from, to).all()).results;
      const DAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
      const key = (x) => ({
        zone: x.zone ?? '?', vendor: x.vendor_name ?? '—', courier: x.courier ?? '—', vehicle: x.plate ? `${x.plate} (${x.vehicle_kind})` : '—',
        weekday: String(((new Date(x.server_at).getUTCDay() + 6) % 7) + 1), hour: x.server_at.slice(11, 13),
      }[axis]);
      const m = new Map();
      for (const x of P) {
        const g = m.get(key(x)) ?? { n: 0, d: 0, f: 0, first: 0, on: 0, timed: 0, lead: [] };
        g.n += 1;
        if (x.event === 'deliver') {
          g.d += 1; if (x.attempts === 0) g.first += 1;
          if (x.promised_at || x.eta) { g.timed += 1; if (onTime(x)) g.on += 1; }
          g.lead.push(hoursBetween(x.confirmed_at, x.server_at));
        } else g.f += 1;
        m.set(key(x), g);
      }
      const rows = [...m].map(([k, g]) => ({
        key: k, label: axis === 'weekday' ? DAYS[Number(k) - 1] : axis === 'hour' ? `${k} h` : k,
        presentations: g.n, delivered: g.d, failed: g.f, failure_pct: pct(g.f, g.n, 1), first_attempt_pct: pct(g.first, g.d, 1), on_time_pct: pct(g.on, g.timed, 1),
        lead_hours: g.lead.length ? r1(g.lead.reduce((s, x) => s + x, 0) / g.lead.length) : null,
      }));
      rows.sort((x, y) => (['weekday', 'hour'].includes(axis) ? x.key.localeCompare(y.key) : y.presentations - x.presentations || x.key.localeCompare(y.key)));
      return { axis, from: a.p_from, to: a.p_to, rows };
    },
  },

  // Coûts (frais de route, entretien, paie des chauffeurs) et marge (frais de livraison encaissés), par véhicule et par zone.
  lg_costs: {
    roles: ['dispatcher', 'accountant'],
    async handler(ctx, a) {
      const [from, to] = period(a.p_from, a.p_to); const cid = ctx.company.id;
      const [pres, trips, exp, maint, pay, rev, veh] = await ctx.db.batch([
        ctx.db.prepare(`SELECT e.event, p.zone, t.vehicle_id, t.courier_id FROM scan_events e JOIN packages p ON p.id = e.package_id LEFT JOIN trips t ON t.id = e.trip_id
            WHERE e.company_id = ? AND e.event IN ('deliver', 'fail') AND e.server_at >= ? AND e.server_at < ?`).bind(cid, from, to),
        ctx.db.prepare(`SELECT t.id, t.vehicle_id, coalesce(t.distance_km, 0) AS km, t.load_weight_g, t.load_volume_l, t.load_count, v.capacity_kg, v.capacity_l, v.max_packages
            FROM trips t JOIN vehicles v ON v.id = t.vehicle_id WHERE t.company_id = ? AND t.started_at >= ? AND t.started_at < ?`).bind(cid, from, to),
        ctx.db.prepare(`SELECT coalesce(x.vehicle_id, t.vehicle_id) AS vehicle_id, x.amount_fcfa FROM trip_expenses x LEFT JOIN trips t ON t.id = x.trip_id
            WHERE x.company_id = ? AND x.status <> 'rejected' AND x.created_at >= ? AND x.created_at < ?`).bind(cid, from, to),
        ctx.db.prepare('SELECT vehicle_id, cost_fcfa FROM vehicle_logs WHERE company_id = ? AND cost_fcfa > 0 AND created_at >= ? AND created_at < ?').bind(cid, from, to),
        ctx.db.prepare(`SELECT courier_id, sum(amount_fcfa) AS amount FROM courier_earnings WHERE company_id = ? AND type IN ('delivery', 'bonus')
            AND created_at >= ? AND created_at < ? GROUP BY courier_id`).bind(cid, from, to),
        ctx.db.prepare(`SELECT coalesce(delivery_zone, '?') AS zone, sum(delivery_fee_fcfa) AS revenue FROM orders WHERE company_id = ? AND delivered_at >= ? AND delivered_at < ?
            GROUP BY coalesce(delivery_zone, '?')`).bind(cid, from, to),
        ctx.db.prepare('SELECT id, plate, kind FROM vehicles WHERE company_id = ?').bind(cid),
      ]);
      const P = pres.results; const sum = (xs, f) => xs.reduce((s, x) => s + (f(x) ?? 0), 0);
      const n = P.length; const d = P.filter((x) => x.event === 'deliver').length; const f = n - d;
      const expenses = sum(exp.results, (x) => x.amount_fcfa); const maintenance = sum(maint.results, (x) => x.cost_fcfa);
      const driverPay = sum(pay.results, (x) => x.amount); const km = Math.round(sum(trips.results, (t) => t.km) * 10) / 10;
      const revenue = sum(rev.results, (x) => x.revenue); const cost = expenses + maintenance + driverPay;
      const per = (x, y) => (y ? Math.round(x / y) : null);
      // paie d'un chauffeur répartie sur ses véhicules au prorata de ses livraisons
      const dv = new Map(); const dt = new Map();
      for (const x of P.filter((y) => y.event === 'deliver' && y.courier_id)) {
        dv.set(`${x.courier_id}|${x.vehicle_id}`, (dv.get(`${x.courier_id}|${x.vehicle_id}`) ?? 0) + 1); dt.set(x.courier_id, (dt.get(x.courier_id) ?? 0) + 1);
      }
      const payVeh = new Map();
      for (const [k, cnt] of dv) {
        const [courier, vehicle] = k.split('|'); const amount = pay.results.find((p) => p.courier_id === courier)?.amount ?? 0;
        payVeh.set(vehicle, (payVeh.get(vehicle) ?? 0) + (amount * cnt) / dt.get(courier));
      }
      const byVehicle = veh.results.map((v) => {
        const vt = trips.results.filter((t) => t.vehicle_id === v.id);
        const e = sum(exp.results.filter((x) => x.vehicle_id === v.id), (x) => x.amount_fcfa); const m = sum(maint.results.filter((x) => x.vehicle_id === v.id), (x) => x.cost_fcfa);
        const p = Math.round(payVeh.get(v.id) ?? 0); const vkm = Math.round(sum(vt, (t) => t.km) * 10) / 10;
        const del = P.filter((x) => x.vehicle_id === v.id && x.event === 'deliver').length;
        return { vehicle_id: v.id, plate: v.plate, kind: v.kind, trips: vt.length, km: vkm,
          fill_pct: vt.length ? Math.round(sum(vt, (t) => gaugeOf(t, t, 0, 0).fill_pct) / vt.length) : null, delivered: del,
          expenses_fcfa: e, maintenance_fcfa: m, driver_pay_fcfa: p, cost_fcfa: e + m + p, cost_per_km_fcfa: per(e + m + p, vkm), cost_per_package_fcfa: per(e + m + p, del) };
      }).filter((v) => v.trips > 0 || v.expenses_fcfa + v.maintenance_fcfa > 0).sort((x, y) => y.cost_fcfa - x.cost_fcfa || x.plate.localeCompare(y.plate));
      const zones = new Map();
      for (const x of P) { const g = zones.get(x.zone ?? '?') ?? { n: 0, d: 0, f: 0 }; g.n += 1; g[x.event === 'deliver' ? 'd' : 'f'] += 1; zones.set(x.zone ?? '?', g); }
      return {
        from: a.p_from, to: a.p_to,
        totals: { cost_fcfa: cost, expenses_fcfa: expenses, maintenance_fcfa: maintenance, driver_pay_fcfa: driverPay, presentations: n, delivered: d, failed: f, km,
          revenue_fcfa: revenue, margin_fcfa: revenue - cost, cost_per_presentation_fcfa: per(cost, n), cost_per_delivery_fcfa: per(cost, d), cost_per_km_fcfa: per(cost, km),
          // une présentation ratée coûte autant qu'une réussie, sans recette
          failure_cost_fcfa: n ? Math.round((cost * f) / n) : null },
        by_vehicle: byVehicle,
        by_zone: [...zones].map(([zone, g]) => {
          const zc = n ? Math.round((cost * g.n) / n) : null; const r = rev.results.find((x) => x.zone === zone)?.revenue ?? 0;
          return { zone, presentations: g.n, delivered: g.d, failed: g.f, revenue_fcfa: r, cost_fcfa: zc, margin_fcfa: r - (zc ?? 0), failure_cost_fcfa: n ? Math.round((cost * g.f) / n) : null };
        }).sort((x, y) => y.presentations - x.presentations || x.zone.localeCompare(y.zone)),
      };
    },
  },

  // Prévision : moyenne pondérée des 4 mêmes jours de semaine précédents, par zone, × facteur des jours de pic.
  lg_forecast: {
    roles: ['dispatcher', 'accountant'],
    async handler(ctx, a) {
      const days = Math.min(Math.max(int(a.p_days) ?? 7, 1), 31); const cid = ctx.company.id; const d0 = today(ctx);
      const since = `${addDays(d0, -35)}T00:00:00.000Z`;
      const [per, fleet, hist] = await ctx.db.batch([
        ctx.db.prepare(`SELECT avg(n) AS a FROM (SELECT count(*) AS n FROM trip_packages tp JOIN trips t ON t.id = tp.trip_id
            WHERE t.company_id = ? AND t.started_at > ? AND tp.outcome IN ('delivered', 'failed') GROUP BY t.id)`).bind(cid, new Date(Date.parse(ctx.now) - 28 * 86400000).toISOString()),
        ctx.db.prepare("SELECT count(*) AS n FROM vehicles WHERE company_id = ? AND status IN ('available', 'on_trip')").bind(cid),
        ctx.db.prepare(`SELECT substr(created_at, 1, 10) AS d, coalesce(delivery_zone, '?') AS zone, count(*) AS n FROM orders
            WHERE company_id = ? AND status <> 'cancelled' AND created_at > ? GROUP BY 1, 2`).bind(cid, since),
      ]);
      const perTrip = Math.max(per.results[0].a != null ? Math.round(per.results[0].a * 10) / 10 : 12, 4);
      const nFleet = fleet.results[0].n;
      const peaks = (Array.isArray(ctx.company.config.peak_days) ? ctx.company.config.peak_days : []);
      const W = { 1: 0.4, 2: 0.3, 3: 0.2, 4: 0.1 };
      const NAMES = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
      const out = [];
      for (let g = 1; g <= days; g++) {
        const d = addDays(d0, g); const zones = new Map();
        for (const h of hist.results) {
          const diff = Math.round((Date.parse(d) - Date.parse(h.d)) / 86400000);
          if (diff % 7 === 0 && W[diff / 7]) zones.set(h.zone, (zones.get(h.zone) ?? 0) + h.n * W[diff / 7]);
        }
        const pk = peaks.find((p) => p?.date === d); const factor = Number(pk?.factor ?? 1) || 1;
        const total = Math.round([...zones.values()].reduce((s, x) => s + x, 0) * factor * 10) / 10;
        const need = Math.ceil((total * 1.15) / perTrip);
        out.push({ date: d, weekday: NAMES[new Date(`${d}T00:00:00Z`).getUTCDay()], orders: total, peak: pk?.label ?? null, vehicles_needed: need, under_capacity: need > nFleet,
          zones: [...zones].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([zone, n]) => ({ zone, orders: Math.round(n * factor * 10) / 10 })) });
      }
      return { per_trip: perTrip, fleet: nFleet, days: out };
    },
  },

  // Anomalies : livraisons validées loin, écarts de caisse répétés, échecs anormaux, refus répétés, ruptures, zones.
  lg_anomalies: {
    roles: ['dispatcher', 'support', 'accountant'],
    async handler(ctx, a) {
      const since = new Date(Date.parse(ctx.now) - (int(a.p_days) ?? 30) * 86400000).toISOString();
      const radius = Number(ctx.company.config.proof_radius_m ?? 300); const cid = ctx.company.id;
      const [far, gaps, drv, cust, stock, zone] = await ctx.db.batch([
        ctx.db.prepare(`SELECT c.name, count(*) AS n, sum(pf.distance_m > ?3) AS far FROM proofs pf JOIN trip_stops s ON s.id = pf.stop_id JOIN trips t ON t.id = s.trip_id
            JOIN couriers c ON c.id = t.courier_id WHERE pf.company_id = ?1 AND pf.kind IN ('otp', 'signature') AND pf.created_at > ?2 GROUP BY t.courier_id`).bind(cid, since, radius),
        ctx.db.prepare(`SELECT c.name, count(*) AS n, sum(r.gap_fcfa) AS total FROM cash_remittances r JOIN couriers c ON c.id = r.courier_id
            WHERE r.company_id = ? AND r.validated_at > ? AND r.gap_fcfa < 0 GROUP BY r.courier_id HAVING count(*) >= 2`).bind(cid, since),
        ctx.db.prepare(`SELECT c.name, sum(s.status = 'delivered') AS d, sum(s.status = 'failed') AS f FROM trip_stops s JOIN trips t ON t.id = s.trip_id
            JOIN couriers c ON c.id = t.courier_id WHERE s.company_id = ? AND s.completed_at > ? AND s.kind = 'delivery' GROUP BY t.courier_id`).bind(cid, since),
        ctx.db.prepare(`SELECT max(o.buyer_name) AS name, max(o.buyer_phone) AS phone, count(*) AS n, sum(s.failure_reason = 'refused') AS refused
            FROM trip_stops s JOIN orders o ON o.id = s.order_id LEFT JOIN customers cu ON cu.id = o.customer_id
            WHERE s.company_id = ? AND s.status = 'failed' AND s.completed_at > ? GROUP BY coalesce(cu.phone_key, o.buyer_phone)
            HAVING count(*) >= 3 OR sum(s.failure_reason = 'refused') >= 2`).bind(cid, since),
        ctx.db.prepare(`SELECT coalesce(u.name, ?3) AS name, count(*) AS n, sum(l.status = 'short') AS short FROM pick_lines l JOIN pick_tasks t ON t.id = l.task_id
            LEFT JOIN users u ON u.id = t.vendor_id WHERE t.company_id = ?1 AND t.created_at > ?2 GROUP BY t.vendor_id`).bind(cid, since, ctx.company.name),
        ctx.db.prepare(`SELECT o.delivery_zone AS zone, sum(s.status = 'delivered') AS d, sum(s.status = 'failed') AS f FROM trip_stops s JOIN orders o ON o.id = s.order_id
            WHERE s.company_id = ? AND s.completed_at > ? AND s.kind = 'delivery' GROUP BY o.delivery_zone`).bind(cid, since),
      ]);
      const mask = (p) => String(p ?? '').replace(/\D/g, '').slice(-9).replace(/^(\d{2})\d{4}(\d{3})$/, '$1****$2');
      const out = [];
      for (const x of far.results) if (x.n >= 3 && (100 * x.far) / x.n >= 20) out.push({ kind: 'far_deliveries', subject_type: 'driver', subject: x.name, score: pct(x.far, x.n),
        metric: `${x.far} livraisons sur ${x.n} validées à plus de ${radius} m de l'adresse`, severity: (100 * x.far) / x.n >= 40 ? 'critical' : 'warning' });
      for (const x of gaps.results) out.push({ kind: 'cash_gaps', subject_type: 'driver', subject: x.name, score: 50 + x.n * 10,
        metric: `${x.n} écart(s) de caisse, ${x.total} F au total`, severity: 'critical' });
      for (const x of drv.results) if (x.d + x.f >= 5 && (100 * x.f) / (x.d + x.f) > 30) out.push({ kind: 'driver_failures', subject_type: 'driver', subject: x.name,
        score: pct(x.f, x.d + x.f), metric: `${x.f} échec(s) sur ${x.d + x.f} présentations`, severity: 'warning' });
      for (const x of cust.results) out.push({ kind: 'customer_refusals', subject_type: 'customer', subject: `${x.name} · ${mask(x.phone)}`, score: 40 + x.n * 15,
        metric: `${x.n} échec(s) dont ${x.refused} refus`, severity: x.refused >= 2 ? 'critical' : 'warning' });
      for (const x of stock.results) if (x.n >= 5 && (100 * x.short) / x.n > 15) out.push({ kind: 'vendor_stockouts', subject_type: 'vendor', subject: x.name,
        score: pct(x.short, x.n), metric: `${x.short} ligne(s) en rupture sur ${x.n}`, severity: 'warning' });
      for (const x of zone.results) if (x.d + x.f >= 5 && (100 * x.f) / (x.d + x.f) > 25) out.push({ kind: 'zone_failures', subject_type: 'zone', subject: x.zone,
        score: pct(x.f, x.d + x.f), metric: `${x.f} échec(s) sur ${x.d + x.f} présentations`, severity: 'info' });
      return out.sort((x, y) => y.score - x.score);
    },
  },

  lg_leaderboard: {
    roles: 'member',
    async handler(ctx, a) {
      if (!hasRole(ctx, ['dispatcher', 'cashier', 'accountant']) && !ctx.courierId) fail('forbidden', 403);
      return (await driverScores(ctx, Math.min(Math.max(int(a.p_days) ?? 7, 1), 90))).map((x) => ({ ...x, me: x.courier_id === ctx.courierId }));
    },
  },

  lg_return_stats: {
    roles: ['dock_chief', 'support', 'accountant', 'dispatcher'],
    async handler(ctx, a) {
      const t = today(ctx);
      const fromD = ISO_DAY.test(String(a.p_from ?? '')) ? a.p_from : addDays(t, -29); const toD = ISO_DAY.test(String(a.p_to ?? '')) ? a.p_to : t;
      const [from, to] = period(fromD, toD); const cid = ctx.company.id;
      const [ch, del, uncl] = await ctx.db.batch([
        ctx.db.prepare(`SELECT rc.cause, rc.payer, rc.amount_fcfa, rc.zone, rc.vendor_id, coalesce(o.vendor_name, '—') AS vendor_name FROM return_charges rc JOIN orders o ON o.id = rc.order_id
            WHERE rc.company_id = ? AND rc.classified_at >= ? AND rc.classified_at < ?`).bind(cid, from, to),
        ctx.db.prepare('SELECT vendor_id, count(*) AS n FROM orders WHERE company_id = ? AND delivered_at >= ? AND delivered_at < ? GROUP BY vendor_id').bind(cid, from, to),
        ctx.db.prepare(`SELECT count(*) AS n FROM packages p WHERE p.company_id = ? AND p.updated_at >= ? AND p.updated_at < ? AND (p.direction = 'return' OR p.attempts > 0)
            AND p.status IN ('returned_hub', 'returned_vendor', 'damaged', 'cancelled') AND NOT EXISTS (SELECT 1 FROM return_charges rc WHERE rc.package_id = p.id)`).bind(cid, from, to),
      ]);
      const C = ch.results; const causes = await causesOf(ctx);
      const sumPayer = (p) => C.filter((x) => x.payer === p).reduce((s, x) => s + x.amount_fcfa, 0);
      const byCause = new Map(); const byVendor = new Map(); const byZone = new Map();
      for (const x of C) {
        const c = byCause.get(x.cause) ?? { n: 0, a: 0 }; c.n += 1; c.a += x.amount_fcfa; byCause.set(x.cause, c);
        const v = byVendor.get(x.vendor_id ?? '') ?? { name: x.vendor_name, n: 0, vf: 0, a: 0 }; v.n += 1;
        if (x.payer === 'vendor') { v.vf += 1; v.a += x.amount_fcfa; } byVendor.set(x.vendor_id ?? '', v);
        const z = byZone.get(x.zone ?? '?') ?? { n: 0, causes: {} }; z.n += 1; z.causes[x.cause] = (z.causes[x.cause] ?? 0) + 1; byZone.set(x.zone ?? '?', z);
      }
      return {
        from: fromD, to: toD,
        totals: { returns: C.length, vendor_fcfa: sumPayer('vendor'), customer_fcfa: sumPayer('customer'), nexus_fcfa: sumPayer('company'), company_fcfa: sumPayer('company'),
          unclassified: uncl.results[0].n },
        by_cause: [...byCause].map(([code, x]) => { const c = causes.find((y) => y.code === code); return { cause: code, label: c?.label ?? code, payer: c?.payer ?? null, count: x.n, amount_fcfa: x.a, pos: c?.position ?? 99 }; })
          .sort((x, y) => y.count - x.count || x.pos - y.pos).map(({ pos, ...x }) => x),
        by_vendor: [...byVendor].map(([id, x]) => { const d = del.results.find((y) => (y.vendor_id ?? '') === id)?.n ?? 0;
          return { vendor_id: id || null, name: x.name, count: x.n, vendor_fault: x.vf, amount_fcfa: x.a, delivered: d, return_pct: pct(x.n, d + x.n, 1) }; })
          .sort((x, y) => y.count - x.count || String(x.name).localeCompare(String(y.name))),
        by_zone: [...byZone].map(([zone, x]) => ({ zone, count: x.n, causes: x.causes })).sort((x, y) => y.count - x.count),
      };
    },
  },

  // ----------------------------------------------------------------- renforts (jours de pic)
  lg_reinforcements: {
    roles: ['dispatcher'],
    async handler(ctx, a) {
      const t = today(ctx); const end = addDays(t, Math.min(Math.max(int(a.p_days) ?? 7, 0), 60));
      const [calls, answers] = await ctx.db.batch([
        ctx.db.prepare('SELECT * FROM reinforcement_calls WHERE company_id = ? AND day >= ? AND day <= ? ORDER BY day').bind(ctx.company.id, t, end),
        ctx.db.prepare(`SELECT a.call_id, a.available, a.answered_at, c.id AS courier_id, c.name, c.phone, c.vehicle_kind FROM reinforcement_answers a
            JOIN couriers c ON c.id = a.courier_id JOIN reinforcement_calls r ON r.id = a.call_id WHERE r.company_id = ? AND r.day >= ? AND r.day <= ?`).bind(ctx.company.id, t, end),
      ]);
      return calls.results.map((c) => {
        const ans = answers.results.filter((x) => x.call_id === c.id);
        return { id: c.id, day: c.day, needed: c.needed, zones: parseJson(c.zones, []), note: c.note, status: c.status,
          yes: ans.filter((x) => x.available === 1).length, no: ans.filter((x) => x.available === 0).length, waiting: ans.filter((x) => x.available == null).length,
          available: ans.filter((x) => x.available === 1).sort((x, y) => String(x.answered_at).localeCompare(String(y.answered_at)))
            .map((x) => ({ courier_id: x.courier_id, name: x.name, phone: x.phone, vehicle: x.vehicle_kind, at: x.answered_at })) };
      });
    },
  },

  // Appel à renforts : chaque chauffeur actif est sollicité une fois (message WhatsApp avec les messages, cycle C8).
  lg_reinforcement_call: {
    roles: ['dispatcher'],
    async handler(ctx, a) {
      const day = String(a.p_day ?? '');
      if (!ISO_DAY.test(day)) fail('invalid_period');
      if (day < today(ctx)) fail('past_day');
      const needed = int(a.p_needed);
      if (!(needed > 0)) fail('invalid_quantity');
      const zones = (Array.isArray(a.p_zones) ? a.p_zones : []).map((z) => text(z, 60)).filter(Boolean).slice(0, 30);
      const cid = ctx.company.id; const id = uuid();
      // chauffeurs actifs pas encore sollicités pour ce jour : ils reçoivent le message une fois
      const fresh = (await ctx.db.prepare(`SELECT c.id, c.name, c.phone, u.email FROM couriers c LEFT JOIN users u ON u.id = c.user_id
          WHERE c.company_id = ?1 AND c.active = 1 AND NOT EXISTS (SELECT 1 FROM reinforcement_answers a JOIN reinforcement_calls r ON r.id = a.call_id
            WHERE r.company_id = ?1 AND r.day = ?2 AND a.courier_id = c.id)`).bind(cid, day).all()).results;
      const res = await ctx.db.batch([
        ctx.db.prepare(`INSERT INTO reinforcement_calls (id, company_id, day, needed, zones, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (company_id, day) DO UPDATE SET needed = excluded.needed, zones = excluded.zones, note = excluded.note, status = 'open'`)
          .bind(id, cid, day, needed, JSON.stringify(zones), text(a.p_note, 300), ctx.user.id),
        ctx.db.prepare(`INSERT OR IGNORE INTO reinforcement_answers (call_id, company_id, courier_id)
            SELECT r.id, ?1, c.id FROM couriers c JOIN reinforcement_calls r ON r.company_id = ?1 AND r.day = ?2 WHERE c.company_id = ?1 AND c.active = 1`).bind(cid, day),
        ctx.db.prepare('SELECT id FROM reinforcement_calls WHERE company_id = ? AND day = ?').bind(cid, day),
      ]);
      const callId = res[2].results[0].id;
      const jour = `${day.slice(8, 10)}/${day.slice(5, 7)}`;
      await sendLater(ctx, await Promise.all(fresh.map((c) => notifyPerson(ctx, 'lg_reinforcement', { phone: c.phone, email: c.email },
        { prenom: String(c.name ?? '').split(' ')[0], jour, zones: zones.length ? ` (${zones.join(', ')})` : '' }))));
      await audit(ctx, 'reinforcement_call', 'day', day, { needed, notified: res[1].meta.changes });
      return { ok: true, id: callId, notified: res[1].meta.changes };
    },
  },

  lg_reinforcement_close: {
    roles: ['dispatcher'],
    async handler(ctx, a) {
      const r = await ctx.db.prepare("UPDATE reinforcement_calls SET status = 'closed' WHERE id = ? AND company_id = ?").bind(String(a.p_call ?? ''), ctx.company.id).run();
      if (!r.meta.changes) fail('unknown_call', 404);
      return { ok: true };
    },
  },

  lg_reinforcement_answer: {
    roles: 'member',
    async handler(ctx, a) {
      if (!ctx.courierId) fail('not_a_courier', 403);
      const r = await ctx.db.prepare(`UPDATE reinforcement_answers SET available = ?, answered_at = ? WHERE call_id = ? AND courier_id = ? AND company_id = ?
          AND EXISTS (SELECT 1 FROM reinforcement_calls c WHERE c.id = reinforcement_answers.call_id AND c.status = 'open' AND c.day >= ?)`)
        .bind(a.p_available === true ? 1 : 0, ctx.now, String(a.p_call ?? ''), ctx.courierId, ctx.company.id, today(ctx)).run();
      return r.meta.changes ? { ok: true } : { ok: false, error: 'call_closed' };
    },
  },

  lg_my_reinforcements: {
    roles: 'member',
    async handler(ctx) {
      if (!ctx.courierId) return [];
      const r = await ctx.db.prepare(`SELECT c.id, c.day, c.zones, c.note, a.available FROM reinforcement_calls c JOIN reinforcement_answers a ON a.call_id = c.id AND a.courier_id = ?
          WHERE c.company_id = ? AND c.status = 'open' AND c.day >= ? ORDER BY c.day`).bind(ctx.courierId, ctx.company.id, today(ctx)).all();
      return r.results.map((c) => ({ id: c.id, day: c.day, zones: parseJson(c.zones, []), note: c.note, available: c.available == null ? null : c.available === 1 }));
    },
  },
};
