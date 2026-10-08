// Cycle C6 — caisse, rapprochement, gains, factures et avoirs, export comptable, relevés vendeurs, incidents.
// Comportement porté de test/sql/parcours (12 facture, 13 versement avec écart, 14 rapprochement après retour,
// 15 avoir), cycle1 (versement intermédiaire), cycle14 (indemnité plafonnée, accord du client), cycle16 (relevés)
// + isolation entre entreprises et rôles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, Client, invite } from '../helpers/api-client.js';
import { ev, setup, ready, sealedTrip, otpOf, tokenOf } from '../helpers/scenario.js';

const YEAR = new Date().getUTCFullYear();
const db = (env) => env.DB.db;

/** Départ, puis chaque arrêt livré (code client, photo, montant exact en espèces sauf `pay` donné). */
async function deliverAll(S, trip, driver = S.driver, { pay = null, failOrders = [] } = {}) {
  await driver.rpc('lg_trip_start', { p_trip: trip, p_event: ev() });
  for (const st of (await driver.rpc('lg_my_day')).trips.find((t) => t.id === trip).stops) {
    if (failOrders.includes(st.order_id)) {
      await driver.rpc('lg_stop_call', { p_stop: st.id });
      assert.equal((await driver.rpc('lg_fail', { p_stop: st.id, p_event: ev(), p_reason: 'absent', p_photo_path: `${trip}/f.jpg` })).ok, true);
      continue;
    }
    const codes = st.packages.map((p) => p.code);
    const r = await driver.rpc('lg_deliver', { p_stop: st.id, p_event: ev(), p_codes: codes, p_otp: otpOf(S.env, st.order_id).code, p_photo_path: `${trip}/p.jpg`,
      p_payments: pay ? pay(st.cod_due_fcfa) : st.cod_due_fcfa ? [{ method: 'cash', amount: st.cod_due_fcfa }] : [] });
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  return driver.rpc('lg_trip_finish', { p_trip: trip, p_event: ev() });
}

test('facture à la livraison, versement avec écart, retenue, rapprochement et gains du chauffeur', async () => {
  const env = makeEnv();
  const S = await setup(env);
  await S.admin.rpc('lg_set_config', { p: { company_ninea: '0071234562V2', company_address: 'Liberté 6, Dakar' } });
  const A = await ready(S, [[S.P.rice, 2], [S.P.oil, 1]], { method: 'cod' });
  const trip = await sealedTrip(S, [A]);
  const due = 2 * 5000 + 1500 + 1500;
  const fin = await deliverAll(S, trip, S.driver, { pay: (d) => [{ method: 'cash', amount: d - 2000 }, { method: 'wave', amount: 2000, ref: 'WV-889' }] });
  // facture : lignes livrées + livraison, TVA 18 %, TTC = montant encaissé, montant en lettres, numéro sans trou
  const list = await S.accountant.rpc('lg_invoices_list', {});
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].number, list[0].ttc, list[0].kind, list[0].payment_method], [`FAC-${YEAR}-000001`, due, 'invoice', 'cod']);
  const doc = await S.accountant.rpc('lg_invoice_get', { p_invoice: list[0].id });
  assert.deepEqual(doc.lines.map((l) => [l.kind, l.quantity]), [['product', 2], ['product', 1], ['delivery', 1]]);
  assert.equal(Math.round((doc.amount_ht + doc.tva) * 100) / 100, due);
  assert.deepEqual([doc.metadata.seller.name, doc.metadata.seller.ninea, doc.metadata.issuer_mode], ['Express Dakar', '0071234562V2', 'company']);
  assert.equal(doc.metadata.amount_words, 'Treize mille francs CFA');
  assert.match(doc.metadata.payment_ref, /wave:WV-889/);
  assert.equal(await S.driver.rpcError('lg_invoice_get', { p_invoice: list[0].id }), 'forbidden');
  const anon = new Client(env);
  assert.equal((await anon.rpc('lg_track', { p_token: tokenOf(env, A.order.id) })).invoice.number, `FAC-${YEAR}-000001`);
  assert.equal((await anon.rpc('lg_track_invoice', { p_token: tokenOf(env, A.order.id) })).invoice_number, `FAC-${YEAR}-000001`);
  // caisse : espèces attendues, versement avec écart → incident, voyage non rapproché
  assert.deepEqual([fin.cash_to_remit_fcfa, fin.mobile_collected_fcfa], [due - 2000, 2000]);
  const desk = await S.cashier.rpc('lg_cash_desk');
  assert.deepEqual([desk.to_close.length, desk.to_close[0].cash_to_remit_fcfa, desk.to_close[0].remitted], [1, due - 2000, false]);
  assert.equal(await S.driver.rpcError('lg_remit_cash', { p_trip: trip, p_remitted_fcfa: 0 }), 'forbidden');
  const r = await S.cashier.rpc('lg_remit_cash', { p_trip: trip, p_remitted_fcfa: due - 2500, p_event: ev(), p_note: 'manque 500' });
  assert.deepEqual([r.ok, r.gap_fcfa, r.reconciled], [true, -500, false]);
  assert.match(r.receipt, /^Reçu voyage 1 — 10500 F versés le \d\d\/\d\d\/\d{4} \d\d:\d\d$/);
  assert.equal(await S.cashier.rpcError('lg_remit_cash', { p_trip: trip, p_remitted_fcfa: 1, p_event: ev() }), 'already_remitted');
  assert.equal((await S.cashier.rpc('lg_cash_desk')).recent[0].gap_fcfa, -500);
  const inc = (await S.support.rpc('lg_incidents_list')).find((i) => i.kind === 'cash_gap');
  assert.deepEqual([inc.responsible_type, inc.trip_number, inc.has_order], ['driver', 1, false]);
  assert.equal(db(env).prepare("SELECT status FROM trips WHERE id = ?").get(trip).status, 'completed');
  // décision : retenue de l'écart sur les gains → voyage rapproché, gains crédités, véhicule libéré
  const res = await S.support.rpc('lg_resolve_incident', { p_id: inc.id, p_resolution: 'Retenue sur gains', p_deduction_fcfa: 500 });
  assert.deepEqual([res.ok, res.closed], [true, true]);
  assert.equal(db(env).prepare("SELECT status FROM trips WHERE id = ?").get(trip).status, 'reconciled');
  const earn = db(env).prepare('SELECT type, amount_fcfa FROM courier_earnings ORDER BY type').all().map((e) => [e.type, e.amount_fcfa]);
  // un colis livré × 500 F, prime « zéro échec » 1 000 F, retenue de l'écart 500 F
  assert.deepEqual(earn, [['bonus', 1000], ['delivery', 500], ['payout', -500]]);
  const day = await S.driver.rpc('lg_my_day');
  assert.deepEqual([day.earnings_pending_fcfa, day.week.earnings, day.cash_in_hand_fcfa], [1000, 1000, 0]);
  assert.equal((await S.dock.rpc('lg_fleet')).find((v) => v.id === S.V.van).status, 'available');
  assert.equal((await S.support.rpc('lg_resolve_incident', { p_id: inc.id, p_resolution: 'x' })).error, 'already_closed');
  assert.deepEqual((await S.cashier.rpc('lg_cash_desk')).to_close, []);
});

test('versement intermédiaire au plafond ; rapprochement seulement après le retour des colis en échec', async () => {
  const env = makeEnv();
  const S = await setup(env);
  await S.admin.rpc('lg_set_config', { p: { cash_limit_fcfa: 3000 } });
  const A = await ready(S, [[S.P.rice, 1]], { method: 'cod' });
  const B = await ready(S, [[S.P.oil, 1]], { method: 'cod' });
  const trip = await sealedTrip(S, [A, B]);
  await S.driver.rpc('lg_trip_start', { p_trip: trip, p_event: ev() });
  const [sa, sb] = (await S.driver.rpc('lg_my_day')).trips[0].stops;
  await S.driver.rpc('lg_deliver', { p_stop: sa.id, p_event: ev(), p_codes: A.codes, p_otp: otpOf(env, A.order.id).code, p_photo_path: 'p.jpg',
    p_payments: [{ method: 'cash', amount: sa.cod_due_fcfa }] });
  const desk = await S.cashier.rpc('lg_cash_desk');
  assert.deepEqual([desk.on_road.length, desk.on_road[0].outstanding_fcfa, desk.on_road[0].over_limit], [1, sa.cod_due_fcfa, true]);
  assert.equal((await S.cashier.rpc('lg_cash_drop', { p_trip: trip, p_amount_fcfa: sa.cod_due_fcfa + 1, p_event: ev() })).error, 'exceeds_cash');
  assert.equal(await S.driver.rpcError('lg_cash_drop', { p_trip: trip, p_amount_fcfa: 100 }), 'forbidden');
  const drop = await S.cashier.rpc('lg_cash_drop', { p_trip: trip, p_amount_fcfa: sa.cod_due_fcfa, p_event: ev(), p_note: 'plafond' });
  assert.deepEqual([drop.ok, drop.outstanding], [true, 0]);
  assert.equal((await S.driver.rpc('lg_my_day')).cash_in_hand_fcfa, 0);
  assert.equal(db(env).prepare("SELECT COUNT(*) AS n FROM alerts WHERE kind = 'cash_limit' AND acked_at IS NULL").get().n, 0, 'alerte de plafond levée');
  // B en échec : le colis reste chez le chauffeur
  await S.driver.rpc('lg_stop_call', { p_stop: sb.id });
  await S.driver.rpc('lg_fail', { p_stop: sb.id, p_event: ev(), p_reason: 'absent', p_photo_path: 'f.jpg' });
  const fin = await S.driver.rpc('lg_trip_finish', { p_trip: trip, p_event: ev() });
  assert.deepEqual([fin.cash_to_remit_fcfa, fin.cash_dropped_fcfa], [0, sa.cod_due_fcfa]);
  const remit = await S.cashier.rpc('lg_remit_cash', { p_trip: trip, p_remitted_fcfa: 0, p_event: ev() });
  assert.deepEqual([remit.gap_fcfa, remit.reconciled], [0, false], 'colis en échec pas encore rendu');
  assert.equal((await S.dock.rpc('lg_return_hub', { p_code: B.codes[0], p_event: ev() })).ok, true);
  assert.equal(db(env).prepare('SELECT status FROM trips WHERE id = ?').get(trip).status, 'reconciled');
  // un échec : pas de prime « zéro échec »
  assert.deepEqual(db(env).prepare('SELECT type, amount_fcfa FROM courier_earnings').all().map((e) => [e.type, e.amount_fcfa]), [['delivery', 500]]);
});

test('avoirs : par ligne ou geste global, jamais plus que facturé ; export comptable', async () => {
  const env = makeEnv();
  const S = await setup(env);
  const A = await ready(S, [[S.P.rice, 2], [S.P.oil, 1]]);
  const trip = await sealedTrip(S, [A]);
  await deliverAll(S, trip);
  const inv = (await S.accountant.rpc('lg_invoices_list', {}))[0];
  const doc = await S.accountant.rpc('lg_invoice_get', { p_invoice: inv.id });
  const rice = doc.lines.find((l) => l.kind === 'product' && l.quantity === 2);
  assert.equal(await S.support.rpcError('lg_credit_note_manual', { p_invoice: inv.id, p_lines: [], p_reason: 'x', p_amount_fcfa: 100 }), 'forbidden');
  assert.equal(await S.accountant.rpcError('lg_credit_note_manual', { p_invoice: inv.id, p_lines: [], p_reason: ' ', p_amount_fcfa: 100 }), 'reason_required');
  assert.equal(await S.accountant.rpcError('lg_credit_note_manual', { p_invoice: inv.id, p_lines: [], p_reason: 'rien' }), 'empty_credit_note');
  const c1 = await S.accountant.rpc('lg_credit_note_manual', { p_invoice: inv.id, p_lines: [{ order_item_id: rice.order_item_id, quantity: 1 }], p_reason: 'Sac percé' });
  assert.deepEqual([c1.ok, c1.number, c1.ttc], [true, `AV-${YEAR}-000001`, -5000]);
  assert.equal(await S.accountant.rpcError('lg_credit_note_manual', { p_invoice: inv.id, p_lines: [{ order_item_id: rice.order_item_id, quantity: 2 }], p_reason: 'Encore' }),
    'credit_exceeds_invoice');
  assert.equal(await S.accountant.rpcError('lg_credit_note_manual', { p_invoice: inv.id, p_lines: [], p_reason: 'Trop', p_amount_fcfa: 1e6 }), 'credit_exceeds_invoice');
  assert.equal(await S.accountant.rpcError('lg_credit_note_manual', { p_invoice: c1.id, p_lines: [], p_reason: 'avoir d\'avoir', p_amount_fcfa: 10 }), 'unknown_invoice');
  const c2 = await S.accountant.rpc('lg_credit_note_manual', { p_invoice: inv.id, p_lines: [], p_reason: 'Geste commercial', p_amount_fcfa: 1000 });
  assert.equal(c2.number, `AV-${YEAR}-000002`, 'séquence des avoirs sans trou malgré les refus');
  const after = await S.accountant.rpc('lg_invoice_get', { p_invoice: inv.id });
  assert.deepEqual(after.credits.map((c) => c.ttc), [-5000, -1000]);
  assert.equal(after.status, 'paid');
  // tout le reste crédité : facture « remboursée »
  const rest = inv.ttc - 6000;
  await S.accountant.rpc('lg_credit_note_manual', { p_invoice: inv.id, p_lines: [], p_reason: 'Remboursement', p_amount_fcfa: rest });
  assert.equal((await S.accountant.rpc('lg_invoice_get', { p_invoice: inv.id })).status, 'refunded');
  const today = new Date().toISOString().slice(0, 10);
  const exp = await S.accountant.rpc('lg_accounting_export', { p_from: today, p_to: today });
  assert.deepEqual(exp.sales_journal.map((l) => l.type), ['Facture', 'Avoir', 'Avoir', 'Avoir']);
  assert.equal(exp.sales_journal.reduce((s, l) => s + l.ttc, 0), 0);
  assert.equal(exp.vat_by_rate[0].taux, 18);
  assert.equal(await S.support.rpcError('lg_accounting_export', { p_from: today, p_to: today }), 'forbidden');
  assert.equal((await S.support.rpc('lg_invoices_list', { p_q: 'AV-' })).length, 3);
});

test('relevé de reversement d\'un vendeur : commission, retenues, espèces rapprochées seulement', async () => {
  const env = makeEnv();
  const S = await setup(env);
  await S.admin.rpc('lg_set_config', { p: { commission_pct: 10 } });
  const vendor = await invite(env, S.admin, 'ndeye@boutique.sn', { role: 'vendor', name: 'Boutique Ndèye' });
  const pr = await vendor.rpc('lg_product_upsert', { p: { name: 'Bissap', sku: 'BIS-1', price_fcfa: 2000, weight_g: 1000 } });
  const o = await vendor.rpc('lg_order_create', { p_customer: { name: 'Client', phone: '770001122' }, p_zone: 'Yoff', p_items: [{ product_id: pr.id, quantity: 3 }], p_payment_method: 'cod' });
  await S.support.rpc('lg_confirm_cod', { p_order: o.id });
  const t = (await S.picker.rpc('lg_pick_queue')).find((x) => x.order_id === o.id);
  await S.picker.rpc('lg_pick_take', { p_task: t.id });
  for (let i = 0; i < 3; i++) await S.picker.rpc('lg_pick_scan', { p_task: t.id, p_code: 'BIS-1', p_event: ev() });
  const pk = await S.picker.rpc('lg_pack', { p_task: t.id, p_event: ev(), p_packages: [{ weight_g: 3000 }] });
  await S.picker.rpc('lg_stage', { p_code: pk.packages[0].code, p_event: ev() });
  const trip = await sealedTrip(S, [{ order: o, codes: [pk.packages[0].code] }]);
  const fin = await deliverAll(S, trip);
  const today = new Date().toISOString().slice(0, 10);
  let s = await vendor.rpc('lg_vendor_statement', { p_from: today, p_to: today, p_vendor: S.admin.user.id });
  assert.equal(s.vendor_id, vendor.user.id, 'un vendeur ne voit que son relevé');
  assert.deepEqual([s.totals.goods_fcfa, s.totals.commission_fcfa, s.totals.net_payable_fcfa, s.totals.pending_fcfa, s.totals.pending_orders], [6000, 600, 0, 5400, 1]);
  await S.cashier.rpc('lg_remit_cash', { p_trip: trip, p_remitted_fcfa: fin.cash_to_remit_fcfa, p_event: ev() });
  s = await S.accountant.rpc('lg_vendor_statement', { p_from: today, p_to: today, p_vendor: vendor.user.id });
  assert.deepEqual([s.totals.net_payable_fcfa, s.orders[0].settled, s.commission_rate], [5400, true, 10]);
  // retenue : frais de retour à la charge du vendeur
  db(env).prepare("INSERT INTO return_charges (company_id, package_id, order_id, cause, payer, amount_fcfa, vendor_id, classified_at) VALUES (?, ?, ?, 'vendor_error', 'vendor', 1500, ?, ?)")
    .run(S.admin.companyId, db(env).prepare('SELECT id FROM packages WHERE code = ?').get(pk.packages[0].code).id, o.id, vendor.user.id, new Date().toISOString());
  const all = await S.accountant.rpc('lg_vendor_statements', { p_from: today, p_to: today });
  assert.deepEqual([all.length, all[0].vendor, all[0].deductions_fcfa, all[0].net_payable_fcfa], [1, 'Boutique Ndèye', 1500, 3900]);
  assert.equal(await S.accountant.rpcError('lg_vendor_statement', { p_from: today, p_to: today }), 'vendor_required');
  assert.equal(await S.driver.rpcError('lg_vendor_statement', { p_from: today, p_to: today }), 'forbidden');
  assert.equal(await vendor.rpcError('lg_vendor_statements', { p_from: today, p_to: today }), 'forbidden');
  // le vendeur voit ses factures, pas celles des autres
  assert.equal((await vendor.rpc('lg_invoices_list', {})).length, 1);
});

test('incidents : ouverture, indemnité plafonnée, accord du client depuis sa page de suivi, avoir', async () => {
  const env = makeEnv();
  const S = await setup(env);
  await S.admin.rpc('lg_set_config', { p: { uninsured_cap_fcfa: 3000 } });
  const A = await ready(S, [[S.P.rice, 1]]);
  const trip = await sealedTrip(S, [A]);
  await deliverAll(S, trip);
  assert.equal(await S.picker.rpcError('lg_open_incident', { p_kind: 'volcan', p_description: 'x' }), 'invalid_kind');
  const o = await S.support.rpc('lg_open_incident', { p_kind: 'damaged', p_description: 'Sac déchiré à la livraison', p_code: A.codes[0] });
  assert.deepEqual([o.ok, o.number], [true, 1]);
  const inc = (await S.support.rpc('lg_incidents_list')).find((i) => i.id === o.id);
  assert.deepEqual([inc.trip_number, inc.cap_fcfa, inc.has_order, inc.package], [1, 3000, true, A.codes[0]]);
  const over = await S.support.rpc('lg_resolve_incident', { p_id: o.id, p_resolution: 'Remboursement', p_compensation_fcfa: 4000 });
  assert.deepEqual([over.ok, over.error, over.cap_fcfa, over.insured], [false, 'over_cap', 3000, false]);
  const r = await S.support.rpc('lg_resolve_incident', { p_id: o.id, p_resolution: 'Remboursement du sac', p_compensation_fcfa: 2500, p_credit_note: true });
  assert.deepEqual([r.ok, r.closed, r.awaiting_customer, r.credit_note], [true, false, true, `AV-${YEAR}-000001`]);
  assert.equal((await S.support.rpc('lg_incidents_list')).find((i) => i.id === o.id).credit_note, `AV-${YEAR}-000001`);
  const anon = new Client(env); const tok = tokenOf(env, A.order.id);
  const props = await anon.rpc('lg_track_incidents', { p_token: tok });
  assert.deepEqual(props.map((p) => p.compensation_fcfa), [2500]);
  assert.deepEqual(await anon.rpc('lg_track_incident_answer', { p_token: tok, p_incident: o.id, p_accept: true }), { ok: true, closed: true });
  assert.equal((await anon.rpc('lg_track_incident_answer', { p_token: tok, p_incident: o.id, p_accept: false })).error, 'nothing_to_answer');
  assert.deepEqual(await anon.rpc('lg_track_incidents', { p_token: tok }), []);
  assert.equal((await S.support.rpc('lg_incidents_list', { p_status: 'closed' })).length, 1);
  // un chauffeur signale une panne : alerte SOS
  assert.equal((await S.driver.rpc('lg_open_incident', { p_kind: 'vehicle_breakdown', p_description: 'Embrayage', p_trip: trip })).ok, true);
  assert.equal(db(env).prepare("SELECT COUNT(*) AS n FROM alerts WHERE kind = 'sos'").get().n, 1);
  assert.equal(await S.driver.rpcError('lg_resolve_incident', { p_id: o.id, p_resolution: 'x' }), 'forbidden');
});

test('isolation : une autre entreprise ne voit ni ne touche rien du cycle C6', async () => {
  const env = makeEnv();
  const S = await setup(env);
  const X = await setup(env, 'binta@rapide.sn', 'Rapide Thiès');
  const A = await ready(S, [[S.P.rice, 1]], { method: 'cod' });
  const trip = await sealedTrip(S, [A]);
  await deliverAll(S, trip);
  const inv = (await S.accountant.rpc('lg_invoices_list', {}))[0];
  await S.support.rpc('lg_open_incident', { p_kind: 'late', p_description: 'Retard', p_code: A.codes[0] });
  const inc = (await S.support.rpc('lg_incidents_list'))[0];
  const today = new Date().toISOString().slice(0, 10);
  for (const [who, fn, args, code] of [
    [X.accountant, 'lg_invoice_get', { p_invoice: inv.id }, 'unknown_invoice'],
    [X.accountant, 'lg_credit_note_manual', { p_invoice: inv.id, p_lines: [], p_reason: 'x', p_amount_fcfa: 100 }, 'unknown_invoice'],
    [X.cashier, 'lg_remit_cash', { p_trip: trip, p_remitted_fcfa: 0, p_event: ev() }, 'unknown_trip'],
    [X.cashier, 'lg_cash_drop', { p_trip: trip, p_amount_fcfa: 100, p_event: ev() }, 'unknown_trip'],
    [X.support, 'lg_resolve_incident', { p_id: inc.id, p_resolution: 'x' }, 'unknown_incident'],
    [X.support, 'lg_open_incident', { p_kind: 'late', p_description: 'x', p_code: A.codes[0] }, 'unknown_package'],
    [X.accountant, 'lg_vendor_statement', { p_from: today, p_to: today, p_vendor: S.admin.user.id }, 'unknown_vendor'],
  ]) assert.equal(await who.rpcError(fn, args), code, fn);
  assert.deepEqual(await X.accountant.rpc('lg_invoices_list', {}), []);
  assert.deepEqual(await X.support.rpc('lg_incidents_list', { p_status: null }), []);
  assert.deepEqual(await X.accountant.rpc('lg_vendor_statements', { p_from: today, p_to: today }), []);
  const desk = await X.cashier.rpc('lg_cash_desk');
  assert.deepEqual([desk.to_close, desk.on_road, desk.recent], [[], [], []]);
  const exp = await X.accountant.rpc('lg_accounting_export', { p_from: today, p_to: today });
  assert.deepEqual([exp.sales_journal, exp.collections_by_method], [[], []]);
  // le jeton d'une commande ne donne accès qu'aux incidents de cette commande
  const B = await ready(X, [[X.P.rice, 1]]);
  assert.equal((await new Client(env).rpc('lg_track_incident_answer', { p_token: tokenOf(env, B.order.id), p_incident: inc.id, p_accept: true })).error, 'nothing_to_answer');
  assert.equal(db(env).prepare('SELECT status FROM incidents WHERE id = ?').get(inc.id).status, 'open');
  assert.equal(db(env).prepare('SELECT status FROM trips WHERE id = ?').get(trip).status, 'completed');
});

test('rôles : caisse au caissier, factures au comptable et au service client', async () => {
  const env = makeEnv();
  const S = await setup(env);
  for (const fn of ['lg_cash_desk', 'lg_cash_drop', 'lg_remit_cash', 'lg_credit_note_manual', 'lg_accounting_export', 'lg_vendor_statements', 'lg_incidents_list', 'lg_resolve_incident']) {
    assert.equal(await S.picker.rpcError(fn, { p_event: ev() }), 'forbidden', fn);
  }
  for (const fn of ['lg_invoices_list', 'lg_invoice_get']) assert.equal(await S.driver.rpcError(fn, { p_invoice: 'x' }), 'forbidden', fn);
  assert.equal(await S.cashier.rpcError('lg_remit_cash', { p_trip: 'inconnu', p_remitted_fcfa: 0 }), 'unknown_trip');
  assert.equal(await S.accountant.rpcError('lg_cash_drop', { p_trip: 'x', p_amount_fcfa: 1 }), 'forbidden', 'le comptable consulte la caisse, il ne l\'encaisse pas');
  assert.deepEqual((await S.accountant.rpc('lg_cash_desk')).to_close, []);
});
