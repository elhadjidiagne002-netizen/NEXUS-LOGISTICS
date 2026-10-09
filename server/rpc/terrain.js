// Cycle C5 — livraison sur le terrain (app chauffeur) : journée, départ signé, appel, arrivée (manuelle ou GPS),
// livraison avec preuve (code client OU signature + nom), photo, encaissement exact, échec motivé, fin de tournée,
// positions (au plus toutes les 30 s), SOS, dépenses, collecte chez un vendeur ou un client, transferts entre voyages.
// Portage de 20261007000400 (lg_trip_start … lg_trip_finish), cycle1 (collecte, transferts), cycle20 (alerte de colis
// non rapportés), cycle21 (arrivée automatique) et 20261007000700 (positions, SOS, dépenses).
// Un code client faux décompte un essai SANS lever d'erreur (règle 5) : la décrémentation reste écrite.
import { fail, audit, idempotent, hasRole, text, num, int, uuid, parseJson, distanceM, guard, runBatch, plusMinutes } from './core.js';
import { normCode } from './preparation.js';
import { tripFor, isTripDriver, refreshStatement, etaStatements, etaOrigin, loadPlan } from './voyages.js';
import { alertStatement, maintenanceAlert } from './flotte.js';
import { OUTSTANDING_SQL } from './caisse.js';
import { issueInvoice } from './factures.js';
import { notifyOrder, notifyPerson, sendLater, hhmm } from './messages.js';
import { webhookStatement } from './webhooks.js';

// Annexe C — motifs d'échec (mêmes codes que lg_failure_reasons et que l'app chauffeur)
export const FAILURE_REASONS = {
  absent: { label: 'Client absent', counts: true, call: true, vendor: false, incident: false },
  unreachable: { label: 'Client injoignable', counts: true, call: true, vendor: false, incident: false },
  address: { label: 'Adresse introuvable', counts: true, call: true, vendor: false, incident: false },
  refused: { label: 'Refus du colis', counts: true, call: false, vendor: true, incident: true },
  no_money: { label: "Pas d'argent disponible", counts: true, call: false, vendor: false, incident: false },
  postponed: { label: 'Report demandé', counts: true, call: false, vendor: false, incident: false },
  damaged: { label: "Colis abîmé à l'arrivée", counts: false, call: false, vendor: false, incident: true },
  wrong_product: { label: 'Mauvais produit', counts: false, call: false, vendor: false, incident: true },
  no_access: { label: 'Accès impossible', counts: false, call: false, vendor: false, incident: false },
  breakdown: { label: 'Panne ou accident', counts: false, call: false, vendor: false, incident: true },
};
const PAY_METHODS = ['cash', 'wave', 'orange_money'];
const pos = (a) => { const lat = num(a.p_lat); const lng = num(a.p_lng); return lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : { lat: null, lng: null }; };
const rnd = () => 'lower(hex(randomblob(16)))';

/** Le voyage du chauffeur connecté (ou n'importe quel voyage pour l'administrateur) — lg_assert_driver. */
async function driverTrip(ctx, tripId) {
  const t = await tripFor(ctx, tripId);
  if (!isTripDriver(ctx, t) && !ctx.isAdmin) fail('not_your_trip', 403);
  return t;
}
async function stopFor(ctx, id) {
  const s = await ctx.db.prepare('SELECT * FROM trip_stops WHERE id = ? AND company_id = ?').bind(String(id ?? ''), ctx.company.id).first();
  if (!s) fail('unknown_stop', 404);
  return s;
}
const courierPos = (ctx, courierId, p) => (p.lat == null ? [] : [ctx.db.prepare('UPDATE couriers SET last_lat = ?, last_lng = ?, last_seen_at = ? WHERE id = ? AND company_id = ?')
  .bind(p.lat, p.lng, ctx.now, courierId, ctx.company.id)]);

/** Espèces portées par un chauffeur (lg_courier_cash) : sur ses voyages pas encore versés en caisse. */
export async function cashInHand(ctx, courierId) {
  return ctx.db.prepare(
    `SELECT coalesce(sum(${OUTSTANDING_SQL}), 0) AS n FROM trips t WHERE t.company_id = ? AND t.courier_id = ? AND t.status IN ('sealed', 'in_progress', 'completed')
       AND NOT EXISTS (SELECT 1 FROM cash_remittances r WHERE r.trip_id = t.id)`,
  ).bind(ctx.company.id, courierId).first('n');
}

/**
 * Passe à l'arrêt suivant (lg_advance_trip) quand aucun n'est en cours, et recalcule les heures.
 * Le message « votre livreur arrive » part avec les messages clients (cycle C8). Renvoie l'arrêt suivant.
 */
export async function advanceTrip(ctx, tripId) {
  const t = await tripFor(ctx, tripId);
  const stops = (await ctx.db.prepare('SELECT id, seq, status, lat, lng, eta FROM trip_stops WHERE trip_id = ? AND company_id = ?').bind(t.id, ctx.company.id).all()).results;
  if (stops.some((s) => s.status === 'en_route' || s.status === 'arrived')) return null;
  const next = stops.filter((s) => s.status === 'pending').sort((a, b) => a.seq - b.seq)[0];
  if (!next) return null;
  next.status = 'en_route';
  await ctx.db.batch([
    ctx.db.prepare("UPDATE trip_stops SET status = 'en_route' WHERE id = ? AND company_id = ? AND status = 'pending'").bind(next.id, ctx.company.id),
    ...etaStatements(ctx, t, stops, await etaOrigin(ctx, t)),
  ]);
  // « votre livreur arrive » (lg_approaching) : seulement pour une livraison
  const s = await ctx.db.prepare(`SELECT s.kind, s.eta, s.cod_due_fcfa, c.name AS courier, o.* FROM trip_stops s JOIN orders o ON o.id = s.order_id
      LEFT JOIN couriers c ON c.id = ? WHERE s.id = ? AND s.company_id = ?`).bind(t.courier_id, next.id, ctx.company.id).first();
  if (s?.kind === 'delivery') {
    await sendLater(ctx, [await notifyOrder(ctx, 'lg_approaching', s, { livreur: String(s.courier ?? 'Votre livreur').split(' ')[0],
      minutes: Math.max(5, Math.round((Date.parse(s.eta ?? ctx.now) - Date.parse(ctx.now)) / 60000)), montant: s.cod_due_fcfa })]);
  }
  return next.id;
}

/** Bilan d'un voyage (lg_trip_summary). */
export async function tripSummary(ctx, tripId) {
  const t = await tripFor(ctx, tripId);
  const [st, pk, cc, dr] = await ctx.db.batch([
    ctx.db.prepare('SELECT status FROM trip_stops WHERE trip_id = ? AND company_id = ?').bind(t.id, ctx.company.id),
    ctx.db.prepare('SELECT p.code, p.status, p.holder_type, tp.outcome, tp.loaded_at FROM trip_packages tp JOIN packages p ON p.id = tp.package_id WHERE tp.trip_id = ? AND tp.company_id = ?').bind(t.id, ctx.company.id),
    ctx.db.prepare('SELECT cc.method, cc.amount_collected_fcfa AS a FROM cod_collections cc JOIN trip_stops s ON s.id = cc.stop_id WHERE s.trip_id = ? AND cc.company_id = ?').bind(t.id, ctx.company.id),
    ctx.db.prepare(`SELECT (SELECT coalesce(sum(amount_fcfa), 0) FROM cash_drops WHERE trip_id = ?1 AND company_id = ?2) AS dropped,
        EXISTS (SELECT 1 FROM cash_remittances WHERE trip_id = ?1 AND company_id = ?2) AS remitted`).bind(t.id, ctx.company.id),
  ]);
  const dropped = dr.results[0].dropped; const remitted = Boolean(dr.results[0].remitted);
  const cash = cc.results.filter((x) => x.method === 'cash').reduce((s, x) => s + x.a, 0);
  return {
    number: t.number, status: t.status,
    delivered: st.results.filter((s) => s.status === 'delivered').length, failed: st.results.filter((s) => s.status === 'failed').length,
    packages_to_return: pk.results.filter((p) => p.outcome === 'failed' && p.status === 'failed').map((p) => p.code),
    cash_to_remit_fcfa: cash - dropped, cash_dropped_fcfa: dropped,
    to_hub: pk.results.filter((p) => !p.outcome && p.loaded_at && p.holder_type === 'driver' && p.status === 'loaded').map((p) => p.code),
    mobile_collected_fcfa: cc.results.filter((x) => x.method !== 'cash').reduce((s, x) => s + x.a, 0),
    cod_expected_fcfa: t.cod_expected_fcfa, remitted,
  };
}

/** Colis à rapporter au quai après la tournée (lg_trip_unreturned). */
export const UNRETURNED_SQL = `SELECT p.code FROM trip_packages tp JOIN packages p ON p.id = tp.package_id WHERE tp.trip_id = ? AND tp.company_id = ?
  AND ((tp.outcome = 'failed' AND p.status = 'failed') OR (tp.outcome IS NULL AND tp.loaded_at IS NOT NULL AND p.holder_type = 'driver' AND p.status IN ('loaded', 'out_for_delivery')))
  ORDER BY p.code`;

const codesMatch = (expected, given) => {
  const g = [...new Set((Array.isArray(given) ? given : []).map(normCode))].sort();
  const e = [...expected].sort();
  return { ok: g.length === e.length && g.every((c, i) => c === e[i]), given: g, expected: e };
};

export default {
  // ----------------------------------------------------------------- ma journée
  lg_my_day: {
    roles: 'member',
    async handler(ctx) {
      if (!ctx.courierId) fail('not_a_courier', 403);
      const cid = ctx.company.id; const since = new Date(Date.parse(ctx.now) - 7 * 86400000).toISOString();
      const [c, trips, stops, pk, week, earn] = await ctx.db.batch([
        ctx.db.prepare('SELECT id, name, rating_avg, deliveries_done, cash_limit_fcfa FROM couriers WHERE id = ? AND company_id = ?').bind(ctx.courierId, cid),
        ctx.db.prepare(
          `SELECT t.*, v.plate, v.kind AS vkind FROM trips t JOIN vehicles v ON v.id = t.vehicle_id
            WHERE t.company_id = ? AND t.courier_id = ? AND t.status IN ('planned', 'loading', 'sealed', 'in_progress', 'completed') ORDER BY t.planned_departure`,
        ).bind(cid, ctx.courierId),
        ctx.db.prepare(
          `SELECT s.*, o.number FROM trip_stops s JOIN trips t ON t.id = s.trip_id LEFT JOIN orders o ON o.id = s.order_id
            WHERE t.company_id = ? AND t.courier_id = ? AND t.status IN ('planned', 'loading', 'sealed', 'in_progress', 'completed') AND s.status <> 'skipped'`,
        ).bind(cid, ctx.courierId),
        ctx.db.prepare(
          `SELECT tp.package_id, tp.stop_id, tp.loaded_at, tp.outcome, tp.transfer_from, p.code, p.seq_in_order, p.count_in_order, p.handling, p.weight_g, p.status, p.direction
             FROM trip_packages tp JOIN packages p ON p.id = tp.package_id JOIN trips t ON t.id = tp.trip_id
            WHERE t.company_id = ? AND t.courier_id = ? AND t.status IN ('planned', 'loading', 'sealed', 'in_progress', 'completed')`,
        ).bind(cid, ctx.courierId),
        ctx.db.prepare(
          `SELECT t.courier_id, sum(s.status = 'delivered') AS delivered, sum(s.status = 'failed') AS failed,
                  sum(s.status = 'delivered' AND s.completed_at <= coalesce(s.window_end, datetime(s.eta, '+30 minutes'))) AS on_time
             FROM trip_stops s JOIN trips t ON t.id = s.trip_id WHERE t.company_id = ? AND s.kind = 'delivery' AND s.completed_at > ? GROUP BY t.courier_id`,
        ).bind(cid, since),
        ctx.db.prepare(`SELECT coalesce(sum(CASE WHEN status = 'pending' THEN amount_fcfa END), 0) AS pending,
            coalesce(sum(CASE WHEN created_at > ? THEN amount_fcfa END), 0) AS week FROM courier_earnings WHERE company_id = ? AND courier_id = ?`).bind(since, cid, ctx.courierId),
      ]);
      const me = c.results[0];
      const limit = me.cash_limit_fcfa ?? Number(ctx.company.config.cash_limit_fcfa ?? 150000);
      // classement de la semaine : volume (40) + réussite (30) + ponctualité (20) + note (10)
      const score = (w) => Math.round((40 * Math.min((w?.delivered ?? 0) / 40, 1) + 0.3 * (w && w.delivered + w.failed ? (100 * w.delivered) / (w.delivered + w.failed) : 0)
        + 0.2 * (w?.delivered ? (100 * w.on_time) / w.delivered : 0)) * 10) / 10;
      const mine = week.results.find((w) => w.courier_id === ctx.courierId);
      const ranked = week.results.map((w) => ({ id: w.courier_id, s: score(w) })).sort((a, b) => b.s - a.s);
      const pkgs = pk.results.map((p) => ({ ...p, handling: parseJson(p.handling, []) }));
      return {
        courier: { id: me.id, name: me.name, rating: me.rating_avg, deliveries_done: me.deliveries_done, cash_limit_fcfa: limit },
        cash_in_hand_fcfa: await cashInHand(ctx, ctx.courierId),
        earnings_pending_fcfa: earn.results[0].pending,
        week: { delivered: mine?.delivered ?? 0, failed: mine?.failed ?? 0, on_time_pct: mine?.delivered ? Math.round((100 * mine.on_time) / mine.delivered) : null,
          first_attempt_pct: mine && mine.delivered + mine.failed ? Math.round((100 * mine.delivered) / (mine.delivered + mine.failed)) : null,
          rating: me.rating_avg, earnings: earn.results[0].week, score: score(mine), rank: (ranked.findIndex((r) => r.id === ctx.courierId) + 1) || null, of: ranked.length },
        trips: trips.results.map((t) => {
          const ts = stops.results.filter((s) => s.trip_id === t.id);
          const plan = loadPlan(ts, pkgs.filter((p) => ts.some((s) => s.id === p.stop_id)), t.vkind);
          return {
            id: t.id, number: t.number, label: t.label, status: t.status, kind: t.kind, planned_departure: t.planned_departure,
            cod_expected_fcfa: t.cod_expected_fcfa, signed: Boolean(t.courier_signature_path), vehicle: { id: t.vehicle_id, plate: t.plate, kind: t.vkind },
            stops: ts.sort((a, b) => a.seq - b.seq).map((s) => ({
              id: s.id, seq: s.seq, kind: s.kind, status: s.status, order_id: s.order_id, order_short: s.number != null ? String(s.number) : null,
              contact_name: s.contact_name,
              // le téléphone n'est montré que pendant la tournée (chapitre 11)
              contact_phone: ['sealed', 'in_progress'].includes(t.status) ? s.contact_phone : null,
              address: s.address, landmark: s.landmark, lat: s.lat, lng: s.lng, eta: s.eta, window_end: s.window_end, cod_due_fcfa: s.cod_due_fcfa,
              failure_reason: s.failure_reason, called: Boolean(s.call_attempted_at), arrived_auto: Boolean(s.arrived_auto),
              packages: pkgs.filter((p) => p.stop_id === s.id && p.outcome !== 'removed').map((p) => ({ code: p.code, seq: p.seq_in_order, count: p.count_in_order,
                handling: p.handling, weight_g: p.weight_g, status: p.status, load_zone: plan.get(p.package_id)?.load_zone ?? null,
                to_take: !p.loaded_at && Boolean(p.transfer_from), direction: p.direction })),
            })),
          };
        }),
      };
    },
  },

  // ----------------------------------------------------------------- départ, appel, arrivée
  // Départ signé : colis « en livraison », commandes « en route », code de livraison pour chaque client.
  lg_trip_start: {
    roles: 'member',
    async handler(ctx, a) {
      return idempotent(ctx, 'trip_start', a.p_event, async () => {
        const t = await driverTrip(ctx, a.p_trip);
        if (t.status !== 'sealed') fail('trip_not_sealed');
        const sig = text(a.p_signature_path, 300) ?? t.courier_signature_path;
        if (!sig) fail('signature_required');
        const p = pos(a); const cfg = ctx.company.config;
        const orders = (await ctx.db.prepare("SELECT DISTINCT order_id FROM trip_stops WHERE trip_id = ? AND company_id = ? AND kind = 'delivery' AND status = 'pending' AND order_id IS NOT NULL")
          .bind(t.id, ctx.company.id).all()).results.map((r) => r.order_id);
        const expires = plusMinutes(ctx.now, Number(cfg.otp_ttl_hours ?? 48) * 60);
        await runBatch(ctx, [
          guard(ctx.db, "(SELECT status FROM trips WHERE id = ?) = 'sealed'", [t.id]),
          ctx.db.prepare("UPDATE trips SET status = 'in_progress', started_at = ?, courier_signature_path = ?, updated_at = ? WHERE id = ? AND company_id = ?")
            .bind(ctx.now, sig, ctx.now, t.id, ctx.company.id),
          ctx.db.prepare(`UPDATE packages SET status = 'out_for_delivery', updated_at = ? WHERE company_id = ? AND direction = 'outbound' AND status = 'loaded'
              AND id IN (SELECT package_id FROM trip_packages WHERE trip_id = ? AND outcome IS NULL AND loaded_at IS NOT NULL)`).bind(ctx.now, ctx.company.id, t.id),
          ctx.db.prepare(`UPDATE orders SET status = 'in_transit', in_transit_at = coalesce(in_transit_at, ?), updated_at = ? WHERE company_id = ? AND status IN ('pending', 'processing')
              AND id IN (SELECT order_id FROM trip_stops WHERE trip_id = ? AND kind = 'delivery' AND status = 'pending')`).bind(ctx.now, ctx.now, ctx.company.id, t.id),
          // code de livraison : nouveau à chaque départ (l'ancien ne vaut plus) ; envoyé au client (C8) et visible sur sa page de suivi
          ...orders.map((o) => ctx.db.prepare(
            `INSERT INTO delivery_codes (order_id, company_id, code, attempts_left, expires_at, verified_at) VALUES (?, ?, ?, ?, ?, NULL)
             ON CONFLICT (order_id) DO UPDATE SET code = excluded.code, attempts_left = excluded.attempts_left, expires_at = excluded.expires_at, verified_at = NULL`,
          ).bind(o, ctx.company.id, String(crypto.getRandomValues(new Uint16Array(1))[0] % 10000).padStart(4, '0'), Number(cfg.otp_attempts ?? 3), expires)),
          ...courierPos(ctx, t.courier_id, p),
        ], 'trip_not_sealed');
        await advanceTrip(ctx, t.id);
        // « en route » avec le code de livraison ; la personne désignée par le client reçoit le même code
        const rows = (await ctx.db.prepare(`SELECT o.*, dc.code, s.eta, c.name AS courier FROM trip_stops s JOIN orders o ON o.id = s.order_id
            JOIN delivery_codes dc ON dc.order_id = o.id LEFT JOIN couriers c ON c.id = ? WHERE s.trip_id = ? AND s.company_id = ? AND s.kind = 'delivery'
              AND s.status IN ('pending', 'en_route')`).bind(t.courier_id, t.id, ctx.company.id).all()).results;
        const msgs = [];
        for (const o of rows) {
          const v = { code: o.code, livreur: String(o.courier ?? 'votre livreur').split(' ')[0], heure: hhmm(o.eta) ?? "aujourd'hui" };
          msgs.push(await notifyOrder(ctx, 'lg_out_for_delivery', o, v), webhookStatement(ctx, o.id, 'order.in_transit', { eta: o.eta, courier: v.livreur }));
          if (o.recipient_phone) msgs.push(await notifyPerson(ctx, 'lg_third_party_code', { phone: o.recipient_phone, orderId: o.id },
            { ...v, destinataire: o.recipient_name, prenom: String(o.buyer_name ?? '').split(' ')[0] }));
        }
        await sendLater(ctx, msgs);
        return { ok: true };
      });
    },
  },

  // « Appeler » : trace la tentative d'appel exigée avant « client absent ».
  lg_stop_call: {
    roles: 'member',
    async handler(ctx, a) {
      const s = await stopFor(ctx, a.p_stop);
      await driverTrip(ctx, s.trip_id);
      await ctx.db.prepare('UPDATE trip_stops SET call_attempted_at = ? WHERE id = ? AND company_id = ?').bind(ctx.now, s.id, ctx.company.id).run();
      return { ok: true, phone: s.contact_phone };
    },
  },

  lg_stop_arrive: {
    roles: 'member',
    async handler(ctx, a) {
      return idempotent(ctx, 'arrive', a.p_event, async () => {
        const s = await stopFor(ctx, a.p_stop);
        const t = await driverTrip(ctx, s.trip_id);
        await ctx.db.batch([
          ctx.db.prepare("UPDATE trip_stops SET status = 'arrived', arrived_at = ? WHERE id = ? AND company_id = ? AND status IN ('pending', 'en_route')").bind(ctx.now, s.id, ctx.company.id),
          ...courierPos(ctx, t.courier_id, pos(a)),
        ]);
        return { ok: true };
      });
    },
  },

  // Position du chauffeur pendant la tournée : au plus une écriture toutes les 25 s, trace toutes les 2 min,
  // arrivée détectée automatiquement près de l'arrêt en cours (GPS précis, rayon auto_arrive_m, 0 = désactivé).
  lg_driver_ping: {
    roles: 'member',
    async handler(ctx, a) {
      if (!ctx.courierId) fail('not_a_courier', 403);
      const p = pos(a);
      if (p.lat == null) fail('invalid_position');
      const [t, c] = await ctx.db.batch([
        ctx.db.prepare("SELECT id FROM trips WHERE company_id = ? AND courier_id = ? AND status = 'in_progress' LIMIT 1").bind(ctx.company.id, ctx.courierId),
        ctx.db.prepare('SELECT last_seen_at, (SELECT max(recorded_at) FROM driver_positions WHERE courier_id = couriers.id) AS last_trace FROM couriers WHERE id = ? AND company_id = ?')
          .bind(ctx.courierId, ctx.company.id),
      ]);
      const trip = t.results[0]?.id;
      if (!trip) return { ok: true, stored: false, reason: 'off_duty' };
      const last = c.results[0];
      const stmts = [];
      if (!last.last_seen_at || last.last_seen_at < plusMinutes(ctx.now, -25 / 60)) stmts.push(...courierPos(ctx, ctx.courierId, p));
      const trace = !last.last_trace || last.last_trace < plusMinutes(ctx.now, -2);
      if (trace) stmts.push(ctx.db.prepare('INSERT INTO driver_positions (company_id, courier_id, trip_id, lat, lng, accuracy_m, speed_kmh, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(ctx.company.id, ctx.courierId, trip, p.lat, p.lng, int(a.p_accuracy_m), num(a.p_speed_kmh), ctx.now));
      const radius = Number(ctx.company.config.auto_arrive_m ?? 80);
      let arrived = null;
      if (radius > 0 && (int(a.p_accuracy_m) ?? 0) <= 100) {
        const s = await ctx.db.prepare("SELECT id, seq, lat, lng FROM trip_stops WHERE trip_id = ? AND company_id = ? AND status = 'en_route' AND lat IS NOT NULL ORDER BY seq LIMIT 1")
          .bind(trip, ctx.company.id).first();
        if (s && distanceM(s.lat, s.lng, p.lat, p.lng) <= radius) {
          arrived = s;
          stmts.push(ctx.db.prepare("UPDATE trip_stops SET status = 'arrived', arrived_at = ?, arrived_auto = 1 WHERE id = ? AND company_id = ? AND status = 'en_route'").bind(ctx.now, s.id, ctx.company.id));
        }
      }
      if (stmts.length) await ctx.db.batch(stmts);
      return arrived ? { ok: true, stored: trace, arrived_stop: arrived.id, seq: arrived.seq } : { ok: true, stored: trace };
    },
  },

  // ----------------------------------------------------------------- livraison
  // Colis scannés (tous ceux de l'arrêt, rien d'autre), preuve, photo, encaissement exact.
  lg_deliver: {
    roles: 'member',
    async handler(ctx, a) {
      return idempotent(ctx, 'deliver', a.p_event, async () => {
        const s = await stopFor(ctx, a.p_stop);
        const t = await driverTrip(ctx, s.trip_id);
        if (t.status !== 'in_progress') fail('trip_not_in_progress');
        if (!['pending', 'en_route', 'arrived'].includes(s.status)) return { ok: false, error: 'stop_closed', status: s.status };
        if (s.kind !== 'delivery') return { ok: false, error: 'not_a_delivery_stop' };
        const pk = (await ctx.db.prepare('SELECT p.code, tp.loaded_at FROM trip_packages tp JOIN packages p ON p.id = tp.package_id WHERE tp.stop_id = ? AND tp.company_id = ? AND tp.outcome IS NULL')
          .bind(s.id, ctx.company.id).all()).results;
        if (pk.some((p) => !p.loaded_at)) return { ok: false, error: 'transfer_pending' };
        // 1. colis
        const m = codesMatch(pk.map((p) => p.code), a.p_codes);
        if (!m.ok) return { ok: false, error: 'package_mismatch', expected: m.expected, given: m.given };
        // 2. preuve
        const cfg = ctx.company.config; let proof;
        const otp = text(a.p_otp, 10);
        if (otp) {
          const dc = await ctx.db.prepare('SELECT * FROM delivery_codes WHERE order_id = ? AND company_id = ?').bind(s.order_id, ctx.company.id).first();
          if (!dc || dc.expires_at < ctx.now) return { ok: false, error: 'code_expired' };
          if (dc.attempts_left <= 0) return { ok: false, error: 'code_locked' };
          if (dc.code !== otp) {
            // un essai de moins, écrit (pas d'exception : elle annulerait la décrémentation)
            await ctx.db.prepare('UPDATE delivery_codes SET attempts_left = attempts_left - 1 WHERE order_id = ? AND company_id = ? AND attempts_left > 0').bind(s.order_id, ctx.company.id).run();
            return { ok: false, error: 'bad_code', attempts_left: dc.attempts_left - 1 };
          }
          proof = 'otp';
        } else if (text(a.p_signature_path, 300) && text(a.p_recipient_name, 80)) {
          proof = 'signature';
        } else return { ok: false, error: 'proof_required' };
        const photo = text(a.p_photo_path, 300);
        if (cfg.require_photo !== false && cfg.require_photo !== 'false' && !photo) return { ok: false, error: 'photo_required' };
        // 3. encaissement : le montant affiché, ni plus ni moins
        const pays = Array.isArray(a.p_payments) ? a.p_payments : [];
        let paid = 0; let cash = 0;
        for (const x of pays) {
          const amt = int(x?.amount);
          if (!PAY_METHODS.includes(x?.method) || amt == null || amt < 0) return { ok: false, error: 'invalid_payment' };
          paid += amt; if (x.method === 'cash') cash += amt;
        }
        if (paid !== s.cod_due_fcfa) return { ok: false, error: 'amount_mismatch', due: s.cod_due_fcfa, given: paid };
        // 4. écritures (un seul lot)
        const p = pos(a); const dist = distanceM(s.lat, s.lng, p.lat, p.lng);
        const far = dist != null && dist > Number(cfg.proof_radius_m ?? 300);
        const o = await ctx.db.prepare('SELECT o.*, c.phone_key FROM orders o LEFT JOIN customers c ON c.id = o.customer_id WHERE o.id = ? AND o.company_id = ?').bind(s.order_id, ctx.company.id).first();
        const cid = ctx.company.id;
        const stmts = [
          guard(ctx.db, "(SELECT status FROM trip_stops WHERE id = ?) IN ('pending', 'en_route', 'arrived')", [s.id]),
          ctx.db.prepare('INSERT INTO proofs (id, company_id, stop_id, kind, file_path, recipient_name, lat, lng, distance_m, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(uuid(), cid, s.id, proof, proof === 'signature' ? text(a.p_signature_path, 300) : null, text(a.p_recipient_name, 80), p.lat, p.lng, dist, ctx.user.id),
        ];
        if (photo) stmts.push(ctx.db.prepare("INSERT INTO proofs (id, company_id, stop_id, kind, file_path, lat, lng, distance_m, created_by) VALUES (?, ?, ?, 'photo', ?, ?, ?, ?, ?)")
          .bind(uuid(), cid, s.id, photo, p.lat, p.lng, dist, ctx.user.id));
        if (proof === 'otp') stmts.push(ctx.db.prepare('UPDATE delivery_codes SET verified_at = ? WHERE order_id = ? AND company_id = ?').bind(ctx.now, s.order_id, cid));
        for (const x of pays) if (int(x.amount) > 0) {
          stmts.push(ctx.db.prepare('INSERT INTO cod_collections (id, company_id, stop_id, order_id, courier_id, amount_due_fcfa, amount_collected_fcfa, method, payment_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(uuid(), cid, s.id, s.order_id, t.courier_id, s.cod_due_fcfa, int(x.amount), x.method, text(x.ref, 60)));
        }
        stmts.push(
          ctx.db.prepare(`INSERT INTO scan_events (company_id, client_event_id, package_id, event, actor_id, trip_id, lat, lng, device_at, meta)
              SELECT ?, ${rnd()}, tp.package_id, 'deliver', ?, ?, ?, ?, ?, ? FROM trip_packages tp WHERE tp.stop_id = ? AND tp.outcome IS NULL`)
            .bind(cid, ctx.user.id, s.trip_id, p.lat, p.lng, text(a.p_device_at, 40) ?? ctx.now, JSON.stringify({ stop: s.id, proof }), s.id),
          ctx.db.prepare(`UPDATE packages SET status = 'delivered', holder_type = 'customer', holder_id = NULL, updated_at = ? WHERE company_id = ?
              AND id IN (SELECT package_id FROM trip_packages WHERE stop_id = ? AND outcome IS NULL)`).bind(ctx.now, cid, s.id),
          ctx.db.prepare("UPDATE trip_packages SET outcome = 'delivered' WHERE stop_id = ? AND company_id = ? AND outcome IS NULL").bind(s.id, cid),
          ctx.db.prepare("UPDATE trip_stops SET status = 'delivered', completed_at = ?, arrived_at = coalesce(arrived_at, ?) WHERE id = ? AND company_id = ?").bind(ctx.now, ctx.now, s.id, cid),
          ctx.db.prepare('UPDATE trips SET cash_collected_fcfa = cash_collected_fcfa + ?, updated_at = ? WHERE id = ? AND company_id = ?').bind(cash, ctx.now, s.trip_id, cid),
          ctx.db.prepare('UPDATE couriers SET deliveries_done = deliveries_done + 1 WHERE id = ? AND company_id = ?').bind(t.courier_id, cid),
          ...courierPos(ctx, t.courier_id, p),
          // commande livrée quand tous ses colis le sont ; payée si paiement à la livraison ; à terme : échéance = livraison + délai
          ctx.db.prepare(`UPDATE orders SET status = 'delivered', delivered_at = ?, updated_at = ?,
              payment_status = CASE WHEN payment_method = 'cod' THEN 'paid' ELSE payment_status END,
              paid_at = CASE WHEN payment_method = 'cod' THEN coalesce(paid_at, ?) ELSE paid_at END,
              due_at = CASE WHEN payment_terms_days IS NOT NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+' || payment_terms_days || ' days') ELSE due_at END
            WHERE id = ? AND company_id = ? AND NOT EXISTS (SELECT 1 FROM packages WHERE order_id = ? AND status NOT IN ('delivered', 'cancelled'))`)
            .bind(ctx.now, ctx.now, ctx.now, ctx.now, s.order_id, cid, s.order_id),
        );
        // adresse vérifiée pour la prochaine fois (pas si la remise s'est faite loin de l'adresse prévue)
        if (p.lat != null && o?.phone_key && !far) stmts.push(ctx.db.prepare(
          `INSERT INTO verified_addresses (company_id, phone_key, lat, lng, landmark, zone, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (company_id, phone_key) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, landmark = coalesce(excluded.landmark, verified_addresses.landmark),
             zone = excluded.zone, deliveries = verified_addresses.deliveries + 1, updated_at = excluded.updated_at`,
        ).bind(cid, o.phone_key, p.lat, p.lng, s.landmark ?? o.landmark, o.delivery_zone, ctx.now));
        if (far) stmts.push(alertStatement(ctx, cid, 'far_delivery', 'warning', `Arrêt ${s.seq} du voyage ${t.number} validé à ${dist} m de l'adresse`, { trip: t.id, stop: s.id, dedupe: `far:${s.id}` }));
        await runBatch(ctx, stmts, 'stop_closed');
        // facture à la livraison (jamais bloquante) ; message « livré » au client : cycle C8
        let invoice = null;
        if ((await ctx.db.prepare('SELECT status FROM orders WHERE id = ? AND company_id = ?').bind(s.order_id, cid).first('status')) === 'delivered') {
          try { invoice = (await issueInvoice(ctx, s.order_id)).number ?? null; } catch (e) { await audit(ctx, 'invoice_failed', 'order', s.order_id, { error: String(e?.message ?? e) }); }
        }
        const inHand = await cashInHand(ctx, t.courier_id);
        const limit = (await ctx.db.prepare('SELECT cash_limit_fcfa FROM couriers WHERE id = ?').bind(t.courier_id).first('cash_limit_fcfa')) ?? Number(cfg.cash_limit_fcfa ?? 150000);
        if (inHand > limit) await alertStatement(ctx, cid, 'cash_limit', 'critical', `Le chauffeur du voyage ${t.number} porte ${inHand} F (plafond ${limit} F)`,
          { trip: t.id, dedupe: `cash_limit:${t.id}` }).run();
        await sendLater(ctx, [await notifyOrder(ctx, 'lg_delivered', o ? { ...o, status: 'delivered', payment_status: o.payment_terms_days != null ? o.payment_status : 'paid' } : null,
          { heure: hhmm(ctx.now), facture: invoice ?? '' }), webhookStatement(ctx, s.order_id, 'order.delivered', { invoice, proof, collected_fcfa: paid })]);
        const next = await advanceTrip(ctx, t.id);
        return { ok: true, far, distance_m: dist, cash_in_hand_fcfa: inHand, must_remit: inHand > limit, invoice, next_stop: next };
      });
    },
  },

  // Échec : motif de la liste, photo, appel exigé pour certains motifs ; incident ouvert si besoin.
  lg_fail: {
    roles: 'member',
    async handler(ctx, a) {
      return idempotent(ctx, 'fail', a.p_event, async () => {
        const s = await stopFor(ctx, a.p_stop);
        const t = await driverTrip(ctx, s.trip_id);
        if (t.status !== 'in_progress') fail('trip_not_in_progress');
        if (!['pending', 'en_route', 'arrived'].includes(s.status)) return { ok: false, error: 'stop_closed' };
        const r = FAILURE_REASONS[a.p_reason];
        if (!r) return { ok: false, error: 'unknown_reason' };
        if (r.call && !s.call_attempted_at) return { ok: false, error: 'call_required' };
        const cfg = ctx.company.config; const photo = text(a.p_photo_path, 300);
        if (cfg.require_photo !== false && cfg.require_photo !== 'false' && !photo) return { ok: false, error: 'photo_required' };
        const p = pos(a); const cid = ctx.company.id; const note = text(a.p_note, 500);
        const stmts = [guard(ctx.db, "(SELECT status FROM trip_stops WHERE id = ?) IN ('pending', 'en_route', 'arrived')", [s.id])];
        if (photo) stmts.push(ctx.db.prepare("INSERT INTO proofs (id, company_id, stop_id, kind, file_path, lat, lng, distance_m, created_by) VALUES (?, ?, ?, 'failure_photo', ?, ?, ?, ?, ?)")
          .bind(uuid(), cid, s.id, photo, p.lat, p.lng, distanceM(s.lat, s.lng, p.lat, p.lng), ctx.user.id));
        stmts.push(
          ctx.db.prepare(`INSERT INTO scan_events (company_id, client_event_id, package_id, event, actor_id, trip_id, lat, lng, device_at, meta)
              SELECT ?, ${rnd()}, tp.package_id, 'fail', ?, ?, ?, ?, ?, ? FROM trip_packages tp WHERE tp.stop_id = ? AND tp.outcome IS NULL`)
            .bind(cid, ctx.user.id, s.trip_id, p.lat, p.lng, text(a.p_device_at, 40) ?? ctx.now, JSON.stringify({ reason: a.p_reason, note }), s.id),
          ctx.db.prepare(`UPDATE packages SET status = 'failed', attempts = attempts + ?, updated_at = ? WHERE company_id = ?
              AND id IN (SELECT package_id FROM trip_packages WHERE stop_id = ? AND outcome IS NULL)`).bind(r.counts ? 1 : 0, ctx.now, cid, s.id),
          ctx.db.prepare("UPDATE trip_packages SET outcome = 'failed' WHERE stop_id = ? AND company_id = ? AND outcome IS NULL").bind(s.id, cid),
          ctx.db.prepare("UPDATE trip_stops SET status = 'failed', failure_reason = ?, completed_at = ?, arrived_at = coalesce(arrived_at, ?) WHERE id = ? AND company_id = ?")
            .bind(a.p_reason, ctx.now, ctx.now, s.id, cid),
          alertStatement(ctx, cid, 'failure', 'warning', `Échec arrêt ${s.seq}, voyage ${t.number} : ${r.label}`, { trip: t.id, stop: s.id, dedupe: `fail:${s.id}` }),
          ...courierPos(ctx, t.courier_id, p),
        );
        let incident = null;
        if (r.incident) {
          incident = uuid();
          stmts.push(
            ctx.db.prepare("INSERT INTO counters (company_id, key, n) VALUES (?, 'incident', 1) ON CONFLICT (company_id, key) DO UPDATE SET n = n + 1").bind(cid),
            ctx.db.prepare(`INSERT INTO incidents (id, company_id, number, kind, trip_id, stop_id, order_id, description, photos, reported_by, responsible_type, due_at)
                VALUES (?, ?, (SELECT n FROM counters WHERE company_id = ? AND key = 'incident'), ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              .bind(incident, cid, cid, { damaged: 'damaged', wrong_product: 'wrong_product', refused: 'refused', breakdown: 'vehicle_breakdown' }[a.p_reason] ?? 'other',
                t.id, s.id, s.order_id, note ?? r.label, JSON.stringify(photo ? [photo] : []), ctx.user.id,
                { wrong_product: 'vendor', refused: 'customer' }[a.p_reason] ?? 'unknown', plusMinutes(ctx.now, 48 * 60)),
          );
        }
        await runBatch(ctx, stmts, 'stop_closed');
        // message au client : choisir un autre jour ou être rappelé (réponse 1, 2 ou 3)
        const ord = await ctx.db.prepare('SELECT * FROM orders WHERE id = ? AND company_id = ?').bind(s.order_id, cid).first();
        await sendLater(ctx, [await notifyOrder(ctx, 'lg_failed', ord, { heure: hhmm(ctx.now), motif: r.label.toLowerCase() }),
          webhookStatement(ctx, s.order_id, 'order.failed', { reason: a.p_reason, label: r.label })]);
        const next = await advanceTrip(ctx, t.id);
        return { ok: true, incident_id: incident, next_stop: next };
      });
    },
  },

  // Fin de tournée : chaque arrêt a une issue ; colis à rapporter signalés à la tour de contrôle.
  lg_trip_finish: {
    roles: 'member',
    async handler(ctx, a) {
      return idempotent(ctx, 'trip_finish', a.p_event, async () => {
        const t = await driverTrip(ctx, a.p_trip);
        if (t.status !== 'in_progress') fail('trip_not_in_progress');
        if (await ctx.db.prepare("SELECT 1 AS x FROM trip_stops WHERE trip_id = ? AND company_id = ? AND status IN ('pending', 'en_route', 'arrived')").bind(t.id, ctx.company.id).first()) {
          return { ok: false, error: 'stops_pending' };
        }
        await runBatch(ctx, [
          guard(ctx.db, "(SELECT status FROM trips WHERE id = ?) = 'in_progress'", [t.id]),
          ctx.db.prepare("UPDATE trips SET status = 'completed', ended_at = ?, updated_at = ? WHERE id = ? AND company_id = ?").bind(ctx.now, ctx.now, t.id, ctx.company.id),
        ], 'trip_not_in_progress');
        // colis à rapporter au quai (échecs, colis jamais livrés) : alerte, levée au dernier scan de retour
        const codes = (await ctx.db.prepare(UNRETURNED_SQL).bind(t.id, ctx.company.id).all()).results.map((r) => r.code);
        if (codes.length) await alertStatement(ctx, ctx.company.id, 'not_scanned', 'warning', `Voyage ${t.number} clôturé : ${codes.length} colis à rapporter au quai (${codes.join(', ')})`,
          { trip: t.id, dedupe: `unreturned:${t.id}` }).run();
        try { await maintenanceAlert(ctx, t.vehicle_id); } catch { /* une alerte ne bloque jamais la clôture */ }
        return { ...(await tripSummary(ctx, t.id)), ok: true };
      });
    },
  },

  // ----------------------------------------------------------------- SOS, dépenses
  lg_sos: {
    roles: 'member',
    async handler(ctx, a) {
      if (!ctx.courierId) fail('not_a_courier', 403);
      const kind = ['panne', 'accident', 'agression'].includes(a.p_kind) ? a.p_kind : 'autre';
      const p = pos(a); const cid = ctx.company.id;
      const [t, c] = await ctx.db.batch([
        ctx.db.prepare("SELECT id, number FROM trips WHERE company_id = ? AND courier_id = ? AND status IN ('sealed', 'in_progress') LIMIT 1").bind(cid, ctx.courierId),
        ctx.db.prepare('SELECT name FROM couriers WHERE id = ?').bind(ctx.courierId),
      ]);
      const trip = t.results[0]?.id ?? null; const name = c.results[0].name;
      const where = p.lat != null ? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` : 'position inconnue';
      const incident = uuid();
      const res = await ctx.db.batch([
        ctx.db.prepare("INSERT INTO counters (company_id, key, n) VALUES (?, 'incident', 1) ON CONFLICT (company_id, key) DO UPDATE SET n = n + 1").bind(cid),
        ctx.db.prepare(`INSERT INTO incidents (id, company_id, number, kind, severity, trip_id, description, reported_by, responsible_type, responsible_id, due_at)
            VALUES (?, ?, (SELECT n FROM counters WHERE company_id = ? AND key = 'incident'), ?, 'critical', ?, ?, ?, 'driver', ?, ?) RETURNING number`)
          .bind(incident, cid, cid, { panne: 'vehicle_breakdown', accident: 'accident' }[kind] ?? 'other', trip,
            `ALERTE ${kind.toUpperCase()} — ${name}${a.p_note ? ' : ' + text(a.p_note, 300) : ''}`, ctx.user.id, ctx.courierId, plusMinutes(ctx.now, 60)),
        alertStatement(ctx, cid, 'sos', 'critical', `ALERTE ${kind.toUpperCase()} : ${name} (${where})`, { trip, dedupe: `sos:${ctx.courierId}:${ctx.now.slice(0, 16)}` }),
        ...courierPos(ctx, ctx.courierId, p),
      ]);
      return { ok: true, incident: res[1].results[0].number };
    },
  },

  lg_add_expense: {
    roles: 'member',
    async handler(ctx, a) {
      if (!ctx.courierId) fail('not_a_courier', 403);
      const kind = ['carburant', 'peage', 'reparation', 'amende', 'stationnement', 'autre'].includes(a.p_kind) ? a.p_kind : null;
      if (!kind) fail('invalid_kind');
      const amt = int(a.p_amount_fcfa);
      if (!(amt > 0)) fail('invalid_amount');
      const t = await ctx.db.prepare("SELECT id, vehicle_id FROM trips WHERE company_id = ? AND courier_id = ? AND status IN ('sealed', 'in_progress', 'completed') ORDER BY created_at DESC LIMIT 1")
        .bind(ctx.company.id, ctx.courierId).first();
      await ctx.db.prepare('INSERT INTO trip_expenses (id, company_id, trip_id, vehicle_id, courier_id, kind, amount_fcfa, receipt_path, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(uuid(), ctx.company.id, t?.id ?? null, t?.vehicle_id ?? null, ctx.courierId, kind, amt, text(a.p_receipt_path, 300), text(a.p_note, 300), ctx.user.id).run();
      return { ok: true };
    },
  },

  // ----------------------------------------------------------------- collecte (vendeur ou client) par le chauffeur
  lg_collect: {
    roles: 'member',
    async handler(ctx, a) {
      return idempotent(ctx, 'collect', a.p_event, async () => {
        const s = await stopFor(ctx, a.p_stop);
        const t = await driverTrip(ctx, s.trip_id);
        if (t.status !== 'in_progress') fail('trip_not_in_progress');
        if (s.kind !== 'pickup' && s.kind !== 'return') return { ok: false, error: 'not_a_pickup_stop' };
        if (!['pending', 'en_route', 'arrived'].includes(s.status)) return { ok: false, error: 'stop_closed' };
        const pk = (await ctx.db.prepare('SELECT p.code FROM trip_packages tp JOIN packages p ON p.id = tp.package_id WHERE tp.stop_id = ? AND tp.company_id = ? AND tp.outcome IS NULL')
          .bind(s.id, ctx.company.id).all()).results.map((p) => p.code);
        const m = codesMatch(pk, a.p_codes);
        if (!m.ok) return { ok: false, error: 'package_mismatch', expected: m.expected, given: m.given };
        const photo = text(a.p_photo_path, 300); const cfg = ctx.company.config;
        if (s.kind === 'return' && cfg.require_photo !== false && cfg.require_photo !== 'false' && !photo) return { ok: false, error: 'photo_required' };
        const p = pos(a); const cid = ctx.company.id;
        const stmts = [guard(ctx.db, "(SELECT status FROM trip_stops WHERE id = ?) IN ('pending', 'en_route', 'arrived')", [s.id])];
        if (photo) stmts.push(ctx.db.prepare("INSERT INTO proofs (id, company_id, stop_id, kind, file_path, lat, lng, distance_m, created_by) VALUES (?, ?, ?, 'photo', ?, ?, ?, ?, ?)")
          .bind(uuid(), cid, s.id, photo, p.lat, p.lng, distanceM(s.lat, s.lng, p.lat, p.lng), ctx.user.id));
        stmts.push(
          ctx.db.prepare(`INSERT INTO scan_events (company_id, client_event_id, package_id, event, actor_id, trip_id, lat, lng, device_at, meta)
              SELECT ?, ${rnd()}, tp.package_id, 'load', ?, ?, ?, ?, ?, ? FROM trip_packages tp WHERE tp.stop_id = ? AND tp.outcome IS NULL`)
            .bind(cid, ctx.user.id, s.trip_id, p.lat, p.lng, ctx.now, JSON.stringify({ collect: s.kind }), s.id),
          ctx.db.prepare('UPDATE trip_packages SET loaded_at = ?, loaded_by = ? WHERE stop_id = ? AND company_id = ? AND outcome IS NULL').bind(ctx.now, ctx.user.id, s.id, cid),
          ctx.db.prepare(`UPDATE packages SET status = 'loaded', holder_type = 'driver', holder_id = ?, updated_at = ? WHERE company_id = ?
              AND id IN (SELECT package_id FROM trip_packages WHERE stop_id = ? AND outcome IS NULL)`).bind(t.courier_id, ctx.now, cid, s.id),
          ctx.db.prepare("UPDATE trip_stops SET status = 'delivered', completed_at = ?, arrived_at = coalesce(arrived_at, ?) WHERE id = ? AND company_id = ?").bind(ctx.now, ctx.now, s.id, cid),
          refreshStatement(ctx, s.trip_id),
          ...courierPos(ctx, t.courier_id, p),
        );
        await runBatch(ctx, stmts, 'stop_closed');
        return { ok: true, packages: pk.length, next_stop: await advanceTrip(ctx, t.id) };
      });
    },
  },

  // ----------------------------------------------------------------- transferts entre voyages (panne, surcharge)
  // L'arrêt change de voyage ; un colis déjà chargé chez le premier chauffeur doit être repris par double scan.
  lg_transfer_stop: {
    roles: ['dispatcher', 'dock_chief'],
    async handler(ctx, a) {
      return idempotent(ctx, 'transfer', a.p_event, async () => {
        const s = await stopFor(ctx, a.p_stop);
        if (!['pending', 'en_route', 'arrived'].includes(s.status)) fail('stop_closed');
        const src = await tripFor(ctx, s.trip_id);
        const dst = await ctx.db.prepare('SELECT * FROM trips WHERE id = ? AND company_id = ?').bind(String(a.p_to_trip ?? ''), ctx.company.id).first();
        if (!dst || dst.id === src.id || !['planned', 'loading', 'sealed', 'in_progress'].includes(dst.status)) fail('invalid_destination');
        const pk = (await ctx.db.prepare('SELECT package_id, loaded_at FROM trip_packages WHERE trip_id = ? AND stop_id = ? AND outcome IS NULL').bind(src.id, s.id).all()).results;
        const cid = ctx.company.id;
        const others = (await ctx.db.prepare("SELECT id, seq FROM trip_stops WHERE trip_id = ? AND company_id = ? AND id <> ? ORDER BY seq").bind(src.id, cid, s.id).all()).results;
        await runBatch(ctx, [
          guard(ctx.db, "(SELECT status FROM trip_stops WHERE id = ?) IN ('pending', 'en_route', 'arrived')", [s.id]),
          ctx.db.prepare("UPDATE trip_stops SET trip_id = ?, seq = (SELECT coalesce(max(seq), 0) + 1 FROM trip_stops WHERE trip_id = ?), status = 'pending', arrived_at = NULL WHERE id = ? AND company_id = ?")
            .bind(dst.id, dst.id, s.id, cid),
          // d'abord retirer (un colis n'est que dans un seul voyage actif), puis rattacher
          ctx.db.prepare("UPDATE trip_packages SET outcome = 'removed' WHERE trip_id = ? AND stop_id = ? AND outcome IS NULL").bind(src.id, s.id),
          ...pk.map((p) => ctx.db.prepare(`INSERT INTO trip_packages (company_id, trip_id, package_id, stop_id, transfer_from) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT (trip_id, package_id) DO UPDATE SET stop_id = excluded.stop_id, outcome = NULL, loaded_at = NULL, transfer_from = excluded.transfer_from`)
            .bind(cid, dst.id, p.package_id, s.id, p.loaded_at ? src.id : null)),
          ...others.map((o, i) => ctx.db.prepare('UPDATE trip_stops SET seq = ? WHERE id = ? AND company_id = ?').bind(i + 1, o.id, cid)),
          refreshStatement(ctx, src.id), refreshStatement(ctx, dst.id),
        ], 'stop_closed');
        for (const tr of [src, dst]) if (tr.status === 'in_progress') await advanceTrip(ctx, tr.id);
        await audit(ctx, 'stop_transfer', 'stop', s.id, { from: src.number, to: dst.number });
        return { ok: true, packages: pk.length, to_take: pk.filter((p) => p.loaded_at).length };
      });
    },
  },

  // Prise en charge d'un colis transféré : par le chauffeur qui le reçoit (ou le quai).
  lg_take_transfer: {
    roles: 'member',
    async handler(ctx, a) {
      return idempotent(ctx, 'take', a.p_event, async () => {
        const t = await tripFor(ctx, a.p_trip);
        if (!isTripDriver(ctx, t) && !hasRole(ctx, ['dock_chief', 'dispatcher'])) fail('forbidden', 403);
        const p = await ctx.db.prepare(
          `SELECT p.*, tp.transfer_from, tp.loaded_at AS tp_loaded FROM packages p JOIN trip_packages tp ON tp.package_id = p.id AND tp.trip_id = ? AND tp.outcome IS NULL
            WHERE p.company_id = ? AND p.code = ?`,
        ).bind(t.id, ctx.company.id, normCode(a.p_code)).first();
        if (!p || p.tp_loaded) return { ok: false, error: 'not_to_take' };
        await ctx.db.batch([
          ctx.db.prepare('UPDATE trip_packages SET loaded_at = ?, loaded_by = ? WHERE trip_id = ? AND package_id = ?').bind(ctx.now, ctx.user.id, t.id, p.id),
          ctx.db.prepare("UPDATE packages SET holder_type = 'driver', holder_id = ?, status = ?, updated_at = ? WHERE id = ? AND company_id = ?")
            .bind(t.courier_id, t.status === 'in_progress' && p.direction === 'outbound' ? 'out_for_delivery' : 'loaded', ctx.now, p.id, ctx.company.id),
          ctx.db.prepare("INSERT INTO scan_events (company_id, client_event_id, package_id, event, actor_id, trip_id, device_at, meta) VALUES (?, ?, ?, 'load', ?, ?, ?, ?)")
            .bind(ctx.company.id, a.p_event ? String(a.p_event) : uuid(), p.id, ctx.user.id, t.id, ctx.now, JSON.stringify({ transfer_from: p.transfer_from })),
          refreshStatement(ctx, t.id),
        ]);
        return { ok: true, code: p.code };
      });
    },
  },
};

