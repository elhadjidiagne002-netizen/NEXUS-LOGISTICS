// Cycle 13 : coûts — par véhicule (au km, par colis), marge par zone, coût des échecs.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, U, IDS } from '../helpers/db.mjs';
import { runScenario } from '../../src/demo/scenario.js';

let t; let A;
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Dakar' });
before(async () => {
  t = await createDb();
  const r = await runScenario((n, a, uid) => t.rpc(uid ?? null, n, a), (q, p) => t.db.query(q, p));
  [A] = r.trips;
  await t.as(null);
  await t.db.query(`insert into lg_trip_expenses (trip_id, kind, amount_fcfa, status) values ($1, 'carburant', 5000, 'approved'), ($1, 'peage', 700, 'rejected')`, [A]);
  await t.db.query(`insert into lg_vehicle_logs (vehicle_id, kind, cost_fcfa) values ($1, 'vidange', 3000)`, [IDS.van]);
  await t.db.query("update lg_trips set distance_km = 40 where id = $1", [A]);
  await t.db.query("insert into courier_earnings (courier_id, amount, type) values ($1, 2000, 'delivery')", [IDS.courier]);
});

test('totaux : dépenses non rejetées + entretien + paie ; coût par présentation, par livraison, des échecs', async () => {
  const c = await t.rpc(U.accountant, 'lg_costs', { p_from: today, p_to: today });
  const pay = Number((await t.one("select coalesce(sum(amount), 0) s from courier_earnings where type in ('delivery', 'bonus')")).s);
  const exp = Number((await t.one("select coalesce(sum(amount_fcfa), 0) s from lg_trip_expenses where status <> 'rejected'")).s);
  const k = c.totals;
  assert.ok(exp >= 5000 + 6000, 'notre carburant + le plein de la démo');
  assert.deepEqual([k.expenses_fcfa, k.maintenance_fcfa, k.driver_pay_fcfa], [exp, 3000, pay], 'la dépense rejetée (700) ne compte pas');
  assert.equal(k.cost_fcfa, exp + 3000 + pay);
  assert.equal(k.cost_per_presentation_fcfa, Math.round(k.cost_fcfa / k.presentations));
  assert.equal(k.failure_cost_fcfa, Math.round(k.cost_fcfa * k.failed / k.presentations));
  assert.equal(k.margin_fcfa, k.revenue_fcfa - k.cost_fcfa);
  await assert.rejects(t.rpc(U.support, 'lg_costs', { p_from: today, p_to: today }), /forbidden/);
});

test('par véhicule : coût au km et par colis ; par zone : la somme des coûts répartis redonne le total', async () => {
  const c = await t.rpc(U.dispatcher, 'lg_costs', { p_from: today, p_to: today });
  const van = c.by_vehicle.find((v) => v.vehicle_id === IDS.van);
  assert.ok(van.expenses_fcfa >= 5000 && van.maintenance_fcfa === 3000);
  assert.equal(van.cost_fcfa, van.expenses_fcfa + van.maintenance_fcfa + van.driver_pay_fcfa);
  if (van.km > 0) assert.equal(van.cost_per_km_fcfa, Math.round(van.cost_fcfa / van.km));
  if (van.delivered > 0) assert.equal(van.cost_per_package_fcfa, Math.round(van.cost_fcfa / van.delivered));
  const zoneCost = c.by_zone.reduce((n, z) => n + z.cost_fcfa, 0);
  assert.ok(Math.abs(zoneCost - c.totals.cost_fcfa) <= c.by_zone.length, 'arrondis près');
  assert.ok(c.by_zone.every((z) => z.margin_fcfa === z.revenue_fcfa - z.cost_fcfa));
});
