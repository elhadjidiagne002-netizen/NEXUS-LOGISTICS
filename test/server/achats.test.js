// Fournisseurs et bons de commande : cycle de vie d'un bon, réception partielle / totale (entrée en stock tracée),
// numéros sans trou, propositions depuis les alertes de stock, droits, isolation entre entreprises.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, Client } from '../helpers/api-client.js';
import { setup, ev } from '../helpers/scenario.js';

const stockOf = async (S, id) => (await S.dock.rpc('lg_stock_overview')).products.find((p) => p.id === id);

test('bon de commande : brouillon, envoi, réception partielle puis totale, stock et prix d\'achat mis à jour', async () => {
  const env = makeEnv(); const S = await setup(env);
  const sup = await S.dock.rpc('lg_supplier_upsert', { p: { name: 'Grossiste Sandaga', phone: '771234567', lead_days: 2, payment_terms: '30 jours' } });
  assert.equal((await S.dock.rpc('lg_supplier_upsert', { p: { name: 'grossiste sandaga' } })).error, 'duplicate_supplier');
  const po = await S.dock.rpc('lg_purchase_order_create', { p_supplier: sup.id, p_expected_on: '2099-01-10',
    p_lines: [{ product_id: S.P.rice, qty: 20, unit_cost_fcfa: 4500 }, { product_id: S.P.oil, qty: 12, unit_cost_fcfa: 1100 }, { product_id: S.P.rice, qty: 5, unit_cost_fcfa: 4500 }] });
  assert.match(po.number, /^BC-\d{4}-000001$/);
  assert.equal(po.total_fcfa, 25 * 4500 + 12 * 1100, 'même produit deux fois : une seule ligne');
  let d = await S.dock.rpc('lg_purchase_order_detail', { p_id: po.id });
  assert.deepEqual([d.status, d.lines.length, d.supplier.name], ['draft', 2, 'Grossiste Sandaga']);
  assert.equal((await stockOf(S, S.P.rice)).on_order, 25);
  // modifiable en brouillon seulement
  await S.dock.rpc('lg_purchase_order_update', { p_id: po.id, p_lines: [{ product_id: S.P.rice, qty: 24, unit_cost_fcfa: 4500 }, { product_id: S.P.oil, qty: 12, unit_cost_fcfa: 1100 }] });
  await S.dock.rpc('lg_purchase_order_send', { p_id: po.id });
  assert.equal((await S.dock.rpc('lg_purchase_order_update', { p_id: po.id, p_note: 'x' })).error, 'po_not_draft');
  d = await S.dock.rpc('lg_purchase_order_detail', { p_id: po.id });
  const rice = d.lines.find((l) => l.product_id === S.P.rice); const oil = d.lines.find((l) => l.product_id === S.P.oil);
  // 1re livraison : 20 riz (le reste plus tard) ; plus que commandé : refusé
  assert.equal((await S.picker.rpc('lg_purchase_order_receive', { p_id: po.id, p_lines: [{ line_id: rice.id, qty: 30 }], p_event: ev() })).error, 'over_receipt');
  const e1 = ev();
  let r = await S.picker.rpc('lg_purchase_order_receive', { p_id: po.id, p_ref: 'BL-55', p_lines: [{ line_id: rice.id, qty: 20 }], p_event: e1 });
  assert.deepEqual([r.status, r.units], ['partial', 20]);
  r = await S.picker.rpc('lg_purchase_order_receive', { p_id: po.id, p_ref: 'BL-55', p_lines: [{ line_id: rice.id, qty: 20 }], p_event: e1 });
  assert.equal((await stockOf(S, S.P.rice)).stock, 30, 'rejeu de la même réception : rien compté deux fois');
  // 2e livraison : le reste
  r = await S.picker.rpc('lg_purchase_order_receive', { p_id: po.id, p_lines: [{ line_id: rice.id, qty: 4 }, { line_id: oil.id, qty: 12 }], p_event: ev() });
  assert.equal(r.status, 'received');
  const after = await stockOf(S, S.P.rice);
  assert.deepEqual([after.stock, after.on_order, after.cost_fcfa], [34, 0, 4500]);
  const moves = await S.dock.rpc('lg_stock_moves', { p_product: S.P.rice });
  assert.deepEqual(moves.filter((m) => m.kind === 'in').map((m) => [m.qty, m.ref]), [[4, po.number], [20, po.number]]);
  assert.equal((await S.picker.rpc('lg_purchase_order_receive', { p_id: po.id, p_lines: [{ line_id: oil.id, qty: 1 }], p_event: ev() })).error, 'po_closed');
  const list = await S.accountant.rpc('lg_suppliers_list');
  assert.deepEqual([list[0].name, list[0].open_orders, list[0].spent_365d], ['Grossiste Sandaga', 0, 24 * 4500 + 12 * 1100]);
});

test('annulation, solde d\'un reliquat, numéros sans trou, propositions depuis les alertes', async () => {
  const env = makeEnv(); const S = await setup(env);
  const a = (await S.dock.rpc('lg_supplier_upsert', { p: { name: 'Huilerie de Dakar', lead_days: 3 } })).id;
  const b = (await S.dock.rpc('lg_supplier_upsert', { p: { name: 'Rizerie du Fleuve' } })).id;
  const po1 = await S.dock.rpc('lg_purchase_order_create', { p_supplier: a, p_lines: [{ product_id: S.P.oil, qty: 5 }] });
  assert.equal(await S.dock.rpcError('lg_purchase_order_cancel', { p_id: po1.id }), 'reason_required');
  await S.dock.rpc('lg_purchase_order_cancel', { p_id: po1.id, p_reason: 'erreur de quantité' });
  // reçu en partie puis soldé
  const po2 = await S.dock.rpc('lg_purchase_order_create', { p_supplier: a, p_lines: [{ product_id: S.P.oil, qty: 10 }] });
  const line = (await S.dock.rpc('lg_purchase_order_detail', { p_id: po2.id })).lines[0];
  await S.dock.rpc('lg_purchase_order_receive', { p_id: po2.id, p_lines: [{ line_id: line.id, qty: 6 }], p_event: ev() });
  assert.equal((await S.dock.rpc('lg_purchase_order_cancel', { p_id: po2.id, p_reason: 'x' })).error, 'po_closed');
  await S.dock.rpc('lg_purchase_order_close', { p_id: po2.id, p_reason: 'rupture chez le fournisseur' });
  assert.equal((await S.dock.rpc('lg_purchase_order_detail', { p_id: po2.id })).status, 'received');
  assert.deepEqual([po1.number.slice(-6), po2.number.slice(-6)], ['000001', '000002']);
  // alertes : riz sous le seuil chez la rizerie, huile sous le seuil chez l'huilerie, sucre sans fournisseur
  await S.admin.rpc('lg_product_upsert', { p: { id: S.P.rice, name: 'Riz 5 kg', sku: 'RIZ-5', price_fcfa: 5000, weight_g: 5000, min_stock: 15, supplier_id: b, cost_fcfa: 4200 } });
  await S.admin.rpc('lg_product_upsert', { p: { id: S.P.oil, name: 'Huile 1 L', sku: 'HUI-1', price_fcfa: 1500, weight_g: 1000, min_stock: 20, supplier_id: a } });
  await S.admin.rpc('lg_product_upsert', { p: { name: 'Sucre 1 kg', sku: 'SUC-1', price_fcfa: 800, stock: 2, min_stock: 10 } });
  const prop = await S.dock.rpc('lg_purchase_orders_from_alerts');
  assert.deepEqual(prop.created.map((c) => [c.supplier, c.lines]).sort(), [['Huilerie de Dakar', 1], ['Rizerie du Fleuve', 1]]);
  assert.deepEqual(prop.without_supplier, ['Sucre 1 kg']);
  const riceRow = (await S.dock.rpc('lg_stock_overview')).products.find((p) => p.id === S.P.rice);
  assert.deepEqual([riceRow.supplier, riceRow.on_order, riceRow.to_order], ['Rizerie du Fleuve', 20, 0], 'déjà en commande : plus rien à commander');
  assert.equal((await S.dock.rpc('lg_purchase_orders_from_alerts')).created.length, 0, 'pas de doublon de proposition');
  const hui = (await S.dock.rpc('lg_purchase_orders_list', { p_status: 'open' })).find((o) => o.supplier === 'Huilerie de Dakar');
  assert.ok(hui.expected_on, 'date attendue = délai habituel du fournisseur');
});

test('droits et isolation', async () => {
  const env = makeEnv(); const S = await setup(env);
  const sup = (await S.dock.rpc('lg_supplier_upsert', { p: { name: 'Fournisseur A' } })).id;
  assert.equal(await S.picker.rpcError('lg_supplier_upsert', { p: { name: 'X' } }), 'forbidden');
  assert.equal(await S.driver.rpcError('lg_suppliers_list'), 'forbidden');
  assert.equal(await S.picker.rpcError('lg_purchase_order_create', { p_supplier: sup, p_lines: [{ product_id: S.P.rice, qty: 1 }] }), 'forbidden');
  const po = await S.accountant.rpc('lg_purchase_order_create', { p_supplier: sup, p_lines: [{ product_id: S.P.rice, qty: 3 }] });
  assert.equal(await S.accountant.rpcError('lg_purchase_order_receive', { p_id: po.id, p_lines: [], p_event: ev() }), 'forbidden', 'la comptabilité commande, le quai reçoit');
  const other = new Client(env); await other.register('bob@rapide.sn', { company: 'Rapide' });
  assert.deepEqual(await other.rpc('lg_suppliers_list'), []);
  assert.deepEqual(await other.rpc('lg_purchase_orders_list'), []);
  assert.equal(await other.rpcError('lg_purchase_order_detail', { p_id: po.id }), 'unknown_po');
  assert.equal(await other.rpcError('lg_purchase_order_create', { p_supplier: sup, p_lines: [{ product_id: S.P.rice, qty: 1 }] }), 'unknown_supplier');
  const own = (await other.rpc('lg_supplier_upsert', { p: { name: 'Le sien' } })).id;
  assert.equal(await other.rpcError('lg_purchase_order_create', { p_supplier: own, p_lines: [{ product_id: S.P.rice, qty: 1 }] }), 'unknown_product');
  assert.equal(await other.rpcError('lg_product_upsert', { p: { name: 'Y', supplier_id: sup } }), 'unknown_supplier');
});
