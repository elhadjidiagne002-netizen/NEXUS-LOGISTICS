// Cycle 4 : entrepôt — emplacements, chemin de prélèvement, vague, inventaire tournant.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, makeOrder, U, IDS } from '../helpers/db.mjs';

let t;
const qtyAt = async (product, code) => (await t.one(`select pl.qty from lg_product_locations pl join lg_stock_locations l on l.id = pl.location_id
  where pl.product_id = $1 and l.code = $2`, [product, code]))?.qty;
before(async () => { t = await createDb(); });

test('chemin de prélèvement : lignes triées par emplacement, prélèvement déduit du rayon', async () => {
  const o = await makeOrder(t, { method: 'mobile', paid: true, lines: [[IDS.soap, 1], [IDS.rice, 1], [IDS.eggs, 1]] });
  const task = (await t.one('select id from lg_pick_tasks where order_id = $1', [o])).id;
  const d = await t.rpc(U.picker, 'lg_pick_task_detail', { p_task: task });
  assert.deepEqual(d.lines.map((l) => l.location), ['A-01-1', 'A-10-2', 'B-03-1'], 'A-01 avant A-10 (tri naturel) avant B');
  await t.rpc(U.picker, 'lg_pick_take', { p_task: task });
  await t.rpc(U.picker, 'lg_pick_scan', { p_task: task, p_code: 'RIZ-5', p_event: t.ev() });
  assert.equal(await qtyAt(IDS.rice, 'A-01-1'), 29);
});

test('rangement et recherche : « où est ce produit ? »', async () => {
  const r = await t.rpc(U.dock, 'lg_put_away', { p_product_code: '6111234500024', p_location_code: 'c-01-0', p_qty: 12, p_event: t.ev() });
  assert.deepEqual([r.ok, r.location, r.qty], [true, 'C-01-0', 12]);
  assert.equal((await t.rpc(U.dock, 'lg_put_away', { p_product_code: 'inconnu', p_location_code: 'C-01-0', p_qty: 1, p_event: t.ev() })).error, 'unknown_product');
  const f = await t.rpc(U.picker, 'lg_product_find', { p_q: 'huile' });
  assert.deepEqual(f[0].locations.map((x) => x.code), ['A-02-1', 'C-01-0']);
  await assert.rejects(t.rpc(U.driver, 'lg_product_find', { p_q: 'huile' }), /forbidden/);
});

test('vague : 3 commandes en un passage, chaque scan indique le bac de la commande', async () => {
  const ids = [];
  for (const lines of [[[IDS.oil, 2]], [[IDS.oil, 1], [IDS.soap, 1]], [[IDS.soap, 2]]]) {
    const o = await makeOrder(t, { method: 'mobile', paid: true, lines });
    ids.push((await t.one('select id from lg_pick_tasks where order_id = $1', [o])).id);
  }
  await assert.rejects(t.rpc(U.picker, 'lg_wave_create', { p_tasks: [ids[0]] }), /wave_size/);
  const w = await t.rpc(U.picker, 'lg_wave_create', { p_tasks: ids });
  assert.equal(w.bins, 3);
  const det = await t.rpc(U.picker, 'lg_wave_detail', { p_wave: w.wave_id });
  assert.deepEqual(det.products.map((p) => [p.name, p.ordered]), [['Huile 1 L', 3], ['Savon de Marseille x4', 3]], 'groupé par produit, ordre des rayons');
  const bins = [];
  for (let i = 0; i < 3; i++) bins.push((await t.rpc(U.picker, 'lg_wave_scan', { p_wave: w.wave_id, p_code: 'HUI-1', p_event: t.ev() })).bin);
  assert.deepEqual(bins, [1, 1, 2], 'les 2 huiles du bac 1, puis celle du bac 2');
  assert.equal((await t.rpc(U.picker, 'lg_wave_scan', { p_wave: w.wave_id, p_code: 'HUI-1', p_event: t.ev() })).error, 'line_complete');
  assert.equal((await t.rpc(U.picker, 'lg_wave_scan', { p_wave: w.wave_id, p_code: 'RIZ-5', p_event: t.ev() })).error, 'unexpected_product');
  let last;
  for (let i = 0; i < 3; i++) last = await t.rpc(U.picker, 'lg_wave_scan', { p_wave: w.wave_id, p_code: '6111234500048', p_event: t.ev() });
  assert.equal(last.wave_done, true);
  // ensuite chaque commande se ferme normalement
  const p = await t.rpc(U.picker, 'lg_pack', { p_task: ids[1], p_event: t.ev(), p_packages: [{ weight_g: 1600 }] });
  assert.equal(p.ok, true);
  assert.equal((await t.rpc(U.picker, 'lg_my_waves', {})).length, 1, 'deux bacs restent à emballer');
});

test('inventaire tournant : emplacements jamais comptés d\'abord, écart corrige rayon et stock du site', async () => {
  const today = await t.rpc(U.picker, 'lg_inventory_today', { p_limit: 3 });
  assert.equal(today.length, 3);
  assert.ok(today.every((l) => l.last_counted_at === null));
  const loc = today.find((l) => l.code === 'A-10-2');
  const stockBefore = (await t.one('select stock from products where id = $1', [IDS.eggs])).stock;
  const r = await t.rpc(U.picker, 'lg_inventory_count', { p_location: loc.id, p_event: t.ev(),
    p_counts: [{ product_id: IDS.eggs, counted: loc.contents[0].expected - 2, reason: 'casse' }] });
  assert.equal(r.gap_units, 2);
  assert.equal((await t.one('select stock from products where id = $1', [IDS.eggs])).stock, stockBefore - 2);
  const hist = await t.rpc(U.dock, 'lg_inventory_history', {});
  assert.equal(hist[0].gap, -2);
  const next = await t.rpc(U.picker, 'lg_inventory_today', { p_limit: 10 });
  assert.equal(next.at(-1).code, 'A-10-2', 'l\'emplacement compté passe en dernier');
});
