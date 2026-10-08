// Cycle 11 : plusieurs quais — affectation par voyage, file d'attente des véhicules, temps moyens.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, makeOrder, U, IDS } from '../helpers/db.mjs';

let t; let A; let B; let C;
const Q = { q1: '60000000-0000-4000-a000-000000000001', q2: '60000000-0000-4000-a000-000000000002' };
before(async () => {
  t = await createDb();
  A = (await t.rpc(U.dispatcher, 'lg_trip_create', { p_vehicle: IDS.van, p_courier: IDS.courier, p_label: 'A' })).trip_id;
  B = (await t.rpc(U.dispatcher, 'lg_trip_create', { p_vehicle: IDS.moto, p_courier: IDS.courier2, p_label: 'B' })).trip_id;
});

test('file d\'attente : le chauffeur signale son arrivée et voit sa place', async () => {
  await assert.rejects(t.rpc(U.driver2, 'lg_dock_checkin', { p_trip: A }), /forbidden/, 'pas le voyage d\'un autre');
  assert.equal((await t.rpc(U.driver, 'lg_dock_checkin', { p_trip: A })).ok, true);
  await t.rpc(U.driver2, 'lg_dock_checkin', { p_trip: B });
  assert.equal((await t.rpc(U.driver2, 'lg_trip_dock', { p_trip: B })).position, 2, 'arrivé après A');
  const board = await t.rpc(U.dock, 'lg_dock_board', {});
  assert.deepEqual(board.queue.map((q) => q.trip_id), [A, B]);
  assert.equal(board.docks.length, 3);
});

test('affectation : un quai n\'accueille qu\'un voyage à la fois, libre au départ', async () => {
  assert.equal((await t.rpc(U.dock, 'lg_dock_assign', { p_trip: A, p_dock: Q.q1 })).dock, 'Q1');
  const busy = await t.rpc(U.dock, 'lg_dock_assign', { p_trip: B, p_dock: Q.q1 });
  assert.equal(busy.error, 'dock_busy');
  // sans quai précisé : le premier quai libre
  assert.equal((await t.rpc(U.dispatcher, 'lg_dock_assign', { p_trip: B })).dock, 'Q2');
  const d = await t.rpc(U.driver, 'lg_trip_dock', { p_trip: A });
  assert.deepEqual([d.dock, d.position], ['Q1', null]);
  const board = await t.rpc(U.dock, 'lg_dock_board', {});
  assert.equal(board.queue.length, 0);
  assert.equal(board.docks.find((k) => k.code === 'Q1').trip.id, A);
  assert.equal(board.docks.find((k) => k.code === 'Q3').trip, null);
  await assert.rejects(t.rpc(U.driver, 'lg_dock_assign', { p_trip: A, p_dock: Q.q1 }), /forbidden/);
  // le voyage A annulé libère Q1
  await t.rpc(U.dispatcher, 'lg_trip_cancel', { p_trip: A, p_reason: 'test' });
  assert.equal((await t.rpc(U.dock, 'lg_dock_board', {})).docks.find((k) => k.code === 'Q1').trip, null);
});

test('temps moyens : attente avant quai et chargement par quai', async () => {
  C = (await t.rpc(U.dispatcher, 'lg_trip_create', { p_vehicle: IDS.tricycle, p_courier: IDS.courier, p_label: 'C' })).trip_id;
  await t.rpc(U.dock, 'lg_dock_checkin', { p_trip: C });
  await t.rpc(U.dock, 'lg_dock_assign', { p_trip: C, p_dock: Q.q1 });
  const order = await makeOrder(t, { method: 'mobile', paid: true });
  await t.as(null);
  await t.db.query("update lg_trips set dock_queued_at = dock_assigned_at - interval '12 minutes' where id = $1", [C]);
  // chargement simulé : un colis chargé, scellé 25 min après
  const pkg = await t.one(`insert into lg_packages (code, order_id, status) values ('NXP-TEST-0001', $1, 'loaded') returning id`, [order]);
  await t.db.query("insert into lg_trip_packages (trip_id, package_id, loaded_at) values ($1, $2, now() - interval '25 minutes')", [C, pkg.id]);
  await t.db.query("update lg_trips set status = 'in_progress', sealed_at = now() where id = $1", [C]);
  const board = await t.rpc(U.dock, 'lg_dock_board', {});
  assert.equal(Number(board.avg_wait_min), 4, 'A et B affectés aussitôt arrivés (0 min), C après 12 min : (0 + 0 + 12) / 3');
  assert.equal(Number(board.docks.find((k) => k.code === 'Q1').avg_loading_min), 25);
  assert.equal(board.docks.find((k) => k.code === 'Q1').trip, null, 'parti : quai libre');
  assert.equal((await t.rpc(U.dock, 'lg_dock_checkin', { p_trip: C })).error, 'trip_started');
});
