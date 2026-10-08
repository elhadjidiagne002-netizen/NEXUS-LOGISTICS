// Cycle C2 — commandes, zones, tarifs, suppléments, assurance, suivi client, API par clé, isolation entre entreprises.
// Comportement porté de test/sql/cycle10 (suppléments), cycle14 (assurance), cycle3/parcours (confirmation, suivi).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, Client, invite } from '../helpers/api-client.js';
import { REGISTRY } from '../../server/rpc/index.js';

const hhmm = (h) => new Date(Date.now() + h * 3600000).toISOString().slice(11, 16); // Dakar = UTC
const customer = { name: 'Aminata Diop', phone: '+221 77 123 45 67', address: 'Villa 12, Mermoz', landmark: 'face pharmacie' };
const items = [{ name: 'Huile 5 L', quantity: 2, unit_price_fcfa: 6000, weight_g: 1000 }];

/** Entreprise prête à vendre : zones de Dakar, tarifs standard 1 500 F et express 3 000 F, une gratuité à Mermoz. */
async function shop(env, email = 'awa@express.sn', company = 'Express Dakar') {
  const a = new Client(env); await a.register(email, { company });
  await a.rpc('lg_zones_seed');
  await a.rpc('lg_upsert_rate_card', { p: { max_weight_g: 20000, price_fcfa: 1500 } });
  await a.rpc('lg_upsert_rate_card', { p: { service: 'express', max_weight_g: 20000, price_fcfa: 3000, lead_hours: 3 } });
  await a.rpc('lg_set_zone', { p_zone: 'Mermoz', p: { free_above_fcfa: 30000 } });
  return a;
}
const order = (c, extra = {}) => c.rpc('lg_order_create', { p_customer: customer, p_zone: 'Yoff', p_items: items, ...extra });

test('zones et grille : démarrage rapide, réglages, devis par zone et par poids', async () => {
  const env = makeEnv();
  const a = await shop(env);
  const p = await a.rpc('lg_pricing');
  assert.equal(p.zones.length, 42);
  assert.equal(p.rate_cards.length, 2);
  assert.equal((await a.rpc('lg_zones_seed')).added, 0, 'rien en double');
  const q = await a.rpc('lg_quote', { p_zone: 'Yoff', p_weight_g: 3000 });
  assert.deepEqual([q.ok, q.price_fcfa, q.vehicle_kind, q.surcharges], [true, 1500, 'moto', []]);
  assert.ok(q.promised_at.endsWith('T19:00:00.000Z') || q.service === 'express');
  assert.equal((await a.rpc('lg_quote', { p_zone: 'Yoff', p_weight_g: 30000 })).error, 'no_rate', 'au-delà de la tranche');
  assert.equal((await a.rpc('lg_quote', { p_zone: 'Lune', p_weight_g: 1000 })).error, 'unknown_zone');
  // livraison offerte au-delà du panier
  assert.deepEqual(await a.rpc('lg_quote', { p_zone: 'Mermoz', p_weight_g: 1000, p_subtotal_fcfa: 40000 }).then((r) => [r.price_fcfa, r.free]), [0, true]);
  // zone fermée
  await a.rpc('lg_set_zone', { p_zone: 'Ngor', p: { served: false } });
  assert.equal((await a.rpc('lg_quote', { p_zone: 'Ngor', p_weight_g: 1000 })).error, 'zone_not_served');
  // zone déduite de la position (près du centre de Yoff)
  assert.equal((await a.rpc('lg_quote', { p_lat: 14.756, p_lng: -17.472, p_weight_g: 1000 })).zone, 'Yoff');
  // tarif propre à une zone : prioritaire sur « toutes zones »
  await a.rpc('lg_upsert_rate_card', { p: { zone: 'Rufisque', max_weight_g: 20000, price_fcfa: 2500 } });
  assert.equal((await a.rpc('lg_quote', { p_zone: 'Rufisque', p_weight_g: 1000 })).price_fcfa, 2500);
  // prix au km depuis le lieu de l'entreprise
  await a.rpc('lg_hub_upsert', { p_id: (await a.rpc('lg_me')).hubs[0].id, p_name: 'Dépôt', p_lat: 14.716, p_lng: -17.467 });
  await a.rpc('lg_upsert_rate_card', { p: { zone: 'Thiès', max_weight_g: 20000, price_fcfa: 1000, per_km_fcfa: 50 } });
  const t = await a.rpc('lg_quote', { p_zone: 'Thiès', p_weight_g: 1000 });
  assert.ok(t.distance_km > 60 && t.price_fcfa > 4000, `Thiès à ${t.distance_km} km : ${t.price_fcfa} F`);
  // refus de valeurs invalides
  assert.equal(await a.rpcError('lg_set_zone', { p_zone: 'Yoff', p: { cutoff_time: '25:00' } }), 'invalid_time');
  assert.equal(await a.rpcError('lg_upsert_rate_card', { p: { zone: 'Lune', max_weight_g: 1000, price_fcfa: 1 } }), 'unknown_zone');
  // désactiver un tarif
  await a.rpc('lg_upsert_rate_card', { p: { id: p.rate_cards[0].id, active: false } });
  assert.equal((await a.rpc('lg_pricing')).rate_cards.length, 3);
});

test('devis public depuis le site d\'une boutique : adresse publique de l\'entreprise', async () => {
  const env = makeEnv();
  await shop(env);
  const anon = new Client(env);
  const q = await anon.rpc('lg_quote', { p_company: 'express-dakar', p_zone: 'Yoff', p_weight_g: 3000 });
  assert.equal(q.price_fcfa, 1500);
  assert.equal((await anon.rpc('lg_quote', { p_company: 'inconnue', p_zone: 'Yoff', p_weight_g: 3000 })).error, 'unknown_company');
  assert.equal((await anon.rpc('lg_quote', { p_zone: 'Yoff', p_weight_g: 3000 })).error, 'unknown_company');
});

test('suppléments : désactivés par défaut, pluie déclarée par le répartiteur, nuit à cheval sur minuit (cycle 10)', async () => {
  const env = makeEnv();
  const a = await shop(env);
  const disp = await invite(env, a, 'aissatou@express.sn', { staff: ['dispatcher'], name: 'Aïssatou' });
  const driver = await invite(env, a, 'moussa@express.sn', { role: 'courier', name: 'Moussa' });
  const quote = async (zone, extra = {}) => (await a.rpc('lg_quote', { p_zone: zone, p_weight_g: 3000, ...extra }));
  assert.deepEqual(await quote('Yoff').then((q) => [q.price_fcfa, q.base_fcfa, q.surcharges]), [1500, 1500, []]);
  assert.deepEqual((await disp.rpc('lg_surcharges_list')).map((s) => [s.code, s.in_force]), [['night', false], ['rain', false]]);
  // pluie
  assert.equal(await driver.rpcError('lg_surcharge_declare', { p_code: 'rain', p_hours: 2 }), 'forbidden');
  assert.equal(await disp.rpcError('lg_surcharge_declare', { p_code: 'rain', p_hours: 48 }), 'invalid_hours');
  assert.equal(await disp.rpcError('lg_surcharge_declare', { p_code: 'grele', p_hours: 2 }), 'unknown_surcharge');
  const d = await disp.rpc('lg_surcharge_declare', { p_code: 'rain', p_hours: 2, p_zones: ['Yoff', 'Mermoz'] });
  assert.ok(new Date(d.until) > new Date());
  assert.deepEqual(await quote('Yoff').then((q) => [q.price_fcfa, q.surcharges.map((s) => s.code)]), [2000, ['rain']]);
  assert.equal((await quote('Rufisque')).price_fcfa, 1500, 'zone non concernée');
  assert.deepEqual(await quote('Mermoz', { p_subtotal_fcfa: 40000 }).then((q) => [q.price_fcfa, q.surcharges]), [0, []], 'offerte : pas de supplément');
  // la déclaration expire d'elle-même
  env.DB.db.prepare("UPDATE surcharges SET until = '2000-01-01T00:00:00.000Z' WHERE code = 'rain'").run();
  assert.equal((await quote('Yoff')).price_fcfa, 1500);
  await disp.rpc('lg_surcharge_declare', { p_code: 'rain', p_hours: 1 });
  assert.equal((await quote('Rufisque')).price_fcfa, 2000, 'sans zone : partout');
  await disp.rpc('lg_surcharge_declare', { p_code: 'rain', p_hours: 0 });
  assert.equal((await quote('Rufisque')).price_fcfa, 1500, 'levée');
  // nuit
  assert.equal(await disp.rpcError('lg_surcharge_save', { p: { code: 'night', active: true } }), 'forbidden');
  await a.rpc('lg_surcharge_save', { p: { code: 'night', label: 'Supplément nuit', amount_fcfa: 1000, active: true, start_time: hhmm(-1), end_time: hhmm(1), services: ['express'] } });
  assert.equal((await quote('Yoff', { p_service: 'express' })).price_fcfa, 4000);
  assert.equal((await quote('Yoff')).price_fcfa, 1500, 'service standard non concerné');
  await a.rpc('lg_surcharge_save', { p: { code: 'night', amount_fcfa: 1000, active: true, start_time: hhmm(2), end_time: hhmm(1), services: null } });
  assert.equal((await quote('Yoff')).price_fcfa, 2500, 'fenêtre à cheval sur minuit');
  await a.rpc('lg_surcharge_save', { p: { code: 'night', amount_fcfa: 1000, active: true, start_time: hhmm(1), end_time: hhmm(2), services: null } });
  assert.equal((await quote('Yoff')).price_fcfa, 1500);
  assert.equal(await a.rpcError('lg_surcharge_save', { p: { code: 'X!' } }), 'invalid_code');
});

test('assurance : prime au devis, plafond assurable, commande assurée après coup (cycle 14)', async () => {
  const env = makeEnv();
  const a = await shop(env);
  const q = await a.rpc('lg_quote', { p_zone: 'Yoff', p_weight_g: 3000, p_declared_value_fcfa: 100000 });
  assert.deepEqual([q.insurance_fee_fcfa, q.total_fcfa], [2000, q.price_fcfa + 2000]);
  assert.equal((await a.rpc('lg_quote', { p_zone: 'Yoff', p_weight_g: 3000, p_declared_value_fcfa: 5000 })).insurance_fee_fcfa, 300);
  assert.equal((await a.rpc('lg_quote', { p_zone: 'Yoff', p_weight_g: 3000, p_declared_value_fcfa: 2000000 })).error, 'value_too_high');
  const o = await order(a);
  assert.equal(o.total_fcfa, 12000 + 1500);
  const r = await a.rpc('lg_order_insure', { p_order: o.id, p_value: 200000 });
  assert.deepEqual([r.insured_value_fcfa, r.insurance_fee_fcfa], [200000, 4000]);
  assert.equal((await a.rpc('lg_order_detail', { p_order: o.id })).total_fcfa, 12000 + 1500 + 4000);
  assert.equal((await a.rpc('lg_order_insure', { p_order: o.id, p_value: 3000000 })).error, 'value_too_high');
  // commande partie : plus d'assurance
  env.DB.db.prepare("UPDATE orders SET status = 'in_transit' WHERE id = ?").run(o.id);
  assert.equal((await a.rpc('lg_order_insure', { p_order: o.id, p_value: 10000 })).error, 'already_loaded');
  const driver = await invite(env, a, 'moussa@express.sn', { role: 'courier' });
  assert.equal(await driver.rpcError('lg_order_insure', { p_order: o.id, p_value: 1000 }), 'forbidden');
});

test('saisie d\'une commande : numéro sans trou, client mémorisé, devis appliqué, rejeu sans doublon', async () => {
  const env = makeEnv();
  const a = await shop(env);
  const ev = crypto.randomUUID();
  const o1 = await order(a, { p_event: ev });
  assert.deepEqual([o1.number, o1.zone, o1.delivery_fee_fcfa, o1.total_fcfa, o1.amount_due_fcfa], [1, 'Yoff', 1500, 13500, 13500]);
  assert.match(o1.tracking_url, /\/suivi\/[\w-]{24}$/);
  assert.deepEqual(await order(a, { p_event: ev }), { ...o1, replayed: true }, 'même p_event : même résultat, pas de 2e commande');
  // une erreur ne consomme pas de numéro
  assert.equal(await a.rpcError('lg_order_create', { p_customer: customer, p_zone: 'Lune', p_items: items }), 'unknown_zone');
  assert.equal(await a.rpcError('lg_order_create', { p_customer: { name: 'X', phone: '12' }, p_zone: 'Yoff', p_items: items }), 'invalid_customer');
  assert.equal(await a.rpcError('lg_order_create', { p_customer: customer, p_zone: 'Yoff', p_items: [] }), 'no_items');
  assert.equal(await a.rpcError('lg_order_create', { p_customer: customer, p_zone: 'Yoff', p_items: [{ name: 'X', quantity: 0 }] }), 'invalid_quantity');
  const o2 = await order(a, { p_payment_method: 'prepaid', p_delivery_fee_fcfa: 1000 });
  assert.deepEqual([o2.number, o2.delivery_fee_fcfa, o2.amount_due_fcfa], [2, 1000, 0], 'payé d\'avance : rien à encaisser');
  // même client (numéro écrit autrement) : une seule fiche
  await order(a, { p_customer: { ...customer, phone: '771234567' } });
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 1);
  // produit du catalogue : nom, prix et poids repris de la fiche
  const pr = await a.rpc('lg_product_upsert', { p: { name: 'Riz 10 kg', price_fcfa: 7500, weight_g: 10000, handling: ['lourd', 'pirate'] } });
  const o4 = await a.rpc('lg_order_create', { p_customer: customer, p_zone: 'Yoff', p_items: [{ product_id: pr.id, quantity: 1 }], p_service: 'express' });
  assert.equal(o4.error, undefined);
  const det = await a.rpc('lg_order_detail', { p_order: o4.id });
  assert.deepEqual([det.items[0].product_name, det.items[0].unit_price_fcfa, det.weight_g, det.number], ['Riz 10 kg', 7500, 10000, 4]);
  assert.equal(await a.rpcError('lg_order_create', { p_customer: customer, p_zone: 'Yoff', p_items: [{ product_id: crypto.randomUUID(), quantity: 1 }] }), 'unknown_product');
  const list = await a.rpc('lg_orders_list', { p_status: 'open' });
  assert.deepEqual(list.map((o) => o.number), [4, 3, 2, 1]);
  assert.equal((await a.rpc('lg_orders_list', { p_q: '2' })).length >= 1, true);
});

test('import par fichier : lignes valides créées, erreurs signalées par ligne, référence jamais en double', async () => {
  const env = makeEnv();
  const a = await shop(env);
  const support = await invite(env, a, 'coumba@express.sn', { staff: ['support'], name: 'Coumba' });
  const rows = [
    { external_ref: 'WC-1', customer: customer, zone: 'yoff', items },
    { external_ref: 'WC-2', customer: { name: 'Ousmane', phone: '+221 78 000 00 01' }, zone: 'Médina', items, payment_method: 'prepaid' },
    { external_ref: 'WC-3', customer: { name: 'Sans téléphone', phone: '' }, zone: 'Yoff', items },
    { external_ref: 'WC-1', customer, zone: 'Yoff', items },
  ];
  const r = await support.rpc('lg_order_import', { p_orders: rows });
  assert.equal(r.created, 2);
  assert.deepEqual(r.errors.map((e) => [e.line, e.error]), [[3, 'invalid_customer'], [4, 'duplicate_ref']]);
  assert.equal(r.results[0].zone, 'Yoff', 'zone retrouvée sans tenir compte de la casse');
  const again = await support.rpc('lg_order_import', { p_orders: rows.slice(0, 2) });
  assert.deepEqual([again.created, again.duplicates], [0, 2]);
  assert.equal(await support.rpcError('lg_order_import', { p_orders: Array.from({ length: 51 }, () => rows[0]) }), 'too_many_orders');
  const nums = (await a.rpc('lg_orders_list', { p_status: 'all' })).map((o) => o.number).sort();
  assert.deepEqual(nums, [1, 2]);
  // 50 commandes d'un coup : lectures groupées, un seul lot d'écriture
  const before = env.DB.calls;
  const big = Array.from({ length: 50 }, (_, i) => ({ external_ref: `B-${i}`, customer: { name: `Client ${i}`, phone: `77${String(1000000 + i)}` }, zone: 'Yoff', items }));
  assert.equal((await support.rpc('lg_order_import', { p_orders: big })).created, 50);
  assert.ok(env.DB.calls - before <= 10, `${env.DB.calls - before} allers-retours vers D1`);
});

test('confirmation du paiement à la livraison, numéro banni, annulation (cycle 3)', async () => {
  const env = makeEnv();
  const a = await shop(env);
  const support = await invite(env, a, 'coumba@express.sn', { staff: ['support'], name: 'Coumba' });
  const o = await order(a);
  const pending = await support.rpc('lg_cod_pending');
  assert.deepEqual(pending.map((x) => [x.order_id, x.amount_fcfa, x.previous_orders]), [[o.id, 13500, 0]]);
  assert.deepEqual(await support.rpc('lg_confirm_cod', { p_order: o.id, p_via: 'appel' }), { ok: true, confirmed: true });
  assert.deepEqual(await support.rpc('lg_cod_pending'), []);
  // payée d'avance : rien à confirmer
  const pre = await order(a, { p_payment_method: 'prepaid' });
  assert.equal((await support.rpc('lg_confirm_cod', { p_order: pre.id })).error, 'not_cod');
  // numéro banni : confirmation refusée, nouvelle commande refusée
  const o2 = await order(a, { p_customer: { name: 'Fraudeur', phone: '+221 70 999 99 99' } });
  await support.rpc('lg_ban_number', { p_phone: '709999999', p_reason: '3 refus' });
  assert.equal((await support.rpc('lg_confirm_cod', { p_order: o2.id })).error, 'banned_number');
  assert.equal(await support.rpcError('lg_order_create', { p_customer: { name: 'Fraudeur', phone: '00221709999999' }, p_zone: 'Yoff', p_items: items }), 'banned_number');
  // annulation tant que rien n'est parti ; idempotente ; refusée après le départ
  assert.deepEqual(await support.rpc('lg_cancel_unconfirmed', { p_order: o2.id, p_reason: 'Non confirmée' }), { ok: true });
  assert.equal((await support.rpc('lg_cancel_unconfirmed', { p_order: o2.id })).already, true);
  assert.equal((await support.rpc('lg_confirm_cod', { p_order: o2.id })).error, 'order_cancelled');
  env.DB.db.prepare("UPDATE orders SET status = 'in_transit' WHERE id = ?").run(o.id);
  assert.equal((await support.rpc('lg_cancel_unconfirmed', { p_order: o.id })).error, 'already_shipped');
  assert.equal((await support.rpc('lg_cancel_unconfirmed', { p_order: crypto.randomUUID() })).error, 'unknown_order');
});

test('page de suivi publique : jeton secret, confirmation, position, demandes, note (parcours)', async () => {
  const env = makeEnv();
  const a = await shop(env);
  const o = await order(a);
  const token = o.tracking_url.split('/').pop();
  const anon = new Client(env);
  const t = await anon.rpc('lg_track', { p_token: token });
  assert.deepEqual([t.ok, t.company.name, t.amount_due_fcfa, t.can_confirm, t.can_edit_address, t.order.first_name], [true, 'Express Dakar', 13500, true, true, 'Aminata']);
  assert.equal((await anon.rpc('lg_track', { p_token: 'x'.repeat(24) })).ok, false);
  assert.equal((await anon.rpc('lg_track', { p_token: "' OR 1=1 --" })).error, 'not_found');
  // le client confirme, puis ne peut plus annuler par la page
  assert.equal((await anon.rpc('lg_track_confirm', { p_token: token, p_yes: true })).confirmed, true);
  assert.equal((await anon.rpc('lg_track_confirm', { p_token: token, p_yes: false })).error, 'already_confirmed');
  const t2 = await anon.rpc('lg_track', { p_token: token });
  assert.ok(t2.steps[0].at);
  assert.equal(t2.can_confirm, false);
  // position : épingle près de Yoff acceptée, en pleine mer refusée
  assert.deepEqual(await anon.rpc('lg_track_set_location', { p_token: token, p_lat: 14.757, p_lng: -17.474, p_landmark: 'portail bleu' }), { ok: true });
  assert.equal((await anon.rpc('lg_track_set_location', { p_token: token, p_lat: 10, p_lng: -30 })).error, 'outside_area');
  assert.equal((await a.rpc('lg_order_detail', { p_order: o.id })).landmark, 'portail bleu');
  // demandes au service client, limitées
  const support = await invite(env, a, 'coumba@express.sn', { staff: ['support'], name: 'Coumba' });
  assert.equal((await anon.rpc('lg_track_request', { p_token: token, p_kind: 'callback', p_payload: { message: 'Après 18 h', order_id: 'pirate' } })).ok, true);
  assert.equal((await anon.rpc('lg_track_request', { p_token: token, p_kind: 'pirate' })).error, 'invalid_kind');
  for (let i = 0; i < 4; i++) await anon.rpc('lg_track_request', { p_token: token, p_kind: 'help' });
  assert.equal((await anon.rpc('lg_track_request', { p_token: token, p_kind: 'help' })).error, 'too_many_requests');
  const reqs = await support.rpc('lg_requests_list', { p_status: 'open' });
  assert.equal(reqs.length, 5);
  assert.deepEqual(reqs[0].payload, { message: 'Après 18 h' });
  assert.equal((await support.rpc('lg_request_done', { p_id: reqs[0].id, p_note: 'rappelée' })).ok, true);
  assert.equal((await support.rpc('lg_requests_list', { p_status: 'open' })).length, 4);
  // tiers désigné
  assert.equal((await anon.rpc('lg_track_third_party', { p_token: token, p_name: 'Voisin', p_phone: '12' })).error, 'invalid_recipient');
  assert.equal((await anon.rpc('lg_track_third_party', { p_token: token, p_name: 'Moussa le voisin', p_phone: '+221 77 555 55 55' })).ok, true);
  // note : seulement une fois livrée ; note basse → demande au service client
  assert.equal((await anon.rpc('lg_track_rate', { p_token: token, p_rating: 5 })).error, 'not_delivered');
  env.DB.db.prepare("UPDATE orders SET status = 'delivered', delivered_at = ? WHERE id = ?").run(new Date().toISOString(), o.id);
  assert.equal((await anon.rpc('lg_track_set_location', { p_token: token, p_lat: 14.757, p_lng: -17.474 })).error, 'already_loaded');
  assert.equal((await anon.rpc('lg_track_rate', { p_token: token, p_rating: 9 })).error, 'invalid_rating');
  assert.equal((await anon.rpc('lg_track_rate', { p_token: token, p_rating: 2, p_comment: 'en retard' })).ok, true);
  assert.equal((await anon.rpc('lg_track', { p_token: token })).can_rate, false);
  assert.equal((await support.rpc('lg_requests_list', { p_status: 'open' })).filter((r) => r.kind === 'help' && r.payload.reason === 'note_basse').length, 1);
  // annulation par le client sur une autre commande non confirmée
  const o2 = await order(a);
  const tok2 = o2.tracking_url.split('/').pop();
  assert.deepEqual(await anon.rpc('lg_track_confirm', { p_token: tok2, p_yes: false }), { ok: true });
  assert.equal((await anon.rpc('lg_track', { p_token: tok2 })).order.status, 'cancelled');
});

test('catalogue : fiches logistiques, vendeur limité à ses fiches, recherche', async () => {
  const env = makeEnv();
  const a = await shop(env);
  const vendor = await invite(env, a, 'ndeye@boutique.sn', { role: 'vendor', name: 'Boutique Ndèye' });
  const picker = await invite(env, a, 'fatou@express.sn', { staff: ['picker'], name: 'Fatou' });
  const mine = await vendor.rpc('lg_product_upsert', { p: { name: 'Savon noir', price_fcfa: 1500 } });
  const theirs = await a.rpc('lg_product_upsert', { p: { name: 'Huile 5 L', barcode: '6111234500048', price_fcfa: 6000, weight_g: 5000 } });
  assert.deepEqual((await vendor.rpc('lg_products_to_complete')).map((p) => p.name), ['Savon noir']);
  assert.equal((await vendor.rpc('lg_vendor_overview')).products_missing_data, 1);
  await vendor.rpc('lg_product_logistics', { p_product: mine.id, p_barcode: '6111234500024', p_weight_g: 250, p_handling: ['fragile'] });
  assert.equal((await vendor.rpc('lg_vendor_overview')).products_missing_data, 0);
  assert.equal(await vendor.rpcError('lg_product_logistics', { p_product: theirs.id, p_weight_g: 1 }), 'forbidden');
  assert.equal(await vendor.rpcError('lg_product_upsert', { p: { id: theirs.id, name: 'Volé' } }), 'unknown_product');
  // l'équipe complète toutes les fiches et retrouve un produit par code-barres, nom ou code interne
  await picker.rpc('lg_product_logistics', { p_product: theirs.id, p_length_cm: 30, p_width_cm: 20, p_height_cm: 10 });
  assert.equal((await picker.rpc('lg_product_find', { p_q: '6111234500048' }))[0].name, 'Huile 5 L');
  assert.equal((await picker.rpc('lg_product_find', { p_q: 'savon' }))[0].name, 'Savon noir');
  assert.equal((await picker.rpc('lg_product_find', { p_q: 'NXI-' + mine.id.slice(0, 8) })).length, 1);
  assert.equal(await vendor.rpcError('lg_product_find', { p_q: 'savon' }), 'forbidden');
  // le vendeur saisit une commande pour lui-même : elle porte son nom, il ne voit que les siennes
  await order(a);
  const vo = await order(vendor);
  assert.equal((await a.rpc('lg_order_detail', { p_order: vo.id })).vendor, 'Boutique Ndèye');
  assert.deepEqual((await vendor.rpc('lg_orders_list')).map((o) => o.id), [vo.id]);
});

test('API par clé : création, renvoi sans doublon, clé révoquée, isolation', async () => {
  const env = makeEnv();
  const a = await shop(env);
  const k = await a.rpc('lg_api_key_create', { p_name: 'Site WooCommerce' });
  assert.match(k.key, /^nxl_/);
  assert.equal((await a.rpc('lg_api_keys_list'))[0].prefix, k.key.slice(0, 10));
  assert.ok(!JSON.stringify(await a.rpc('lg_api_keys_list')).includes(k.key), 'la clé elle-même n\'est jamais relue');
  const shopSite = new Client(env);
  const body = { external_ref: 'WC-1001', customer, zone: 'Yoff', items };
  const r1 = await shopSite.req('POST', '/api/v1/orders', body, { authorization: `Bearer ${k.key}` });
  assert.equal(r1.status, 201);
  assert.equal(r1.data.number, 1);
  const r2 = await shopSite.req('POST', '/api/v1/orders', body, { 'x-api-key': k.key });
  assert.deepEqual([r2.status, r2.data.duplicate, r2.data.id], [200, true, r1.data.id]);
  const bad = await shopSite.req('POST', '/api/v1/orders', { ...body, external_ref: 'WC-1002', zone: 'Lune' }, { authorization: `Bearer ${k.key}` });
  assert.deepEqual([bad.status, bad.data.error], [400, 'unknown_zone']);
  const many = await shopSite.req('POST', '/api/v1/orders', { orders: [{ ...body, external_ref: 'WC-2' }, { ...body, external_ref: 'WC-3' }] }, { authorization: `Bearer ${k.key}` });
  assert.deepEqual([many.status, many.data.created], [201, 2]);
  assert.equal((await shopSite.req('POST', '/api/v1/orders', body, { authorization: 'Bearer nxl_faussecle_faussecle_fausse' })).status, 401);
  assert.equal((await shopSite.req('POST', '/api/v1/orders', body)).status, 401);
  // une autre entreprise ne voit pas la clé et ne peut pas la révoquer
  const b = new Client(env); await b.register('bob@rapide.sn', { company: 'Rapide' });
  assert.deepEqual(await b.rpc('lg_api_keys_list'), []);
  assert.equal(await b.rpcError('lg_api_key_revoke', { p_id: (await a.rpc('lg_api_keys_list'))[0].id }), 'unknown_key');
  await a.rpc('lg_api_key_revoke', { p_id: k.id });
  assert.equal((await shopSite.req('POST', '/api/v1/orders', { ...body, external_ref: 'WC-9' }, { authorization: `Bearer ${k.key}` })).status, 401);
  assert.equal(await (await invite(env, a, 'coumba@express.sn', { staff: ['support'] })).rpcError('lg_api_key_create'), 'forbidden');
});

test('isolation : une autre entreprise ne voit ni ne modifie rien du cycle C2', async () => {
  const env = makeEnv();
  const a = await shop(env);
  const b = await shop(env, 'bob@rapide.sn', 'Rapide');
  const o = await order(a);
  const pr = await a.rpc('lg_product_upsert', { p: { name: 'Huile 5 L', barcode: '6111234500048' } });
  const card = (await a.rpc('lg_pricing')).rate_cards[0];
  await a.rpc('lg_track_request', { p_token: o.tracking_url.split('/').pop(), p_kind: 'help' }).catch(() => null);
  const anon = new Client(env);
  await anon.rpc('lg_track_request', { p_token: o.tracking_url.split('/').pop(), p_kind: 'help' });
  // lectures
  assert.deepEqual(await b.rpc('lg_orders_list', { p_status: 'all' }), []);
  assert.deepEqual(await b.rpc('lg_cod_pending'), []);
  assert.deepEqual(await b.rpc('lg_requests_list', {}), []);
  assert.deepEqual(await b.rpc('lg_products_list', {}), []);
  assert.deepEqual(await b.rpc('lg_product_find', { p_q: '6111234500048' }), []);
  assert.equal(await b.rpcError('lg_order_detail', { p_order: o.id }), 'unknown_order');
  // écritures : même réponse que pour une commande inexistante
  assert.equal((await b.rpc('lg_confirm_cod', { p_order: o.id })).error, 'unknown_order');
  assert.equal((await b.rpc('lg_cancel_unconfirmed', { p_order: o.id })).error, 'unknown_order');
  assert.equal(await b.rpcError('lg_order_insure', { p_order: o.id, p_value: 1000 }), 'unknown_order');
  assert.equal(await b.rpcError('lg_product_logistics', { p_product: pr.id, p_weight_g: 1 }), 'unknown_product');
  assert.equal(await b.rpcError('lg_product_upsert', { p: { id: pr.id, name: 'Volé' } }), 'unknown_product');
  assert.equal(await b.rpcError('lg_upsert_rate_card', { p: { id: card.id, active: false } }), 'unknown_rate');
  assert.equal(await b.rpcError('lg_upsert_rate_card', { p: { id: card.id, max_weight_g: 1000, price_fcfa: 1 } }), 'unknown_rate');
  const req = (await a.rpc('lg_requests_list', { p_status: 'open' }))[0];
  assert.equal((await b.rpc('lg_request_done', { p_id: req.id })).ok, false);
  // réglages de zones et suppléments propres à chaque entreprise
  await b.rpc('lg_set_zone', { p_zone: 'Yoff', p: { served: false } });
  await b.rpc('lg_surcharge_declare', { p_code: 'rain', p_hours: 2 });
  assert.equal((await a.rpc('lg_quote', { p_zone: 'Yoff', p_weight_g: 1000 })).price_fcfa, 1500);
  assert.equal((await b.rpc('lg_quote', { p_zone: 'Yoff', p_weight_g: 1000 })).error, 'zone_not_served');
  assert.equal(await b.rpcError('lg_zone_delete', { p_zone: 'Lune' }), 'unknown_zone');
  // numéros de commande propres à chaque entreprise
  assert.equal((await order(b, { p_zone: 'Médina' })).number, 1);
  // tout est resté intact chez A
  const d = await a.rpc('lg_order_detail', { p_order: o.id });
  assert.deepEqual([d.status, d.cod_confirmed_at, d.insured_value_fcfa], ['pending', null, null]);
  assert.equal((await a.rpc('lg_pricing')).rate_cards.length, 2);
  assert.equal((await a.rpc('lg_requests_list', { p_status: 'open' })).length, 2);
});

test('rôles : chaque fonction C2 refuse les membres sans le rôle voulu ; les fonctions publiques sont voulues', async () => {
  const env = makeEnv();
  const a = await shop(env);
  const driver = await invite(env, a, 'moussa@express.sn', { role: 'courier', name: 'Moussa' });
  const picker = await invite(env, a, 'fatou@express.sn', { staff: ['picker'], name: 'Fatou' });
  const publicFns = Object.entries(REGISTRY).filter(([, d]) => d.roles === 'public').map(([n]) => n).sort();
  assert.deepEqual(publicFns, ['lg_quote', 'lg_slots_available', 'lg_track', 'lg_track_book_slot', 'lg_track_confirm', 'lg_track_rate', 'lg_track_request',
    'lg_track_set_location', 'lg_track_third_party']);
  for (const fn of ['lg_order_create', 'lg_order_import', 'lg_orders_list', 'lg_order_detail', 'lg_cod_pending', 'lg_confirm_cod', 'lg_cancel_unconfirmed',
    'lg_order_insure', 'lg_ban_number', 'lg_requests_list', 'lg_request_done', 'lg_pricing', 'lg_surcharges_list', 'lg_surcharge_declare',
    'lg_set_zone', 'lg_zone_delete', 'lg_zones_seed', 'lg_upsert_rate_card', 'lg_surcharge_save', 'lg_api_key_create', 'lg_api_keys_list',
    'lg_api_key_revoke', 'lg_product_upsert', 'lg_products_list', 'lg_product_find', 'lg_vendor_overview', 'lg_products_to_complete']) {
    assert.equal(await driver.rpcError(fn, {}), 'forbidden', fn);
  }
  // un préparateur cherche les produits, mais ne voit ni les commandes ni les tarifs
  assert.deepEqual(await picker.rpc('lg_product_find', { p_q: 'zz' }), []);
  assert.equal(await picker.rpcError('lg_orders_list'), 'forbidden');
  assert.equal(await picker.rpcError('lg_pricing'), 'forbidden');
});
