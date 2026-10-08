// Cycle 7 : productivité de la préparation — lignes par heure, erreurs, ruptures par vendeur, emballages.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, makeOrder, U, IDS } from '../helpers/db.mjs';

let t;
before(async () => { t = await createDb(); });

const taskOf = async (o) => (await t.one('select id from lg_pick_tasks where order_id = $1', [o])).id;

test('productivité : lignes par heure, mauvais scans, ruptures, emballages', async () => {
  // commande 1 : 2 lignes complètes ; commande 2 : savon prélevé, œufs en rupture, un mauvais produit scanné
  const o1 = await makeOrder(t, { method: 'mobile', paid: true, lines: [[IDS.rice, 2], [IDS.oil, 1]] });
  const o2 = await makeOrder(t, { method: 'mobile', paid: true, lines: [[IDS.soap, 1], [IDS.eggs, 1]] });
  const [t1, t2] = [await taskOf(o1), await taskOf(o2)];
  await t.rpc(U.picker, 'lg_pick_take', { p_task: t1 });
  for (const c of ['RIZ-5', 'RIZ-5', 'HUI-1']) await t.rpc(U.picker, 'lg_pick_scan', { p_task: t1, p_code: c, p_event: t.ev() });
  await t.rpc(U.picker, 'lg_pack', { p_task: t1, p_event: t.ev(), p_packages: [{ weight_g: 6200, length_cm: 30, width_cm: 20, height_cm: 10 }] });

  await t.rpc(U.picker, 'lg_pick_take', { p_task: t2 });
  assert.equal((await t.rpc(U.picker, 'lg_pick_scan', { p_task: t2, p_code: 'RIZ-5', p_event: t.ev() })).error, 'unexpected_product');
  await t.rpc(U.picker, 'lg_pick_scan', { p_task: t2, p_code: '6111234500048', p_event: t.ev() });
  const eggs = (await t.one('select id from lg_pick_lines where task_id = $1 and product_id = $2', [t2, IDS.eggs])).id;
  await t.rpc(U.picker, 'lg_pick_short', { p_task: t2, p_line: eggs, p_qty_found: 0, p_event: t.ev() });
  await t.rpc(U.picker, 'lg_pack', { p_task: t2, p_event: t.ev(), p_packages: [{ weight_g: 900 }] });

  const r0 = await t.rpc(U.dock, 'lg_pick_productivity', {});
  assert.equal(r0.totals.lines_per_hour, null, 'préparé en quelques millisecondes : pas de cadence aberrante');
  assert.equal(r0.pickers[0].lines_per_hour, null);

  // durées maîtrisées : 30 min par commande
  await t.as(null);
  await t.db.query("update lg_pick_tasks set started_at = done_at - interval '30 minutes' where id = any($1)", [[t1, t2]]);
  const r = await t.rpc(U.dock, 'lg_pick_productivity', {});
  const p = r.pickers.find((x) => x.picker_id === U.picker);
  assert.deepEqual([p.orders, p.lines, p.units, p.minutes, Number(p.lines_per_hour)], [2, 4, 4, 60, 4]);
  assert.deepEqual([Number(p.short_pct), p.wrong_scans, Number(p.error_pct)], [25, 1, 25]);
  assert.equal(Number(r.vendors[0].short_pct), 25);
  assert.deepEqual(r.packaging.map((x) => [x.size, x.count]), [['medium', 1], ['unmeasured', 1]]);
  assert.deepEqual([r.totals.orders, r.totals.lines, Number(r.totals.hours), r.totals.packages], [2, 4, 1, 2]);
  await assert.rejects(t.rpc(U.picker, 'lg_pick_productivity', {}), /forbidden/);
});

test('productivité : une vague compte une seule fois son temps', async () => {
  const ids = [];
  for (const lines of [[[IDS.oil, 1]], [[IDS.oil, 1]]]) ids.push(await taskOf(await makeOrder(t, { method: 'mobile', paid: true, lines })));
  const w = await t.rpc(U.picker, 'lg_wave_create', { p_tasks: ids });
  for (let i = 0; i < 2; i++) await t.rpc(U.picker, 'lg_wave_scan', { p_wave: w.wave_id, p_code: 'HUI-1', p_event: t.ev() });
  for (const id of ids) await t.rpc(U.picker, 'lg_pack', { p_task: id, p_event: t.ev(), p_packages: [{ weight_g: 1000 }] });
  await t.as(null);
  await t.db.query("update lg_pick_tasks set started_at = now() - interval '20 minutes', done_at = now() where id = any($1)", [ids]);
  const r = await t.rpc(U.dock, 'lg_pick_productivity', {});
  const p = r.pickers.find((x) => x.picker_id === U.picker);
  assert.equal(p.minutes, 80, '60 min des deux commandes précédentes + 20 min pour la vague (et non 40)');
});
