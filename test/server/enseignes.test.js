// Enseignes : prix convenus (HT), remise générale, TVA par produit, client exonéré, magasins, facture à la raison
// sociale, collecte (enseigne reconnue, écarts de prix, tarif ou prix du bon), import de grille, isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from '../helpers/api-client.js';
import { ev, setup, ready, sealedTrip, otpOf } from '../helpers/scenario.js';

async function deliverAll(S, trip) {
  await S.driver.rpc('lg_trip_start', { p_trip: trip, p_event: ev() });
  for (const st of (await S.driver.rpc('lg_my_day')).trips.find((t) => t.id === trip).stops) {
    const r = await S.driver.rpc('lg_deliver', { p_stop: st.id, p_event: ev(), p_codes: st.packages.map((p) => p.code), p_otp: otpOf(S.env, st.order_id).code,
      p_photo_path: `${trip}/p.jpg`, p_payments: st.cod_due_fcfa ? [{ method: 'cash', amount: st.cod_due_fcfa }] : [] });
    assert.equal(r.ok, true, JSON.stringify(r));
  }
}
const items = (env, orderId) => env.DB.db.prepare('SELECT product_id, unit_price_fcfa, unit_price_ht, vat_rate, price_source FROM order_items WHERE order_id = ? ORDER BY rowid').all(orderId);

test('enseigne : prix convenus HT, remise, TVA par produit, délai, facture à la raison sociale', async () => {
  const env = makeEnv(); const S = await setup(env);
  await S.admin.rpc('lg_product_upsert', { p: { id: S.P.oil, name: 'Huile 1 L', sku: 'HUI-1', price_fcfa: 1100, weight_g: 1000, vat_rate: 10 } });
  assert.equal(await S.admin.rpcError('lg_product_upsert', { p: { id: S.P.oil, name: 'Huile 1 L', price_fcfa: 1100, vat_rate: 50 } }), 'invalid_vat');
  const acc = (await S.accountant.rpc('lg_account_upsert', { p: { name: 'Supermarchés Exemple SA', payment_terms_days: 15, discount_pct: 10, ninea: '00123', address: 'Zone industrielle, Dakar' } })).id;
  assert.equal(await S.accountant.rpcError('lg_account_upsert', { p: { name: 'Supermarchés Exemple SA' } }), 'duplicate_name');
  assert.equal(await S.picker.rpcError('lg_account_upsert', { p: { name: 'X SA' } }), 'forbidden');
  assert.deepEqual(await S.accountant.rpc('lg_account_prices_set', { p_account: acc, p_prices: [{ product_id: S.P.rice, price_fcfa: 4000 }] }), { ok: true, saved: 1 });
  const store = (await S.support.rpc('lg_account_store_upsert', { p_account: acc, p_store: { name: 'Exemple Sacré-Cœur', phone: '338001111', zone: 'Yoff' } })).id;
  const g = await S.support.rpc('lg_account_get', { p_id: acc });
  assert.deepEqual([g.stores.map((s) => s.id), g.prices.find((p) => p.product_id === S.P.rice).tariff, g.prices.find((p) => p.product_id === S.P.oil).vat_rate], [[store], 4000, 10]);
  // commande du magasin, sans prix ni mode : enseigne reconnue, à terme 15 j, riz au prix convenu HT + 18 %, huile catalogue − 10 % à 10 %
  const A = await ready(S, [[S.P.rice, 2], [S.P.oil, 1]], { method: '', phone: '338001111' });
  assert.deepEqual([A.order.payment_method, A.order.payment_terms_days], ['account', 15]);
  const li = items(env, A.order.id);
  assert.deepEqual(li.map((l) => [l.unit_price_fcfa, l.unit_price_ht, l.vat_rate, l.price_source]), [[4720, 4000, 18, 'tariff'], [1100, 900, 10, 'discount']].map((x, i) => i === 1 ? [Math.round(1100 / 1.1 * 0.9 * 1.1), 900, 10, 'discount'] : x));
  // facture : à la raison sociale, livrée au magasin, une TVA par ligne
  await deliverAll(S, await sealedTrip(S, [A]));
  const inv = (await S.accountant.rpc('lg_invoices_list', {}))[0];
  const doc = await S.accountant.rpc('lg_invoice_get', { p_invoice: inv.id });
  assert.deepEqual([doc.metadata.customer.name, doc.metadata.customer.ninea], ['Supermarchés Exemple SA', '00123']);
  assert.match(doc.metadata.customer.delivered_to, /Sacré-Cœur|Awa Diop/);
  const prods = doc.lines.filter((l) => l.kind === 'product');
  assert.deepEqual(prods.map((l) => [l.unit_price_ht, l.tva_rate]), [[4000, 18], [900, 10]]);
  // prix donné explicitement : il prime sur le tarif
  const B = await S.support.rpc('lg_order_create', { p_customer: { name: 'Exemple Sacré-Cœur', phone: '338001111' }, p_zone: 'Yoff', p_items: [{ product_id: S.P.rice, quantity: 1, unit_price_fcfa: 5000 }] });
  assert.deepEqual(items(env, B.id).map((l) => [l.unit_price_fcfa, l.price_source]), [[5000, 'given']]);
  // magasin détaché : retour au catalogue
  await S.support.rpc('lg_account_store_unlink', { p_customer: store });
  const C = await S.support.rpc('lg_order_create', { p_customer: { name: 'Exemple Sacré-Cœur', phone: '338001111' }, p_zone: 'Yoff', p_items: [{ product_id: S.P.rice, quantity: 1 }], p_payment_method: 'cod' });
  assert.deepEqual(items(env, C.id).map((l) => [l.unit_price_fcfa, l.vat_rate, l.price_source]), [[5000, 18, 'catalogue']]);
});

test('client exonéré, import de grille, enseigne demandée, isolation', async () => {
  const env = makeEnv(); const S = await setup(env);
  const ex = (await S.accountant.rpc('lg_account_upsert', { p: { name: 'Ambassade Exemple', vat_exempt: true } })).id;
  const o = await S.support.rpc('lg_order_create', { p_customer: { name: 'Ambassade', phone: '338002222' }, p_zone: 'Yoff', p_account_id: ex,
    p_items: [{ product_id: S.P.rice, quantity: 1 }], p_payment_method: 'prepaid' });
  assert.deepEqual(items(env, o.id).map((l) => [l.unit_price_fcfa, l.vat_rate]), [[Math.round(5000 / 1.18), 0]], 'exonéré : HT du catalogue, TVA 0');
  // enseigne demandée à la commande : le magasin lui est rattaché pour la suite
  const again = await S.support.rpc('lg_order_create', { p_customer: { name: 'Ambassade', phone: '338002222' }, p_zone: 'Yoff', p_items: [{ product_id: S.P.rice, quantity: 1 }], p_payment_method: 'prepaid' });
  assert.equal(items(env, again.id)[0].vat_rate, 0);
  const imp = await S.accountant.rpc('lg_account_prices_import', { p_account: ex, p_rows: [{ code: 'riz-5', price: '4 100' }, { code: 'Huile 1 L', price: 1000 }, { code: 'INCONNU', price: 1 }] });
  assert.deepEqual([imp.imported, imp.unknown], [2, ['INCONNU']]);
  // autre entreprise : ni lecture, ni écriture, ni produit étranger dans la grille
  const T = await setup(env, 'bob@autre.sn', 'Autre Express');
  assert.equal(await T.accountant.rpcError('lg_account_get', { p_id: ex }), 'unknown_account');
  assert.equal(await T.accountant.rpcError('lg_account_prices_set', { p_account: ex, p_prices: [] }), 'unknown_account');
  assert.equal(await T.support.rpcError('lg_order_create', { p_customer: { name: 'X Y', phone: '338003333' }, p_zone: 'Yoff', p_account_id: ex, p_items: [{ product_id: T.P.rice, quantity: 1 }] }), 'unknown_account');
  assert.equal((await T.accountant.rpc('lg_accounts_list')).length, 0);
  const mine = (await T.accountant.rpc('lg_account_upsert', { p: { name: 'Chez Bob' } })).id;
  await T.accountant.rpc('lg_account_prices_set', { p_account: mine, p_prices: [{ product_id: S.P.rice, price_fcfa: 1 }] });
  assert.equal(env.DB.db.prepare('SELECT count(*) n FROM account_prices WHERE account_id = ?').get(mine).n, 0, 'produit d\'une autre entreprise refusé');
});

test('collecte : enseigne reconnue, écart de prix signalé, tarif convenu ou prix du bon', async () => {
  const env = makeEnv();
  const IA = { document_type: 'commande', customer: { name: 'Enseigne Test' }, order_number: '777001', delivery_place: 'ENSEIGNE TEST ALMADIES', confidence: 0.9,
    lines: [{ ref: 'R1', label: 'RIZ 5KG', cases: 2, units_per_case: 5, unit_price: 4200 }] };
  env.AI = { toMarkdown: async (files) => files.map((f) => ({ name: f.name, format: 'markdown', data: 'BON 777001 RIZ 5KG R1' })), run: async () => ({ response: JSON.stringify(IA) }) };
  const S = await setup(env);
  const acc = (await S.accountant.rpc('lg_account_upsert', { p: { name: 'Enseigne Test', payment_terms_days: 30 } })).id;
  await S.accountant.rpc('lg_account_prices_set', { p_account: acc, p_prices: [{ product_id: S.P.rice, price_fcfa: 4000 }] });
  const store = (await S.support.rpc('lg_account_store_upsert', { p_account: acc, p_store: { name: 'Enseigne Test Almadies', phone: '338004444', zone: 'Yoff' } })).id;
  const up = await S.support.rpc('lg_inbox_upload', { p_filename: 'bon.pdf', p_data: Buffer.from('%PDF').toString('base64') });
  const d = await S.support.rpc('lg_inbox_detail', { p_id: up.id });
  assert.deepEqual([d.account?.id, d.account?.stores.map((s) => s.id)], [acc, [store]]);
  d.data.lines[0].product_id = S.P.rice;
  await S.support.rpc('lg_inbox_save', { p_id: up.id, p_data: d.data });
  const d2 = await S.support.rpc('lg_inbox_detail', { p_id: up.id });
  assert.deepEqual(d2.price_checks.map((c) => [c.doc, c.tariff, c.diff_pct]), [[4200, 4000, 5]]);
  // conversion au tarif convenu
  const cv = await S.support.rpc('lg_inbox_convert', { p_id: up.id, p_account: acc, p_prices: 'tariff', p_customer: { name: 'Enseigne Test Almadies', phone: '338004444' }, p_zone: 'Yoff' });
  assert.equal(cv.ok, true, JSON.stringify(cv));
  assert.deepEqual(items(env, cv.order_id).map((l) => [l.unit_price_ht, l.price_source]), [[4000, 'tariff']]);
  const o = await S.support.rpc('lg_order_detail', { p_order: cv.order_id });
  assert.deepEqual([o.payment_method, o.payment_terms_days], ['account', 30]);
  // second bon, au prix du bon (HT)
  IA.order_number = '777002';
  const up2 = await S.support.rpc('lg_inbox_upload', { p_filename: 'bon2.pdf', p_data: Buffer.from('%PDF 2').toString('base64') });
  const cv2 = await S.support.rpc('lg_inbox_convert', { p_id: up2.id, p_account: acc, p_customer: { name: 'Enseigne Test Almadies', phone: '338004444' }, p_zone: 'Yoff', p_free_lines: true });
  assert.equal(cv2.ok, true, JSON.stringify(cv2));
  const l2 = items(env, cv2.order_id)[0];
  assert.deepEqual([l2.unit_price_ht, l2.unit_price_fcfa, l2.price_source], [4200, Math.round(4200 * 1.18), 'given']);
});
