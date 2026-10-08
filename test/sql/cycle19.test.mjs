// Cycle 19 : entretien préventif au kilométrage + cadence « colis par heure » protégée.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, U, IDS } from '../helpers/db.mjs';
import { runScenario } from '../../src/demo/scenario.js';

let t; let A;
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Dakar' });
before(async () => {
  t = await createDb();
  [A] = (await runScenario((n, a, uid) => t.rpc(uid ?? null, n, a), (q, p) => t.db.query(q, p))).trips;
});

test('colis par heure : pas de cadence aberrante quand les tournées ont duré quelques secondes', async () => {
  const k = (await t.rpc(U.dispatcher, 'lg_kpis', { p_from: today, p_to: today })).kpis;
  assert.equal(k.packages_per_hour, null, 'journée de démo jouée en quelques secondes');
  await t.as(null);
  await t.db.query("update lg_trips set started_at = now() - interval '2 hours' where id = $1", [A]);
  const k2 = (await t.rpc(U.dispatcher, 'lg_kpis', { p_from: today, p_to: today })).kpis;
  assert.ok(Number(k2.packages_per_hour) > 0 && Number(k2.packages_per_hour) < 50);
});

test('entretien : échéance au carnet, kilométrage estimé avec les voyages, alerte bientôt puis dépassée', async () => {
  const flt = async () => (await t.rpc(U.dock, 'lg_fleet', {})).find((v) => v.id === IDS.van).maintenance;
  assert.equal(await flt(), null, 'rien de prévu au carnet');
  // relevé au compteur actuel (km0), vidange prévue 300 km plus loin
  const km0 = (await t.one('select public.lg_vehicle_km_estimate($1) k', [IDS.van])).k + 50;
  await t.rpc(U.dock, 'lg_log_maintenance', { p_vehicle: IDS.van, p_kind: 'vidange', p_odometer_km: km0, p_cost_fcfa: 15000,
    p_note: 'Vidange', p_next_due_km: km0 + 300 });
  let m = await flt();
  assert.deepEqual([m.due_km, m.km, m.state], [km0 + 300, km0, 'soon'], 'à 300 km : dans la fenêtre de 500 km');
  let alert = await t.one(`select severity, message from lg_alerts where kind = 'maintenance_due' and dedupe_key like 'maint:${IDS.van}%' order by id desc limit 1`);
  assert.equal(alert.severity, 'info');
  assert.match(alert.message, /vidange dans 300 km/);
  // le voyage A roule 400 km et se clôt : échéance dépassée
  await t.as(null);
  await t.db.query("update lg_trips set distance_km = 400, started_at = now() where id = $1", [A]);
  await t.db.query("update lg_trips set status = 'completed' where id = $1", [A]);
  m = await flt();
  assert.deepEqual([m.km, m.state, m.remaining_km], [km0 + 400, 'overdue', -100]);
  alert = await t.one(`select severity, message from lg_alerts where kind = 'maintenance_due' and dedupe_key like 'maint:${IDS.van}%' order by id desc limit 1`);
  assert.deepEqual([alert.severity, /dépassé de 100 km/.test(alert.message)], ['warning', true]);
  assert.equal((await t.one(`select count(*)::int n from lg_alerts where kind = 'maintenance_due' and dedupe_key like 'maint:${IDS.van}%'`)).n, 2, 'une alerte par état, sans doublon');
  // vidange faite : nouvelle échéance, plus d'alerte nouvelle
  await t.rpc(U.dock, 'lg_log_maintenance', { p_vehicle: IDS.van, p_kind: 'vidange', p_odometer_km: km0 + 420, p_cost_fcfa: 15000, p_note: 'Faite', p_next_due_km: km0 + 5420 });
  assert.equal((await flt()).state, 'ok');
  assert.equal((await t.one(`select count(*)::int n from lg_alerts where kind = 'maintenance_due' and dedupe_key like 'maint:${IDS.van}%'`)).n, 2);
});
