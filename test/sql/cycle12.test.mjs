// Cycle 12 : tableaux par axe — mêmes totaux que les indicateurs, découpés par zone, vendeur, chauffeur…
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, U } from '../helpers/db.mjs';
import { runScenario } from '../../src/demo/scenario.js';

let t;
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Dakar' });
before(async () => {
  t = await createDb();
  await runScenario((n, a, uid) => t.rpc(uid ?? null, n, a), (q, p) => t.db.query(q, p));
});

test('chaque axe redonne les totaux de lg_kpis (livrés, échecs)', async () => {
  const k = (await t.rpc(U.dispatcher, 'lg_kpis', { p_from: today, p_to: today })).kpis;
  assert.ok(k.delivered > 0 && k.failed > 0, 'la journée de démo a des livraisons et un échec');
  for (const axis of ['zone', 'vendor', 'courier', 'vehicle', 'weekday', 'hour']) {
    const r = await t.rpc(U.accountant, 'lg_kpis_by_axis', { p_axis: axis, p_from: today, p_to: today });
    const sum = (f) => r.rows.reduce((n, x) => n + x[f], 0);
    assert.deepEqual([sum('delivered'), sum('failed')], [k.delivered, k.failed], axis);
    assert.ok(r.rows.every((x) => x.presentations === x.delivered + x.failed));
  }
});

test('libellés : jour de la semaine en français, heures, chauffeurs nommés', async () => {
  const wd = await t.rpc(U.support, 'lg_kpis_by_axis', { p_axis: 'weekday', p_from: today, p_to: today });
  const name = new Date().toLocaleDateString('fr-FR', { weekday: 'long', timeZone: 'Africa/Dakar' });
  assert.deepEqual(wd.rows.map((x) => x.label), [name]);
  const h = await t.rpc(U.support, 'lg_kpis_by_axis', { p_axis: 'hour', p_from: today, p_to: today });
  assert.ok(h.rows.every((x) => /^\d\d h$/.test(x.label)));
  const c = await t.rpc(U.support, 'lg_kpis_by_axis', { p_axis: 'courier', p_from: today, p_to: today });
  assert.ok(c.rows.every((x) => x.key !== '—'), 'chaque présentation rattachée à un chauffeur');
  await assert.rejects(t.rpc(U.support, 'lg_kpis_by_axis', { p_axis: 'couleur', p_from: today, p_to: today }), /invalid_axis/);
  await assert.rejects(t.rpc(U.driver, 'lg_kpis_by_axis', { p_axis: 'zone', p_from: today, p_to: today }), /forbidden/);
});
