// Cycle 3 : planification automatique (simulation puis création) et double contrôle.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, makeOrder, U, IDS } from '../helpers/db.mjs';

let t;
// prépare une commande jusqu'au quai, comme le ferait un préparateur
async function prepare(order, { stage = true } = {}) {
  const task = (await t.one('select id from lg_pick_tasks where order_id = $1', [order])).id;
  await t.rpc(U.picker, 'lg_pick_take', { p_task: task });
  const d = await t.rpc(U.picker, 'lg_pick_task_detail', { p_task: task });
  for (const l of d.lines) for (let q = 0; q < l.qty_ordered; q++) {
    await t.rpc(U.picker, 'lg_pick_scan', l.barcode ? { p_task: task, p_code: l.barcode, p_event: t.ev() }
      : { p_task: task, p_code: '', p_event: t.ev(), p_manual: true, p_line: l.id });
  }
  const w = d.lines.reduce((s, l) => s + (l.weight_g ?? 500) * l.qty_ordered, 0);
  const code = (await t.rpc(U.picker, 'lg_pack', { p_task: task, p_event: t.ev(), p_packages: [{ weight_g: w }] })).packages[0].code;
  if (stage) assert.equal((await t.rpc(U.picker, 'lg_stage', { p_code: code, p_event: t.ev() })).ok, true);
  return code;
}

before(async () => { t = await createDb(); });

test('planification automatique : simulation sans effet, puis voyages créés et commandes toutes affectées', async () => {
  const spots = [['Rufisque', 14.716, -17.27], ['Bargny', 14.695, -17.225], ['Pikine', 14.755, -17.39], ['Yoff', 14.755, -17.473],
    ['Ouakam', 14.722, -17.49], ['Médina', 14.683, -17.454]];
  const orders = [];
  for (const [city, lat, lng] of spots) {
    const o = await makeOrder(t, { method: 'mobile', paid: true, lines: [[IDS.rice, 1]], city, lat, lng });
    await prepare(o); orders.push(o);
  }
  const sim = await t.rpc(U.dispatcher, 'lg_autoplan_run', { p_apply: false });
  assert.equal(sim.applied, false);
  assert.equal(sim.trips.reduce((s, x) => s + x.orders.length, 0), 6);
  assert.equal((await t.one('select count(*)::int n from lg_trips')).n, 0, 'la simulation ne crée rien');
  assert.ok(sim.trips[0].fill_pct >= 0 && sim.trips[0].label);
  await assert.rejects(t.rpc(U.picker, 'lg_autoplan_run', { p_apply: false }), /forbidden/);

  const run = await t.rpc(U.dispatcher, 'lg_autoplan_run', { p_apply: true });
  assert.equal(run.created.length, sim.trips.length);
  const assigned = await t.all(`select distinct p.order_id from lg_trip_packages tp join lg_packages p on p.id = tp.package_id where tp.outcome is null`);
  assert.equal(assigned.length, 6);
  // l'ordre des arrêts a été calculé (rangs 1..n sans trou)
  const seqs = await t.all('select trip_id, array_agg(seq order by seq) s from lg_trip_stops group by trip_id');
  for (const r of seqs) assert.deepEqual(r.s, r.s.map((_, i) => i + 1));
  const again = await t.rpc(U.dispatcher, 'lg_autoplan_run', { p_apply: false });
  assert.equal(again.trips.length, 0, 'plus rien à planifier');
});

test('planification automatique : le plafond d\'espèces répartit le paiement à la livraison sur plusieurs véhicules', async () => {
  const t2 = t; t = await createDb();
  await t.rpc(U.admin, 'lg_set_config', { p: { cash_limit_fcfa: 12000 } });
  for (const [city, lat, lng] of [['Yoff', 14.755, -17.473], ['Ouakam', 14.722, -17.49], ['Mermoz', 14.708, -17.475]]) {
    const o = await makeOrder(t, { method: 'cod', lines: [[IDS.rice, 1]], city, lat, lng });
    await t.rpc(U.support, 'lg_confirm_cod', { p_order: o });
    await prepare(o);
  }
  const sim = await t.rpc(U.dispatcher, 'lg_autoplan_run', { p_apply: false });
  for (const tr of sim.trips) assert.ok(tr.cod <= 12000, `${tr.plate} porterait ${tr.cod} F`);
  assert.ok(sim.trips.length + sim.unassigned.length >= 2, 'impossible de tout mettre dans un seul véhicule');
  t = t2;
});

test('double contrôle : au-delà du seuil, mise à quai refusée tant qu\'une autre personne n\'a pas contrôlé', async () => {
  await t.rpc(U.admin, 'lg_set_config', { p: { double_check_fcfa: 5000 } });
  const o = await makeOrder(t, { method: 'mobile', paid: true, lines: [[IDS.fan, 1]] });
  const code = await prepare(o, { stage: false });
  assert.equal((await t.one('select check_required from lg_packages where code = $1', [code])).check_required, true);
  assert.equal((await t.rpc(U.picker, 'lg_stage', { p_code: code, p_event: t.ev() })).error, 'double_check_required');
  assert.equal((await t.rpc(U.picker, 'lg_double_check', { p_code: code, p_event: t.ev() })).error, 'same_person');
  assert.equal((await t.rpc(U.dock, 'lg_double_check', { p_code: code, p_event: t.ev() })).ok, true);
  assert.equal((await t.rpc(U.picker, 'lg_stage', { p_code: code, p_event: t.ev() })).ok, true);
  // un écart constaté ouvre un incident au lieu de valider
  const o2 = await makeOrder(t, { method: 'mobile', paid: true, lines: [[IDS.fan, 1]] });
  const c2 = await prepare(o2, { stage: false });
  const ko = await t.rpc(U.dock, 'lg_double_check', { p_code: c2, p_event: t.ev(), p_ok: false, p_note: 'Ventilateur manquant' });
  assert.equal(ko.incident, true);
  assert.equal((await t.rpc(U.picker, 'lg_stage', { p_code: c2, p_event: t.ev() })).error, 'double_check_required');
});

test('numéros de voyage et d\'incident consécutifs', async () => {
  const n = (await t.all('select number from lg_trips order by number')).map((r) => r.number);
  assert.deepEqual(n, n.map((_, i) => i + 1));
});
