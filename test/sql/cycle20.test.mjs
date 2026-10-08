// Cycle 20 : retour de tournée — écart signalé à la clôture, colis attendus au quai, alerte levée au dernier scan.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, U } from '../helpers/db.mjs';
import { runScenario } from '../../src/demo/scenario.js';

let t; let A; let codes;
before(async () => {
  t = await createDb();
  [A] = (await runScenario((n, a, uid) => t.rpc(uid ?? null, n, a), (q, p) => t.db.query(q, p))).trips;
});

test('clôture avec des colis non livrés : alerte immédiate avec leurs codes, liste du quai', async () => {
  codes = (await t.one('select public.lg_trip_unreturned($1) c', [A])).c;
  assert.ok(codes.length >= 1, 'au moins le colis en échec de la démo');
  await t.as(null);
  await t.db.query("update lg_trips set status = 'completed', ended_at = now() where id = $1", [A]);
  const a = await t.one("select severity, message, acked_at from lg_alerts where dedupe_key = $1", ['return:' + A]);
  assert.equal(a.severity, 'warning');
  for (const c of codes) assert.ok(a.message.includes(c), c);
  const exp = await t.rpc(U.dock, 'lg_returns_expected', {});
  assert.deepEqual(exp.find((x) => x.trip_id === A).codes, codes);
  await assert.rejects(t.rpc(U.driver, 'lg_returns_expected', {}), /forbidden/);
});

test('rescan au quai par une autre personne : l\'alerte se lève au dernier colis', async () => {
  for (const [i, c] of codes.entries()) {
    const r = await t.rpc(U.dock, 'lg_return_hub', { p_code: c, p_event: t.ev() });
    assert.equal(r.ok, true, JSON.stringify(r));
    const acked = (await t.one('select acked_at from lg_alerts where dedupe_key = $1', ['return:' + A])).acked_at;
    assert.equal(acked !== null, i === codes.length - 1, `levée seulement après le dernier (${i + 1}/${codes.length})`);
  }
  assert.ok(!(await t.rpc(U.dock, 'lg_returns_expected', {})).some((x) => x.trip_id === A));
});

test('voyage clos sans rien à rapporter : pas d\'alerte', async () => {
  const B = (await t.one("select id from lg_trips where id <> $1 order by created_at limit 1", [A])).id;
  await t.as(null);
  await t.db.query("update lg_trip_packages set outcome = 'delivered' where trip_id = $1", [B]);
  await t.db.query("update lg_packages set status = 'delivered', holder_type = 'customer' where id in (select package_id from lg_trip_packages where trip_id = $1)", [B]);
  await t.db.query("update lg_trips set status = 'completed', ended_at = now() where id = $1", [B]);
  assert.equal((await t.one("select count(*)::int n from lg_alerts where dedupe_key = $1", ['return:' + B])).n, 0);
});
