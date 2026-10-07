// Cycle 1 : versement intermédiaire, transfert d'arrêt, retour client, collecte vendeur.
// Point de départ : la journée de démo (voyage A en tournée, voyage B en chargement).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, makeOrder, U, IDS } from '../helpers/db.mjs';
import { runScenario } from '../../src/demo/scenario.js';

let t; let A; let B;
const S = {};
const day = (uid) => t.rpc(uid, 'lg_my_day', {});
const otpOf = async (orderId) => (await t.one(`select vars->>'code' c from notification_outbox where event_key = 'lg_out_for_delivery'
  and vars->>'commande' = upper(left($1::text, 8)) order by created_at desc limit 1`, [orderId])).c;

before(async () => {
  t = await createDb();
  const r = await runScenario((n, a, uid) => t.rpc(uid ?? null, n, a), (q, p) => t.db.query(q, p));
  [A, B] = r.trips;
  S.orders = r.orders;
});

test('versement intermédiaire : réduit l\'encours, jamais plus que les espèces portées', async () => {
  const before = (await day(U.driver)).cash_in_hand_fcfa;
  assert.ok(before > 0);
  const over = await t.rpc(U.cashier, 'lg_cash_drop', { p_trip: A, p_amount_fcfa: before + 1, p_event: t.ev() });
  assert.equal(over.error, 'exceeds_cash');
  await assert.rejects(t.rpc(U.driver, 'lg_cash_drop', { p_trip: A, p_amount_fcfa: 100, p_event: t.ev() }), /forbidden/);
  const r = await t.rpc(U.cashier, 'lg_cash_drop', { p_trip: A, p_amount_fcfa: before, p_event: t.ev(), p_note: 'plafond' });
  assert.equal(r.outstanding, 0);
  assert.equal((await day(U.driver)).cash_in_hand_fcfa, 0);
  const desk = await t.rpc(U.cashier, 'lg_cash_desk', {});
  assert.ok(Array.isArray(desk.on_road));
  S.dropped = before;
});

test('réaffectation : l\'arrêt change de voyage, le colis doit être repris par double scan', async () => {
  // le voyage B part (sans attendre)
  await t.rpc(U.dock, 'lg_trip_seal', { p_trip: B, p_signature_path: 'sig.png' }).then((r) => {
    if (!r.ok) return Promise.all(r.codes.map((c) => t.rpc(U.dock, 'lg_load_package', { p_trip: B, p_code: c, p_event: t.ev(), p_device_at: new Date() })))
      .then(() => t.rpc(U.dock, 'lg_trip_seal', { p_trip: B, p_signature_path: 'sig.png' }));
    return r;
  });
  await t.rpc(U.driver2, 'lg_trip_start', { p_trip: B, p_event: t.ev() });
  const stopA = (await day(U.driver)).trips[0].stops.find((s) => s.status === 'en_route');
  const r = await t.rpc(U.dispatcher, 'lg_transfer_stop', { p_stop: stopA.id, p_to_trip: B, p_event: t.ev() });
  assert.deepEqual([r.ok, r.to_take], [true, 1]);
  const mine = (await day(U.driver2)).trips[0].stops.find((s) => s.id === stopA.id);
  assert.ok(mine, 'l\'arrêt apparaît chez Ibrahima');
  assert.equal(mine.packages[0].to_take, true);
  assert.ok(!(await day(U.driver)).trips[0].stops.some((s) => s.id === stopA.id), 'et disparaît chez Moussa');
  const code = mine.packages[0].code;
  const base = { p_stop: stopA.id, p_codes: [code], p_otp: await otpOf(mine.order_id), p_photo_path: 'x.jpg',
    p_payments: mine.cod_due_fcfa ? [{ method: 'cash', amount: mine.cod_due_fcfa }] : [] };
  assert.equal((await t.rpc(U.driver2, 'lg_deliver', { ...base, p_event: t.ev() })).error, 'transfer_pending');
  assert.equal((await t.rpc(U.driver2, 'lg_take_transfer', { p_trip: B, p_code: code, p_event: t.ev() })).ok, true);
  const ok = await t.rpc(U.driver2, 'lg_deliver', { ...base, p_event: t.ev() });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const card = await t.rpc(U.support, 'lg_package_card', { p_code: code });
  assert.deepEqual(card.timeline.map((e) => e.event).slice(-3), ['load', 'load', 'deliver'], 'deux chargements tracés : quai puis transfert');
});

test('retour demandé par le client : reprise, réception au hub, retour vendeur avec avoir', async () => {
  const delivered = (await t.all("select id from orders where status = 'delivered' order by delivered_at limit 1"))[0].id;
  await t.as(null);
  const { rows } = await t.db.query(`insert into return_requests (order_id, buyer_name, vendor_name, category, description, status)
    values ($1, 'Client', 'Boutique Ndèye', 'defectueux', 'Ne fonctionne pas', 'approved') returning id`, [delivered]);
  const pend = await t.rpc(U.dispatcher, 'lg_returns_pending', {});
  assert.equal(pend.length, 1);
  const add = await t.rpc(U.dispatcher, 'lg_trip_add_return', { p_trip: B, p_return: rows[0].id });
  assert.match(add.code, /^NXP-/);
  assert.equal((await t.rpc(U.dispatcher, 'lg_returns_pending', {})).length, 0);
  assert.equal((await t.rpc(U.driver2, 'lg_collect', { p_stop: add.stop_id, p_event: t.ev(), p_codes: [add.code] })).error, 'photo_required');
  const c = await t.rpc(U.driver2, 'lg_collect', { p_stop: add.stop_id, p_event: t.ev(), p_codes: [add.code], p_photo_path: 'r.jpg' });
  assert.equal(c.ok, true);
  assert.equal((await t.rpc(U.driver2, 'lg_receive', { p_code: add.code, p_event: t.ev() }).catch((e) => e.message)), 'forbidden');
  const rec = await t.rpc(U.dock, 'lg_receive', { p_code: add.code, p_event: t.ev() });
  assert.deepEqual([rec.ok, rec.next], [true, 'return_vendor']);
  const rv = await t.rpc(U.dock, 'lg_return_vendor', { p_code: add.code, p_event: t.ev(), p_reason: 'Retour client' });
  assert.match(rv.credit_note ?? '', /^AV-/, 'avoir émis sur la facture de livraison');
  assert.equal((await t.one('select status from orders where id = $1', [delivered])).status, 'delivered', 'la commande reste livrée');
});

test('collecte vendeur : prêt chez le vendeur → tournée → reçu au hub → à affecter', async () => {
  const o = await makeOrder(t, { method: 'mobile', paid: true, lines: [[IDS.soap, 1]], city: 'Yoff' });
  const task = (await t.one('select id from lg_pick_tasks where order_id = $1', [o])).id;
  await t.rpc(U.vendor, 'lg_pick_take', { p_task: task });
  await t.rpc(U.vendor, 'lg_pick_scan', { p_task: task, p_code: 'SAV-4', p_event: t.ev() });
  const code = (await t.rpc(U.vendor, 'lg_pack', { p_task: task, p_event: t.ev(), p_packages: [{ weight_g: 700 }] })).packages[0].code;
  const st = await t.rpc(U.vendor, 'lg_stage', { p_code: code, p_event: t.ev() });
  assert.equal(st.ok, true);
  assert.equal((await t.one('select hub_id, holder_type from lg_packages where code = $1', [code])).holder_type, 'vendor');
  const pend = await t.rpc(U.dispatcher, 'lg_pickups_pending', {});
  assert.deepEqual([pend.length, pend[0].packages], [1, 1]);
  const dash0 = await t.rpc(U.dispatcher, 'lg_dashboard', {});
  assert.ok(!dash0.to_assign.some((x) => x.order_id === o), 'pas « à affecter » tant qu\'il est chez le vendeur');
  const add = await t.rpc(U.dispatcher, 'lg_trip_add_pickup', { p_trip: B, p_vendor: U.vendor });
  const col = await t.rpc(U.driver2, 'lg_collect', { p_stop: add.stop_id, p_event: t.ev(), p_codes: [code] });
  assert.equal(col.ok, true);
  const rec = await t.rpc(U.dock, 'lg_receive', { p_code: code, p_event: t.ev(), p_weight_g: 720 });
  assert.equal(rec.next, 'staged');
  const dash = await t.rpc(U.dispatcher, 'lg_dashboard', {});
  assert.ok(dash.to_assign.some((x) => x.order_id === o), 'reçu au hub : prêt à affecter');
  assert.equal((await t.one('select weight_g from lg_packages where code = $1', [code])).weight_g, 720, 'repesé à la réception');
});

test('rapprochement : bloqué tant qu\'un colis collecté n\'est pas reçu ; versement net des espèces déjà déposées', async () => {
  // voyage A : on termine les arrêts restants en échec, on rend les colis, on verse
  let d = await day(U.driver);
  for (const s of d.trips[0].stops.filter((x) => ['pending', 'en_route', 'arrived'].includes(x.status))) {
    await t.rpc(U.driver, 'lg_stop_call', { p_stop: s.id });
    const r = await t.rpc(U.driver, 'lg_fail', { p_stop: s.id, p_event: t.ev(), p_reason: 'absent', p_photo_path: 'f.jpg' });
    assert.equal(r.ok, true);
  }
  const fin = await t.rpc(U.driver, 'lg_trip_finish', { p_trip: A, p_event: t.ev() });
  assert.equal(fin.cash_dropped_fcfa, S.dropped);
  const remit = await t.rpc(U.cashier, 'lg_remit_cash', { p_trip: A, p_remitted_fcfa: fin.cash_to_remit_fcfa, p_event: t.ev() });
  assert.deepEqual([remit.gap_fcfa, remit.reconciled], [0, false], 'des colis en échec sont encore chez le chauffeur');
  for (const c of fin.packages_to_return) await t.rpc(U.dock, 'lg_return_hub', { p_code: c, p_event: t.ev() });
  assert.equal((await t.one('select status from lg_trips where id = $1', [A])).status, 'reconciled');
});

test('cycle 2 · messages : texte final dans la file, modèle modifiable, désactivable', async () => {
  const sent = await t.one("select vars from notification_outbox where event_key = 'lg_out_for_delivery' order by created_at desc limit 1");
  assert.match(sent.vars.texte, /^Votre colis est en route avec \w+\. Arrivée vers \d\dh\d\d\. Votre code de livraison : \d{4}\./);
  assert.ok(!/\{[a-z_]+\}/.test(sent.vars.texte), 'aucune variable non remplie');
  const appr = await t.one("select vars from notification_outbox where event_key = 'lg_approaching' order by created_at desc limit 1");
  assert.match(appr.vars.texte, /Montant à préparer : (\d{1,3}( \d{3})*|0) F/, 'montant avec séparateur de milliers');
  const list = await t.rpc(U.support, 'lg_templates_list', {});
  assert.equal(list.length, 12); // annexe B + gérant + code pour un tiers (cycle 5)
  await assert.rejects(t.rpc(U.driver, 'lg_templates_list', {}), /forbidden/);
  await t.rpc(U.support, 'lg_template_save', { p_event: 'lg_prepared', p_body_fr: 'Coucou {prenom}, {colis} colis prêts !', p_active: true });
  assert.equal(await t.rpc(U.support, 'lg_preview_message', { p_event: 'lg_prepared', p_body: null, p_vars: { prenom: 'Awa', colis: 2 } }), 'Coucou Awa, 2 colis prêts !');
  await t.rpc(U.support, 'lg_template_save', { p_event: 'lg_cod_confirm', p_body_fr: list[0].body_fr, p_active: false });
  const before = (await t.one("select count(*)::int n from notification_outbox where event_key = 'lg_cod_confirm'")).n;
  await makeOrder(t, { method: 'cod', lines: [[IDS.oil, 1]] });
  assert.equal((await t.one("select count(*)::int n from notification_outbox where event_key = 'lg_cod_confirm'")).n, before, 'modèle désactivé : rien envoyé');
  const q = await t.rpc(U.support, 'lg_outbox_recent', { p_limit: 5 });
  assert.equal(q.length, 5);
  assert.match(q[0].to, /\*\*\*/, 'numéro masqué');
});
