// Produits et stock : un seul chiffre de stock tenu par tous les mouvements, réception, correction, transfert,
// historique, seuil d'alerte, import de catalogue, isolation entre entreprises, vendeur limité à ses produits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, Client, invite } from '../helpers/api-client.js';
import { setup, ready, ev } from '../helpers/scenario.js';

const row = (ov, id) => ov.products.find((p) => p.id === id);

test('le stock baisse à chaque préparation, avec l\'historique ; réservé et disponible suivent les commandes', async () => {
  const env = makeEnv(); const S = await setup(env);
  let ov = await S.dock.rpc('lg_stock_overview');
  assert.deepEqual([row(ov, S.P.rice).stock, row(ov, S.P.rice).reserved], [10, 0]);
  // commande créée, pas encore préparée : 3 riz réservés
  const o = await S.support.rpc('lg_order_create', { p_customer: { name: 'Awa Diop', phone: '771112233' }, p_zone: 'Yoff',
    p_items: [{ product_id: S.P.rice, quantity: 3 }], p_payment_method: 'prepaid' });
  ov = await S.dock.rpc('lg_stock_overview');
  assert.deepEqual([row(ov, S.P.rice).stock, row(ov, S.P.rice).reserved, row(ov, S.P.rice).available], [10, 3, 7]);
  // préparation : chaque unité scannée sort du stock
  const t = (await S.picker.rpc('lg_pick_queue')).find((x) => x.order_id === o.id);
  await S.picker.rpc('lg_pick_take', { p_task: t.id });
  for (let i = 0; i < 3; i++) await S.picker.rpc('lg_pick_scan', { p_task: t.id, p_code: 'RIZ-5', p_event: ev() });
  ov = await S.dock.rpc('lg_stock_overview');
  assert.deepEqual([row(ov, S.P.rice).stock, row(ov, S.P.rice).reserved, row(ov, S.P.rice).available], [7, 0, 7]);
  const moves = await S.dock.rpc('lg_stock_moves', { p_product: S.P.rice });
  assert.deepEqual(moves.map((m) => [m.kind, m.qty, m.stock_after]), [['pick', -1, 7], ['pick', -1, 8], ['pick', -1, 9], ['initial', 10, 10]]);
  assert.equal(moves[0].order_number, (await S.support.rpc('lg_order_detail', { p_order: o.id })).number);
});

test('réception (avec ou sans emplacement), correction motivée, transfert, seuil d\'alerte', async () => {
  const env = makeEnv(); const S = await setup(env);
  await S.dock.rpc('lg_location_upsert', { p: { code: 'A-01' } });
  await S.dock.rpc('lg_location_upsert', { p: { code: 'B-02' } });
  // réception sans emplacement, puis à un emplacement avec un lot daté
  let r = await S.dock.rpc('lg_stock_receive', { p_code: 'HUI-1', p_qty: 5, p_ref: 'BL-778', p_event: ev() });
  assert.deepEqual([r.ok, r.stock], [true, 15]);
  assert.equal(await S.dock.rpcError('lg_stock_receive', { p_product: S.P.oil, p_qty: 2, p_lot: 'L1', p_event: ev() }), 'location_required');
  r = await S.dock.rpc('lg_stock_receive', { p_product: S.P.oil, p_qty: 4, p_location_code: 'a-01', p_lot: 'l1', p_expires_on: '2099-01-01', p_event: ev() });
  assert.deepEqual([r.stock, r.location, r.lot], [19, 'A-01', 'L1']);
  assert.equal((await S.dock.rpc('lg_stock_receive', { p_product: S.P.oil, p_qty: 1, p_location_code: 'A-01', p_expires_on: '2001-01-01', p_event: ev() })).error, 'expired_lot');
  // rejouer la même réception (réseau coupé puis revenu) ne compte pas deux fois
  const e = ev();
  await S.dock.rpc('lg_stock_receive', { p_product: S.P.oil, p_qty: 1, p_event: e });
  assert.equal((await S.dock.rpc('lg_stock_receive', { p_product: S.P.oil, p_qty: 1, p_event: e })).stock, 20);
  // correction : motif obligatoire, réservée au chef de quai (et à l'administrateur)
  assert.equal(await S.dock.rpcError('lg_stock_adjust', { p_product: S.P.oil, p_new_qty: 18, p_event: ev() }), 'reason_required');
  assert.equal(await S.picker.rpcError('lg_stock_adjust', { p_product: S.P.oil, p_new_qty: 18, p_reason: 'casse', p_event: ev() }), 'forbidden');
  assert.deepEqual(await S.dock.rpc('lg_stock_adjust', { p_product: S.P.oil, p_new_qty: 18, p_reason: '2 bouteilles cassées', p_event: ev() }).then((x) => [x.stock, x.delta]), [18, -2]);
  // transfert : le stock ne change pas, l'emplacement et le lot suivent
  assert.equal((await S.dock.rpc('lg_stock_transfer', { p_product: S.P.oil, p_from_code: 'A-01', p_to_code: 'B-02', p_qty: 9, p_event: ev() })).error, 'qty_exceeds');
  assert.equal((await S.dock.rpc('lg_stock_transfer', { p_product: S.P.oil, p_from_code: 'A-01', p_to_code: 'B-02', p_qty: 3, p_event: ev() })).ok, true);
  const ov = await S.dock.rpc('lg_stock_overview');
  assert.equal(row(ov, S.P.oil).stock, 18);
  assert.deepEqual(row(ov, S.P.oil).locations, [{ code: 'A-01', qty: 1 }, { code: 'B-02', qty: 3 }]);
  const lots = env.DB.db.prepare("SELECT l.code, s.qty FROM stock_lots s JOIN stock_locations l ON l.id = s.location_id WHERE s.qty > 0 ORDER BY l.code").all();
  assert.deepEqual(lots.map((x) => [x.code, x.qty]), [['A-01', 1], ['B-02', 3]]);
  // seuil : sous le seuil → alerte et quantité à commander
  await S.admin.rpc('lg_product_upsert', { p: { id: S.P.rice, name: 'Riz 5 kg', sku: 'RIZ-5', price_fcfa: 5000, weight_g: 5000, min_stock: 12 } });
  const alert = await S.dock.rpc('lg_stock_overview', { p_filter: 'alert' });
  assert.deepEqual(alert.products.map((p) => [p.name, p.state, p.to_order]), [['Riz 5 kg', 'low', 14]]);
  assert.equal(row(await S.dock.rpc('lg_stock_overview'), S.P.rice).stock, 10, 'modifier la fiche ne touche jamais au stock');
  const kinds = (await S.dock.rpc('lg_stock_moves', { p_product: S.P.oil })).map((m) => m.kind);
  assert.deepEqual(kinds, ['transfer', 'adjust', 'in', 'in', 'in', 'initial']);
});

test('import du catalogue : création avec stock de départ, mise à jour par référence, erreurs par ligne', async () => {
  const env = makeEnv(); const S = await setup(env);
  const r = await S.admin.rpc('lg_products_import', { p_rows: [
    { name: 'Sucre 1 kg', sku: 'SUC-1', price_fcfa: '800', weight_kg: '1', stock: '40', min_stock: '10', supplier: 'Grossiste Sandaga' },
    { name: 'Lait en poudre', barcode: '6111234567890', price_fcfa: '2 500', stock: '' },
    { name: '', sku: 'X' },
    { name: 'Riz parfumé', sku: 'RIZ-5', price_fcfa: '5500' },
    { name: 'Doublon', sku: 'SUC-1' },
  ] });
  assert.deepEqual([r.created, r.updated, r.skipped, r.errors.map((e) => [e.line, e.error])], [2, 0, 2, [[4, 'invalid_name']]]);
  const ov = await S.admin.rpc('lg_stock_overview');
  const sugar = ov.products.find((p) => p.sku === 'SUC-1');
  assert.deepEqual([sugar.stock, sugar.min_stock, sugar.supplier, sugar.weight_g, sugar.price_fcfa], [40, 10, 'Grossiste Sandaga', 1000, 800]);
  assert.equal(ov.products.find((p) => p.name === 'Lait en poudre').state, 'untracked');
  const u = await S.admin.rpc('lg_products_import', { p_update: true, p_rows: [{ name: 'Riz parfumé 5 kg', sku: 'riz-5', price_fcfa: '5500', stock: '999' }] });
  assert.equal(u.updated, 1);
  const rice = (await S.admin.rpc('lg_stock_overview')).products.find((p) => p.id === S.P.rice);
  assert.deepEqual([rice.name, rice.price_fcfa, rice.stock], ['Riz parfumé 5 kg', 5500, 10]);
  // même code-barres qu'un autre produit : refusé à la saisie
  assert.equal((await S.admin.rpc('lg_product_upsert', { p: { name: 'Autre', barcode: '6111234567890' } })).error, 'duplicate_code');
});

test('isolation entre entreprises et vendeur limité à ses produits', async () => {
  const env = makeEnv(); const S = await setup(env);
  const other = new Client(env); await other.register('bob@rapide.sn', { company: 'Rapide' });
  assert.deepEqual((await other.rpc('lg_stock_overview')).products, []);
  assert.equal(await other.rpcError('lg_stock_receive', { p_product: S.P.rice, p_qty: 5, p_event: ev() }), 'unknown_product');
  assert.equal(await other.rpcError('lg_stock_adjust', { p_product: S.P.rice, p_new_qty: 0, p_reason: 'x', p_event: ev() }), 'unknown_product');
  assert.deepEqual(await other.rpc('lg_stock_moves'), []);
  // vendeur : ses produits seulement, sans emplacement d'entrepôt
  const vendor = await invite(env, S.admin, 'ndeye@boutique.sn', { role: 'vendor', name: 'Boutique Ndèye' });
  const mine = (await vendor.rpc('lg_product_upsert', { p: { name: 'Bissap 1 L', price_fcfa: 1000, stock: 6 } })).id;
  const v = await vendor.rpc('lg_stock_overview');
  assert.deepEqual(v.products.map((p) => p.id), [mine]);
  assert.equal(await vendor.rpcError('lg_stock_receive', { p_product: S.P.rice, p_qty: 1, p_event: ev() }), 'unknown_product');
  assert.equal((await vendor.rpc('lg_stock_receive', { p_product: mine, p_qty: 4, p_event: ev() })).stock, 10);
  assert.equal(await vendor.rpcError('lg_stock_receive', { p_product: mine, p_qty: 1, p_location_code: 'A-01', p_event: ev() }), 'forbidden');
  assert.equal((await vendor.rpc('lg_stock_adjust', { p_product: mine, p_new_qty: 8, p_reason: 'inventaire du soir', p_event: ev() })).stock, 8);
  // un chauffeur ne voit pas le stock
  assert.equal(await S.driver.rpcError('lg_stock_overview'), 'forbidden');
  // premiers pas (propriétaire)
  const st = await S.admin.rpc('lg_setup_status');
  assert.ok(st.products >= 3 && st.zones > 0 && st.couriers === 2);
});
