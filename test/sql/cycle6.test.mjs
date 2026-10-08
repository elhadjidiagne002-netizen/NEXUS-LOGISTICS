// Cycle 6 : lots et dates de péremption — rangement par lot, FEFO, rebut, traçabilité.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, makeOrder, U, IDS } from '../helpers/db.mjs';

let t;
const day = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Africa/Dakar' });
const lot = async (code) => t.one('select * from lg_stock_lots where lot_code = $1', [code]);
const qtyAt = async (product, code) => (await t.one(`select pl.qty from lg_product_locations pl join lg_stock_locations l on l.id = pl.location_id
  where pl.product_id = $1 and l.code = $2`, [product, code]))?.qty;
let order;
before(async () => { t = await createDb(); });

test('rangement par lot : lot daté rangé, lot périmé refusé, état « bientôt »', async () => {
  const a = await t.rpc(U.dock, 'lg_put_away', { p_product_code: 'RIZ-5', p_location_code: 'A-01-1', p_qty: 5, p_event: t.ev(), p_lot: 'l-loin', p_expires_on: day(60) });
  assert.deepEqual([a.ok, a.lot, a.state, a.qty], [true, 'L-LOIN', 'ok', 35], 'code de lot normalisé en majuscules');
  const b = await t.rpc(U.dock, 'lg_put_away', { p_product_code: 'RIZ-5', p_location_code: 'A-01-1', p_qty: 5, p_event: t.ev(), p_lot: 'L-PROCHE', p_expires_on: day(10) });
  assert.equal(b.state, 'soon');
  const ev = t.ev();
  const c = await t.rpc(U.dock, 'lg_put_away', { p_product_code: 'RIZ-5', p_location_code: 'A-01-1', p_qty: 2, p_event: ev, p_lot: 'L-VIEUX', p_expires_on: day(-1) });
  assert.equal(c.error, 'expired_lot');
  assert.equal(await qtyAt(IDS.rice, 'A-01-1'), 40, 'le lot périmé n\'est pas entré');
  // même lot rangé deux fois : une seule ligne, quantité cumulée ; rejeu sans doublon
  const ev2 = t.ev();
  await t.rpc(U.dock, 'lg_put_away', { p_product_code: 'RIZ-5', p_location_code: 'A-01-1', p_qty: 1, p_event: ev2, p_lot: 'L-LOIN', p_expires_on: day(60) });
  await t.rpc(U.dock, 'lg_put_away', { p_product_code: 'RIZ-5', p_location_code: 'A-01-1', p_qty: 1, p_event: ev2, p_lot: 'L-LOIN', p_expires_on: day(60) });
  assert.equal((await lot('L-LOIN')).qty, 6);
});

test('prélèvement FEFO : la consigne indique le lot qui périme le premier, et c\'est lui qui sort', async () => {
  order = await makeOrder(t, { method: 'mobile', paid: true, lines: [[IDS.rice, 3]] });
  const task = (await t.one('select id from lg_pick_tasks where order_id = $1', [order])).id;
  const d = await t.rpc(U.picker, 'lg_pick_task_detail', { p_task: task });
  assert.deepEqual([d.lines[0].location, d.lines[0].lot.lot, d.lines[0].lot.state], ['A-01-1', 'L-PROCHE', 'soon']);
  await t.rpc(U.picker, 'lg_pick_take', { p_task: task });
  for (let i = 0; i < 3; i++) await t.rpc(U.picker, 'lg_pick_scan', { p_task: task, p_code: 'RIZ-5', p_event: t.ev() });
  assert.deepEqual([(await lot('L-PROCHE')).qty, (await lot('L-LOIN')).qty], [2, 6]);
  assert.equal(await qtyAt(IDS.rice, 'A-01-1'), 38);
});

test('traçabilité : le lot rappelé mène à la commande et au client', async () => {
  const tr = await t.rpc(U.support, 'lg_lot_trace', { p_lot: 'l-proche' });
  assert.equal(tr.length, 1);
  assert.deepEqual([tr[0].received, tr[0].in_stock, tr[0].orders.length], [5, 2, 1]);
  assert.deepEqual([tr[0].orders[0].order_id, tr[0].orders[0].qty, tr[0].orders[0].customer], [order, 3, 'Awa Diop']);
  assert.equal((await t.rpc(U.support, 'lg_lot_trace', { p_lot: 'L-LOIN' }))[0].orders.length, 0);
  await assert.rejects(t.rpc(U.driver, 'lg_lot_trace', { p_lot: 'L-PROCHE' }), /forbidden/);
});

test('emplacement choisi : un lot valide proche de sa date passe avant le rayon le plus garni, un lot périmé jamais', async () => {
  // huile : 40 non loties en A-02-1 ; 5 d'un lot qui périme dans 5 jours en C-01-0
  await t.rpc(U.dock, 'lg_put_away', { p_product_code: 'HUI-1', p_location_code: 'C-01-0', p_qty: 5, p_event: t.ev(), p_lot: 'H-1', p_expires_on: day(5) });
  const loc = async () => (await t.one('select public.lg_product_location($1) c', [IDS.oil])).c;
  assert.equal(await loc(), 'C-01-0');
  await t.as(null);
  await t.db.query("update lg_stock_lots set expires_on = (now() at time zone 'Africa/Dakar')::date - 1 where lot_code = 'H-1'");
  assert.equal(await loc(), 'A-02-1', 'C-01-0 ne contient plus rien de vendable');
});

test('péremption : liste des lots à surveiller, rebut motivé qui corrige rayon et stock du site', async () => {
  const list = await t.rpc(U.dock, 'lg_lots_expiring', {});
  assert.deepEqual(list.map((l) => [l.lot, l.state]), [['H-1', 'expired'], ['L-PROCHE', 'soon']], 'L-LOIN (60 j) hors fenêtre de 30 j');
  assert.equal((await t.rpc(U.dock, 'lg_lots_expiring', { p_days: 90 })).length, 3);
  // le vendeur ne voit que ses produits (riz et huile sont à lui), un inconnu rien
  assert.equal((await t.rpc(U.vendor, 'lg_lots_expiring', {})).length, 2);
  await assert.rejects(t.rpc(U.stranger, 'lg_lots_expiring', {}), /forbidden/);

  const h = await lot('H-1');
  const stock = (await t.one('select stock from products where id = $1', [IDS.oil])).stock;
  await assert.rejects(t.rpc(U.picker, 'lg_lot_discard', { p_lot: h.id, p_qty: 5, p_reason: 'périmé' }), /forbidden/);
  await assert.rejects(t.rpc(U.dock, 'lg_lot_discard', { p_lot: h.id, p_qty: 5, p_reason: ' ' }), /reason_required/);
  assert.equal((await t.rpc(U.dock, 'lg_lot_discard', { p_lot: h.id, p_qty: 9, p_reason: 'périmé', p_event: t.ev() })).error, 'qty_exceeds');
  const r = await t.rpc(U.dock, 'lg_lot_discard', { p_lot: h.id, p_qty: 5, p_reason: 'périmé', p_event: t.ev() });
  assert.deepEqual([r.ok, r.left], [true, 0]);
  assert.equal(await qtyAt(IDS.oil, 'C-01-0'), 0);
  assert.equal((await t.one('select stock from products where id = $1', [IDS.oil])).stock, stock - 5);
  assert.ok(await t.one("select 1 x from audit_logs where action = 'lg.lot_discard'"));
});

test('inventaire : un rayon compté plus bas ne garde pas plus de lots que d\'unités', async () => {
  const loc = (await t.one("select id from lg_stock_locations where code = 'A-01-1'")).id;
  const r = await t.rpc(U.picker, 'lg_inventory_count', { p_location: loc, p_counts: [{ product_id: IDS.rice, counted: 4, reason: 'casse' }], p_event: t.ev() });
  assert.equal(r.ok, true);
  // 8 unités en lots (2 L-PROCHE + 6 L-LOIN) pour 4 comptées : le plus ancien part d'abord
  assert.deepEqual([(await lot('L-PROCHE')).qty, (await lot('L-LOIN')).qty], [0, 4]);
  assert.ok(await t.one("select 1 x from lg_lot_moves where kind = 'adjust'"));
});
