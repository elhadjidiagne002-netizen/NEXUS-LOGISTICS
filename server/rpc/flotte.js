// Cycle C4 — flotte : véhicules, documents (assurance, visite technique, permis), entretien au kilométrage,
// contrôle avant départ, alertes ; adresse de collecte d'un vendeur.
// Portage de 20261007000800_administration.sql (véhicules), 20261007000700 (lg_fleet, lg_vehicle_check) et
// 20261008001900_cycle19_entretien_preventif.sql (entretien préventif).
import { fail, audit, hasRole, text, num, int, uuid, parseJson, today } from './core.js';

export const VEHICLE_KINDS = ['vélo', 'moto', 'tricycle', 'voiture', 'fourgonnette', 'camion'];
const DOC_KINDS = ['assurance', 'visite_technique', 'carte_grise', 'permis', 'autre'];
const LOG_KINDS = ['checklist', 'entretien', 'panne', 'kilometrage', 'pneus', 'vidange'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const plusDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

/** Alerte de la tour de contrôle (lg_raise_alert) : une seule ouverte par situation (dedupe). */
export const alertStatement = (ctx, companyId, kind, severity, message, { trip = null, stop = null, pkg = null, dedupe = null } = {}) =>
  ctx.db.prepare('INSERT OR IGNORE INTO alerts (company_id, kind, severity, message, trip_id, stop_id, package_id, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(companyId, kind, severity, String(message).slice(0, 500), trip, stop, pkg, dedupe);

/** Documents obligatoires périmés sans remplaçant valide (assurance, visite technique, carte grise). */
export const DOCS_EXPIRED_SQL = `EXISTS (SELECT 1 FROM vehicle_documents d WHERE d.vehicle_id = v.id AND d.expires_at < ?
  AND d.kind IN ('assurance', 'visite_technique', 'carte_grise')
  AND NOT EXISTS (SELECT 1 FROM vehicle_documents d2 WHERE d2.vehicle_id = v.id AND d2.kind = d.kind AND d2.expires_at >= ?))`;

/** Entretien préventif : kilométrage estimé (dernier relevé + km des voyages depuis) et échéance (lg_vehicle_maintenance). */
function maintenance(v, logs, trips, alertKm) {
  const due = logs.filter((l) => l.next_due_km != null).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (!due) return null;
  const reading = logs.filter((l) => l.odometer_km != null).sort((a, b) => b.odometer_km - a.odometer_km || b.created_at.localeCompare(a.created_at))[0];
  const baseKm = reading?.odometer_km ?? v.odometer_km; const baseAt = reading?.created_at ?? v.updated_at;
  const km = baseKm == null ? null : Math.round(baseKm + trips.filter((t) => t.started_at && t.started_at > baseAt).reduce((s, t) => s + (t.distance_km ?? 0), 0));
  const remaining = km == null ? null : due.next_due_km - km;
  return { kind: due.kind, due_km: due.next_due_km, km, remaining_km: remaining,
    state: km == null ? 'unknown' : km >= due.next_due_km ? 'overdue' : remaining <= alertKm ? 'soon' : 'ok' };
}

/** Alerte d'entretien à prévoir (lg_maintenance_check), à appeler après un relevé ou une fin de voyage. */
export async function maintenanceAlert(ctx, vehicleId) {
  const [v, logs, trips] = await ctx.db.batch([
    ctx.db.prepare('SELECT * FROM vehicles WHERE id = ? AND company_id = ?').bind(vehicleId, ctx.company.id),
    ctx.db.prepare('SELECT kind, odometer_km, next_due_km, created_at FROM vehicle_logs WHERE vehicle_id = ? AND company_id = ?').bind(vehicleId, ctx.company.id),
    ctx.db.prepare('SELECT started_at, distance_km FROM trips WHERE vehicle_id = ? AND company_id = ? AND started_at IS NOT NULL').bind(vehicleId, ctx.company.id),
  ]);
  const veh = v.results[0]; if (!veh) return;
  const m = maintenance(veh, logs.results, trips.results, Number(ctx.company.config.maintenance_alert_km ?? 500));
  if (!m || (m.state !== 'soon' && m.state !== 'overdue')) return;
  const msg = m.state === 'overdue' ? `${veh.plate} : ${m.kind} dépassé de ${-m.remaining_km} km (prévu à ${m.due_km} km)`
    : `${veh.plate} : ${m.kind} dans ${m.remaining_km} km (à ${m.due_km} km)`;
  await alertStatement(ctx, ctx.company.id, 'maintenance_due', m.state === 'overdue' ? 'warning' : 'info', msg,
    { dedupe: `maint:${vehicleId}:${m.due_km}:${m.state}` }).run();
}

async function vehicleFor(ctx, id) {
  const v = await ctx.db.prepare('SELECT * FROM vehicles WHERE id = ? AND company_id = ?').bind(String(id ?? ''), ctx.company.id).first();
  if (!v) fail('unknown_vehicle', 404);
  return v;
}
const fleetRoles = (ctx) => ctx.isAdmin || hasRole(ctx, ['dock_chief']);

export default {
  lg_fleet: {
    roles: ['dock_chief', 'dispatcher'],
    async handler(ctx) {
      const cid = ctx.company.id; const day = today(ctx);
      const since = new Date(Date.parse(ctx.now) - 30 * 86400000).toISOString();
      const [vs, docs, logs, trips, couriers, exp] = await ctx.db.batch([
        ctx.db.prepare("SELECT * FROM vehicles WHERE company_id = ? AND status <> 'retired'").bind(cid),
        ctx.db.prepare('SELECT id, vehicle_id, kind, number, expires_at FROM vehicle_documents WHERE company_id = ? AND vehicle_id IS NOT NULL ORDER BY expires_at').bind(cid),
        ctx.db.prepare('SELECT vehicle_id, kind, ok, odometer_km, next_due_km, cost_fcfa, created_at FROM vehicle_logs WHERE company_id = ?').bind(cid),
        ctx.db.prepare("SELECT vehicle_id, number, status, started_at, distance_km FROM trips WHERE company_id = ? AND (status IN ('planned', 'loading', 'sealed', 'in_progress') OR started_at IS NOT NULL)").bind(cid),
        ctx.db.prepare('SELECT id, name FROM couriers WHERE company_id = ?').bind(cid),
        ctx.db.prepare("SELECT vehicle_id, sum(amount_fcfa) AS n FROM trip_expenses WHERE company_id = ? AND status <> 'rejected' AND created_at > ? GROUP BY vehicle_id").bind(cid, since),
      ]);
      const alertKm = Number(ctx.company.config.maintenance_alert_km ?? 500);
      const order = ['available', 'on_trip', 'maintenance'];
      return vs.results.map((v) => {
        const vl = logs.results.filter((l) => l.vehicle_id === v.id); const vt = trips.results.filter((t) => t.vehicle_id === v.id);
        const check = vl.filter((l) => l.kind === 'checklist').sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
        const dc = couriers.results.find((c) => c.id === v.default_courier_id);
        return {
          id: v.id, plate: v.plate, kind: v.kind, label: v.label, status: v.status, ownership: v.ownership, capacity_kg: v.capacity_kg,
          capacity_l: v.capacity_l, max_packages: v.max_packages, equipment: parseJson(v.equipment, []), odometer_km: v.odometer_km, hub_id: v.hub_id,
          default_courier: dc ? { id: dc.id, name: dc.name } : null,
          documents: docs.results.filter((d) => d.vehicle_id === v.id).map((d) => ({ id: d.id, kind: d.kind, number: d.number, expires_at: d.expires_at,
            expired: d.expires_at < day, soon: d.expires_at < plusDays(day, 15) })),
          last_check: check ? { at: check.created_at, ok: Boolean(check.ok) } : null,
          // frais de route (cycle C5) + entretien des 30 derniers jours
          costs_30d_fcfa: vl.filter((l) => l.created_at > since).reduce((s, l) => s + (l.cost_fcfa ?? 0), 0) + (exp.results.find((e) => e.vehicle_id === v.id)?.n ?? 0),
          km_30d: vt.filter((t) => t.started_at && t.started_at > since).reduce((s, t) => s + (t.distance_km ?? 0), 0) || null,
          on_trip: vt.find((t) => ['planned', 'loading', 'sealed', 'in_progress'].includes(t.status))?.number ?? null,
          maintenance: maintenance(v, vl, vt, alertKm),
        };
      }).sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.kind.localeCompare(b.kind) || a.plate.localeCompare(b.plate));
    },
  },

  lg_upsert_vehicle: {
    roles: ['dock_chief'],
    async handler(ctx, a) {
      const p = a.p && typeof a.p === 'object' ? a.p : {};
      const plate = text(p.plate, 20)?.toUpperCase();
      if (!plate) fail('invalid_plate');
      if (!VEHICLE_KINDS.includes(p.kind)) fail('invalid_vehicle');
      const cap = num(p.capacity_kg);
      if (!(cap > 0)) fail('invalid_capacity');
      const ownership = p.ownership ?? 'interne';
      if (!['interne', 'partenaire', 'independant'].includes(ownership)) fail('invalid_ownership');
      const status = p.status ?? 'available';
      if (!['available', 'maintenance', 'retired'].includes(status) && status !== 'on_trip') fail('invalid_status');
      for (const [table, id] of [['hubs', p.hub_id], ['couriers', p.default_courier_id]]) {
        if (id && !(await ctx.db.prepare(`SELECT 1 AS x FROM ${table} WHERE id = ? AND company_id = ?`).bind(id, ctx.company.id).first())) fail(table === 'hubs' ? 'unknown_hub' : 'unknown_courier', 404);
      }
      const equipment = JSON.stringify(Array.isArray(p.equipment) ? p.equipment.map(String).slice(0, 10) : []);
      const vals = [plate, p.kind, text(p.label, 80), cap, num(p.capacity_l), int(p.max_packages), equipment, ownership, p.hub_id || null, p.default_courier_id || null];
      const id = p.id || uuid();
      try {
        if (p.id) {
          const r = await ctx.db.prepare(
            `UPDATE vehicles SET plate = ?, kind = ?, label = ?, capacity_kg = ?, capacity_l = ?, max_packages = ?, equipment = ?, ownership = ?, hub_id = ?,
               default_courier_id = ?, odometer_km = coalesce(?, odometer_km), status = CASE WHEN status = 'on_trip' THEN 'on_trip' ELSE ? END, updated_at = ?
             WHERE id = ? AND company_id = ?`,
          ).bind(...vals, int(p.odometer_km), status === 'on_trip' ? 'available' : status, ctx.now, id, ctx.company.id).run();
          if (!r.meta.changes) fail('unknown_vehicle', 404);
        } else {
          await ctx.db.prepare(
            `INSERT INTO vehicles (plate, kind, label, capacity_kg, capacity_l, max_packages, equipment, ownership, hub_id, default_courier_id, odometer_km, status, id, company_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(...vals, int(p.odometer_km), status === 'on_trip' ? 'available' : status, id, ctx.company.id).run();
        }
      } catch (e) {
        if (/UNIQUE/i.test(String(e?.message))) fail('plate_taken', 409);
        throw e;
      }
      await audit(ctx, 'vehicle_upsert', 'vehicle', id, { plate, kind: p.kind });
      return { ok: true, id };
    },
  },

  lg_set_vehicle_status: {
    roles: ['dock_chief'],
    async handler(ctx, a) {
      if (!['available', 'maintenance', 'retired'].includes(a.p_status)) fail('invalid_status');
      const r = await ctx.db.prepare("UPDATE vehicles SET status = ?, updated_at = ? WHERE id = ? AND company_id = ? AND status <> 'on_trip'")
        .bind(a.p_status, ctx.now, String(a.p_vehicle ?? ''), ctx.company.id).run();
      return { ok: r.meta.changes > 0 };
    },
  },

  // Document d'un véhicule (assurance, visite technique, carte grise) ou d'un chauffeur (permis).
  lg_add_document: {
    roles: ['dock_chief'],
    async handler(ctx, a) {
      if (!DOC_KINDS.includes(a.p_kind)) fail('invalid_kind');
      if (!DATE.test(String(a.p_expires_at ?? ''))) fail('invalid_date');
      if (!a.p_vehicle && !a.p_courier) fail('unknown_vehicle', 404);
      if (a.p_vehicle) await vehicleFor(ctx, a.p_vehicle);
      if (a.p_courier && !(await ctx.db.prepare('SELECT 1 AS x FROM couriers WHERE id = ? AND company_id = ?').bind(a.p_courier, ctx.company.id).first())) fail('unknown_courier', 404);
      const id = uuid();
      const stmts = [ctx.db.prepare('INSERT INTO vehicle_documents (id, company_id, vehicle_id, courier_id, kind, number, expires_at, file_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, ctx.company.id, a.p_vehicle || null, a.p_courier || null, a.p_kind, text(a.p_number, 40), a.p_expires_at, text(a.p_file_path, 300))];
      if (a.p_kind === 'permis' && a.p_courier) {
        stmts.push(ctx.db.prepare('UPDATE couriers SET license_expires_at = max(coalesce(license_expires_at, ?), ?) WHERE id = ? AND company_id = ?')
          .bind(a.p_expires_at, a.p_expires_at, a.p_courier, ctx.company.id));
      }
      await ctx.db.batch(stmts);
      return { ok: true, id };
    },
  },

  lg_log_maintenance: {
    roles: ['dock_chief'],
    async handler(ctx, a) {
      if (!LOG_KINDS.includes(a.p_kind) || a.p_kind === 'checklist') fail('invalid_kind');
      const v = await vehicleFor(ctx, a.p_vehicle);
      const km = int(a.p_odometer_km);
      await ctx.db.batch([
        ctx.db.prepare('INSERT INTO vehicle_logs (id, company_id, vehicle_id, kind, odometer_km, cost_fcfa, note, next_due_km, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(uuid(), ctx.company.id, v.id, a.p_kind, km, int(a.p_cost_fcfa), text(a.p_note, 500), int(a.p_next_due_km), ctx.user.id),
        ctx.db.prepare(`UPDATE vehicles SET odometer_km = max(coalesce(odometer_km, 0), ?), updated_at = ?,
            status = CASE WHEN ? = 'panne' AND status = 'available' THEN 'maintenance' ELSE status END WHERE id = ? AND company_id = ?`)
          .bind(km ?? 0, ctx.now, a.p_kind, v.id, ctx.company.id),
      ]);
      await maintenanceAlert(ctx, v.id);
      return { ok: true };
    },
  },

  // Contrôle avant départ (chef de quai ou chauffeur) : une case non cochée lève une alerte.
  lg_vehicle_check: {
    roles: 'member',
    async handler(ctx, a) {
      if (!hasRole(ctx, ['dock_chief']) && !ctx.courierId) fail('forbidden', 403);
      const v = await vehicleFor(ctx, a.p_vehicle);
      const checklist = a.p_checklist && typeof a.p_checklist === 'object' && !Array.isArray(a.p_checklist) ? a.p_checklist : {};
      const bad = Object.entries(checklist).filter(([, val]) => val !== true && val !== 'true').map(([k]) => k);
      const ok = bad.length === 0;
      const km = int(a.p_odometer_km);
      const stmts = [ctx.db.prepare('INSERT INTO vehicle_logs (id, company_id, vehicle_id, trip_id, kind, odometer_km, checklist, ok, note, photos, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(uuid(), ctx.company.id, v.id, a.p_trip || null, 'checklist', km, JSON.stringify(checklist), ok ? 1 : 0, text(a.p_note, 500),
          JSON.stringify(Array.isArray(a.p_photos) ? a.p_photos.map(String).slice(0, 6) : []), ctx.user.id)];
      if (km != null) stmts.push(ctx.db.prepare('UPDATE vehicles SET odometer_km = max(coalesce(odometer_km, 0), ?), updated_at = ? WHERE id = ? AND company_id = ?').bind(km, ctx.now, v.id, ctx.company.id));
      if (!ok) stmts.push(alertStatement(ctx, ctx.company.id, 'overload', 'warning', `Contrôle véhicule non conforme (${v.plate}) : ${bad.join(', ')}`,
        { trip: a.p_trip || null, dedupe: `check:${v.id}:${today(ctx)}` }));
      await ctx.db.batch(stmts);
      return { ok: true, conform: ok };
    },
  },

  // Adresse et position de collecte d'un vendeur (lui-même, ou l'administrateur pour un membre).
  lg_member_location: {
    roles: 'member',
    async handler(ctx, a) {
      const user = a.p_user || ctx.user.id;
      if (user !== ctx.user.id && !fleetRoles(ctx) && !ctx.isAdmin) fail('forbidden', 403);
      const lat = num(a.p_lat); const lng = num(a.p_lng);
      if ((lat == null) !== (lng == null) || (lat != null && (Math.abs(lat) > 90 || Math.abs(lng) > 180))) fail('invalid_position');
      const r = await ctx.db.prepare('UPDATE members SET address = coalesce(?, address), lat = coalesce(?, lat), lng = coalesce(?, lng) WHERE company_id = ? AND user_id = ?')
        .bind(text(a.p_address, 200), lat, lng, ctx.company.id, user).run();
      if (!r.meta.changes) fail('unknown_user', 404);
      return { ok: true };
    },
  },
};
