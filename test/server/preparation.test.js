// Cycle C3 — préparation et entrepôt. Comportement porté de test/sql/parcours (01 à 07), cycle3 (double contrôle),
// cycle4 (chemin de prélèvement, rangement, vague, inventaire), cycle6 (lots, FEFO, rebut, traçabilité), cycle7
// (productivité) ; + isolation entre entreprises et rôles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, Client, invite } from '../helpers/api-client.js';

const ev = () => crypto.randomUUID();
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const customer = { name: 'Awa Diop', phone: '+221 77 123 45 67', address: 'Rufisque', landmark: 'près du marché' };

/** Entreprise prête : zones, tarif, catalogue (riz, huile, œufs sans code, savon), équipe. */
async function setup(env, email = 'awa@express.sn', company = 'Express Dakar') {
  const admin = new Client(env); await admin.register(email, { company });
  await admin.rpc('lg_zones_seed');
  await admin.rpc('lg_upsert_rate_card', { p: { max_weight_g: 200000, price_fcfa: 1500 } });
  const P = {};
  P.rice = (await admin.rpc('lg_product_upsert', { p: { name: 'Riz parfumé 5 kg', sku: 'RIZ-5', barcode: '6111234500017', price_fcfa: 5000, weight_g: 5000, stock: 50, handling: ['alimentaire'] } })).id;
  P.oil = (await admin.rpc('lg_product_upsert', { p: { name: 'Huile 1 L', sku: 'HUI-1', barcode: '6111234500024', price_fcfa: 1500, weight_g: 1000, stock: 50, handling: ['liquide', 'alimentaire'] } })).id;
  P.eggs = (await admin.rpc('lg_product_upsert', { p: { name: 'Œufs, plateau de 30', price_fcfa: 3000, weight_g: 2000, stock: 20, handling: ['fragile'] } })).id;
  P.soap = (await admin.rpc('lg_product_upsert', { p: { name: 'Savon de Marseille x4', sku: 'SAV-4', barcode: '6111234500048', price_fcfa: 1000, weight_g: 400, stock: 30 } })).id;
  const slug = email.split('@')[0];
  const picker = await invite(env, admin, `prep-${slug}@x.sn`, { staff: ['picker'], name: 'Fatou Préparatrice' });
  const picker2 = await invite(env, admin, `prep2-${slug}@x.sn`, { staff: ['picker'], name: 'Binta' });
  const dock = await invite(env, admin, `quai-${slug}@x.sn`, { staff: ['dock_chief'], name: 'Ousmane' });
  const support = await invite(env, admin, `sav-${slug}@x.sn`, { staff: ['support'], name: 'Coumba' });
  return { admin, picker, picker2, dock, support, P };
}
const order = (c, items, extra = {}) => c.rpc('lg_order_create', { p_customer: customer, p_zone: 'Rufisque', p_items: items, ...extra });
const taskOf = async (c, orderId) => (await c.rpc('lg_pick_queue')).find((t) => t.order_id === orderId);

test('parcours : confirmation → préparation, verrou, scans, rupture, colisage en 2 colis, mise à quai', async () => {
  const env = makeEnv();
  const { admin, picker, picker2, support, P } = await setup(env);
  // commande à la livraison : pas de préparation avant la confirmation
  const o = await order(support, [{ product_id: P.rice, quantity: 2 }, { product_id: P.oil, quantity: 1 }, { product_id: P.eggs, quantity: 1 }]);
  assert.equal(await taskOf(picker, o.id), undefined);
  const token = o.tracking_url.split('/').pop();
  assert.equal((await new Client(env).rpc('lg_track_confirm', { p_token: token, p_yes: true })).ok, true);
  assert.equal((await new Client(env).rpc('lg_track_confirm', { p_token: token, p_yes: true })).ok, true, 'reconfirmer ne crée pas 2 préparations');
  const q = await picker.rpc('lg_pick_queue');
  assert.equal(q.length, 1);
  assert.deepEqual([q[0].zone, q[0].lines, q[0].units, q[0].order_short], ['Rufisque', 3, 4, String(o.number)]);
  const task = q[0].id;
  // verrou
  await picker.rpc('lg_pick_take', { p_task: task });
  assert.equal(await picker2.rpcError('lg_pick_take', { p_task: task }), 'task_locked');
  assert.equal((await picker2.rpc('lg_pick_queue'))[0].locked, true);
  assert.equal(await support.rpcError('lg_pick_take', { p_task: task }), 'forbidden');
  assert.equal((await admin.rpc('lg_order_detail', { p_order: o.id })).status, 'processing');
  // scans
  const e1 = ev();
  const s1 = await picker.rpc('lg_pick_scan', { p_task: task, p_code: '6111234500017', p_event: e1 });
  assert.deepEqual([s1.ok, s1.qty_picked, s1.qty_ordered], [true, 1, 2]);
  const replay = await picker.rpc('lg_pick_scan', { p_task: task, p_code: '6111234500017', p_event: e1 });
  assert.deepEqual([replay.replayed, replay.qty_picked], [true, 1], 'le rejeu ne compte pas deux fois');
  assert.equal((await picker.rpc('lg_pick_scan', { p_task: task, p_code: 'riz-5', p_event: ev() })).line_done, true, 'référence vendeur');
  const wrong = await picker.rpc('lg_pick_scan', { p_task: task, p_code: '6111234500048', p_event: ev() });
  assert.deepEqual([wrong.ok, wrong.error, wrong.product], [false, 'unexpected_product', 'Savon de Marseille x4']);
  assert.equal((await picker.rpc('lg_pick_scan', { p_task: task, p_code: '6111234500017', p_event: ev() })).error, 'line_complete');
  assert.equal((await picker.rpc('lg_pick_scan', { p_task: task, p_code: 'NXI-' + P.oil.slice(0, 8), p_event: ev() })).ok, true, 'code interne');
  assert.equal(await picker2.rpcError('lg_pick_scan', { p_task: task, p_code: 'HUI-1', p_event: ev() }), 'not_your_task');
  // rupture : œufs introuvables → stock 0, montant à encaisser réduit
  const d = await picker.rpc('lg_pick_task_detail', { p_task: task });
  const eggs = d.lines.find((l) => l.name.startsWith('Œufs'));
  assert.equal(eggs.barcode, null);
  assert.equal(await picker.rpcError('lg_pack', { p_task: task, p_event: ev(), p_packages: [{ weight_g: 1 }] }), 'lines_pending');
  assert.equal(await picker.rpcError('lg_pick_short', { p_task: task, p_line: eggs.id, p_qty_found: 1, p_event: ev() }), 'invalid_quantity');
  assert.equal((await picker.rpc('lg_pick_short', { p_task: task, p_line: eggs.id, p_qty_found: 0, p_event: ev() })).task_done, true);
  assert.equal((await admin.rpc('lg_products_list', { p_q: 'Œufs' }))[0].stock, 0);
  const due = (await admin.rpc('lg_order_detail', { p_order: o.id })).amount_due_fcfa;
  assert.equal(due, 2 * 5000 + 1500 + 1500, 'œufs retirés du montant dû');
  // colisage
  const rice = d.lines.find((l) => l.name.startsWith('Riz')); const oil = d.lines.find((l) => l.name.startsWith('Huile'));
  assert.equal(await picker.rpcError('lg_pack', { p_task: task, p_event: ev(), p_packages: [{ items: [] }] }), 'weight_required');
  assert.equal(await picker.rpcError('lg_pack', { p_task: task, p_event: ev(), p_packages: [
    { weight_g: 9000, items: [{ order_item_id: rice.order_item_id, quantity: 1 }] }, { weight_g: 1000, items: [{ order_item_id: oil.order_item_id, quantity: 1 }] }] }), 'package_contents_mismatch');
  assert.equal(await picker.rpcError('lg_pack', { p_task: task, p_event: ev(), p_packages: [{ weight_g: 9000 }, { weight_g: 1000 }] }), 'items_required_for_multi_package');
  const pk = await picker.rpc('lg_pack', { p_task: task, p_event: ev(), p_packages: [
    { weight_g: 10200, length_cm: 40, width_cm: 30, height_cm: 22, items: [{ order_item_id: rice.order_item_id, quantity: 2 }] },
    { weight_g: 1100, length_cm: 10, width_cm: 10, height_cm: 30, handling: ['fragile'], items: [{ order_item_id: oil.order_item_id, quantity: 1 }] }] });
  assert.deepEqual([pk.ok, pk.packages.length, pk.zone], [true, 2, 'Rufisque']);
  const codes = pk.packages.map((p) => p.code);
  assert.match(codes[0], /^NXP-[2-9A-HJKMNP-Z]{6}$/);
  const card = await support.rpc('lg_package_card', { p_code: codes[1] });
  assert.deepEqual(card.package.handling.sort(), ['alimentaire', 'fragile', 'liquide'], 'mentions héritées des fiches');
  assert.equal(card.package.volume_l, 3);
  assert.equal(card.holder.type, 'hub');
  const labels = await picker.rpc('lg_labels', { p_task: task });
  assert.deepEqual([labels[0].zone, labels[0].cod, labels.length], ['Rufisque', true, 2]);
  assert.equal(JSON.stringify(labels).includes('+221'), false, 'aucun téléphone sur l\'étiquette');
  // mise à quai, y compris par les 6 derniers caractères
  const a1 = await picker.rpc('lg_stage', { p_code: codes[0], p_event: ev() });
  assert.deepEqual([a1.ok, a1.order_complete], [true, false]);
  const a2 = await picker.rpc('lg_stage', { p_code: codes[1].slice(-6).toLowerCase(), p_event: ev(), p_manual: true });
  assert.deepEqual([a2.ok, a2.order_complete], [true, true]);
  assert.equal((await picker.rpc('lg_stage', { p_code: codes[1], p_event: ev() })).already, true);
  assert.equal((await picker.rpc('lg_stage', { p_code: 'NXP-ZZZZZZ', p_event: ev() })).error, 'unknown_package');
  assert.deepEqual(await picker.rpc('lg_pick_queue'), [], 'plus rien à préparer');
  const timeline = (await support.rpc('lg_package_card', { p_code: codes[0] })).timeline.map((e) => e.event);
  assert.deepEqual(timeline, ['pack', 'stage']);
  // la page de suivi montre « colis préparé »
  assert.ok((await new Client(env).rpc('lg_track', { p_token: token })).steps.find((s) => s.key === 'prepared').at);
});

test('payée d\'avance : préparation ouverte dès la saisie ; rien à expédier : pas de préparation ; annulation', async () => {
  const env = makeEnv();
  const { picker, support, P } = await setup(env);
  const o = await order(support, [{ product_id: P.soap, quantity: 1 }], { p_payment_method: 'prepaid' });
  const t = await taskOf(picker, o.id);
  assert.ok(t);
  assert.equal((await picker.rpc('lg_labels', { p_task: t.id })).length, 0);
  await support.rpc('lg_product_upsert', { p: { id: P.eggs, name: 'Œufs, plateau de 30', price_fcfa: 3000, weight_g: 2000, is_shippable: false } });
  const service = await order(support, [{ product_id: P.eggs, quantity: 1 }], { p_payment_method: 'prepaid' });
  assert.equal(await taskOf(picker, service.id), undefined, 'rien à transporter');
  // préparée et à quai, puis annulée : la préparation et les colis suivent
  await picker.rpc('lg_pick_take', { p_task: t.id });
  await picker.rpc('lg_pick_scan', { p_task: t.id, p_code: 'SAV-4', p_event: ev() });
  const code = (await picker.rpc('lg_pack', { p_task: t.id, p_event: ev(), p_packages: [{ weight_g: 500 }] })).packages[0].code;
  await picker.rpc('lg_stage', { p_code: code, p_event: ev() });
  assert.equal((await support.rpc('lg_cancel_unconfirmed', { p_order: o.id })).ok, true);
  assert.equal((await support.rpc('lg_package_card', { p_code: code })).package.status, 'cancelled');
  // chargé : plus d'annulation ni d'assurance
  const o2 = await order(support, [{ product_id: P.soap, quantity: 1 }], { p_payment_method: 'prepaid' });
  const t2 = await taskOf(picker, o2.id);
  await picker.rpc('lg_pick_take', { p_task: t2.id });
  await picker.rpc('lg_pick_scan', { p_task: t2.id, p_code: 'SAV-4', p_event: ev() });
  const c2 = (await picker.rpc('lg_pack', { p_task: t2.id, p_event: ev(), p_packages: [{ weight_g: 500 }] })).packages[0].code;
  env.DB.db.prepare("UPDATE packages SET status = 'loaded' WHERE code = ?").run(c2);
  assert.equal((await support.rpc('lg_cancel_unconfirmed', { p_order: o2.id })).error, 'already_shipped');
  assert.equal((await support.rpc('lg_order_insure', { p_order: o2.id, p_value: 5000 })).error, 'already_loaded');
});

test('préparation chez le vendeur (réglage) : le vendeur prépare ses commandes, le colis reste chez lui', async () => {
  const env = makeEnv();
  const { admin, picker } = await setup(env);
  await admin.rpc('lg_set_config', { p: { prep_at_vendor: true } });
  const vendor = await invite(env, admin, 'ndeye@boutique.sn', { role: 'vendor', name: 'Boutique Ndèye' });
  const other = await invite(env, admin, 'autre@boutique.sn', { role: 'vendor', name: 'Autre vendeur' });
  const pr = await vendor.rpc('lg_product_upsert', { p: { name: 'Bissap 1 kg', barcode: '6000000000011', price_fcfa: 2000, weight_g: 1000 } });
  const o = await order(vendor, [{ product_id: pr.id, quantity: 1 }], { p_payment_method: 'prepaid' });
  const q = await vendor.rpc('lg_pick_queue');
  assert.equal(q.length, 1);
  assert.deepEqual(await other.rpc('lg_pick_queue'), [], 'un autre vendeur ne voit pas ses commandes');
  assert.equal(await other.rpcError('lg_pick_take', { p_task: q[0].id }), 'forbidden');
  await vendor.rpc('lg_pick_take', { p_task: q[0].id });
  await vendor.rpc('lg_pick_scan', { p_task: q[0].id, p_code: '6000000000011', p_event: ev() });
  const code = (await vendor.rpc('lg_pack', { p_task: q[0].id, p_event: ev(), p_packages: [{ weight_g: 1000 }] })).packages[0].code;
  const card = await admin.rpc('lg_package_card', { p_code: code });
  assert.deepEqual([card.holder.type, card.holder.name], ['vendor', 'Boutique Ndèye']);
  assert.equal((await vendor.rpc('lg_stage', { p_code: code, p_event: ev() })).ok, true);
  const ov = await vendor.rpc('lg_vendor_overview');
  assert.deepEqual([ov.to_prepare, ov.in_transit, ov.packages.length], [0, 1, 1]);
  assert.ok(o.id && picker);
});

test('entrepôt : emplacements, rangement par lot, chemin de prélèvement FEFO, traçabilité, rebut, inventaire', async () => {
  const env = makeEnv();
  const { picker, dock, support, P } = await setup(env);
  for (const code of ['A-01-1', 'A-02-1', 'A-10-2', 'C-01-0']) await dock.rpc('lg_location_upsert', { p: { code: code.toLowerCase() } });
  assert.equal(await picker.rpcError('lg_location_upsert', { p: { code: 'Z-1' } }), 'forbidden');
  assert.deepEqual((await picker.rpc('lg_locations_list')).map((l) => l.code), ['A-01-1', 'A-02-1', 'A-10-2', 'C-01-0'], 'tri naturel');
  // rangement
  await dock.rpc('lg_put_away', { p_product_code: 'RIZ-5', p_location_code: 'A-01-1', p_qty: 30, p_event: ev() });
  await dock.rpc('lg_put_away', { p_product_code: 'HUI-1', p_location_code: 'A-02-1', p_qty: 40, p_event: ev() });
  await dock.rpc('lg_put_away', { p_product_code: 'NXI-' + P.eggs.slice(0, 8), p_location_code: 'A-10-2', p_qty: 12, p_event: ev() });
  assert.equal((await dock.rpc('lg_put_away', { p_product_code: 'inconnu', p_location_code: 'A-01-1', p_qty: 1, p_event: ev() })).error, 'unknown_product');
  assert.equal((await dock.rpc('lg_put_away', { p_product_code: 'RIZ-5', p_location_code: 'Z-99', p_qty: 1, p_event: ev() })).error, 'unknown_location');
  const a = await dock.rpc('lg_put_away', { p_product_code: 'RIZ-5', p_location_code: 'A-01-1', p_qty: 5, p_event: ev(), p_lot: 'l-loin', p_expires_on: day(60) });
  assert.deepEqual([a.ok, a.lot, a.state, a.qty], [true, 'L-LOIN', 'ok', 35]);
  assert.equal((await dock.rpc('lg_put_away', { p_product_code: 'RIZ-5', p_location_code: 'A-01-1', p_qty: 5, p_event: ev(), p_lot: 'L-PROCHE', p_expires_on: day(10) })).state, 'soon');
  assert.equal((await dock.rpc('lg_put_away', { p_product_code: 'RIZ-5', p_location_code: 'A-01-1', p_qty: 2, p_event: ev(), p_lot: 'L-VIEUX', p_expires_on: day(-1) })).error, 'expired_lot');
  const e2 = ev();
  await dock.rpc('lg_put_away', { p_product_code: 'RIZ-5', p_location_code: 'A-01-1', p_qty: 1, p_event: e2, p_lot: 'L-LOIN', p_expires_on: day(60) });
  await dock.rpc('lg_put_away', { p_product_code: 'RIZ-5', p_location_code: 'A-01-1', p_qty: 1, p_event: e2, p_lot: 'L-LOIN', p_expires_on: day(60) });
  const find = await support.rpc('lg_product_find', { p_q: 'riz' });
  assert.deepEqual(find[0].locations.map((l) => [l.code, l.qty]), [['A-01-1', 41]]);
  assert.deepEqual(find[0].locations[0].lots.map((l) => [l.lot, l.qty]), [['L-PROCHE', 5], ['L-LOIN', 6]]);
  // prélèvement : la consigne indique le lot qui périme le premier, et c'est lui qui sort
  const o = await order(support, [{ product_id: P.rice, quantity: 3 }], { p_payment_method: 'prepaid' });
  const t = await taskOf(picker, o.id);
  const det = await picker.rpc('lg_pick_task_detail', { p_task: t.id });
  assert.deepEqual([det.lines[0].location, det.lines[0].lot.lot, det.lines[0].lot.state], ['A-01-1', 'L-PROCHE', 'soon']);
  await picker.rpc('lg_pick_take', { p_task: t.id });
  for (let i = 0; i < 3; i++) await picker.rpc('lg_pick_scan', { p_task: t.id, p_code: 'RIZ-5', p_event: ev() });
  const lots = Object.fromEntries((await support.rpc('lg_product_find', { p_q: 'riz' }))[0].locations[0].lots.map((l) => [l.lot, l.qty]));
  assert.deepEqual(lots, { 'L-PROCHE': 2, 'L-LOIN': 6 });
  // traçabilité
  const tr = await support.rpc('lg_lot_trace', { p_lot: 'l-proche' });
  assert.deepEqual([tr[0].received, tr[0].in_stock, tr[0].orders.length, tr[0].orders[0].qty, tr[0].orders[0].customer], [5, 2, 1, 3, 'Awa Diop']);
  assert.equal((await support.rpc('lg_lot_trace', { p_lot: 'L-LOIN' }))[0].orders.length, 0);
  // un lot valide proche de sa date passe avant le rayon le plus garni
  await dock.rpc('lg_put_away', { p_product_code: 'HUI-1', p_location_code: 'C-01-0', p_qty: 5, p_event: ev(), p_lot: 'H-1', p_expires_on: day(5) });
  const o2 = await order(support, [{ product_id: P.oil, quantity: 1 }], { p_payment_method: 'prepaid' });
  const t2 = await taskOf(picker, o2.id);
  assert.equal((await picker.rpc('lg_pick_task_detail', { p_task: t2.id })).lines[0].location, 'C-01-0');
  env.DB.db.prepare("UPDATE stock_lots SET expires_on = ? WHERE lot_code = 'H-1'").run(day(-1));
  assert.equal((await picker.rpc('lg_pick_task_detail', { p_task: t2.id })).lines[0].location, 'A-02-1', 'un lot périmé jamais');
  // péremption et rebut
  assert.deepEqual((await dock.rpc('lg_lots_expiring', {})).map((l) => [l.lot, l.state]), [['H-1', 'expired'], ['L-PROCHE', 'soon']]);
  assert.equal((await dock.rpc('lg_lots_expiring', { p_days: 90 })).length, 3);
  const h = (await dock.rpc('lg_lots_expiring', {}))[0];
  assert.equal(await picker.rpcError('lg_lot_discard', { p_lot: h.id, p_qty: 5, p_reason: 'périmé' }), 'forbidden');
  assert.equal(await dock.rpcError('lg_lot_discard', { p_lot: h.id, p_qty: 5, p_reason: ' ' }), 'reason_required');
  assert.equal((await dock.rpc('lg_lot_discard', { p_lot: h.id, p_qty: 9, p_reason: 'périmé', p_event: ev() })).error, 'qty_exceeds');
  const stockBefore = (await support.rpc('lg_products_list', { p_q: 'HUI-1' }))[0].stock;
  assert.deepEqual(await dock.rpc('lg_lot_discard', { p_lot: h.id, p_qty: 5, p_reason: 'périmé', p_event: ev() }).then((r) => [r.ok, r.left]), [true, 0]);
  assert.equal((await support.rpc('lg_products_list', { p_q: 'HUI-1' }))[0].stock, stockBefore - 5);
  // inventaire tournant : jamais compté d'abord ; un rayon compté plus bas ne garde pas plus de lots que d'unités
  const today = await picker.rpc('lg_inventory_today', { p_limit: 10 });
  assert.ok(today.every((l) => l.last_counted_at === null));
  const a01 = today.find((l) => l.code === 'A-01-1');
  const r = await picker.rpc('lg_inventory_count', { p_location: a01.id, p_counts: [{ product_id: P.rice, counted: 4, reason: 'casse' }], p_event: ev() });
  assert.equal(r.gap_units, 38 - 4);
  const after = Object.fromEntries((await support.rpc('lg_product_find', { p_q: 'riz' }))[0].locations[0].lots.map((l) => [l.lot, l.qty]));
  assert.deepEqual(after, { 'L-LOIN': 4 }, 'le lot le plus ancien part d\'abord');
  assert.equal((await dock.rpc('lg_inventory_history', {}))[0].gap, -34);
  assert.equal(await picker.rpcError('lg_inventory_history', {}), 'forbidden');
  assert.equal((await picker.rpc('lg_inventory_today', { p_limit: 10 })).at(-1).code, 'A-01-1', 'compté : passe en dernier');
});

test('vague : 3 commandes en un passage, chaque scan indique le bac', async () => {
  const env = makeEnv();
  const { picker, support, P } = await setup(env);
  const ids = [];
  for (const items of [[{ product_id: P.oil, quantity: 2 }], [{ product_id: P.oil, quantity: 1 }, { product_id: P.soap, quantity: 1 }], [{ product_id: P.soap, quantity: 2 }]]) {
    const o = await order(support, items, { p_payment_method: 'prepaid' });
    ids.push((await taskOf(picker, o.id)).id);
  }
  assert.equal(await picker.rpcError('lg_wave_create', { p_tasks: [ids[0]] }), 'wave_size');
  const w = await picker.rpc('lg_wave_create', { p_tasks: ids });
  assert.deepEqual([w.bins, w.number], [3, 1]);
  const det = await picker.rpc('lg_wave_detail', { p_wave: w.wave_id });
  assert.deepEqual(det.products.map((p) => [p.name, p.ordered]).sort(), [['Huile 1 L', 3], ['Savon de Marseille x4', 3]]);
  const bins = [];
  for (let i = 0; i < 3; i++) bins.push((await picker.rpc('lg_wave_scan', { p_wave: w.wave_id, p_code: 'HUI-1', p_event: ev() })).bin);
  assert.deepEqual(bins, [1, 1, 2]);
  assert.equal((await picker.rpc('lg_wave_scan', { p_wave: w.wave_id, p_code: 'HUI-1', p_event: ev() })).error, 'line_complete');
  assert.equal((await picker.rpc('lg_wave_scan', { p_wave: w.wave_id, p_code: 'RIZ-5', p_event: ev() })).error, 'unexpected_product');
  let last;
  for (let i = 0; i < 3; i++) last = await picker.rpc('lg_wave_scan', { p_wave: w.wave_id, p_code: '6111234500048', p_event: ev() });
  assert.equal(last.wave_done, true);
  assert.equal((await picker.rpc('lg_pack', { p_task: ids[1], p_event: ev(), p_packages: [{ weight_g: 1600 }] })).ok, true);
  assert.equal((await picker.rpc('lg_my_waves')).length, 1, 'deux bacs restent à emballer');
});

test('double contrôle au-delà du seuil de valeur, par une autre personne ; écart → incident ; productivité', async () => {
  const env = makeEnv();
  const { admin, picker, picker2, dock, support, P } = await setup(env);
  await admin.rpc('lg_set_config', { p: { double_check_fcfa: 10000 } });
  const o = await order(support, [{ product_id: P.rice, quantity: 3 }], { p_payment_method: 'prepaid' });
  const t = await taskOf(picker, o.id);
  await picker.rpc('lg_pick_take', { p_task: t.id });
  await picker.rpc('lg_pick_scan', { p_task: t.id, p_code: 'SAV-4', p_event: ev() }); // mauvais produit, compté en productivité
  for (let i = 0; i < 3; i++) await picker.rpc('lg_pick_scan', { p_task: t.id, p_code: 'RIZ-5', p_event: ev() });
  const code = (await picker.rpc('lg_pack', { p_task: t.id, p_event: ev(), p_packages: [{ weight_g: 15500 }] })).packages[0].code;
  assert.deepEqual((await support.rpc('lg_package_card', { p_code: code })).package.handling.sort(), ['alimentaire', 'lourd'], '« lourd » au-delà de 15 kg');
  assert.equal((await picker.rpc('lg_stage', { p_code: code, p_event: ev() })).error, 'double_check_required');
  assert.equal((await picker.rpc('lg_double_check', { p_code: code, p_event: ev() })).error, 'same_person');
  const ko = await picker2.rpc('lg_double_check', { p_code: code, p_ok: false, p_note: 'un sac ouvert', p_event: ev() });
  assert.equal(ko.incident, true);
  assert.deepEqual((await dock.rpc('lg_package_card', { p_code: code })).incidents.map((i) => [i.number, i.kind]), [[1, 'missing_item']]);
  assert.equal((await picker2.rpc('lg_double_check', { p_code: code, p_event: ev() })).ok, true);
  assert.equal((await picker.rpc('lg_stage', { p_code: code, p_event: ev() })).ok, true);
  const prod = await dock.rpc('lg_pick_productivity', {});
  assert.equal(prod.totals.orders, 1);
  assert.deepEqual([prod.pickers[0].name, prod.pickers[0].lines, prod.pickers[0].wrong_scans, prod.pickers[0].check_errors], ['Fatou Préparatrice', 1, 1, 1]);
  assert.equal(prod.packaging[0].size, 'unmeasured');
  assert.equal(await picker.rpcError('lg_pick_productivity', {}), 'forbidden');
});

test('isolation : une autre entreprise ne voit ni ne touche rien du cycle C3', async () => {
  const env = makeEnv();
  const A = await setup(env);
  const B = await setup(env, 'bob@rapide.sn', 'Rapide');
  await A.dock.rpc('lg_location_upsert', { p: { code: 'A-01-1' } });
  await A.dock.rpc('lg_put_away', { p_product_code: 'RIZ-5', p_location_code: 'A-01-1', p_qty: 10, p_event: ev(), p_lot: 'LOT-A', p_expires_on: day(5) });
  const o = await order(A.support, [{ product_id: A.P.rice, quantity: 1 }], { p_payment_method: 'prepaid' });
  const t = await taskOf(A.picker, o.id);
  await A.picker.rpc('lg_pick_take', { p_task: t.id });
  await A.picker.rpc('lg_pick_scan', { p_task: t.id, p_code: 'RIZ-5', p_event: ev() });
  const code = (await A.picker.rpc('lg_pack', { p_task: t.id, p_event: ev(), p_packages: [{ weight_g: 5000 }] })).packages[0].code;
  const lotA = (await A.dock.rpc('lg_lots_expiring', {}))[0];
  const locA = (await A.dock.rpc('lg_locations_list'))[0];
  // B voit vide
  assert.deepEqual(await B.picker.rpc('lg_pick_queue'), []);
  assert.deepEqual(await B.dock.rpc('lg_locations_list'), []);
  assert.deepEqual(await B.dock.rpc('lg_lots_expiring', {}), []);
  assert.deepEqual(await B.support.rpc('lg_lot_trace', { p_lot: 'LOT-A' }), []);
  assert.deepEqual((await B.support.rpc('lg_product_find', { p_q: 'RIZ-5' }))[0].locations, [], 'son propre riz, sans le stock de A');
  assert.deepEqual(await B.picker.rpc('lg_labels', { p_code: code }), []);
  assert.deepEqual(await B.picker.rpc('lg_inventory_today', {}), []);
  // B ne touche à rien (mêmes réponses qu'un objet inexistant)
  assert.equal(await B.picker.rpcError('lg_pick_task_detail', { p_task: t.id }), 'unknown_task');
  assert.equal(await B.picker.rpcError('lg_pick_take', { p_task: t.id }), 'unknown_task');
  assert.equal(await B.picker.rpcError('lg_pick_scan', { p_task: t.id, p_code: 'RIZ-5', p_event: ev() }), 'unknown_task');
  assert.equal((await B.picker.rpc('lg_pick_release', { p_task: t.id })).ok, false);
  assert.equal((await B.picker.rpc('lg_stage', { p_code: code, p_event: ev() })).error, 'unknown_package');
  assert.equal((await B.picker.rpc('lg_double_check', { p_code: code, p_event: ev() })).error, 'unknown_package');
  assert.equal(await B.support.rpcError('lg_package_card', { p_code: code }), 'unknown_package');
  assert.equal(await B.dock.rpcError('lg_lot_discard', { p_lot: lotA.id, p_qty: 1, p_reason: 'vol', p_event: ev() }), 'unknown_lot');
  assert.equal(await B.dock.rpcError('lg_inventory_count', { p_location: locA.id, p_counts: [], p_event: ev() }), 'unknown_location');
  assert.equal(await B.picker.rpcError('lg_wave_create', { p_tasks: [t.id, t.id + 'x'] }), 'unknown_task');
  assert.equal((await B.dock.rpc('lg_put_away', { p_product_code: 'RIZ-5', p_location_code: 'A-01-1', p_qty: 1, p_event: ev() })).error, 'unknown_location');
  // le même code d'emplacement peut exister dans les deux entreprises
  await B.dock.rpc('lg_location_upsert', { p: { code: 'A-01-1' } });
  assert.equal((await B.dock.rpc('lg_locations_list')).length, 1);
  // rien n'a bougé chez A
  assert.equal((await A.picker.rpc('lg_stage', { p_code: code, p_event: ev() })).ok, true);
  assert.equal((await A.dock.rpc('lg_lots_expiring', {}))[0].qty, 9);
});

test('rôles : un chauffeur n\'accède à aucune fonction de préparation ni d\'entrepôt', async () => {
  const env = makeEnv();
  const { admin } = await setup(env);
  const driver = await invite(env, admin, 'moussa@x.sn', { role: 'courier', name: 'Moussa' });
  for (const fn of ['lg_pick_queue', 'lg_pick_task_detail', 'lg_pick_take', 'lg_pick_scan', 'lg_pick_short', 'lg_pack', 'lg_stage', 'lg_labels',
    'lg_double_check', 'lg_wave_create', 'lg_wave_detail', 'lg_wave_scan', 'lg_resolve_short', 'lg_pick_productivity', 'lg_location_upsert',
    'lg_locations_list', 'lg_put_away', 'lg_product_find', 'lg_inventory_today', 'lg_inventory_count', 'lg_inventory_history', 'lg_lots_expiring',
    'lg_lot_discard', 'lg_lot_trace', 'lg_package_card']) {
    const code = await driver.rpcError(fn, { p_task: crypto.randomUUID(), p_code: 'NXP-AAAAAA' });
    assert.ok(['forbidden', 'unknown_task', 'unknown_package'].includes(code), `${fn} → ${code}`);
    if (fn !== 'lg_pick_task_detail' && fn !== 'lg_pick_take' && fn !== 'lg_pick_scan' && fn !== 'lg_pick_short' && fn !== 'lg_pack' && fn !== 'lg_labels' && fn !== 'lg_package_card') {
      assert.equal(code, 'forbidden', fn);
    }
  }
});
