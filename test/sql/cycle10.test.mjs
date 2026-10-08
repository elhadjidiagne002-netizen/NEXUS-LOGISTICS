// Cycle 10 : suppléments nuit et forte pluie dans le devis au panier.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, U } from '../helpers/db.mjs';

let t;
const quote = (zone, extra = {}) => t.rpc(null, 'lg_quote', { p_zone: zone, p_weight_g: 3000, ...extra });
const dakarTime = async (hours) => (await t.one(`select to_char((now() at time zone 'Africa/Dakar') + make_interval(hours => $1), 'HH24:MI') v`, [hours])).v;
before(async () => {
  t = await createDb();
  await t.rpc(U.admin, 'lg_upsert_rate_card', { p: { max_weight_g: 20000, price_fcfa: 1500 } });
  await t.rpc(U.admin, 'lg_upsert_rate_card', { p: { service: 'express', max_weight_g: 20000, price_fcfa: 3000, lead_hours: 3 } });
  await t.rpc(U.admin, 'lg_set_zone', { p_zone: 'Mermoz', p: { free_above_fcfa: 30000 } });
});

test('suppléments désactivés par défaut : les prix ne changent pas', async () => {
  const q = await quote('Yoff');
  assert.deepEqual([q.price_fcfa, q.base_fcfa, q.surcharges], [1500, 1500, []]);
});

test('forte pluie : déclarée par le répartiteur pour des zones et quelques heures, puis levée', async () => {
  await assert.rejects(t.rpc(U.driver, 'lg_surcharge_declare', { p_code: 'rain', p_hours: 2 }), /forbidden/);
  await assert.rejects(t.rpc(U.dispatcher, 'lg_surcharge_declare', { p_code: 'rain', p_hours: 48 }), /invalid_hours/);
  const d = await t.rpc(U.dispatcher, 'lg_surcharge_declare', { p_code: 'rain', p_hours: 2, p_zones: ['Yoff', 'Mermoz'] });
  assert.ok(new Date(d.until) > new Date());
  const y = await quote('Yoff');
  assert.deepEqual([y.price_fcfa, y.surcharges.map((s) => s.code)], [2000, ['rain']]);
  assert.equal((await quote('Rufisque')).price_fcfa, 1500, 'zone non concernée');
  const free = await quote('Mermoz', { p_subtotal_fcfa: 40000 });
  assert.deepEqual([free.price_fcfa, free.surcharges], [0, []], 'livraison offerte : pas de supplément');
  // la déclaration expire d'elle-même
  await t.as(null);
  await t.db.query("update lg_surcharges set until = now() - interval '1 minute' where code = 'rain'");
  assert.equal((await quote('Yoff')).price_fcfa, 1500);
  await t.rpc(U.dispatcher, 'lg_surcharge_declare', { p_code: 'rain', p_hours: 1 });
  assert.equal((await quote('Rufisque')).price_fcfa, 2000, 'sans zone : partout');
  await t.rpc(U.dispatcher, 'lg_surcharge_declare', { p_code: 'rain', p_hours: 0 });
  assert.equal((await quote('Rufisque')).price_fcfa, 1500, 'levée');
});

test('nuit : fenêtre horaire (même à cheval sur minuit), express seulement par défaut, réglage administrateur', async () => {
  await assert.rejects(t.rpc(U.dispatcher, 'lg_surcharge_save', { p: { code: 'night', active: true } }), /forbidden/);
  // fenêtre qui contient l'heure actuelle
  await t.rpc(U.admin, 'lg_surcharge_save', { p: { code: 'night', label: 'Supplément nuit', amount_fcfa: 1000, active: true,
    start_time: await dakarTime(-1), end_time: await dakarTime(1), services: ['express'] } });
  assert.equal((await quote('Yoff', { p_service: 'express' })).price_fcfa, 4000);
  assert.equal((await quote('Yoff')).price_fcfa, 1500, 'service standard non concerné');
  // fenêtre à cheval sur minuit qui contient l'heure actuelle : de +2 h jusqu'à +1 h le lendemain
  await t.rpc(U.admin, 'lg_surcharge_save', { p: { code: 'night', amount_fcfa: 1000, active: true,
    start_time: await dakarTime(2), end_time: await dakarTime(1), services: null } });
  assert.equal((await quote('Yoff')).price_fcfa, 2500);
  // fenêtre qui ne contient pas l'heure actuelle
  await t.rpc(U.admin, 'lg_surcharge_save', { p: { code: 'night', amount_fcfa: 1000, active: true,
    start_time: await dakarTime(1), end_time: await dakarTime(2), services: null } });
  assert.equal((await quote('Yoff')).price_fcfa, 1500);
  const list = await t.rpc(U.dispatcher, 'lg_surcharges_list', {});
  assert.deepEqual(list.map((s) => s.code), ['night', 'rain']);
});
