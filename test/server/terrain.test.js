// Cycle C5 — livraison sur le terrain et retours. Comportement porté de test/sql/parcours (09 à 14 : départ signé,
// code client, encaissement exact, échec motivé, fin de tournée, retour au quai), cycle1 (collecte, transferts,
// reprises), cycle5 (contrôle d'un retour), cycle8 (causes de retour), cycle20 (colis attendus au quai),
// cycle21 (arrivée automatique) ; + fichiers de preuve, isolation entre entreprises et rôles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../../server/app.js';
import { makeEnv, Client } from '../helpers/api-client.js';
import { ev, setup, ready, sealedTrip, otpOf, tokenOf } from '../helpers/scenario.js';

test('tournée : départ signé, code client, encaissement exact, échec motivé, fin, retour au quai', async () => {
  const env = makeEnv();
  const S = await setup(env);
  const A = await ready(S, [[S.P.rice, 1]], { method: 'cod', zone: 'Yoff', lat: 14.75, lng: -17.49 });
  const B = await ready(S, [[S.P.oil, 2]], { zone: 'Ouakam', lat: 14.72, lng: -17.49 });
  const trip = await sealedTrip(S, [A, B]);
  // ma journée : le voyage, ses arrêts, le téléphone visible une fois scellé
  const day = await S.driver.rpc('lg_my_day');
  assert.equal(day.trips.length, 1);
  const [sa, sb] = day.trips[0].stops;
  assert.deepEqual([sa.order_id, sb.order_id, day.trips[0].signed], [A.order.id, B.order.id, true]);
  assert.ok(sa.contact_phone && sa.cod_due_fcfa > 0 && sb.cod_due_fcfa === 0);
  assert.equal(await S.picker.rpcError('lg_my_day'), 'not_a_courier');
  // départ : seul le chauffeur du voyage
  assert.equal(await S.driver2.rpcError('lg_trip_start', { p_trip: trip, p_event: ev() }), 'not_your_trip');
  assert.equal((await S.driver.rpc('lg_driver_ping', { p_lat: 14.7, p_lng: -17.4 })).reason, 'off_duty');
  assert.deepEqual(await S.driver.rpc('lg_trip_start', { p_trip: trip, p_event: ev(), p_lat: 14.716, p_lng: -17.467 }), { ok: true });
  assert.equal(await S.driver.rpcError('lg_trip_start', { p_trip: trip, p_event: ev() }), 'trip_not_sealed');
  const card0 = await S.dock.rpc('lg_package_card', { p_code: A.codes[0] });
  assert.equal(card0.package.status, 'out_for_delivery');
  // page de suivi : en route, prénom du livreur, code à donner, nombre d'arrêts avant
  const trA = await new Client(env).rpc('lg_track', { p_token: tokenOf(env, A.order.id) });
  const otp = otpOf(env, A.order.id);
  assert.deepEqual([trA.order.status, trA.delivery.courier, trA.delivery_code, trA.delivery.stops_before], ['in_transit', 'Moussa', otp.code, 0]);
  assert.ok(trA.delivery.position, 'le livreur roule vers ce client : position montrée');
  const trB = await new Client(env).rpc('lg_track', { p_token: tokenOf(env, B.order.id) });
  assert.deepEqual([trB.delivery.stops_before, trB.delivery.position], [1, null]);
  // livraison A : colis, code, photo, montant — chaque refus est une réponse, pas une erreur
  const due = sa.cod_due_fcfa;
  const base = { p_stop: sa.id, p_codes: A.codes, p_photo_path: `${trip}/${sa.id}/photo-1.jpg`, p_payments: [{ method: 'cash', amount: due }], p_lat: 14.75, p_lng: -17.49 };
  assert.equal((await S.driver.rpc('lg_deliver', { ...base, p_event: ev(), p_codes: ['NXP-AAAAAA'], p_otp: otp.code })).error, 'package_mismatch');
  assert.equal((await S.driver.rpc('lg_deliver', { ...base, p_event: ev() })).error, 'proof_required');
  const wrong = otp.code === '0000' ? '1111' : '0000';
  const bad = await S.driver.rpc('lg_deliver', { ...base, p_event: ev(), p_otp: wrong });
  assert.deepEqual([bad.ok, bad.error, bad.attempts_left], [false, 'bad_code', 2]);
  assert.equal(otpOf(env, A.order.id).attempts_left, 2, 'l\'essai raté reste décompté');
  assert.equal((await S.driver.rpc('lg_deliver', { ...base, p_event: ev(), p_otp: otp.code, p_photo_path: null })).error, 'photo_required');
  const short = await S.driver.rpc('lg_deliver', { ...base, p_event: ev(), p_otp: otp.code, p_payments: [{ method: 'cash', amount: due - 100 }] });
  assert.deepEqual([short.error, short.due], ['amount_mismatch', due]);
  assert.equal(await S.driver2.rpcError('lg_deliver', { ...base, p_event: ev(), p_otp: otp.code }), 'not_your_trip');
  const e1 = ev();
  const ok = await S.driver.rpc('lg_deliver', { ...base, p_event: e1, p_otp: otp.code, p_payments: [{ method: 'cash', amount: due - 1000 }, { method: 'wave', amount: 1000, ref: 'W-1' }] });
  assert.deepEqual([ok.ok, ok.far, ok.cash_in_hand_fcfa, ok.next_stop], [true, false, due - 1000, sb.id]);
  assert.equal((await S.driver.rpc('lg_deliver', { ...base, p_event: e1, p_otp: otp.code })).replayed, true, 'rejeu : même résultat');
  assert.equal((await S.driver.rpc('lg_deliver', { ...base, p_event: ev(), p_otp: otp.code })).error, 'stop_closed');
  const oa = env.DB.db.prepare('SELECT status, payment_status FROM orders WHERE id = ?').get(A.order.id);
  assert.deepEqual([oa.status, oa.payment_status], ['delivered', 'paid']);
  assert.equal(env.DB.db.prepare('SELECT deliveries FROM verified_addresses').get().deliveries, 1, 'adresse vérifiée pour la prochaine fois');
  const card = await S.dock.rpc('lg_package_card', { p_code: A.codes[0] });
  assert.deepEqual(card.proofs.map((p) => p.kind).sort(), ['otp', 'photo']);
  assert.equal(card.timeline.find((e) => e.event === 'deliver').trip_number, 1);
  // arrivée automatique : position précise à moins de 80 m de l'arrêt en cours
  const ping = await S.driver.rpc('lg_driver_ping', { p_lat: 14.7202, p_lng: -17.4901, p_accuracy_m: 12 });
  assert.equal(ping.arrived_stop, sb.id);
  // échec B : « client absent » exige un appel d'abord
  const fb = { p_stop: sb.id, p_reason: 'absent', p_photo_path: `${trip}/${sb.id}/echec.jpg` };
  assert.equal((await S.driver.rpc('lg_fail', { ...fb, p_event: ev() })).error, 'call_required');
  assert.equal((await S.driver.rpc('lg_fail', { ...fb, p_event: ev(), p_reason: 'pluie' })).error, 'unknown_reason');
  assert.ok((await S.driver.rpc('lg_stop_call', { p_stop: sb.id })).phone);
  assert.equal((await S.driver.rpc('lg_fail', { ...fb, p_event: ev() })).ok, true);
  const trB2 = await new Client(env).rpc('lg_track', { p_token: tokenOf(env, B.order.id) });
  assert.equal(trB2.failure.reason, 'Client absent');
  // fin de tournée : bilan et alerte « colis à rapporter »
  const fin = await S.driver.rpc('lg_trip_finish', { p_trip: trip, p_event: ev() });
  assert.deepEqual([fin.ok, fin.delivered, fin.failed, fin.packages_to_return, fin.cash_to_remit_fcfa, fin.mobile_collected_fcfa], [true, 1, 1, B.codes, due - 1000, 1000]);
  const exp = await S.dock.rpc('lg_returns_expected');
  assert.deepEqual([exp.length, exp[0].codes], [1, B.codes]);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE kind = 'not_scanned' AND acked_at IS NULL").get().n, 1);
  // retour au quai par une autre personne : l'alerte se lève
  assert.equal(await S.driver.rpcError('lg_return_hub', { p_code: B.codes[0], p_event: ev() }), 'forbidden');
  const rh = await S.dock.rpc('lg_return_hub', { p_code: B.codes[0], p_event: ev() });
  assert.deepEqual([rh.ok, rh.attempts, rh.can_retry, rh.to_vendor], [true, 1, true, false]);
  assert.deepEqual(await S.dock.rpc('lg_returns_expected'), []);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE kind = 'not_scanned' AND acked_at IS NULL").get().n, 0);
  // cause du retour et qui paie ; retour au vendeur : commande annulée, stock rendu
  const cl = await S.support.rpc('lg_return_classify', { p_code: B.codes[0], p_cause: 'customer_absent', p_event: ev() });
  assert.deepEqual([cl.ok, cl.payer, cl.amount_fcfa], [true, 'customer', 1500]);
  assert.equal((await S.support.rpc('lg_return_classify', { p_code: B.codes[0], p_cause: 'inconnue', p_event: ev() })).error, 'unknown_cause');
  const stock0 = env.DB.db.prepare('SELECT stock FROM products WHERE id = ?').get(S.P.oil).stock;
  assert.equal((await S.dock.rpc('lg_return_vendor', { p_code: B.codes[0], p_event: ev() })).ok, true);
  assert.equal(env.DB.db.prepare('SELECT status FROM orders WHERE id = ?').get(B.order.id).status, 'cancelled');
  assert.equal(env.DB.db.prepare('SELECT stock FROM products WHERE id = ?').get(S.P.oil).stock, stock0 + 2);
});

test('plafond d\'espèces, SOS, dépenses et coûts du véhicule', async () => {
  const env = makeEnv();
  const S = await setup(env);
  await S.admin.rpc('lg_set_config', { p: { cash_limit_fcfa: 3000, require_photo: false } });
  const A = await ready(S, [[S.P.rice, 1]], { method: 'cod' });
  const trip = await sealedTrip(S, [A]);
  await S.driver.rpc('lg_trip_start', { p_trip: trip, p_event: ev() });
  const st = (await S.driver.rpc('lg_my_day')).trips[0].stops[0];
  const r = await S.driver.rpc('lg_deliver', { p_stop: st.id, p_event: ev(), p_codes: A.codes, p_signature_path: `${trip}/sig.png`, p_recipient_name: 'Awa',
    p_payments: [{ method: 'cash', amount: st.cod_due_fcfa }] });
  assert.deepEqual([r.ok, r.must_remit], [true, true]);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE kind = 'cash_limit'").get().n, 1);
  assert.equal((await S.driver.rpc('lg_my_day')).cash_in_hand_fcfa, st.cod_due_fcfa);
  const sos = await S.driver.rpc('lg_sos', { p_kind: 'panne', p_lat: 14.7, p_lng: -17.45, p_note: 'pneu crevé' });
  assert.deepEqual([sos.ok, sos.incident], [true, 1]);
  assert.match(env.DB.db.prepare("SELECT message FROM alerts WHERE kind = 'sos'").get().message, /PANNE : Moussa Ndiaye/);
  assert.equal(await S.picker.rpcError('lg_sos', {}), 'not_a_courier');
  assert.equal(await S.driver.rpcError('lg_add_expense', { p_kind: 'carburant', p_amount_fcfa: 0 }), 'invalid_amount');
  assert.equal(await S.driver.rpcError('lg_add_expense', { p_kind: 'cadeau', p_amount_fcfa: 10 }), 'invalid_kind');
  assert.equal((await S.driver.rpc('lg_add_expense', { p_kind: 'carburant', p_amount_fcfa: 5000, p_note: 'plein' })).ok, true);
  assert.equal((await S.dock.rpc('lg_fleet')).find((v) => v.id === S.V.van).costs_30d_fcfa, 5000);
  assert.equal((await S.driver.rpc('lg_trip_finish', { p_trip: trip, p_event: ev() })).ok, true);
});

test('transfert d\'un arrêt entre voyages : reprise du colis par double scan', async () => {
  const env = makeEnv();
  const S = await setup(env);
  await S.admin.rpc('lg_set_config', { p: { require_photo: false } });
  const A = await ready(S, [[S.P.oil, 1]]);
  const B = await ready(S, [[S.P.oil, 1]]);
  const t1 = await sealedTrip(S, [A, B]);
  await S.driver.rpc('lg_trip_start', { p_trip: t1, p_event: ev() });
  const t2 = (await S.disp.rpc('lg_trip_create', { p_vehicle: S.V.moto, p_courier: S.C.ibou })).trip_id;
  const stopB = (await S.driver.rpc('lg_my_day')).trips[0].stops.find((s) => s.order_id === B.order.id);
  assert.equal(await S.driver.rpcError('lg_transfer_stop', { p_stop: stopB.id, p_to_trip: t2, p_event: ev() }), 'forbidden');
  assert.equal(await S.disp.rpcError('lg_transfer_stop', { p_stop: stopB.id, p_to_trip: t1, p_event: ev() }), 'invalid_destination');
  const tr = await S.disp.rpc('lg_transfer_stop', { p_stop: stopB.id, p_to_trip: t2, p_event: ev() });
  assert.deepEqual([tr.ok, tr.packages, tr.to_take], [true, 1, 1]);
  const d2 = await S.driver2.rpc('lg_my_day');
  assert.deepEqual([d2.trips[0].stops.length, d2.trips[0].stops[0].packages[0].to_take], [1, true]);
  assert.equal((await S.driver.rpc('lg_take_transfer', { p_trip: t2, p_code: B.codes[0], p_event: ev() }).catch((e) => ({ error: e.code }))).error, 'forbidden');
  assert.deepEqual(await S.driver2.rpc('lg_take_transfer', { p_trip: t2, p_code: B.codes[0], p_event: ev() }), { ok: true, code: B.codes[0] });
  assert.equal((await S.driver2.rpc('lg_take_transfer', { p_trip: t2, p_code: B.codes[0], p_event: ev() })).error, 'not_to_take');
  // le premier voyage n'a plus que A
  assert.deepEqual((await S.driver.rpc('lg_my_day')).trips[0].stops.map((s) => s.order_id), [A.order.id]);
});

test('reprise chez le client : demande, arrêt de reprise, collecte avec photo, contrôle et remise en vente', async () => {
  const env = makeEnv();
  const S = await setup(env);
  const A = await ready(S, [[S.P.rice, 1]]);
  const t1 = await sealedTrip(S, [A]);
  await S.driver.rpc('lg_trip_start', { p_trip: t1, p_event: ev() });
  const st = (await S.driver.rpc('lg_my_day')).trips[0].stops[0];
  const otp = otpOf(env, A.order.id).code;
  assert.equal((await S.driver.rpc('lg_deliver', { p_stop: st.id, p_event: ev(), p_codes: A.codes, p_otp: otp, p_photo_path: `${t1}/p.jpg`, p_payments: [] })).ok, true);
  await S.driver.rpc('lg_trip_finish', { p_trip: t1, p_event: ev() });
  // demande de retour
  const B = await ready(S, [[S.P.oil, 1]]);
  assert.equal((await S.support.rpc('lg_return_request', { p_order: B.order.id })).error, 'not_delivered');
  assert.equal((await S.support.rpc('lg_return_request', { p_order: A.order.id, p_category: 'Produit défectueux', p_description: 'sac percé' })).ok, true);
  assert.equal((await S.support.rpc('lg_return_request', { p_order: A.order.id })).error, 'already_scheduled');
  const pend = await S.disp.rpc('lg_returns_pending');
  assert.deepEqual([pend.length, pend[0].order_id], [1, A.order.id]);
  // arrêt de reprise dans un nouveau voyage (moto)
  const t2 = (await S.disp.rpc('lg_trip_create', { p_vehicle: S.V.moto, p_courier: S.C.ibou })).trip_id;
  const add = await S.disp.rpc('lg_trip_add_return', { p_trip: t2, p_return: pend[0].id });
  assert.ok(add.ok && add.code.startsWith('NXP-'));
  assert.equal(await S.disp.rpcError('lg_trip_add_return', { p_trip: t2, p_return: pend[0].id }), 'already_scheduled');
  assert.deepEqual(await S.disp.rpc('lg_returns_pending'), []);
  assert.equal((await S.dock.rpc('lg_trip_seal', { p_trip: t2 })).ok, true, 'une reprise ne se charge pas au quai');
  await S.driver2.rpc('lg_trip_start', { p_trip: t2, p_event: ev(), p_signature_path: `${t2}/sig.png` });
  assert.equal((await S.driver2.rpc('lg_collect', { p_stop: add.stop_id, p_event: ev(), p_codes: [add.code] })).error, 'photo_required');
  assert.equal((await S.driver2.rpc('lg_deliver', { p_stop: add.stop_id, p_event: ev(), p_codes: [add.code] })).error, 'not_a_delivery_stop');
  const col = await S.driver2.rpc('lg_collect', { p_stop: add.stop_id, p_event: ev(), p_codes: [add.code], p_photo_path: `${t2}/retour.jpg` });
  assert.deepEqual([col.ok, col.packages], [true, 1]);
  assert.equal((await S.driver2.rpc('lg_trip_finish', { p_trip: t2, p_event: ev() })).ok, true);
  assert.equal((await S.dock.rpc('lg_return_hub', { p_code: add.code, p_event: ev() })).ok, true);
  // contrôle : cause proposée d'après la demande, remise en vente seulement si neuf ou bon
  const insp = await S.dock.rpc('lg_returns_to_inspect');
  assert.deepEqual([insp.length, insp[0].code, insp[0].suggested_cause, insp[0].direction], [1, add.code, 'defective', 'return']);
  assert.equal((await S.dock.rpc('lg_return_inspect', { p_code: add.code, p_condition: 'abime', p_decision: 'restock', p_event: ev() })).error, 'not_resellable');
  const stock0 = env.DB.db.prepare('SELECT stock FROM products WHERE id = ?').get(S.P.rice).stock;
  assert.deepEqual(await S.dock.rpc('lg_return_inspect', { p_code: add.code, p_condition: 'neuf', p_decision: 'restock', p_event: ev() }),
    { ok: true, decision: 'restock', credit_note: `AV-${new Date().getUTCFullYear()}-000001` });
  assert.equal(env.DB.db.prepare('SELECT stock FROM products WHERE id = ?').get(S.P.rice).stock, stock0 + 1);
  assert.deepEqual(await S.dock.rpc('lg_returns_to_inspect'), []);
  // causes : valeurs par défaut, modifiables par l'administrateur seulement
  assert.equal((await S.support.rpc('lg_return_causes')).length, 7);
  assert.equal(await S.support.rpcError('lg_return_cause_save', { p: { code: 'other', payer: 'company' } }), 'forbidden');
  await S.admin.rpc('lg_return_cause_save', { p: { code: 'changed_mind', payer: 'customer', fee_mode: 'fixed', fee_fcfa: 1000 } });
  await S.admin.rpc('lg_return_cause_save', { p: { code: 'colis_vole', label: 'Colis volé', payer: 'company' } });
  const causes = await S.dock.rpc('lg_return_causes');
  assert.deepEqual([causes.length, causes.find((c) => c.code === 'changed_mind').fee_fcfa, causes.at(-1).code], [8, 1000, 'colis_vole']);
});

/** Appel brut de l'API de fichiers (le client de test ne parle que JSON). */
async function file(env, who, method, path, { body, type = 'image/jpeg' } = {}) {
  const h = { 'cf-connecting-ip': who.ip, 'user-agent': 'test' };
  if (who.cookie) h.cookie = who.cookie;
  if (body) h['content-type'] = type;
  const res = await handle(new Request(`https://logistique.test/api/files/${path}`, { method, headers: h, body }), env);
  return { status: res.status, type: res.headers.get('content-type'), bytes: new Uint8Array(await res.arrayBuffer()) };
}

test('fichiers de preuve : écrits par le chauffeur du voyage, lus par l\'équipe, invisibles ailleurs', async () => {
  const env = makeEnv();
  const S = await setup(env);
  const X = await setup(env, 'binta@rapide.sn', 'Rapide Thiès');
  const A = await ready(S, [[S.P.oil, 1]]);
  const trip = await sealedTrip(S, [A]);
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const path = `${trip}/photo-${crypto.randomUUID()}.jpg`;
  assert.equal((await file(env, S.driver, 'PUT', path, { body: jpg })).status, 201);
  assert.equal((await file(env, S.driver, 'PUT', path, { body: jpg })).status, 201, 'renvoi (file d\'attente hors ligne) : sans effet');
  const got = await file(env, S.dock, 'GET', path);
  assert.deepEqual([got.status, got.type, [...got.bytes]], [200, 'image/jpeg', [...jpg]]);
  assert.equal((await file(env, S.support, 'GET', path)).status, 200);
  assert.equal((await file(env, S.driver2, 'PUT', `${trip}/autre.jpg`, { body: jpg })).status, 403, 'pas son voyage');
  assert.equal((await file(env, S.picker, 'GET', path)).status, 403);
  assert.equal((await file(env, S.driver, 'PUT', `${trip}/x.svg`, { body: jpg, type: 'image/svg+xml' })).status, 415);
  assert.equal((await file(env, S.driver, 'PUT', `${trip}/x%3B.jpg`, { body: jpg })).status, 400);
  assert.equal((await file(env, S.driver, 'PUT', `${trip}/a/b/c/d.jpg`, { body: jpg })).status, 400);
  assert.equal((await file(env, S.driver, 'PUT', `${trip}/vide.jpg`, { body: new Uint8Array(0) })).status, 400);
  assert.equal((await file(env, S.driver, 'PUT', `${trip}/gros.jpg`, { body: new Uint8Array(1_600_000) })).status, 413);
  assert.equal((await file(env, new Client(env), 'GET', path)).status, 401);
  // une autre entreprise : « inconnu », comme un fichier qui n'existe pas
  assert.equal((await file(env, X.admin, 'GET', path)).status, 404);
  assert.equal((await file(env, X.admin, 'PUT', path, { body: jpg })).status, 404);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 1);
});

test('isolation : une autre entreprise ne voit ni ne touche rien du cycle C5', async () => {
  const env = makeEnv();
  const S = await setup(env);
  const X = await setup(env, 'binta@rapide.sn', 'Rapide Thiès');
  const A = await ready(S, [[S.P.oil, 1]], { method: 'cod' });
  const trip = await sealedTrip(S, [A]);
  await S.driver.rpc('lg_trip_start', { p_trip: trip, p_event: ev() });
  const st = (await S.driver.rpc('lg_my_day')).trips[0].stops[0];
  const cases = [
    ['lg_trip_start', { p_trip: trip, p_event: ev() }, 'unknown_trip'],
    ['lg_trip_finish', { p_trip: trip, p_event: ev() }, 'unknown_trip'],
    ['lg_stop_call', { p_stop: st.id }, 'unknown_stop'],
    ['lg_stop_arrive', { p_stop: st.id, p_event: ev() }, 'unknown_stop'],
    ['lg_deliver', { p_stop: st.id, p_event: ev(), p_codes: A.codes, p_otp: '0000' }, 'unknown_stop'],
    ['lg_fail', { p_stop: st.id, p_event: ev(), p_reason: 'refused' }, 'unknown_stop'],
    ['lg_collect', { p_stop: st.id, p_event: ev() }, 'unknown_stop'],
    ['lg_transfer_stop', { p_stop: st.id, p_to_trip: trip, p_event: ev() }, 'unknown_stop'],
    ['lg_take_transfer', { p_trip: trip, p_code: A.codes[0], p_event: ev() }, 'unknown_trip'],
    ['lg_return_request', { p_order: A.order.id }, 'unknown_order'],
    ['lg_trip_add_return', { p_trip: trip, p_return: 'x' }, 'unknown_trip'],
  ];
  for (const [fn, args, code] of cases) assert.equal(await X.admin.rpcError(fn, args), code, fn);
  for (const fn of ['lg_return_hub', 'lg_return_vendor', 'lg_return_classify', 'lg_return_inspect']) {
    const r = await X.admin.rpc(fn, { p_code: A.codes[0], p_event: ev(), p_cause: 'other', p_condition: 'bon', p_decision: 'vendor' });
    assert.equal(r.ok, false, fn);
    assert.ok(['unknown_package', 'bad_status'].includes(r.error), fn);
  }
  // le chauffeur de l'autre entreprise : son SOS et sa position restent chez lui
  await X.driver.rpc('lg_sos', { p_kind: 'accident' });
  assert.equal((await X.driver.rpc('lg_driver_ping', { p_lat: 14.7, p_lng: -17.4 })).reason, 'off_duty');
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE kind = 'sos' AND company_id = ?").get(S.admin.companyId).n, 0);
  assert.deepEqual(await X.dock.rpc('lg_returns_expected'), []);
  assert.deepEqual(await X.dock.rpc('lg_returns_to_inspect'), []);
  assert.deepEqual(await X.disp.rpc('lg_returns_pending'), []);
  assert.equal((await X.driver.rpc('lg_my_day')).trips.length, 0);
  // rien n'a bougé chez S
  assert.equal(env.DB.db.prepare('SELECT status FROM trip_stops WHERE id = ?').get(st.id).status, 'en_route');
  assert.equal(otpOf(env, A.order.id).attempts_left, 3);
});

test('rôles : préparateur et service client ne conduisent pas, un chauffeur ne gère pas les retours', async () => {
  const env = makeEnv();
  const S = await setup(env);
  for (const fn of ['lg_transfer_stop', 'lg_trip_add_return', 'lg_return_hub', 'lg_return_vendor', 'lg_return_inspect', 'lg_return_classify',
    'lg_returns_expected', 'lg_returns_to_inspect', 'lg_return_causes', 'lg_return_cause_save', 'lg_return_request', 'lg_returns_pending']) {
    assert.equal(await S.driver.rpcError(fn, { p_event: ev() }), 'forbidden', fn);
  }
  for (const fn of ['lg_my_day', 'lg_driver_ping', 'lg_sos', 'lg_add_expense']) assert.equal(await S.picker.rpcError(fn, { p_lat: 1, p_lng: 1 }), 'not_a_courier', fn);
  for (const fn of ['lg_my_day', 'lg_trip_start', 'lg_deliver', 'lg_fail', 'lg_return_hub']) assert.equal(await new Client(env).rpcError(fn, {}), 'auth', fn);
});
