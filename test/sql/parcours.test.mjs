// Parcours complet (chapitre 04) : commande → facture → préparation → colisage → quai →
// chargement → départ → livraison prouvée → encaissement → clôture. Plus les sorties de route.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, makeOrder, U, IDS } from '../helpers/db.mjs';

let t;
const S = {}; // état partagé entre les étapes, dans l'ordre du parcours

const rpcErr = async (uid, name, args) => {
  try { await t.rpc(uid, name, args); } catch (e) { return e.message; }
  assert.fail(`${name} aurait dû échouer`);
};
const outbox = (key) => t.all('select * from notification_outbox where event_key = $1 order by created_at', [key]);
const fcfa = (eur) => Math.round(eur * 655.957);

before(async () => { t = await createDb(); });

test('01 · une commande à la livraison crée ses lignes et demande confirmation, sans préparation', async () => {
  S.order = await makeOrder(t, { method: 'cod' });
  assert.equal((await t.one('select count(*)::int n from order_items where order_id = $1', [S.order])).n, 3);
  assert.equal((await outbox('lg_cod_confirm')).length, 1);
  assert.equal((await t.one('select count(*)::int n from lg_pick_tasks where order_id = $1', [S.order])).n, 0);
  S.token = (await t.one('select tracking_token from orders where id = $1', [S.order])).tracking_token;
});

test('02 · le client confirme depuis la page de suivi (sans compte) : la préparation s\'ouvre', async () => {
  const r = await t.rpc(null, 'lg_track_confirm', { p_token: S.token, p_yes: true });
  assert.equal(r.ok, true);
  const q = await t.rpc(U.picker, 'lg_pick_queue', {});
  assert.equal(q.length, 1);
  assert.equal(q[0].zone, 'Rufisque');
  S.task = q[0].id;
});

test('03 · verrou : une préparation prise ne peut pas être prise par un autre', async () => {
  await t.rpc(U.picker, 'lg_pick_take', { p_task: S.task });
  assert.match(await rpcErr(U.vendor, 'lg_pick_take', { p_task: S.task }), /task_locked/);
  assert.match(await rpcErr(U.stranger, 'lg_pick_take', { p_task: S.task }), /forbidden/);
  assert.equal((await t.one('select status from orders where id = $1', [S.order])).status, 'processing');
});

test('04 · scan : bon produit, mauvais produit, rejeu hors ligne, code interne', async () => {
  const ev = t.ev();
  const a = await t.rpc(U.picker, 'lg_pick_scan', { p_task: S.task, p_code: '6111234500017', p_event: ev });
  assert.equal(a.ok, true); assert.equal(a.qty_picked, 1); assert.equal(a.qty_ordered, 2);
  const replay = await t.rpc(U.picker, 'lg_pick_scan', { p_task: S.task, p_code: '6111234500017', p_event: ev });
  assert.equal(replay.replayed, true); assert.equal(replay.qty_picked, 1, 'le rejeu ne compte pas deux fois');
  const b = await t.rpc(U.picker, 'lg_pick_scan', { p_task: S.task, p_code: 'riz-5', p_event: t.ev() }); // référence vendeur
  assert.equal(b.line_done, true);
  const wrong = await t.rpc(U.picker, 'lg_pick_scan', { p_task: S.task, p_code: '6111234500048', p_event: t.ev() });
  assert.deepEqual([wrong.ok, wrong.error, wrong.product], [false, 'unexpected_product', 'Savon de Marseille x4']);
  const full = await t.rpc(U.picker, 'lg_pick_scan', { p_task: S.task, p_code: '6111234500017', p_event: t.ev() });
  assert.equal(full.error, 'line_complete');
  const oil = await t.rpc(U.picker, 'lg_pick_scan', { p_task: S.task, p_code: 'NXI-42000000', p_event: t.ev() });
  assert.equal(oil.ok, true);
});

test('05 · rupture partielle : stock remis à zéro, client prévenu avec ses trois choix', async () => {
  const d = await t.rpc(U.picker, 'lg_pick_task_detail', { p_task: S.task });
  const eggs = d.lines.find((l) => l.name.startsWith('Œufs'));
  assert.equal(eggs.barcode, null, 'produit sans code-barres');
  assert.match(await rpcErr(U.picker, 'lg_pick_short', { p_task: S.task, p_line: eggs.id, p_qty_found: 1, p_event: t.ev() }), /invalid_quantity/);
  const r = await t.rpc(U.picker, 'lg_pick_short', { p_task: S.task, p_line: eggs.id, p_qty_found: 0, p_event: t.ev() });
  assert.equal(r.task_done, true);
  assert.equal((await t.one('select stock from products where id = $1', [IDS.eggs])).stock, 0);
  const m = await outbox('lg_stockout');
  assert.equal(m.length, 1); assert.equal(m[0].vars.produit, 'Œufs, plateau de 30');
  S.eggsItem = eggs.order_item_id;
});

test('06 · colisage en 2 colis : poids obligatoire, contenu contrôlé, mentions héritées des fiches', async () => {
  const d = await t.rpc(U.picker, 'lg_pick_task_detail', { p_task: S.task });
  const rice = d.lines.find((l) => l.name.startsWith('Riz')); const oil = d.lines.find((l) => l.name.startsWith('Huile'));
  assert.match(await rpcErr(U.picker, 'lg_pack', { p_task: S.task, p_event: t.ev(), p_packages: [{ items: [] }] }), /weight_required/);
  assert.match(await rpcErr(U.picker, 'lg_pack', { p_task: S.task, p_event: t.ev(), p_packages: [
    { weight_g: 9000, items: [{ order_item_id: rice.order_item_id, quantity: 1 }] },
    { weight_g: 1000, items: [{ order_item_id: oil.order_item_id, quantity: 1 }] }] }), /package_contents_mismatch/);
  const r = await t.rpc(U.picker, 'lg_pack', { p_task: S.task, p_event: t.ev(), p_packages: [
    { weight_g: 10200, length_cm: 40, width_cm: 30, height_cm: 22, items: [{ order_item_id: rice.order_item_id, quantity: 2 }] },
    { weight_g: 1100, length_cm: 10, width_cm: 10, height_cm: 30, handling: ['fragile'], items: [{ order_item_id: oil.order_item_id, quantity: 1 }] }] });
  assert.equal(r.ok, true); assert.equal(r.packages.length, 2); assert.equal(r.zone, 'Rufisque');
  S.codes = r.packages.map((p) => p.code);
  assert.match(S.codes[0], /^NXP-[2-9A-HJKMNP-Z]{6}$/);
  const p2 = await t.one('select handling, volume_l from lg_packages where code = $1', [S.codes[1]]);
  assert.deepEqual(p2.handling.sort(), ['alimentaire', 'fragile', 'liquide']);
  assert.equal(Number(p2.volume_l), 3);
  const labels = await t.rpc(U.picker, 'lg_labels', { p_task: S.task });
  assert.equal(labels[0].zone, 'Rufisque'); assert.equal(labels[0].cod, true);
  assert.equal(JSON.stringify(labels).includes('+221'), false, 'aucun téléphone sur l\'étiquette');
});

test('07 · mise à quai, y compris par saisie de secours des 6 derniers caractères', async () => {
  const a = await t.rpc(U.picker, 'lg_stage', { p_code: S.codes[0], p_event: t.ev() });
  assert.equal(a.ok, true); assert.equal(a.order_complete, false, 'le 2e colis n\'est pas encore à quai');
  const b = await t.rpc(U.picker, 'lg_stage', { p_code: S.codes[1].slice(-6).toLowerCase(), p_event: t.ev(), p_manual: true });
  assert.equal(b.ok, true); assert.equal(b.order_complete, true);
  assert.equal((await t.one('select status from lg_pick_tasks where id = $1', [S.task])).status, 'staged');
});

test('08 · voyage : création, affectation, chargement scanné avec jauge, contrôle de départ', async () => {
  const tr = await t.rpc(U.dispatcher, 'lg_trip_create', { p_vehicle: IDS.van, p_courier: IDS.courier, p_label: 'Dakar → Rufisque' });
  S.trip = tr.trip_id;
  assert.match(await rpcErr(U.dispatcher, 'lg_trip_create', { p_vehicle: IDS.van, p_courier: IDS.courier2 }), /vehicle_busy/);
  const add = await t.rpc(U.dispatcher, 'lg_trip_add_order', { p_trip: S.trip, p_order: S.order });
  assert.equal(add.packages, 2);
  const stop = await t.one('select cod_due_fcfa from lg_trip_stops where id = $1', [add.stop_id]);
  S.due = fcfa(7.62) * 2 + fcfa(2.29) + 1500;
  assert.equal(stop.cod_due_fcfa, S.due, 'les œufs en rupture ne sont pas à payer');
  const g = await t.rpc(U.dock, 'lg_load_package', { p_trip: S.trip, p_code: S.codes[0], p_event: t.ev(), p_device_at: new Date() });
  assert.equal(g.ok, true); assert.equal(g.count, 1); assert.equal(g.weight_pct, 2);
  const dup = await t.rpc(U.dock, 'lg_load_package', { p_trip: S.trip, p_code: S.codes[0], p_event: t.ev(), p_device_at: new Date() });
  assert.equal(dup.error, 'already_loaded');
  const seal = await t.rpc(U.dock, 'lg_trip_seal', { p_trip: S.trip });
  assert.deepEqual([seal.ok, seal.error, seal.codes], [false, 'unloaded_packages', [S.codes[1]]]);
  const g2 = await t.rpc(U.dock, 'lg_load_package', { p_trip: S.trip, p_code: S.codes[1], p_event: t.ev(), p_device_at: new Date() });
  assert.ok(g2.warnings.includes('liquid_upright_bottom'));
  const ok = await t.rpc(U.dock, 'lg_trip_seal', { p_trip: S.trip });
  assert.equal(ok.ok, true); assert.equal(ok.trip.cod_expected_fcfa, S.due);
  assert.equal((await t.one('select status from lg_vehicles where id = $1', [IDS.van])).status, 'on_trip');
});

test('09 · départ : signature exigée, client prévenu avec son code, commande « en route »', async () => {
  assert.match(await rpcErr(U.driver2, 'lg_trip_start', { p_trip: S.trip, p_event: t.ev() }), /not_your_trip/);
  assert.match(await rpcErr(U.driver, 'lg_trip_start', { p_trip: S.trip, p_event: t.ev() }), /signature_required/);
  const r = await t.rpc(U.driver, 'lg_trip_start', { p_trip: S.trip, p_event: t.ev(), p_signature_path: 'lg-proofs/sig/t1.png' });
  assert.equal(r.ok, true);
  assert.equal((await t.one('select status from orders where id = $1', [S.order])).status, 'in_transit');
  const m = await outbox('lg_out_for_delivery');
  S.otp = m.at(-1).vars.code;
  assert.match(S.otp, /^\d{4}$/);
  const hash = await t.one('select code_hash from lg_delivery_codes where order_id = $1', [S.order]);
  assert.notEqual(hash.code_hash, S.otp, 'seule l\'empreinte est stockée');
  const day = await t.rpc(U.driver, 'lg_my_day', {});
  assert.equal(day.trips[0].stops[0].status, 'en_route');
  assert.equal(day.trips[0].stops[0].contact_phone, '+221771112233');
  S.stop = day.trips[0].stops[0].id;
});

test('10 · page de suivi : étapes, montant, rien de trop', async () => {
  await t.rpc(U.driver, 'lg_driver_ping', { p_lat: 14.71, p_lng: -17.3 });
  const r = await t.rpc(null, 'lg_track', { p_token: S.token });
  assert.equal(r.ok, true);
  assert.equal(r.amount_due_fcfa, S.due);
  assert.ok(r.steps.find((s) => s.key === 'shipped').at);
  assert.equal(r.delivery.courier, 'Moussa');
  assert.ok(r.delivery.position, 'position visible : le livreur roule vers ce client');
  assert.equal(JSON.stringify(r).includes('+221'), false, 'pas de téléphone sur la page publique');
  assert.equal((await t.rpc(null, 'lg_track', { p_token: '00000000-0000-4000-a000-000000000000' })).ok, false);
});

test('11 · livraison : colis, code, photo et montant exacts sont exigés ; un code faux use un essai', async () => {
  const base = { p_stop: S.stop, p_codes: S.codes, p_photo_path: 'lg-proofs/p/1.jpg', p_lat: 14.7162, p_lng: -17.2702 };
  const bad = await t.rpc(U.driver, 'lg_deliver', { ...base, p_event: t.ev(), p_otp: S.otp === '0000' ? '1111' : '0000',
    p_payments: [{ method: 'cash', amount: S.due }] });
  assert.deepEqual([bad.ok, bad.error, bad.attempts_left], [false, 'bad_code', 2]);
  const miss = await t.rpc(U.driver, 'lg_deliver', { ...base, p_codes: [S.codes[0]], p_event: t.ev(), p_otp: S.otp,
    p_payments: [{ method: 'cash', amount: S.due }] });
  assert.equal(miss.error, 'package_mismatch');
  const amt = await t.rpc(U.driver, 'lg_deliver', { ...base, p_event: t.ev(), p_otp: S.otp, p_payments: [{ method: 'cash', amount: S.due - 500 }] });
  assert.equal(amt.error, 'amount_mismatch');
  const noProof = await t.rpc(U.driver, 'lg_deliver', { ...base, p_event: t.ev(), p_payments: [{ method: 'cash', amount: S.due }] });
  assert.equal(noProof.error, 'proof_required');
  const ok = await t.rpc(U.driver, 'lg_deliver', { ...base, p_event: t.ev(), p_otp: S.otp,
    p_payments: [{ method: 'cash', amount: S.due - 2000 }, { method: 'wave', amount: 2000, ref: 'WV-889' }] });
  assert.equal(ok.ok, true); assert.equal(ok.far, false); assert.match(ok.invoice, /^FAC-\d{4}-\d{6}$/);
  const o = await t.one('select status, payment_status, delivered_at from orders where id = $1', [S.order]);
  assert.deepEqual([o.status, o.payment_status], ['delivered', 'paid']);
  assert.equal((await t.one("select count(*)::int n from lg_packages where order_id = $1 and status = 'delivered' and holder_type = 'customer'", [S.order])).n, 2);
  assert.ok(await t.one('select * from lg_verified_addresses where phone_key = $1', ['771112233']), 'adresse vérifiée mémorisée');
});

test('12 · facture : lignes réellement livrées, livraison, TVA 18 %, montant en lettres, égale au montant encaissé', async () => {
  const inv = await t.one("select * from invoices where order_id = $1 and type = 'buyer' and credit_of is null", [S.order]);
  assert.equal(Number(inv.amount_ttc), S.due);
  const lines = await t.all('select kind, label, quantity, unit_price_ht, tva_rate from invoice_lines where invoice_id = $1 order by position', [inv.id]);
  assert.deepEqual(lines.map((l) => [l.kind, l.quantity]), [['product', 2], ['product', 1], ['delivery', 1]]);
  assert.equal(Number(inv.amount_ht) + Number(inv.tva), S.due);
  assert.equal(inv.metadata.seller.ninea, '0071234562V2');
  assert.match(inv.metadata.amount_words, /francs CFA$/);
  assert.match(inv.metadata.payment_ref, /wave:WV-889/);
  const doc = await t.rpc(U.accountant, 'lg_invoice_get', { p_invoice: inv.id });
  assert.equal(doc.lines.length, 3);
  assert.match(await rpcErr(U.driver, 'lg_invoice_get', { p_invoice: inv.id }), /forbidden/);
  const viaTrack = await t.rpc(null, 'lg_track_invoice', { p_token: S.token });
  assert.equal(viaTrack.invoice_number, inv.invoice_number);
});

test('13 · fin de tournée, versement avec écart : voyage non rapproché jusqu\'à décision', async () => {
  const fin = await t.rpc(U.driver, 'lg_trip_finish', { p_trip: S.trip, p_event: t.ev() });
  assert.equal(fin.ok, true); assert.equal(fin.cash_to_remit_fcfa, S.due - 2000); assert.equal(fin.mobile_collected_fcfa, 2000);
  assert.match(await rpcErr(U.dispatcher, 'lg_trip_create', { p_vehicle: IDS.tricycle, p_courier: IDS.courier }), /courier_has_open_trip/);
  assert.match(await rpcErr(U.driver, 'lg_remit_cash', { p_trip: S.trip, p_remitted_fcfa: 0 }), /forbidden/);
  const r = await t.rpc(U.cashier, 'lg_remit_cash', { p_trip: S.trip, p_remitted_fcfa: S.due - 2000 - 500, p_event: t.ev() });
  assert.deepEqual([r.gap_fcfa, r.reconciled], [-500, false]);
  const inc = (await t.rpc(U.support, 'lg_incidents_list', {})).find((i) => i.kind === 'cash_gap');
  assert.equal(inc.responsible_type, 'driver');
  await t.rpc(U.support, 'lg_resolve_incident', { p_id: inc.id, p_resolution: 'Retenue sur gains', p_deduction_fcfa: 500 });
  assert.equal((await t.one('select status from lg_trips where id = $1', [S.trip])).status, 'reconciled');
  const earn = await t.all('select amount, type from courier_earnings where courier_id = $1 order by type', [IDS.courier]);
  // 2 colis × 500 F, prime « zéro échec » 1 000 F, retenue de l'écart 500 F
  assert.deepEqual(earn.map((e) => [e.type, e.amount]), [['bonus', 1000], ['delivery', 1000], ['payout', -500]]);
  assert.equal((await t.one('select status from lg_vehicles where id = $1', [IDS.van])).status, 'available');
});

test('14 · échec : appel exigé avant « client absent », photo, retour au quai par une autre personne', async () => {
  const o2 = await makeOrder(t, { method: 'cod', lines: [[IDS.soap, 1]], city: 'Pikine', lat: 14.755, lng: -17.39, name: 'Ibou Fall' });
  await t.rpc(U.support, 'lg_confirm_cod', { p_order: o2 });
  const task = (await t.rpc(U.picker, 'lg_pick_queue', {}))[0].id;
  await t.rpc(U.picker, 'lg_pick_take', { p_task: task });
  await t.rpc(U.picker, 'lg_pick_scan', { p_task: task, p_code: '6111234500048', p_event: t.ev() });
  const code = (await t.rpc(U.picker, 'lg_pack', { p_task: task, p_event: t.ev(), p_packages: [{ weight_g: 700 }] })).packages[0].code;
  await t.rpc(U.dock, 'lg_stage', { p_code: code, p_event: t.ev() });
  const trip = (await t.rpc(U.dispatcher, 'lg_trip_create', { p_vehicle: IDS.moto, p_courier: IDS.courier2, p_zones: ['Pikine'] })).trip_id;
  await t.rpc(U.dock, 'lg_load_package', { p_trip: trip, p_code: code, p_event: t.ev(), p_device_at: new Date() });
  assert.equal((await t.one('select load_zone from lg_trip_packages where trip_id = $1', [trip])).load_zone, 'caisson');
  await t.rpc(U.dock, 'lg_trip_seal', { p_trip: trip, p_signature_path: 'sig.png' });
  await t.rpc(U.driver2, 'lg_trip_start', { p_trip: trip, p_event: t.ev() });
  const stop = (await t.rpc(U.driver2, 'lg_my_day', {})).trips[0].stops[0].id;
  assert.equal((await t.rpc(U.driver2, 'lg_fail', { p_stop: stop, p_event: t.ev(), p_reason: 'absent', p_photo_path: 'f.jpg' })).error, 'call_required');
  const call = await t.rpc(U.driver2, 'lg_stop_call', { p_stop: stop });
  assert.equal(call.phone, '+221771112233');
  assert.equal((await t.rpc(U.driver2, 'lg_fail', { p_stop: stop, p_event: t.ev(), p_reason: 'absent' })).error, 'photo_required');
  const f = await t.rpc(U.driver2, 'lg_fail', { p_stop: stop, p_event: t.ev(), p_reason: 'absent', p_photo_path: 'f.jpg' });
  assert.equal(f.ok, true);
  assert.equal((await outbox('lg_failed')).at(-1).vars.motif, 'client absent');
  await t.rpc(U.driver2, 'lg_trip_finish', { p_trip: trip, p_event: t.ev() });
  const remit = await t.rpc(U.cashier, 'lg_remit_cash', { p_trip: trip, p_remitted_fcfa: 0, p_event: t.ev() });
  assert.equal(remit.reconciled, false, 'colis en échec pas encore rendu');
  assert.match(await rpcErr(U.driver2, 'lg_return_hub', { p_code: code, p_event: t.ev() }), /forbidden/);
  const back = await t.rpc(U.dock, 'lg_return_hub', { p_code: code, p_event: t.ev() });
  assert.deepEqual([back.ok, back.can_retry], [true, true]);
  assert.equal((await t.one('select status from lg_trips where id = $1', [trip])).status, 'reconciled');
  // nouvelle présentation, puis dépassement du nombre de tentatives → retour vendeur
  await t.as(null);
  await t.db.query("update lg_packages set attempts = 2 where code = $1", [code]);
  assert.equal((await t.rpc(U.dock, 'lg_stage', { p_code: code, p_event: t.ev() })).error, 'max_attempts_reached');
  const stockBefore = (await t.one('select stock from products where id = $1', [IDS.soap])).stock;
  const rv = await t.rpc(U.dock, 'lg_return_vendor', { p_code: code, p_event: t.ev(), p_reason: 'Absent deux fois' });
  assert.equal(rv.ok, true);
  assert.equal((await t.one('select stock from products where id = $1', [IDS.soap])).stock, stockBefore + 1);
  assert.equal((await t.one('select status from orders where id = $1', [o2])).status, 'cancelled');
  const card = await t.rpc(U.support, 'lg_package_card', { p_code: code });
  assert.deepEqual(card.timeline.map((e) => e.event), ['pack', 'stage', 'load', 'fail', 'return_hub', 'return_vendor']);
  assert.equal(card.holder.type, 'vendor');
});

test('15 · paiement en ligne : facture émise dès le paiement, avoir automatique sur rupture remboursée', async () => {
  const o3 = await makeOrder(t, { method: 'mobile', lines: [[IDS.fan, 1], [IDS.rice, 1]], city: 'Mermoz' });
  await t.as(null);
  await t.db.query("update orders set payment_status = 'paid', mobile_money_ref = 'PT-123' where id = $1", [o3]);
  const inv = await t.one("select * from invoices where order_id = $1 and credit_of is null", [o3]);
  assert.ok(inv, 'facture émise au paiement');
  assert.equal((await outbox('lg_invoice_issued')).length, 1);
  const task = (await t.one('select id from lg_pick_tasks where order_id = $1', [o3])).id;
  await t.rpc(U.picker, 'lg_pick_take', { p_task: task });
  const fanLine = (await t.rpc(U.picker, 'lg_pick_task_detail', { p_task: task })).lines.find((l) => l.name.startsWith('Ventilateur'));
  await t.rpc(U.picker, 'lg_pick_short', { p_task: task, p_line: fanLine.id, p_qty_found: 0, p_event: t.ev() });
  const r = await t.rpc(U.support, 'lg_resolve_short', { p_order_item: fanLine.order_item_id, p_choice: 'refund' });
  assert.match(r.credit_note, /^AV-\d{4}-000001$/);
  const av = await t.one('select * from invoices where credit_of = $1', [inv.id]);
  assert.equal(Number(av.amount_ttc), -fcfa(27.44));
  assert.match(await rpcErr(U.support, 'lg_resolve_short', { p_order_item: fanLine.order_item_id, p_choice: 'refund' }), /credit_exceeds_invoice/);
  const exp = await t.rpc(U.accountant, 'lg_accounting_export', { p_from: '2026-01-01', p_to: '2030-12-31' });
  assert.ok(exp.sales_journal.some((l) => l.type === 'Avoir'));
  assert.ok(exp.collections_by_method.some((c) => c.mode === 'wave'));
});

test('16 · réponses WhatsApp : OUI confirme, une note de 1 à 5 est enregistrée', async () => {
  const o4 = await makeOrder(t, { method: 'cod', lines: [[IDS.oil, 2]], city: 'Yoff' });
  await t.as(null);
  await t.db.query("update orders set buyer_phone = '+221 77 999 88 77' where id = $1", [o4]);
  await t.db.query("update notification_outbox set recipient = jsonb_set(recipient, '{phone}', '\"+221779998877\"') where vars->>'commande' = upper(left($1::text, 8))", [o4]);
  const r = await t.rpc(null, 'lg_handle_reply', { p_phone: '779998877', p_text: ' Oui ! ' });
  assert.equal(r.action, 'confirmed');
  assert.ok((await t.one('select cod_confirmed_at from orders where id = $1', [o4])).cod_confirmed_at);
  const rate = await t.rpc(null, 'lg_track_rate', { p_token: S.token, p_rating: 5 });
  assert.equal(rate.ok, true);
  assert.equal((await t.one('select rating_count from couriers where id = $1', [IDS.courier])).rating_count, 1);
});

test('17 · le journal de scans est en ajout seul', async () => {
  await t.as(null);
  await assert.rejects(t.db.query("update lg_scan_events set event = 'deliver'"), /ajout seul/);
  await assert.rejects(t.db.query('delete from lg_scan_events'), /ajout seul/);
});

test('18 · pilotage : tableau du jour, indicateurs, veille', async () => {
  const d = await t.rpc(U.dispatcher, 'lg_dashboard', {});
  assert.ok(d.kpis.delivered >= 1);
  assert.ok(Array.isArray(d.trips));
  const k = await t.rpc(U.dispatcher, 'lg_kpis', { p_from: '2026-01-01', p_to: '2030-12-31' });
  assert.equal(Number(k.kpis.failure_rate_pct), 33.3); // 2 colis livrés, 1 échec
  assert.ok(k.kpis.failure_reasons.length >= 1);
  const w = await t.rpc(null, 'lg_watchdog', {});
  assert.equal(w.ok, true);
  assert.match(await rpcErr(U.driver, 'lg_dashboard', {}), /forbidden/);
});

test('19 · montant en lettres', async () => {
  const cases = { 0: 'zéro', 21: 'vingt et un', 71: 'soixante et onze', 77: 'soixante-dix-sept', 80: 'quatre-vingts',
    91: 'quatre-vingt-onze', 200: 'deux cents', 1500: 'mille cinq cents', 23000: 'vingt-trois mille', 80000: 'quatre-vingt mille',
    200000: 'deux cent mille', 1000000: 'un million', 2300450: 'deux millions trois cents quatre cent cinquante' };
  delete cases[2300450];
  for (const [n, w] of Object.entries(cases)) {
    assert.equal(await t.rpc(null, 'lg_words_fr', { p_n: Number(n) }), w, `${n}`);
  }
  assert.equal(await t.rpc(null, 'lg_words_fr', { p_n: 2300450 }), 'deux millions trois cent mille quatre cent cinquante');
});

test('20 · devis au panier et créneaux', async () => {
  await t.rpc(U.admin, 'lg_upsert_rate_card', { p: { max_weight_g: 20000, price_fcfa: 1500 } });
  await t.rpc(U.admin, 'lg_upsert_rate_card', { p: { zone: 'Rufisque', max_weight_g: 20000, price_fcfa: 2500 } });
  await t.rpc(U.admin, 'lg_set_zone', { p_zone: 'Mermoz', p: { free_above_fcfa: 30000 } });
  assert.equal((await t.rpc(null, 'lg_quote', { p_zone: 'Rufisque', p_weight_g: 3000 })).price_fcfa, 2500);
  assert.equal((await t.rpc(null, 'lg_quote', { p_zone: 'Yoff', p_weight_g: 3000 })).price_fcfa, 1500);
  const free = await t.rpc(null, 'lg_quote', { p_zone: 'Mermoz', p_weight_g: 3000, p_subtotal_fcfa: 40000 });
  assert.deepEqual([free.price_fcfa, free.free], [0, true]);
  assert.equal((await t.rpc(null, 'lg_quote', { p_zone: 'Yoff', p_weight_g: 50000 })).error, 'no_rate');
  const s = await t.rpc(U.dispatcher, 'lg_create_slots', { p_zone: 'Yoff', p_from: new Date().toISOString().slice(0, 10), p_days: 2,
    p_times: ['09:00-12:00', '15:00-18:00'], p_capacity: 5 });
  assert.equal(s.slots, 4);
});

test('21 · numérotation des factures continue, sans trou, même après des transactions annulées', async () => {
  await t.as(null);
  const year = new Date().getFullYear();
  // une émission annulée ne doit pas consommer de numéro
  await t.db.exec('begin');
  const o = await makeOrder(t, { method: 'mobile', paid: true, lines: [[IDS.soap, 1]] });
  await t.db.exec('rollback');
  for (let i = 0; i < 2; i++) await makeOrder(t, { method: 'mobile', paid: true, lines: [[IDS.soap, 1]] });
  const nums = (await t.all("select invoice_number from invoices where credit_of is null and invoice_number like 'FAC-%' order by invoice_number"))
    .map((r) => Number(r.invoice_number.split('-')[2]));
  assert.deepEqual(nums, nums.map((_, i) => i + 1), nums.join(','));
  assert.ok((await t.all('select invoice_number from invoices')).every((r) => r.invoice_number.includes(String(year))));
});
