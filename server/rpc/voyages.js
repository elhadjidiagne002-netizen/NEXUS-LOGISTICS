// Cycle C4 — voyages : création, arrêts (ajout, retrait, ordre), chargement contrôlé (poids, volume, nombre de colis,
// froid, vivant), plan de chargement, bordereau signé (scellé), collectes chez les vendeurs, réception au hub,
// plusieurs quais et file d'attente, dépôts par les vendeurs, créneaux de livraison, suggestions et planification.
// Portage de 20261007000400 (voyages, chargement), 20261007000700/0800 (listes, suggestions, créneaux), cycle1
// (collectes, réception), cycle3 (planification automatique), cycle11 (quais) et cycle17 (dépôts vendeurs).
import { fail, audit, idempotent, hasRole, text, num, int, uuid, parseJson, distanceM, guard, runBatch, today, plusMinutes } from './core.js';
import { normCode } from './preparation.js';
import { amountDue, orderShort } from './commandes.js';
import { DOCS_EXPIRED_SQL } from './flotte.js';
import { tryReconcile } from './caisse.js';

const OPEN = ['planned', 'loading', 'sealed', 'in_progress'];
const LOADABLE = ['planned', 'loading'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const plusDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const staffHub = (ctx) => ctx.roles.find((r) => r.hub_id && ['picker', 'dock_chief', 'dispatcher'].includes(r.role))?.hub_id ?? null;
const opsRoles = ['dock_chief', 'dispatcher'];

export async function tripFor(ctx, id) {
  const t = await ctx.db.prepare('SELECT * FROM trips WHERE id = ? AND company_id = ?').bind(String(id ?? ''), ctx.company.id).first();
  if (!t) fail('unknown_trip', 404);
  return { ...t, zones: parseJson(t.zones, []) };
}

/** Chauffeur du voyage (utilisateur), pour « son » voyage. */
export const isTripDriver = (ctx, t) => Boolean(ctx.courierId && t.courier_id === ctx.courierId);

/** Totaux recalculés depuis les colis chargés (jamais d'incrément aveugle) — lg_trip_refresh, en une instruction. */
export const refreshStatement = (ctx, tripId) => ctx.db.prepare(
  `UPDATE trips SET
     load_weight_g = (SELECT coalesce(sum(p.weight_g), 0) FROM trip_packages tp JOIN packages p ON p.id = tp.package_id WHERE tp.trip_id = ?1 AND tp.loaded_at IS NOT NULL AND tp.outcome IS NULL),
     load_volume_l = (SELECT coalesce(sum(p.volume_l), 0) FROM trip_packages tp JOIN packages p ON p.id = tp.package_id WHERE tp.trip_id = ?1 AND tp.loaded_at IS NOT NULL AND tp.outcome IS NULL),
     load_count = (SELECT COUNT(*) FROM trip_packages tp WHERE tp.trip_id = ?1 AND tp.loaded_at IS NOT NULL AND tp.outcome IS NULL),
     cod_expected_fcfa = (SELECT coalesce(sum(cod_due_fcfa), 0) FROM trip_stops WHERE trip_id = ?1 AND kind = 'delivery' AND status <> 'skipped'),
     updated_at = ?2
   WHERE id = ?1 AND company_id = ?3`,
).bind(tripId, ctx.now, ctx.company.id);

/** Arrêt de livraison d'une commande dans un voyage (lg_trip_ensure_stop) : créé s'il n'existe pas. */
function ensureStopStatement(ctx, tripId, o) {
  return ctx.db.prepare(
    `INSERT INTO trip_stops (id, company_id, trip_id, seq, kind, order_id, contact_name, contact_phone, address, landmark, lat, lng, cod_due_fcfa, window_start, window_end)
     SELECT ?, ?, ?, (SELECT coalesce(max(seq), 0) + 1 FROM trip_stops WHERE trip_id = ?), 'delivery', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM trip_stops WHERE trip_id = ? AND order_id = ? AND kind = 'delivery' AND status <> 'skipped')`,
  ).bind(uuid(), ctx.company.id, tripId, tripId, o.id, o.recipient_name ? `${o.buyer_name} (remis à ${o.recipient_name})` : o.buyer_name,
    o.buyer_phone, [o.delivery_zone, o.buyer_address].filter(Boolean).join(', ') || null, o.landmark ?? o.c_landmark ?? null,
    o.delivery_lat ?? o.c_lat ?? null, o.delivery_lng ?? o.c_lng ?? null, amountDue(o), o.window_start ?? null, o.window_end ?? null, tripId, o.id);
}
const stopIdSql = "(SELECT id FROM trip_stops WHERE trip_id = ? AND order_id = ? AND kind = 'delivery' AND status <> 'skipped')";

async function orderForStop(ctx, orderId) {
  return ctx.db.prepare(
    // position : celle de la commande, sinon l'adresse vérifiée à une livraison précédente (C5), sinon la fiche client
    `SELECT o.*, coalesce(va.lat, c.lat) AS c_lat, coalesce(va.lng, c.lng) AS c_lng, coalesce(va.landmark, c.landmark) AS c_landmark,
            CASE WHEN s.id IS NOT NULL THEN s.day || 'T' || s.start_time || ':00.000Z' END AS window_start,
            CASE WHEN s.id IS NOT NULL THEN s.day || 'T' || s.end_time || ':00.000Z' END AS window_end
       FROM orders o LEFT JOIN customers c ON c.id = o.customer_id LEFT JOIN delivery_slots s ON s.id = o.slot_id
       LEFT JOIN verified_addresses va ON va.company_id = o.company_id AND va.phone_key = c.phone_key
      WHERE o.id = ? AND o.company_id = ?`,
  ).bind(String(orderId ?? ''), ctx.company.id).first();
}

/**
 * Plan de chargement (chapitre 10), calculé à la lecture : dernier livré chargé en premier (fond), lourd en bas,
 * fragile en haut ; deux-roues → caisson. Renvoie Map(package_id → { load_seq, load_zone }).
 */
export function loadPlan(stops, pkgs, vehicleKind) {
  const live = stops.filter((s) => s.status !== 'skipped');
  const seqs = [...new Set(live.map((s) => s.seq))].sort((a, b) => a - b);
  const n = live.length; const out = new Map();
  const rows = pkgs.filter((p) => !p.outcome).map((p) => ({ ...p, seq: live.find((s) => s.id === p.stop_id)?.seq ?? 0 }));
  rows.sort((a, b) => b.seq - a.seq || (a.handling.includes('fragile') - b.handling.includes('fragile')) || (b.weight_g ?? 0) - (a.weight_g ?? 0));
  rows.forEach((p, i) => {
    const rank = seqs.indexOf(p.seq) + 1;
    out.set(p.package_id, { load_seq: i + 1,
      load_zone: ['moto', 'vélo'].includes(vehicleKind) ? 'caisson' : rank > Math.ceil((n * 2) / 3) ? 'fond' : rank > Math.ceil(n / 3) ? 'milieu' : 'porte' });
  });
  return out;
}

export function gaugeOf(t, v, planned, loaded) {
  const w = Math.round((100 * t.load_weight_g) / (v.capacity_kg * 1000));
  const vol = v.capacity_l > 0 ? Math.round((100 * t.load_volume_l) / v.capacity_l) : null;
  const cnt = v.max_packages > 0 ? Math.round((100 * t.load_count) / v.max_packages) : null;
  return { count: t.load_count, weight_g: t.load_weight_g, volume_l: t.load_volume_l, capacity_kg: v.capacity_kg, capacity_l: v.capacity_l,
    max_packages: v.max_packages, weight_pct: w, volume_pct: vol, count_pct: cnt, fill_pct: Math.max(w, vol ?? 0, cnt ?? 0), planned, loaded };
}

/**
 * Heures estimées (lg_trip_compute_eta) : départ + trajets (vol d'oiseau × détour, 18 km/h) + 8 min par arrêt.
 * Renvoie les instructions (heure de chaque arrêt restant, distance du voyage s'il n'est pas parti).
 */
export function etaStatements(ctx, t, stops, from) {
  const coef = Number(ctx.company.config.detour_coef ?? 1.35);
  let lat = from?.lat ?? null; let lng = from?.lng ?? null; let km = 0;
  let clock = Date.parse([t.started_at, t.planned_departure, ctx.now].find(Boolean));
  if (clock < Date.parse(ctx.now)) clock = Date.parse(ctx.now);
  const stmts = [];
  for (const s of stops.filter((x) => ['pending', 'en_route', 'arrived'].includes(x.status)).sort((a, b) => a.seq - b.seq)) {
    const d = ((distanceM(lat, lng, s.lat, s.lng) ?? 3000) / 1000) * coef;
    km += d; clock += (d / 18) * 3600000;
    const eta = new Date(clock).toISOString();
    if (eta !== s.eta) stmts.push(ctx.db.prepare('UPDATE trip_stops SET eta = ? WHERE id = ? AND company_id = ?').bind(eta, s.id, ctx.company.id));
    clock += 8 * 60000;
    if (s.lat != null) { lat = s.lat; lng = s.lng; }
  }
  if (['planned', 'loading', 'sealed'].includes(t.status)) {
    stmts.push(ctx.db.prepare('UPDATE trips SET distance_km = ? WHERE id = ? AND company_id = ?').bind(Math.round(km * 10) / 10, t.id, ctx.company.id));
  }
  return stmts;
}

/** Point de départ d'un calcul d'heures : position du chauffeur en tournée, sinon le lieu du voyage. */
export async function etaOrigin(ctx, t) {
  if (t.status === 'in_progress' && t.courier_id) {
    const c = await ctx.db.prepare('SELECT last_lat AS lat, last_lng AS lng FROM couriers WHERE id = ? AND company_id = ? AND last_lat IS NOT NULL').bind(t.courier_id, ctx.company.id).first();
    if (c) return c;
  }
  return t.hub_id ? ctx.db.prepare('SELECT lat, lng FROM hubs WHERE id = ? AND company_id = ?').bind(t.hub_id, ctx.company.id).first() : null;
}

async function recomputeEta(ctx, tripId) {
  const t = await tripFor(ctx, tripId);
  const stops = (await ctx.db.prepare('SELECT id, seq, status, lat, lng, eta FROM trip_stops WHERE trip_id = ? AND company_id = ?').bind(t.id, ctx.company.id).all()).results;
  const stmts = etaStatements(ctx, t, stops, await etaOrigin(ctx, t));
  if (stmts.length) await ctx.db.batch(stmts);
}

/** Vue de chargement (lg_trip_loading_view) : voyage, véhicule, chauffeur, jauge, arrêts et colis avec leur place. */
export async function loadingView(ctx, tripId) {
  const t = await tripFor(ctx, tripId);
  const [v, c, stops, pk] = await ctx.db.batch([
    ctx.db.prepare('SELECT * FROM vehicles WHERE id = ? AND company_id = ?').bind(t.vehicle_id, ctx.company.id),
    ctx.db.prepare('SELECT id, name, phone FROM couriers WHERE id = ? AND company_id = ?').bind(t.courier_id, ctx.company.id),
    ctx.db.prepare(
      `SELECT s.*, o.delivery_zone AS zone, o.number FROM trip_stops s LEFT JOIN orders o ON o.id = s.order_id
        WHERE s.trip_id = ? AND s.company_id = ? ORDER BY s.seq`).bind(t.id, ctx.company.id),
    ctx.db.prepare(
      `SELECT tp.package_id, tp.stop_id, tp.loaded_at, tp.outcome, tp.transfer_from, p.code, p.weight_g, p.handling, p.status
         FROM trip_packages tp JOIN packages p ON p.id = tp.package_id WHERE tp.trip_id = ? AND tp.company_id = ?`).bind(t.id, ctx.company.id),
  ]);
  const veh = v.results[0];
  const pkgs = pk.results.map((p) => ({ ...p, handling: parseJson(p.handling, []) }));
  const plan = loadPlan(stops.results, pkgs, veh.kind);
  const active = pkgs.filter((p) => !p.outcome);
  return {
    trip: { id: t.id, number: t.number, label: t.label, status: t.status, kind: t.kind, zones: t.zones, planned_departure: t.planned_departure,
      cod_expected_fcfa: t.cod_expected_fcfa, distance_km: t.distance_km, signed: Boolean(t.courier_signature_path), hub_id: t.hub_id },
    vehicle: { id: veh.id, plate: veh.plate, kind: veh.kind, label: veh.label, equipment: parseJson(veh.equipment, []) },
    courier: c.results[0] ?? null,
    gauge: gaugeOf(t, veh, active.length, active.filter((p) => p.loaded_at).length),
    stops: stops.results.filter((s) => s.status !== 'skipped').map((s) => ({
      id: s.id, seq: s.seq, kind: s.kind, status: s.status, zone: s.zone, contact_name: s.contact_name, contact_phone: s.contact_phone,
      order_id: s.order_id, order_short: s.number != null ? String(s.number) : null, cod_due_fcfa: s.cod_due_fcfa, eta: s.eta,
      lat: s.lat, lng: s.lng, landmark: s.landmark, address: s.address, window_start: s.window_start, window_end: s.window_end,
      packages: pkgs.filter((p) => p.stop_id === s.id && p.outcome !== 'removed').map((p) => ({ code: p.code, weight_g: p.weight_g, handling: p.handling,
        status: p.status, loaded: Boolean(p.loaded_at), outcome: p.outcome, to_take: Boolean(p.transfer_from && !p.loaded_at), ...(plan.get(p.package_id) ?? {}) }))
        .sort((a, b) => (a.load_seq ?? 999) - (b.load_seq ?? 999)),
    })),
  };
}

const canSeeTrip = (ctx, t) => hasRole(ctx, ['dock_chief', 'dispatcher', 'support', 'cashier']) || isTripDriver(ctx, t);
const nextSlotDay = (s) => `${s.day}T${s.end_time}:00.000Z`;

export default {
  // ----------------------------------------------------------------- listes
  lg_trips_list: {
    roles: ['dock_chief', 'dispatcher', 'cashier', 'support'],
    async handler(ctx, a) {
      const scope = a.p_scope === 'all' ? 'all' : 'open';
      const since = new Date(Date.parse(ctx.now) - 30 * 86400000).toISOString();
      const [trips, pk] = await ctx.db.batch([
        ctx.db.prepare(
          `SELECT t.*, v.plate, v.kind AS vkind, v.capacity_kg, v.capacity_l, v.max_packages, c.name AS courier,
                  (SELECT COUNT(*) FROM trip_stops WHERE trip_id = t.id AND status <> 'skipped') AS stops
             FROM trips t JOIN vehicles v ON v.id = t.vehicle_id LEFT JOIN couriers c ON c.id = t.courier_id
            WHERE t.company_id = ? AND ((? = 'open' AND t.status IN ('planned', 'loading', 'sealed', 'in_progress', 'completed')) OR (? = 'all' AND t.created_at > ?))
            ORDER BY t.planned_departure DESC LIMIT 200`).bind(ctx.company.id, scope, scope, since),
        ctx.db.prepare(
          `SELECT tp.trip_id, COUNT(*) AS planned, sum(tp.loaded_at IS NOT NULL) AS loaded FROM trip_packages tp JOIN trips t ON t.id = tp.trip_id
            WHERE tp.company_id = ? AND tp.outcome IS NULL AND t.status IN ('planned', 'loading', 'sealed', 'in_progress', 'completed') GROUP BY tp.trip_id`).bind(ctx.company.id),
      ]);
      return trips.results.map((t) => {
        const k = pk.results.find((x) => x.trip_id === t.id) ?? { planned: 0, loaded: 0 };
        return { id: t.id, number: t.number, label: t.label, status: t.status, kind: t.kind, planned_departure: t.planned_departure, zones: parseJson(t.zones, []),
          vehicle: { plate: t.plate, kind: t.vkind }, courier: t.courier, stops: t.stops,
          gauge: gaugeOf(t, { capacity_kg: t.capacity_kg, capacity_l: t.capacity_l, max_packages: t.max_packages }, k.planned, k.loaded) };
      });
    },
  },

  // Colis à quai (et revenus au hub), par zone, du plus ancien au plus récent.
  lg_staged_packages: {
    roles: ['dock_chief', 'dispatcher', 'picker'],
    async handler(ctx) {
      const r = await ctx.db.prepare(
        `SELECT p.code, p.order_id, o.number, p.weight_g, p.handling, p.status, p.attempts, p.updated_at AS since, coalesce(p.zone, 'Sans zone') AS zone,
                EXISTS (SELECT 1 FROM trip_packages tp WHERE tp.package_id = p.id AND tp.outcome IS NULL) AS in_trip
           FROM packages p JOIN orders o ON o.id = p.order_id
          WHERE p.company_id = ? AND p.status IN ('staged', 'returned_hub') AND p.hub_id IS NOT NULL ORDER BY p.updated_at LIMIT 1000`,
      ).bind(ctx.company.id).all();
      const zones = new Map();
      for (const p of r.results) {
        if (!zones.has(p.zone)) zones.set(p.zone, { zone: p.zone, packages: [], count: 0, oldest: p.since });
        const z = zones.get(p.zone); z.count++;
        z.packages.push({ code: p.code, order_id: p.order_id, order_short: String(p.number), weight_g: p.weight_g, handling: parseJson(p.handling, []),
          status: p.status, attempts: p.attempts, since: p.since, in_trip: Boolean(p.in_trip) });
      }
      return [...zones.values()].sort((x, y) => x.oldest.localeCompare(y.oldest));
    },
  },

  // ----------------------------------------------------------------- création, annulation
  lg_trip_create: {
    roles: opsRoles,
    async handler(ctx, a) {
      const day = today(ctx);
      const v = await ctx.db.prepare(`SELECT v.*, ${DOCS_EXPIRED_SQL} AS docs_expired FROM vehicles v WHERE v.id = ? AND v.company_id = ?`)
        .bind(day, day, String(a.p_vehicle ?? ''), ctx.company.id).first();
      if (!v) fail('unknown_vehicle', 404);
      if (v.status === 'maintenance' || v.status === 'retired') fail('vehicle_unavailable');
      if (v.docs_expired) fail('vehicle_documents_expired');
      if (await ctx.db.prepare("SELECT 1 AS x FROM trips WHERE vehicle_id = ? AND status IN ('planned', 'loading', 'sealed', 'in_progress')").bind(v.id).first()) fail('vehicle_busy', 409);
      if (a.p_courier) {
        const c = await ctx.db.prepare('SELECT * FROM couriers WHERE id = ? AND company_id = ?').bind(a.p_courier, ctx.company.id).first();
        if (!c || !c.active) fail('courier_not_active');
        if (c.license_expires_at && c.license_expires_at < day) fail('license_expired');
        // clôture en caisse obligatoire avant le voyage suivant
        if (await ctx.db.prepare("SELECT 1 AS x FROM trips WHERE courier_id = ? AND status IN ('planned', 'loading', 'sealed', 'in_progress', 'completed')").bind(c.id).first()) fail('courier_has_open_trip', 409);
      }
      const kind = ['delivery', 'pickup', 'mixed', 'transfer'].includes(a.p_kind) ? a.p_kind : 'delivery';
      const zones = Array.isArray(a.p_zones) ? a.p_zones.map(String).slice(0, 50) : [];
      const dep = a.p_departure && !Number.isNaN(Date.parse(a.p_departure)) ? new Date(a.p_departure).toISOString() : plusMinutes(ctx.now, 60);
      const hub = a.p_hub || v.hub_id || (await ctx.db.prepare('SELECT id FROM hubs WHERE company_id = ? AND active = 1 ORDER BY created_at LIMIT 1').bind(ctx.company.id).first('id'));
      const id = uuid();
      let res;
      try {
        res = await ctx.db.batch([
          ctx.db.prepare("INSERT INTO counters (company_id, key, n) VALUES (?, 'voyage', 1) ON CONFLICT (company_id, key) DO UPDATE SET n = n + 1").bind(ctx.company.id),
          ctx.db.prepare(
            `INSERT INTO trips (id, company_id, number, kind, label, hub_id, vehicle_id, courier_id, planned_departure, status, zones, created_by, created_at, updated_at)
             VALUES (?, ?, (SELECT n FROM counters WHERE company_id = ? AND key = 'voyage'), ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?) RETURNING number`,
          ).bind(id, ctx.company.id, ctx.company.id, kind, text(a.p_label, 80), hub, v.id, a.p_courier || null, dep, JSON.stringify(zones), ctx.user.id, ctx.now, ctx.now),
        ]);
      } catch (e) {
        if (/UNIQUE/i.test(String(e?.message))) fail(a.p_courier ? 'courier_has_open_trip' : 'vehicle_busy', 409); // créé au même instant ailleurs
        throw e;
      }
      await audit(ctx, 'trip_create', 'trip', id, { number: res[1].results[0].number });
      return { ok: true, trip_id: id, number: res[1].results[0].number };
    },
  },

  lg_trip_cancel: {
    roles: opsRoles,
    async handler(ctx, a) {
      const t = await tripFor(ctx, a.p_trip);
      if (!['draft', 'planned', 'loading'].includes(t.status)) fail('trip_not_cancellable');
      await runBatch(ctx, [
        guard(ctx.db, "(SELECT status FROM trips WHERE id = ?) IN ('draft', 'planned', 'loading')", [t.id]),
        ctx.db.prepare(`UPDATE packages SET status = 'staged', holder_type = 'hub', holder_id = coalesce(?, hub_id), updated_at = ?
            WHERE company_id = ? AND status = 'loaded' AND id IN (SELECT package_id FROM trip_packages WHERE trip_id = ? AND outcome IS NULL)`)
          .bind(t.hub_id, ctx.now, ctx.company.id, t.id),
        ctx.db.prepare("UPDATE trip_packages SET outcome = 'removed' WHERE trip_id = ? AND company_id = ? AND outcome IS NULL").bind(t.id, ctx.company.id),
        ctx.db.prepare("UPDATE trips SET status = 'cancelled', updated_at = ? WHERE id = ? AND company_id = ?").bind(ctx.now, t.id, ctx.company.id),
      ], 'trip_not_cancellable');
      await audit(ctx, 'trip_cancel', 'trip', t.id, { reason: a.p_reason ?? null });
      return { ok: true };
    },
  },

  // ----------------------------------------------------------------- arrêts
  // Affecter une commande (tous ses colis à quai) à un voyage.
  lg_trip_add_order: {
    roles: opsRoles,
    async handler(ctx, a) {
      const t = await tripFor(ctx, a.p_trip);
      if (!LOADABLE.includes(t.status)) fail('trip_not_open');
      const o = await orderForStop(ctx, a.p_order);
      if (!o || o.status === 'cancelled') fail('order_blocked');
      if (t.zones.length && !t.zones.includes(o.delivery_zone)) fail('wrong_zone');
      if (await ctx.db.prepare('SELECT 1 AS x FROM trip_packages tp JOIN packages p ON p.id = tp.package_id WHERE p.order_id = ? AND tp.outcome IS NULL AND tp.trip_id <> ?')
        .bind(o.id, t.id).first()) fail('order_in_other_trip', 409);
      const [, add] = await ctx.db.batch([
        ensureStopStatement(ctx, t.id, o),
        ctx.db.prepare(
          `INSERT INTO trip_packages (company_id, trip_id, package_id, stop_id)
           SELECT ?, ?, p.id, ${stopIdSql} FROM packages p
            WHERE p.order_id = ? AND p.company_id = ? AND p.status = 'staged' AND p.direction = 'outbound'
              AND NOT EXISTS (SELECT 1 FROM trip_packages tp WHERE tp.package_id = p.id AND tp.outcome IS NULL)
           ON CONFLICT (trip_id, package_id) DO UPDATE SET stop_id = excluded.stop_id, outcome = NULL, loaded_at = NULL`,
        ).bind(ctx.company.id, t.id, t.id, o.id, o.id, ctx.company.id),
        refreshStatement(ctx, t.id),
      ]);
      const [stop, missing] = await ctx.db.batch([
        ctx.db.prepare(stopIdSql.slice(1, -1) + ' LIMIT 1').bind(t.id, o.id),
        ctx.db.prepare("SELECT COUNT(*) AS n FROM packages WHERE order_id = ? AND company_id = ? AND status IN ('created', 'packed')").bind(o.id, ctx.company.id),
      ]);
      return { ok: true, stop_id: stop.results[0]?.id ?? null, packages: add.meta.changes, not_staged: missing.results[0].n };
    },
  },

  lg_trip_remove_stop: {
    roles: opsRoles,
    async handler(ctx, a) {
      const t = await tripFor(ctx, a.p_trip);
      if (!LOADABLE.includes(t.status)) fail('trip_not_open');
      const stop = String(a.p_stop ?? '');
      const [, , , r] = await runBatch(ctx, [
        guard(ctx.db, "(SELECT status FROM trips WHERE id = ?) IN ('planned', 'loading')", [t.id]),
        ctx.db.prepare(`UPDATE packages SET status = 'staged', holder_type = 'hub', holder_id = coalesce(?, hub_id), updated_at = ?
            WHERE company_id = ? AND status = 'loaded' AND id IN (SELECT package_id FROM trip_packages WHERE trip_id = ? AND stop_id = ? AND outcome IS NULL)`)
          .bind(t.hub_id, ctx.now, ctx.company.id, t.id, stop),
        ctx.db.prepare("UPDATE trip_packages SET outcome = 'removed' WHERE trip_id = ? AND stop_id = ? AND company_id = ? AND outcome IS NULL").bind(t.id, stop, ctx.company.id),
        ctx.db.prepare("UPDATE trip_stops SET status = 'skipped' WHERE id = ? AND trip_id = ? AND company_id = ?").bind(stop, t.id, ctx.company.id),
        refreshStatement(ctx, t.id),
      ], 'trip_not_open');
      if (!r.meta.changes) fail('unknown_stop', 404);
      return { ok: true };
    },
  },

  // Ordre décidé par l'app (plus proche voisin + 2-opt, src/lib/algo.js) ou à la main ; le chauffeur peut réordonner en tournée.
  lg_trip_reorder: {
    roles: 'member',
    async handler(ctx, a) {
      const t = await tripFor(ctx, a.p_trip);
      if (!hasRole(ctx, opsRoles) && !(isTripDriver(ctx, t) && t.status === 'in_progress')) fail('forbidden', 403);
      if (!OPEN.includes(t.status)) fail('trip_closed');
      const ids = Array.isArray(a.p_stop_ids) ? a.p_stop_ids.map(String) : [];
      const stops = (await ctx.db.prepare('SELECT id, seq, status, completed_at, lat, lng, eta FROM trip_stops WHERE trip_id = ? AND company_id = ?').bind(t.id, ctx.company.id).all()).results;
      if (new Set(ids).size !== ids.length || ids.some((id) => !stops.some((s) => s.id === id))) fail('unknown_stop', 404);
      // arrêts faits gardent leur rang en tête ; les autres suivent l'ordre demandé (ceux non cités restent devant)
      const key = (s) => [['delivered', 'failed'].includes(s.status) ? 0 : 1, ['delivered', 'failed'].includes(s.status) ? s.completed_at ?? '' : '', ids.includes(s.id) ? 1000 + ids.indexOf(s.id) : s.seq];
      const sorted = [...stops].sort((x, y) => { const kx = key(x); const ky = key(y); return kx[0] - ky[0] || String(kx[1]).localeCompare(String(ky[1])) || kx[2] - ky[2]; });
      const stmts = [];
      sorted.forEach((s, i) => { if (s.seq !== i + 1) { stmts.push(ctx.db.prepare('UPDATE trip_stops SET seq = ? WHERE id = ? AND company_id = ?').bind(i + 1, s.id, ctx.company.id)); s.seq = i + 1; } });
      stmts.push(...etaStatements(ctx, t, sorted, await etaOrigin(ctx, t)));
      if (stmts.length) await ctx.db.batch(stmts);
      return { ok: true };
    },
  },

  // ----------------------------------------------------------------- chargement
  lg_trip_loading_view: {
    roles: 'member',
    async handler(ctx, a) {
      const t = await tripFor(ctx, a.p_trip);
      if (!canSeeTrip(ctx, t)) fail('forbidden', 403);
      return loadingView(ctx, t.id);
    },
  },

  lg_load_package: {
    roles: opsRoles,
    async handler(ctx, a) {
      return idempotent(ctx, 'load', a.p_event, async () => {
        const t = await tripFor(ctx, a.p_trip);
        if (!LOADABLE.includes(t.status)) fail('trip_not_loading');
        const p = await ctx.db.prepare(
          `SELECT p.*, o.status AS order_status, tp.trip_id AS in_trip, tp.loaded_at AS tp_loaded FROM packages p JOIN orders o ON o.id = p.order_id
             LEFT JOIN trip_packages tp ON tp.package_id = p.id AND tp.outcome IS NULL WHERE p.company_id = ? AND p.code = ?`,
        ).bind(ctx.company.id, normCode(a.p_code)).first();
        if (!p) return { ok: false, error: 'unknown_package' };
        const hand = parseJson(p.handling, []);
        if (p.in_trip && p.in_trip !== t.id) return { ok: false, error: 'in_other_trip' };
        if (p.tp_loaded) return { ok: false, error: 'already_loaded', code: p.code };
        if (p.status !== 'staged') return { ok: false, error: 'package_not_staged', status: p.status };
        if (p.order_status === 'cancelled') return { ok: false, error: 'order_blocked' };
        if (t.zones.length && !t.zones.includes(p.zone)) return { ok: false, error: 'wrong_zone', zone: p.zone };
        const [vR, loadedR] = await ctx.db.batch([
          ctx.db.prepare('SELECT * FROM vehicles WHERE id = ? AND company_id = ?').bind(t.vehicle_id, ctx.company.id),
          ctx.db.prepare('SELECT p.handling FROM trip_packages tp JOIN packages p ON p.id = tp.package_id WHERE tp.trip_id = ? AND tp.outcome IS NULL AND tp.loaded_at IS NOT NULL').bind(t.id),
        ]);
        const v = vR.results[0]; const eq = parseJson(v.equipment, []);
        const others = loadedR.results.map((x) => parseJson(x.handling, []));
        const warn = [];
        if (t.load_weight_g + (p.weight_g ?? 0) > v.capacity_kg * 1000) return { ok: false, error: 'overweight' };
        if (v.max_packages != null && t.load_count + 1 > v.max_packages) return { ok: false, error: 'too_many_packages' };
        if (v.capacity_l > 0 && t.load_volume_l + (p.volume_l ?? 0) > v.capacity_l) warn.push('volume_full');
        // incompatibilités (annexe C)
        if (hand.includes('froid') && !eq.includes('glacière')) return { ok: false, error: 'needs_cooler' };
        if (others.some((h) => h.includes('vivant') !== hand.includes('vivant'))) return { ok: false, error: 'incompatible_live' };
        if ((hand.includes('alimentaire') && others.some((h) => h.includes('chimique'))) || (hand.includes('chimique') && others.some((h) => h.includes('alimentaire')))) warn.push('separate_food_chemical');
        if (hand.includes('liquide')) warn.push('liquid_upright_bottom');
        const o = await orderForStop(ctx, p.order_id);
        await runBatch(ctx, [
          guard(ctx.db, "(SELECT status FROM packages WHERE id = ?) = 'staged' AND (SELECT status FROM trips WHERE id = ?) IN ('planned', 'loading')", [p.id, t.id]),
          ensureStopStatement(ctx, t.id, o),
          ctx.db.prepare(
            `INSERT INTO trip_packages (company_id, trip_id, package_id, stop_id, loaded_at, loaded_by) VALUES (?, ?, ?, ${stopIdSql}, ?, ?)
             ON CONFLICT (trip_id, package_id) DO UPDATE SET loaded_at = excluded.loaded_at, loaded_by = excluded.loaded_by, outcome = NULL,
               stop_id = coalesce(trip_packages.stop_id, excluded.stop_id)`,
          ).bind(ctx.company.id, t.id, p.id, t.id, o.id, ctx.now, ctx.user.id),
          ctx.db.prepare("UPDATE packages SET status = 'loaded', holder_type = 'driver', holder_id = ?, updated_at = ? WHERE id = ? AND company_id = ?")
            .bind(t.courier_id, ctx.now, p.id, ctx.company.id),
          ctx.db.prepare("UPDATE trips SET status = 'loading' WHERE id = ? AND company_id = ? AND status = 'planned'").bind(t.id, ctx.company.id),
          ctx.db.prepare("INSERT INTO scan_events (company_id, client_event_id, package_id, event, actor_id, trip_id, hub_id, device_at) VALUES (?, ?, ?, 'load', ?, ?, ?, ?)")
            .bind(ctx.company.id, a.p_event ? String(a.p_event) : uuid(), p.id, ctx.user.id, t.id, t.hub_id, text(a.p_device_at, 40) ?? ctx.now),
          refreshStatement(ctx, t.id),
        ], 'package_not_staged');
        const view = await loadingView(ctx, t.id);
        const mine = view.stops.flatMap((s) => s.packages.map((x) => ({ ...x, stop_seq: s.seq }))).find((x) => x.code === p.code);
        if (view.gauge.fill_pct >= 90) warn.push('fill_90');
        return { ...view.gauge, ok: true, code: p.code, weight_g: p.weight_g, handling: hand, warnings: warn, stop_seq: mine?.stop_seq ?? null, load_zone: mine?.load_zone ?? null };
      });
    },
  },

  lg_unload_package: {
    roles: opsRoles,
    async handler(ctx, a) {
      return idempotent(ctx, 'unload', a.p_event, async () => {
        const t = await tripFor(ctx, a.p_trip);
        if (!LOADABLE.includes(t.status)) fail('trip_not_loading');
        const p = await ctx.db.prepare('SELECT p.* FROM packages p JOIN trip_packages tp ON tp.package_id = p.id AND tp.trip_id = ? AND tp.outcome IS NULL WHERE p.company_id = ? AND p.code = ?')
          .bind(t.id, ctx.company.id, normCode(a.p_code)).first();
        if (!p) return { ok: false, error: 'not_in_trip' };
        const stmts = [ctx.db.prepare("UPDATE trip_packages SET outcome = 'removed' WHERE trip_id = ? AND package_id = ? AND outcome IS NULL").bind(t.id, p.id)];
        if (p.status === 'loaded') {
          stmts.push(ctx.db.prepare("UPDATE packages SET status = 'staged', holder_type = 'hub', holder_id = coalesce(?, hub_id), updated_at = ? WHERE id = ? AND company_id = ?")
            .bind(t.hub_id, ctx.now, p.id, ctx.company.id));
          stmts.push(ctx.db.prepare("INSERT INTO scan_events (company_id, client_event_id, package_id, event, actor_id, trip_id, hub_id, device_at, meta) VALUES (?, ?, ?, 'unload', ?, ?, ?, ?, ?)")
            .bind(ctx.company.id, a.p_event ? String(a.p_event) : uuid(), p.id, ctx.user.id, t.id, t.hub_id, ctx.now, JSON.stringify({ reason: text(a.p_reason, 200) })));
        }
        stmts.push(refreshStatement(ctx, t.id));
        await ctx.db.batch(stmts);
        await audit(ctx, 'package_removed_from_trip', 'package', p.code, { trip: t.id, reason: a.p_reason ?? null });
        return { ...(await loadingView(ctx, t.id)).gauge, ok: true };
      });
    },
  },

  // Validation du départ (bordereau signé) : tout colis prévu doit être chargé ou retiré.
  lg_trip_seal: {
    roles: opsRoles,
    async handler(ctx, a) {
      const t = await tripFor(ctx, a.p_trip);
      if (!LOADABLE.includes(t.status)) fail('trip_not_loading');
      if (!t.courier_id) fail('no_courier');
      const pk = (await ctx.db.prepare(
        `SELECT p.code, tp.loaded_at, tp.transfer_from, s.kind FROM trip_packages tp JOIN packages p ON p.id = tp.package_id LEFT JOIN trip_stops s ON s.id = tp.stop_id
          WHERE tp.trip_id = ? AND tp.company_id = ? AND tp.outcome IS NULL`).bind(t.id, ctx.company.id).all()).results;
      // un colis transféré est pris en charge sur la route (double scan) ; une collecte se charge chez le vendeur
      const missing = pk.filter((p) => !p.loaded_at && p.kind === 'delivery' && !p.transfer_from).map((p) => p.code);
      if (missing.length) return { ok: false, error: 'unloaded_packages', codes: missing };
      if (!pk.length) fail('empty_trip');
      const sealed = { ...t, status: 'sealed' };
      await runBatch(ctx, [
        guard(ctx.db, "(SELECT status FROM trips WHERE id = ?) IN ('planned', 'loading')", [t.id]),
        // les arrêts sans colis sont retirés
        ctx.db.prepare(`UPDATE trip_stops SET status = 'skipped' WHERE trip_id = ? AND company_id = ? AND kind = 'delivery' AND status = 'pending'
            AND NOT EXISTS (SELECT 1 FROM trip_packages tp WHERE tp.stop_id = trip_stops.id AND tp.outcome IS NULL)`).bind(t.id, ctx.company.id),
        refreshStatement(ctx, t.id),
        ctx.db.prepare("UPDATE trips SET status = 'sealed', sealed_by = ?, sealed_at = ?, courier_signature_path = coalesce(?, courier_signature_path), updated_at = ? WHERE id = ? AND company_id = ?")
          .bind(ctx.user.id, ctx.now, text(a.p_signature_path, 300), ctx.now, t.id, ctx.company.id),
        ctx.db.prepare("UPDATE vehicles SET status = 'on_trip', updated_at = ? WHERE id = ? AND company_id = ?").bind(ctx.now, t.vehicle_id, ctx.company.id),
      ], 'trip_not_loading');
      const live = (await ctx.db.prepare('SELECT id, seq, status, lat, lng, eta FROM trip_stops WHERE trip_id = ? AND company_id = ?').bind(t.id, ctx.company.id).all()).results;
      const eta = etaStatements(ctx, sealed, live, await etaOrigin(ctx, sealed));
      if (eta.length) await ctx.db.batch(eta);
      await audit(ctx, 'trip_seal', 'trip', t.id);
      return { ok: true, ...(await loadingView(ctx, t.id)) };
    },
  },

  // ----------------------------------------------------------------- collectes chez les vendeurs, réception au hub
  // Colis prêts chez les vendeurs (préparés chez eux, pas encore dans une collecte ni annoncés en dépôt).
  lg_pickups_pending: {
    roles: opsRoles,
    async handler(ctx) {
      const r = await ctx.db.prepare(
        `SELECT p.holder_id AS vendor_id, COUNT(*) AS packages, sum(coalesce(p.weight_g, 0)) AS weight_g, min(p.updated_at) AS oldest,
                u.name AS vendor, u.phone, m.address, m.lat, m.lng
           FROM packages p JOIN users u ON u.id = p.holder_id JOIN members m ON m.user_id = p.holder_id AND m.company_id = p.company_id
          WHERE p.company_id = ? AND p.status = 'staged' AND p.hub_id IS NULL AND p.holder_type = 'vendor'
            AND NOT EXISTS (SELECT 1 FROM trip_packages tp WHERE tp.package_id = p.id AND tp.outcome IS NULL)
            AND NOT EXISTS (SELECT 1 FROM dropoff_bookings b JOIN dropoff_slots s ON s.id = b.slot_id
                             WHERE b.vendor_id = p.holder_id AND b.company_id = p.company_id AND b.status = 'booked' AND s.day || 'T' || s.end_time > ?)
          GROUP BY p.holder_id ORDER BY oldest`,
      ).bind(ctx.company.id, ctx.now.slice(0, 16)).all();
      return r.results;
    },
  },

  lg_trip_add_pickup: {
    roles: opsRoles,
    async handler(ctx, a) {
      const t = await tripFor(ctx, a.p_trip);
      if (!OPEN.includes(t.status)) fail('trip_not_open');
      const v = await ctx.db.prepare('SELECT u.id, u.name, u.phone, m.address, m.lat, m.lng FROM members m JOIN users u ON u.id = m.user_id WHERE m.company_id = ? AND m.user_id = ?')
        .bind(ctx.company.id, String(a.p_vendor ?? '')).first();
      if (!v) fail('unknown_vendor', 404);
      const stop = uuid();
      const [, add] = await ctx.db.batch([
        ctx.db.prepare(
          `INSERT INTO trip_stops (id, company_id, trip_id, seq, kind, vendor_id, contact_name, contact_phone, address, lat, lng)
           SELECT ?, ?, ?, (SELECT coalesce(max(seq), 0) + 1 FROM trip_stops WHERE trip_id = ?), 'pickup', ?, ?, ?, ?, ?, ?`,
        ).bind(stop, ctx.company.id, t.id, t.id, v.id, v.name, v.phone, v.address, v.lat, v.lng),
        ctx.db.prepare(
          `INSERT INTO trip_packages (company_id, trip_id, package_id, stop_id)
           SELECT ?, ?, p.id, ? FROM packages p WHERE p.company_id = ? AND p.status = 'staged' AND p.hub_id IS NULL AND p.holder_type = 'vendor' AND p.holder_id = ?
              AND NOT EXISTS (SELECT 1 FROM trip_packages tp WHERE tp.package_id = p.id AND tp.outcome IS NULL)`,
        ).bind(ctx.company.id, t.id, stop, ctx.company.id, v.id),
        // rien à collecter : l'arrêt vide disparaît dans le même lot
        ctx.db.prepare('DELETE FROM trip_stops WHERE id = ? AND NOT EXISTS (SELECT 1 FROM trip_packages WHERE stop_id = ?)').bind(stop, stop),
      ]);
      if (!add.meta.changes) fail('nothing_to_collect');
      if (t.status === 'in_progress') await recomputeEta(ctx, t.id);
      return { ok: true, stop_id: stop, packages: add.meta.changes };
    },
  },

  // Réception au hub d'un colis rapporté par un voyage (collecte, retour) : scan d'entrée, pesée.
  lg_receive: {
    roles: ['dock_chief', 'picker'],
    async handler(ctx, a) {
      return idempotent(ctx, 'receive', a.p_event, async () => {
        const p = await ctx.db.prepare(
          `SELECT p.*, tp.trip_id, t.hub_id AS trip_hub, k.user_id AS driver_user FROM packages p
             LEFT JOIN trip_packages tp ON tp.package_id = p.id AND tp.outcome IS NULL AND tp.loaded_at IS NOT NULL
             LEFT JOIN trips t ON t.id = tp.trip_id LEFT JOIN couriers k ON k.id = p.holder_id AND p.holder_type = 'driver'
            WHERE p.company_id = ? AND p.code = ?`,
        ).bind(ctx.company.id, normCode(a.p_code)).first();
        if (!p) return { ok: false, error: 'unknown_package' };
        if (!p.trip_id || p.status !== 'loaded') return { ok: false, error: 'not_in_transit_to_hub', status: p.status };
        if (p.driver_user && p.driver_user === ctx.user.id) return { ok: false, error: 'same_person' };
        const hub = a.p_hub || staffHub(ctx) || p.trip_hub;
        const w = int(a.p_weight_g);
        await runBatch(ctx, [
          guard(ctx.db, "(SELECT status FROM packages WHERE id = ?) = 'loaded'", [p.id]),
          ctx.db.prepare("UPDATE trip_packages SET outcome = 'received' WHERE trip_id = ? AND package_id = ? AND outcome IS NULL").bind(p.trip_id, p.id),
          ctx.db.prepare(`UPDATE packages SET status = ?, holder_type = 'hub', holder_id = ?, hub_id = ?, weight_g = coalesce(?, weight_g), updated_at = ? WHERE id = ? AND company_id = ?`)
            .bind(p.direction === 'return' ? 'returned_hub' : 'staged', hub, hub, w > 0 ? w : null, ctx.now, p.id, ctx.company.id),
          ctx.db.prepare("INSERT INTO scan_events (company_id, client_event_id, package_id, event, actor_id, trip_id, hub_id, device_at, meta) VALUES (?, ?, ?, 'receive', ?, ?, ?, ?, ?)")
            .bind(ctx.company.id, a.p_event ? String(a.p_event) : uuid(), p.id, ctx.user.id, p.trip_id, hub, ctx.now, JSON.stringify({ direction: p.direction, weight_g: w })),
          refreshStatement(ctx, p.trip_id),
        ], 'not_in_transit_to_hub');
        // rapprochement de caisse du voyage : cycle C6
        await tryReconcile(ctx, p.trip_id);
        return { ok: true, code: p.code, direction: p.direction, zone: p.zone, next: p.direction === 'return' ? 'return_vendor' : 'staged' };
      });
    },
  },

  // ----------------------------------------------------------------- quais
  lg_dock_upsert: {
    roles: ['dock_chief'],
    async handler(ctx, a) {
      const p = a.p && typeof a.p === 'object' ? a.p : {};
      const code = text(p.code, 20)?.toUpperCase();
      if (!code) fail('code_required');
      let hub = p.hub_id || staffHub(ctx);
      if (hub && !(await ctx.db.prepare('SELECT 1 AS x FROM hubs WHERE id = ? AND company_id = ?').bind(hub, ctx.company.id).first())) fail('unknown_hub', 404);
      hub = hub || (await ctx.db.prepare('SELECT id FROM hubs WHERE company_id = ? AND active = 1 ORDER BY created_at LIMIT 1').bind(ctx.company.id).first('id'));
      const r = await ctx.db.prepare(
        `INSERT INTO docks (id, company_id, hub_id, code, label, active) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (company_id, hub_id, code) DO UPDATE SET label = excluded.label, active = excluded.active RETURNING id`,
      ).bind(uuid(), ctx.company.id, hub, code, text(p.label, 60), p.active === false ? 0 : 1).first();
      return { ok: true, id: r.id };
    },
  },

  // Arrivée du véhicule au hub : le chauffeur (son voyage) ou le chef de quai la signale.
  lg_dock_checkin: {
    roles: 'member',
    async handler(ctx, a) {
      const t = await tripFor(ctx, a.p_trip);
      if (!isTripDriver(ctx, t) && !hasRole(ctx, opsRoles)) fail('forbidden', 403);
      if (!['draft', 'planned', 'loading', 'sealed'].includes(t.status)) return { ok: false, error: 'trip_started' };
      await ctx.db.prepare('UPDATE trips SET dock_queued_at = coalesce(dock_queued_at, ?), updated_at = ? WHERE id = ? AND company_id = ?').bind(ctx.now, ctx.now, t.id, ctx.company.id).run();
      const dock = t.dock_id ? await ctx.db.prepare('SELECT code FROM docks WHERE id = ? AND company_id = ?').bind(t.dock_id, ctx.company.id).first('code') : null;
      return { ok: true, dock };
    },
  },

  // Affectation d'un quai (p_dock vide = premier quai libre du hub). Un quai est occupé tant que le voyage n'est pas parti.
  lg_dock_assign: {
    roles: opsRoles,
    async handler(ctx, a) {
      const t = await tripFor(ctx, a.p_trip);
      if (!['draft', 'planned', 'loading', 'sealed'].includes(t.status)) return { ok: false, error: 'trip_started' };
      const busySql = "SELECT number FROM trips WHERE dock_id = ? AND id <> ? AND status IN ('draft', 'planned', 'loading', 'sealed') LIMIT 1";
      let d;
      if (!a.p_dock) {
        d = await ctx.db.prepare(
          `SELECT k.* FROM docks k WHERE k.company_id = ? AND k.active = 1 AND (? IS NULL OR k.hub_id = ?)
              AND NOT EXISTS (SELECT 1 FROM trips x WHERE x.dock_id = k.id AND x.id <> ? AND x.status IN ('draft', 'planned', 'loading', 'sealed')) ORDER BY k.code LIMIT 1`,
        ).bind(ctx.company.id, t.hub_id, t.hub_id, t.id).first();
        if (!d) return { ok: false, error: 'no_free_dock' };
      } else {
        d = await ctx.db.prepare('SELECT * FROM docks WHERE id = ? AND company_id = ? AND active = 1').bind(String(a.p_dock), ctx.company.id).first();
        if (!d) fail('unknown_dock', 404);
        const busy = await ctx.db.prepare(busySql).bind(d.id, t.id).first();
        if (busy) return { ok: false, error: 'dock_busy', trip: busy.number };
      }
      await runBatch(ctx, [
        guard(ctx.db, "NOT EXISTS (SELECT 1 FROM trips WHERE dock_id = ? AND id <> ? AND status IN ('draft', 'planned', 'loading', 'sealed'))", [d.id, t.id]),
        ctx.db.prepare('UPDATE trips SET dock_id = ?, dock_assigned_at = ?, updated_at = ? WHERE id = ? AND company_id = ?').bind(d.id, ctx.now, ctx.now, t.id, ctx.company.id),
      ], 'dock_busy');
      await audit(ctx, 'dock_assign', 'trip', String(t.number), { dock: d.code });
      return { ok: true, dock: d.code, dock_id: d.id };
    },
  },

  // Tableau des quais : occupation, file d'attente, temps moyens (7 derniers jours).
  lg_dock_board: {
    roles: opsRoles,
    async handler(ctx, a) {
      const hub = a.p_hub ?? null; const since = new Date(Date.parse(ctx.now) - 7 * 86400000).toISOString();
      const [docks, trips, firsts] = await ctx.db.batch([
        ctx.db.prepare('SELECT * FROM docks WHERE company_id = ? AND (? IS NULL OR hub_id = ?) ORDER BY code').bind(ctx.company.id, hub, hub),
        ctx.db.prepare(
          `SELECT t.*, v.plate, c.name AS courier,
                  (SELECT COUNT(*) FROM trip_packages tp WHERE tp.trip_id = t.id AND tp.loaded_at IS NOT NULL) AS loaded,
                  (SELECT COUNT(*) FROM trip_packages tp WHERE tp.trip_id = t.id) AS packages
             FROM trips t JOIN vehicles v ON v.id = t.vehicle_id LEFT JOIN couriers c ON c.id = t.courier_id
            WHERE t.company_id = ? AND (? IS NULL OR t.hub_id = ?) AND (t.status IN ('draft', 'planned', 'loading', 'sealed') OR t.dock_assigned_at > ?)`,
        ).bind(ctx.company.id, hub, hub, since),
        ctx.db.prepare('SELECT tp.trip_id, min(tp.loaded_at) AS first_load FROM trip_packages tp JOIN trips t ON t.id = tp.trip_id WHERE t.company_id = ? AND t.sealed_at > ? GROUP BY tp.trip_id')
          .bind(ctx.company.id, since),
      ]);
      const waiting = ['draft', 'planned', 'loading', 'sealed'];
      const min = (a2, b2) => Math.round((Date.parse(b2) - Date.parse(a2)) / 60000);
      const avg = (xs) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : null);
      return {
        docks: docks.results.map((k) => {
          const cur = trips.results.filter((t) => t.dock_id === k.id && waiting.includes(t.status)).sort((x, y) => (x.dock_assigned_at ?? '').localeCompare(y.dock_assigned_at ?? ''))[0];
          const loadMins = trips.results.filter((t) => t.dock_id === k.id && t.sealed_at && t.sealed_at > since)
            .map((t) => ({ t, f: firsts.results.find((x) => x.trip_id === t.id)?.first_load })).filter((x) => x.f && x.t.sealed_at > x.f).map((x) => min(x.f, x.t.sealed_at));
          return { id: k.id, code: k.code, label: k.label, active: Boolean(k.active),
            trip: cur ? { id: cur.id, number: cur.number, status: cur.status, vehicle: cur.plate, courier: cur.courier, planned_departure: cur.planned_departure,
              arrived: Boolean(cur.dock_queued_at), assigned_at: cur.dock_assigned_at, loaded: cur.loaded, packages: cur.packages } : null,
            avg_loading_min: avg(loadMins), trips_7d: trips.results.filter((t) => t.dock_id === k.id && t.dock_assigned_at > since).length };
        }),
        queue: trips.results.filter((t) => t.dock_queued_at && !t.dock_id && waiting.includes(t.status)).sort((x, y) => x.dock_queued_at.localeCompare(y.dock_queued_at))
          .map((t) => ({ trip_id: t.id, number: t.number, status: t.status, vehicle: t.plate, courier: t.courier, queued_at: t.dock_queued_at,
            waiting_min: min(t.dock_queued_at, ctx.now), planned_departure: t.planned_departure })),
        upcoming: trips.results.filter((t) => !t.dock_queued_at && !t.dock_id && LOADABLE.includes(t.status))
          .sort((x, y) => (x.planned_departure ?? '9').localeCompare(y.planned_departure ?? '9') || x.number - y.number)
          .map((t) => ({ trip_id: t.id, number: t.number, status: t.status, vehicle: t.plate, courier: t.courier, planned_departure: t.planned_departure })),
        avg_wait_min: avg(trips.results.filter((t) => t.dock_queued_at && t.dock_assigned_at > t.dock_queued_at && t.dock_assigned_at > since).map((t) => min(t.dock_queued_at, t.dock_assigned_at))),
      };
    },
  },

  // Pour le chauffeur : son quai et sa place dans la file.
  lg_trip_dock: {
    roles: 'member',
    async handler(ctx, a) {
      const t = await tripFor(ctx, a.p_trip);
      if (!isTripDriver(ctx, t) && !hasRole(ctx, opsRoles)) fail('forbidden', 403);
      const [dock, pos] = await ctx.db.batch([
        ctx.db.prepare('SELECT code FROM docks WHERE id = ? AND company_id = ?').bind(t.dock_id, ctx.company.id),
        ctx.db.prepare(`SELECT COUNT(*) AS n FROM trips q WHERE q.company_id = ? AND q.dock_queued_at IS NOT NULL AND q.dock_id IS NULL
            AND q.status IN ('draft', 'planned', 'loading', 'sealed') AND q.dock_queued_at <= ? AND q.hub_id IS ?`).bind(ctx.company.id, t.dock_queued_at, t.hub_id),
      ]);
      return { dock: dock.results[0]?.code ?? null, queued_at: t.dock_queued_at, position: !t.dock_id && t.dock_queued_at ? pos.results[0].n : null };
    },
  },

  // ----------------------------------------------------------------- dépôts par les vendeurs (cycle 17)
  lg_dropoff_slots_create: {
    roles: ['dock_chief'],
    async handler(ctx, a) {
      const days = int(a.p_days); const cap = int(a.p_capacity);
      if (!(cap > 0) || !(days >= 1 && days <= 31)) fail('invalid_quantity');
      if (!DATE.test(String(a.p_from ?? ''))) fail('invalid_date');
      const times = (Array.isArray(a.p_times) ? a.p_times : []).map((x) => String(x).split('-').map((s) => s.trim().slice(0, 5)));
      if (!times.length || times.some(([s, e]) => !HHMM.test(s) || !HHMM.test(e ?? '') || e <= s)) fail('invalid_time');
      let hub = a.p_hub || staffHub(ctx);
      if (hub && !(await ctx.db.prepare('SELECT 1 AS x FROM hubs WHERE id = ? AND company_id = ?').bind(hub, ctx.company.id).first())) fail('unknown_hub', 404);
      hub = hub || (await ctx.db.prepare('SELECT id FROM hubs WHERE company_id = ? AND active = 1 ORDER BY created_at LIMIT 1').bind(ctx.company.id).first('id'));
      const stmts = [];
      for (let i = 0; i < days; i++) for (const [s, e] of times) {
        stmts.push(ctx.db.prepare(
          `INSERT INTO dropoff_slots (id, company_id, hub_id, day, start_time, end_time, capacity) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (company_id, hub_id, day, start_time) DO UPDATE SET capacity = excluded.capacity, end_time = excluded.end_time`,
        ).bind(uuid(), ctx.company.id, hub, plusDays(a.p_from, i), s, e, cap));
      }
      if (stmts.length > 200) fail('invalid_quantity');
      await ctx.db.batch(stmts);
      return { ok: true, slots: stmts.length };
    },
  },

  lg_dropoff_available: {
    roles: 'member',
    async handler(ctx, a) {
      if (ctx.member !== 'vendor' && !ctx.isAdmin) fail('forbidden', 403);
      const day = today(ctx); const until = plusDays(day, Math.min(int(a.p_days) ?? 5, 30)); const nowHm = ctx.now.slice(0, 16);
      const [ready, booking, slots] = await ctx.db.batch([
        ctx.db.prepare("SELECT COUNT(*) AS n FROM packages WHERE company_id = ? AND status = 'staged' AND hub_id IS NULL AND holder_type = 'vendor' AND holder_id = ?").bind(ctx.company.id, ctx.user.id),
        ctx.db.prepare(
          `SELECT b.id, s.day, s.start_time AS start, s.end_time AS "end", h.name AS hub, b.packages FROM dropoff_bookings b JOIN dropoff_slots s ON s.id = b.slot_id
             JOIN hubs h ON h.id = s.hub_id WHERE b.company_id = ? AND b.vendor_id = ? AND b.status = 'booked' AND s.day || 'T' || s.end_time > ? ORDER BY s.day, s.start_time LIMIT 1`,
        ).bind(ctx.company.id, ctx.user.id, nowHm),
        ctx.db.prepare(
          `SELECT s.id, s.day, s.start_time AS start, s.end_time AS "end", h.name AS hub,
                  s.capacity - (SELECT COUNT(*) FROM dropoff_bookings b WHERE b.slot_id = s.id AND b.status <> 'cancelled') AS "left"
             FROM dropoff_slots s JOIN hubs h ON h.id = s.hub_id
            WHERE s.company_id = ? AND s.day BETWEEN ? AND ? AND s.day || 'T' || s.start_time > ?
              AND s.capacity > (SELECT COUNT(*) FROM dropoff_bookings b WHERE b.slot_id = s.id AND b.status <> 'cancelled') ORDER BY s.day, s.start_time`,
        ).bind(ctx.company.id, day, until, nowHm),
      ]);
      return { ready_packages: ready.results[0].n, booking: booking.results[0] ?? null, slots: slots.results };
    },
  },

  lg_dropoff_book: {
    roles: 'member',
    async handler(ctx, a) {
      if (ctx.member !== 'vendor') fail('forbidden', 403);
      const s = await ctx.db.prepare('SELECT * FROM dropoff_slots WHERE id = ? AND company_id = ?').bind(String(a.p_slot ?? ''), ctx.company.id).first();
      if (!s || `${s.day}T${s.start_time}` <= ctx.now.slice(0, 16)) return { ok: false, error: 'slot_unavailable' };
      const ready = await ctx.db.prepare("SELECT COUNT(*) AS n FROM packages WHERE company_id = ? AND status = 'staged' AND hub_id IS NULL AND holder_type = 'vendor' AND holder_id = ?")
        .bind(ctx.company.id, ctx.user.id).first('n');
      if (!ready) return { ok: false, error: 'nothing_to_drop' };
      const id = uuid();
      try {
        await runBatch(ctx, [
          guard(ctx.db, "(SELECT COUNT(*) FROM dropoff_bookings WHERE slot_id = ? AND status <> 'cancelled' AND vendor_id <> ?) < ?", [s.id, ctx.user.id, s.capacity]),
          // un seul dépôt prévu à la fois : le nouveau remplace l'ancien
          ctx.db.prepare(`UPDATE dropoff_bookings SET status = 'cancelled' WHERE company_id = ? AND vendor_id = ? AND status = 'booked' AND slot_id <> ?
              AND slot_id IN (SELECT id FROM dropoff_slots WHERE day || 'T' || end_time > ?)`).bind(ctx.company.id, ctx.user.id, s.id, ctx.now.slice(0, 16)),
          ctx.db.prepare(`INSERT INTO dropoff_bookings (id, company_id, slot_id, vendor_id, packages) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT (slot_id, vendor_id) DO UPDATE SET status = 'booked', packages = excluded.packages`).bind(id, ctx.company.id, s.id, ctx.user.id, ready),
        ], 'slot_unavailable');
      } catch (e) {
        if (e?.code === 'slot_unavailable') return { ok: false, error: 'slot_unavailable' };
        throw e;
      }
      const b = await ctx.db.prepare('SELECT id FROM dropoff_bookings WHERE slot_id = ? AND vendor_id = ?').bind(s.id, ctx.user.id).first();
      await audit(ctx, 'dropoff_book', 'dropoff', b.id, { day: s.day, start: s.start_time, packages: ready });
      return { ok: true, id: b.id, packages: ready };
    },
  },

  lg_dropoff_cancel: {
    roles: 'member',
    async handler(ctx, a) {
      const b = await ctx.db.prepare('SELECT * FROM dropoff_bookings WHERE id = ? AND company_id = ?').bind(String(a.p_booking ?? ''), ctx.company.id).first();
      if (!b) fail('unknown_booking', 404);
      if (b.vendor_id !== ctx.user.id && !hasRole(ctx, ['dock_chief'])) fail('forbidden', 403);
      const r = await ctx.db.prepare("UPDATE dropoff_bookings SET status = 'cancelled' WHERE id = ? AND company_id = ? AND status = 'booked'").bind(b.id, ctx.company.id).run();
      return r.meta.changes ? { ok: true } : { ok: false, error: 'bad_status' };
    },
  },

  // Au hub : réception directe d'un colis apporté par son vendeur (sans voyage).
  lg_dropoff_receive: {
    roles: ['dock_chief', 'picker'],
    async handler(ctx, a) {
      return idempotent(ctx, 'dropoff', a.p_event, async () => {
        const p = await ctx.db.prepare('SELECT * FROM packages WHERE company_id = ? AND code = ?').bind(ctx.company.id, normCode(a.p_code)).first();
        if (!p) return { ok: false, error: 'unknown_package' };
        if (p.status !== 'staged' || p.holder_type !== 'vendor' || p.hub_id) return { ok: false, error: 'not_at_vendor', status: p.status };
        // déjà prévu dans une collecte : le chauffeur le cherche
        if (await ctx.db.prepare('SELECT 1 AS x FROM trip_packages WHERE package_id = ? AND outcome IS NULL').bind(p.id).first()) return { ok: false, error: 'in_pickup_trip' };
        const hub = staffHub(ctx) || (await ctx.db.prepare('SELECT id FROM hubs WHERE company_id = ? AND active = 1 ORDER BY created_at LIMIT 1').bind(ctx.company.id).first('id'));
        const w = int(a.p_weight_g);
        const booking = await ctx.db.prepare(
          `SELECT b.id FROM dropoff_bookings b JOIN dropoff_slots s ON s.id = b.slot_id WHERE b.company_id = ? AND b.vendor_id = ? AND b.status IN ('booked', 'arrived') AND s.day = ?
            ORDER BY s.start_time LIMIT 1`).bind(ctx.company.id, p.holder_id, today(ctx)).first('id');
        const stmts = [
          guard(ctx.db, "(SELECT holder_type FROM packages WHERE id = ?) = 'vendor'", [p.id]),
          ctx.db.prepare('UPDATE packages SET holder_type = \'hub\', holder_id = ?, hub_id = ?, weight_g = coalesce(?, weight_g), updated_at = ? WHERE id = ? AND company_id = ?')
            .bind(hub, hub, w > 0 ? w : null, ctx.now, p.id, ctx.company.id),
          ctx.db.prepare("INSERT INTO scan_events (company_id, client_event_id, package_id, event, actor_id, hub_id, device_at, meta) VALUES (?, ?, ?, 'receive', ?, ?, ?, ?)")
            .bind(ctx.company.id, a.p_event ? String(a.p_event) : uuid(), p.id, ctx.user.id, hub, ctx.now, JSON.stringify({ dropoff: true, weight_g: w })),
        ];
        // la réservation du jour du vendeur (même en avance ou en retard) passe « arrivé »
        if (booking) stmts.push(ctx.db.prepare("UPDATE dropoff_bookings SET status = 'arrived', arrived_at = coalesce(arrived_at, ?), received = received + 1 WHERE id = ?").bind(ctx.now, booking));
        await runBatch(ctx, stmts, 'not_at_vendor');
        return { ok: true, code: p.code, zone: p.zone, next: 'staged', booked: Boolean(booking) };
      });
    },
  },

  lg_dropoffs_today: {
    roles: ['dock_chief', 'picker', 'dispatcher'],
    async handler(ctx) {
      const r = await ctx.db.prepare(
        `SELECT b.id, u.name AS vendor, u.phone, s.start_time AS start, s.end_time AS "end", b.packages, b.received, b.status, s.day
           FROM dropoff_bookings b JOIN dropoff_slots s ON s.id = b.slot_id JOIN users u ON u.id = b.vendor_id
          WHERE b.company_id = ? AND s.day = ? AND b.status <> 'cancelled' ORDER BY s.start_time, u.name`,
      ).bind(ctx.company.id, today(ctx)).all();
      return r.results.map(({ day, ...b }) => ({ ...b, late: b.status === 'booked' && `${day}T${b.end}` < ctx.now.slice(0, 16) }));
    },
  },

  // ----------------------------------------------------------------- créneaux de livraison proposés aux clients
  lg_create_slots: {
    roles: ['dispatcher'],
    async handler(ctx, a) {
      const zone = text(a.p_zone, 80);
      if (!zone || !(await ctx.db.prepare('SELECT 1 AS x FROM zones WHERE company_id = ? AND name = ?').bind(ctx.company.id, zone).first())) fail('unknown_zone', 404);
      const days = int(a.p_days); const cap = int(a.p_capacity);
      if (!(cap > 0) || !(days >= 1 && days <= 31) || !DATE.test(String(a.p_from ?? ''))) fail('invalid_quantity');
      const times = (Array.isArray(a.p_times) ? a.p_times : []).map((x) => String(x).split('-').map((s) => s.trim().slice(0, 5)));
      if (!times.length || times.some(([s, e]) => !HHMM.test(s) || !HHMM.test(e ?? '') || e <= s)) fail('invalid_time');
      const stmts = [];
      for (let i = 0; i < days; i++) for (const [s, e] of times) {
        stmts.push(ctx.db.prepare(`INSERT INTO delivery_slots (id, company_id, zone, day, start_time, end_time, capacity) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (company_id, zone, day, start_time) DO UPDATE SET capacity = excluded.capacity`).bind(uuid(), ctx.company.id, zone, plusDays(a.p_from, i), s, e, cap));
      }
      if (stmts.length > 200) fail('invalid_quantity');
      await ctx.db.batch(stmts);
      return { ok: true, slots: stmts.length };
    },
  },

  // Public : avec le jeton de suivi du client (sa zone), ou pour un membre connecté (p_zone).
  lg_slots_available: {
    roles: 'public',
    async handler(ctx, a) {
      let cid = ctx.company?.id; let zone = text(a.p_zone, 80);
      if (a.p_token) {
        const o = await ctx.db.prepare('SELECT company_id, delivery_zone FROM orders WHERE tracking_token = ?').bind(String(a.p_token)).first();
        if (!o) return [];
        cid = o.company_id; zone = o.delivery_zone;
      }
      if (!cid || !zone) return [];
      const day = ctx.now.slice(0, 10);
      return (await ctx.db.prepare(
        `SELECT id, day, start_time AS start, end_time AS "end", capacity - booked AS "left" FROM delivery_slots
          WHERE company_id = ? AND zone = ? AND day BETWEEN ? AND ? AND booked < capacity ORDER BY day, start_time`,
      ).bind(cid, zone, day, plusDays(day, Math.min(int(a.p_days) ?? 5, 30))).all()).results;
    },
  },

  // Le client choisit son créneau depuis sa page de suivi (tant que rien n'est chargé).
  lg_track_book_slot: {
    roles: 'public',
    async handler(ctx, a) {
      const o = typeof a.p_token === 'string' && /^[\w-]{16,64}$/.test(a.p_token)
        ? await ctx.db.prepare('SELECT * FROM orders WHERE tracking_token = ?').bind(a.p_token).first() : null;
      if (!o) return { ok: false, error: 'not_found' };
      if (await ctx.db.prepare("SELECT 1 AS x FROM packages WHERE order_id = ? AND status IN ('loaded', 'out_for_delivery', 'delivered')").bind(o.id).first()) return { ok: false, error: 'already_loaded' };
      const sl = await ctx.db.prepare('SELECT * FROM delivery_slots WHERE id = ? AND company_id = ?').bind(String(a.p_slot ?? ''), o.company_id).first();
      if (!sl || sl.booked >= sl.capacity || sl.zone !== o.delivery_zone) return { ok: false, error: 'slot_unavailable' };
      const c = { ...ctx, company: { id: o.company_id } };
      const stmts = [
        guard(ctx.db, '(SELECT booked < capacity FROM delivery_slots WHERE id = ?)', [sl.id]),
        ctx.db.prepare('UPDATE delivery_slots SET booked = max(booked - 1, 0) WHERE id = ? AND company_id = ? AND ? IS NOT NULL').bind(o.slot_id, o.company_id, o.slot_id),
        ctx.db.prepare('UPDATE delivery_slots SET booked = booked + 1 WHERE id = ?').bind(sl.id),
        ctx.db.prepare('UPDATE orders SET slot_id = ?, promised_at = ?, updated_at = ? WHERE id = ?').bind(sl.id, nextSlotDay(sl), ctx.now, o.id),
        ctx.db.prepare(`UPDATE trip_stops SET window_start = ?, window_end = ? WHERE order_id = ? AND company_id = ?
            AND trip_id IN (SELECT id FROM trips WHERE status IN ('planned', 'loading'))`).bind(`${sl.day}T${sl.start_time}:00.000Z`, nextSlotDay(sl), o.id, o.company_id),
      ];
      try { await runBatch(c, stmts, 'slot_unavailable'); } catch (e) { if (e?.code === 'slot_unavailable') return { ok: false, error: 'slot_unavailable' }; throw e; }
      return { ok: true };
    },
  },

  // ----------------------------------------------------------------- suggestions et planification
  // Voyages compatibles avec une commande à quai, notés : proximité (0-50) + remplissage (0-30) + équilibre (0-20).
  lg_suggest_trips: {
    roles: opsRoles,
    async handler(ctx, a) {
      const o = await orderForStop(ctx, a.p_order);
      if (!o) fail('unknown_order', 404);
      const [pk, trips, stops] = await ctx.db.batch([
        ctx.db.prepare("SELECT weight_g, volume_l, handling FROM packages WHERE order_id = ? AND company_id = ? AND status = 'staged'").bind(o.id, ctx.company.id),
        ctx.db.prepare(
          `SELECT t.*, v.kind AS vkind, v.capacity_kg, v.capacity_l, v.max_packages, v.equipment, c.name AS courier, c.cash_limit_fcfa
             FROM trips t JOIN vehicles v ON v.id = t.vehicle_id LEFT JOIN couriers c ON c.id = t.courier_id WHERE t.company_id = ? AND t.status IN ('planned', 'loading')`,
        ).bind(ctx.company.id),
        ctx.db.prepare("SELECT s.trip_id, s.lat, s.lng FROM trip_stops s JOIN trips t ON t.id = s.trip_id WHERE t.company_id = ? AND t.status IN ('planned', 'loading') AND s.status <> 'skipped'")
          .bind(ctx.company.id),
      ]);
      const w = pk.results.reduce((s, p) => s + (p.weight_g ?? 0), 0); const n = pk.results.length; const vol = pk.results.reduce((s, p) => s + (p.volume_l ?? 0), 0);
      const cold = pk.results.some((p) => parseJson(p.handling, []).includes('froid'));
      const lat = o.delivery_lat ?? o.c_lat; const lng = o.delivery_lng ?? o.c_lng;
      const due = amountDue(o); const limitDefault = Number(ctx.company.config.cash_limit_fcfa ?? 150000);
      return trips.results.filter((t) => {
        const zones = parseJson(t.zones, []);
        return (!zones.length || zones.includes(o.delivery_zone)) && t.load_weight_g + w <= t.capacity_kg * 1000
          && (t.max_packages == null || t.load_count + n <= t.max_packages) && (!(t.capacity_l > 0) || t.load_volume_l + vol <= t.capacity_l)
          && (!cold || parseJson(t.equipment, []).includes('glacière')) && t.cod_expected_fcfa + due <= (t.cash_limit_fcfa ?? limitDefault) * 2;
      }).map((t) => {
        const ts = stops.results.filter((s) => s.trip_id === t.id);
        const ds = ts.map((s) => distanceM(s.lat, s.lng, lat, lng)).filter((d) => d != null);
        const nearest = ds.length ? Math.min(...ds) : null;
        const score = Math.round(50 * Math.exp(-(nearest ?? 8000) / 4000) + 30 * Math.min(1, (t.load_weight_g + w) / (t.capacity_kg * 1000)) + 20 * (1 - Math.min(1, ts.length / 20)));
        return { trip_id: t.id, number: t.number, label: t.label, vehicle_kind: t.vkind, courier: t.courier, score, nearest_m: nearest,
          weight_after_pct: Math.round((100 * (t.load_weight_g + w)) / (t.capacity_kg * 1000)) };
      }).sort((x, y) => y.score - x.score);
    },
  },

  // Planification automatique (« balayage » autour du hub) : simulation, puis création si p_apply.
  lg_autoplan_run: {
    roles: ['dispatcher'],
    async handler(ctx, a) {
      const cid = ctx.company.id; const day = today(ctx);
      const hub = await ctx.db.prepare('SELECT * FROM hubs WHERE company_id = ? AND active = 1 AND (? IS NULL OR id = ?) ORDER BY created_at LIMIT 1').bind(cid, a.p_hub ?? null, a.p_hub ?? null).first();
      if (!hub) fail('unknown_hub', 404);
      const [vs, cs, pk] = await ctx.db.batch([
        ctx.db.prepare(
          `SELECT v.* FROM vehicles v WHERE v.company_id = ? AND v.status = 'available' AND (? IS NULL OR v.hub_id = ?)
              AND NOT EXISTS (SELECT 1 FROM trips t WHERE t.vehicle_id = v.id AND t.status IN ('planned', 'loading', 'sealed', 'in_progress'))
              AND NOT ${DOCS_EXPIRED_SQL} ORDER BY v.capacity_kg DESC`,
        ).bind(cid, a.p_hub ?? null, a.p_hub ?? null, day, day),
        ctx.db.prepare(
          `SELECT c.* FROM couriers c WHERE c.company_id = ? AND c.active = 1 AND (c.license_expires_at IS NULL OR c.license_expires_at >= ?)
              AND NOT EXISTS (SELECT 1 FROM trips t WHERE t.courier_id = c.id AND t.status IN ('planned', 'loading', 'sealed', 'in_progress', 'completed'))
            ORDER BY c.deliveries_done DESC`,
        ).bind(cid, day),
        ctx.db.prepare(
          `SELECT p.order_id, p.weight_g, p.volume_l, p.handling, o.delivery_zone AS zone, coalesce(o.delivery_lat, cu.lat, z.lat) AS lat,
                  coalesce(o.delivery_lng, cu.lng, z.lng) AS lng, o.payment_method, o.payment_status, o.total_fcfa, o.shortage_fcfa, o.discount_fcfa, o.subtotal_fcfa
             FROM packages p JOIN orders o ON o.id = p.order_id LEFT JOIN customers cu ON cu.id = o.customer_id
             LEFT JOIN zones z ON z.company_id = o.company_id AND z.name = o.delivery_zone
            WHERE p.company_id = ? AND p.status = 'staged' AND p.hub_id IS NOT NULL AND p.direction = 'outbound' AND (? IS NULL OR p.hub_id = ?)
              AND NOT EXISTS (SELECT 1 FROM trip_packages tp WHERE tp.package_id = p.id AND tp.outcome IS NULL)`,
        ).bind(cid, a.p_hub ?? null, a.p_hub ?? null),
      ]);
      // véhicules prêts : chauffeur habituel s'il est libre, sinon le premier chauffeur libre
      const freeC = [...cs.results]; const plan = [];
      const limitDefault = Number(ctx.company.config.cash_limit_fcfa ?? 150000);
      for (const v of vs.results) {
        let i = freeC.findIndex((c) => c.id === v.default_courier_id);
        if (i < 0) i = freeC.length ? 0 : -1;
        if (i < 0) continue;   // un même chauffeur ne prend pas deux véhicules
        const [c] = freeC.splice(i, 1);
        const eq = parseJson(v.equipment, []);
        plan.push({ vehicle_id: v.id, plate: v.plate, kind: v.kind, courier_id: c.id, courier: c.name, cap_g: v.capacity_kg * 1000, cap_l: v.capacity_l ?? 0,
          cap_n: v.max_packages ?? 0, cash_limit: c.cash_limit_fcfa ?? limitDefault, cooler: eq.includes('glacière'), two_wheels: ['moto', 'vélo'].includes(v.kind),
          w: 0, v: 0, n: 0, cod: 0, orders: [], zones: [] });
      }
      // commandes à quai, par angle autour du hub
      const byOrder = new Map();
      for (const p of pk.results) {
        const o = byOrder.get(p.order_id) ?? { id: p.order_id, zone: p.zone, lat: p.lat, lng: p.lng, w: 0, vol: 0, n: 0, cold: false, heavy: false, cod: amountDue(p) };
        const h = parseJson(p.handling, []);
        o.w += p.weight_g ?? 1000; o.vol += p.volume_l ?? 0; o.n += 1; o.cold ||= h.includes('froid'); o.heavy ||= h.includes('lourd');
        byOrder.set(p.order_id, o);
      }
      const angle = (o) => Math.atan2((o.lat ?? hub.lat ?? 0) - (hub.lat ?? 0), (o.lng ?? hub.lng ?? 0) - (hub.lng ?? 0));
      const left = [];
      for (const o of [...byOrder.values()].sort((x, y) => angle(x) - angle(y))) {
        const cur = plan.find((t) => t.w + o.w <= t.cap_g && (!t.cap_l || t.v + o.vol <= t.cap_l) && (!t.cap_n || t.n + o.n <= t.cap_n)
          && t.cod + o.cod <= t.cash_limit && (!o.cold || t.cooler) && (!o.heavy || !t.two_wheels));
        if (!cur) { left.push({ id: o.id, zone: o.zone, w: o.w, n: o.n, reason: plan.length === 0 ? 'aucun véhicule libre' : o.cold ? 'glacière requise' : 'capacité atteinte' }); continue; }
        cur.w += o.w; cur.v += o.vol; cur.n += o.n; cur.cod += o.cod; cur.orders.push({ id: o.id, zone: o.zone, lat: o.lat, lng: o.lng, n: o.n, w: o.w });
        if (!cur.zones.includes(o.zone ?? '?')) cur.zones.push(o.zone ?? '?');
      }
      const trips = plan.filter((t) => t.orders.length).map((t) => ({ ...t,
        fill_pct: Math.max(Math.round((100 * t.w) / t.cap_g), t.cap_l ? Math.round((100 * t.v) / t.cap_l) : 0, t.cap_n ? Math.round((100 * t.n) / t.cap_n) : 0),
        label: t.zones.slice(0, 3).join(' · ') }));
      const created = [];
      if (a.p_apply) {
        const R = (await import('./index.js')).REGISTRY;
        for (const t of trips) {
          const tr = await R.lg_trip_create.handler(ctx, { p_vehicle: t.vehicle_id, p_courier: t.courier_id, p_label: t.label, p_hub: hub.id });
          for (const o of t.orders) await R.lg_trip_add_order.handler(ctx, { p_trip: tr.trip_id, p_order: o.id });
          // ordre des arrêts : plus proche voisin depuis le hub (l'app affine avec le 2-opt)
          const st = (await ctx.db.prepare("SELECT id, lat, lng FROM trip_stops WHERE trip_id = ? AND status <> 'skipped'").bind(tr.trip_id).all()).results;
          const order = []; let at = { lat: hub.lat, lng: hub.lng };
          while (st.length) {
            st.sort((x, y) => (distanceM(at.lat, at.lng, x.lat, x.lng) ?? 1e9) - (distanceM(at.lat, at.lng, y.lat, y.lng) ?? 1e9));
            const nx = st.shift(); order.push(nx.id); if (nx.lat != null) at = nx;
          }
          await R.lg_trip_reorder.handler(ctx, { p_trip: tr.trip_id, p_stop_ids: order });
          created.push({ ...tr, label: t.label, orders: t.orders.length });
        }
        await audit(ctx, 'autoplan', 'trip', null, { trips: created.length });
      }
      return { ok: true, applied: Boolean(a.p_apply), trips, unassigned: left, created, vehicles_free: plan.length };
    },
  },

  // Utile à l'écran des commandes : voyage et arrêt d'une commande (lecture).
  lg_order_trip: {
    roles: ['dock_chief', 'dispatcher', 'support'],
    async handler(ctx, a) {
      return (await ctx.db.prepare(
        `SELECT t.id AS trip_id, t.number, t.status, s.id AS stop_id, s.seq, s.status AS stop_status, s.eta FROM trip_stops s JOIN trips t ON t.id = s.trip_id
          WHERE s.order_id = ? AND s.company_id = ? AND s.kind = 'delivery' AND s.status <> 'skipped' ORDER BY t.created_at DESC LIMIT 1`,
      ).bind(String(a.p_order ?? ''), ctx.company.id).first()) ?? null;
    },
  },
};

export { orderShort };
