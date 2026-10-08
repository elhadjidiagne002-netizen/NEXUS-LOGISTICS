// Cycle 21 : arrivée détectée automatiquement par la position GPS du chauffeur.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, U } from '../helpers/db.mjs';
import { runScenario } from '../../src/demo/scenario.js';

let t; let A; let s;
before(async () => {
  t = await createDb();
  [A] = (await runScenario((n, a, uid) => t.rpc(uid ?? null, n, a), (q, p) => t.db.query(q, p))).trips;
  await t.as(null);
  s = await t.one("select id, lat, lng, seq from lg_trip_stops where trip_id = $1 and status = 'en_route' order by seq limit 1", [A]);
});

test('loin de l\'arrêt, ou GPS imprécis : rien ne change', async () => {
  assert.ok(s, 'un arrêt en cours dans la journée de démo');
  const far = await t.rpc(U.driver, 'lg_driver_ping', { p_lat: s.lat + 0.01, p_lng: s.lng, p_accuracy_m: 15 });
  assert.equal(far.arrived_stop, undefined);
  const vague = await t.rpc(U.driver, 'lg_driver_ping', { p_lat: s.lat, p_lng: s.lng, p_accuracy_m: 400 });
  assert.equal(vague.arrived_stop, undefined, 'précision de 400 m : on ne conclut pas');
  assert.equal((await t.one('select status from lg_trip_stops where id = $1', [s.id])).status, 'en_route');
});

test('à 40 m avec un GPS précis : arrivée enregistrée toute seule', async () => {
  const r = await t.rpc(U.driver, 'lg_driver_ping', { p_lat: s.lat + 0.00035, p_lng: s.lng, p_accuracy_m: 12 });
  assert.equal(r.arrived_stop, s.id);
  const st = await t.one('select status, arrived_at, arrived_auto from lg_trip_stops where id = $1', [s.id]);
  assert.deepEqual([st.status, st.arrived_auto, st.arrived_at !== null], ['arrived', true, true]);
  // ping suivant : déjà arrivé, rien de plus
  assert.equal((await t.rpc(U.driver, 'lg_driver_ping', { p_lat: s.lat, p_lng: s.lng, p_accuracy_m: 10 })).arrived_stop, undefined);
});

test('réglage à 0 : détection désactivée', async () => {
  await t.rpc(U.admin, 'lg_set_config', { p: { auto_arrive_m: 0 } });
  await t.as(null);
  await t.db.query("update lg_trip_stops set status = 'en_route', arrived_at = null, arrived_auto = false where id = $1", [s.id]);
  assert.equal((await t.rpc(U.driver, 'lg_driver_ping', { p_lat: s.lat, p_lng: s.lng, p_accuracy_m: 10 })).arrived_stop, undefined);
});
