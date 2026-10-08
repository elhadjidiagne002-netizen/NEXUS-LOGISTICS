// Cycle C10 — intégration des boutiques en ligne (dont NEXUS Market) : commande envoyée par l'API, état lu par
// l'API, statuts renvoyés par un appel signé (HMAC-SHA256) à chaque étape ; isolation et rôles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { handle } from '../../server/app.js';
import { makeEnv, Client } from '../helpers/api-client.js';
import { ev, setup, sealedTrip, otpOf } from '../helpers/scenario.js';
import { signedHeaders } from '../../server/rpc/webhooks.js';

const db = (env) => env.DB.db;
const call = (env, method, path, key, body) => handle(new Request(`https://logistique.test${path}`, {
  method, headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
}), env).then(async (r) => ({ status: r.status, data: await r.json() }));
const cron = (env) => handle(new Request('https://logistique.test/api/cron/messages', { method: 'POST', headers: { 'x-cron-secret': env.CRON_SECRET } }), env);

test('boutique : commande par l\'API, état lu par l\'API, statuts signés renvoyés à chaque étape', async () => {
  const env = makeEnv(); env.SECRETS_KEY = 'k'.repeat(32); env.CRON_SECRET = 'c'.repeat(32);
  const S = await setup(env);
  const key = (await S.admin.rpc('lg_api_key_create', { p_name: 'NEXUS Market' })).key;
  assert.equal(await S.admin.rpcError('lg_webhook_save', { p_url: 'http://boutique.sn/hook' }), 'invalid_url');
  assert.equal(await S.admin.rpcError('lg_webhook_save', { p_url: 'https://localhost/hook' }), 'invalid_url');
  const { secret } = await S.admin.rpc('lg_webhook_save', { p_url: 'https://nexusmarket.sn/api/logistique/webhook' });
  assert.match(secret, /^whsec_/);
  assert.equal(JSON.stringify(await S.admin.rpc('lg_webhook_get')).includes(secret), false, 'secret jamais relu');
  // commande payée par la boutique
  const r = await call(env, 'POST', '/api/v1/orders', key, { external_ref: 'NXM-2026-0042', customer: { name: 'Aminata Fall', phone: '771234567' }, zone: 'Yoff',
    payment_method: 'prepaid', items: [{ product_id: S.P.rice, quantity: 1 }] });
  assert.equal(r.status, 201);
  let st = await call(env, 'GET', '/api/v1/orders/NXM-2026-0042', key);
  assert.deepEqual([st.status, st.data.status, st.data.payment_status, st.data.delivery, st.data.invoice], [200, 'pending', 'paid', null, null]);
  assert.match(st.data.tracking_url, /^https:\/\/logistique\.test\/suivi\//);
  assert.equal((await call(env, 'GET', '/api/v1/orders/INCONNUE', key)).status, 404);
  assert.equal((await call(env, 'GET', '/api/v1/orders/NXM-2026-0042', 'nxl_faussecle_faussecle_fausse')).status, 401);
  // préparation, départ, livraison
  const t = (await S.picker.rpc('lg_pick_queue')).find((x) => x.order_id === r.data.id);
  await S.picker.rpc('lg_pick_take', { p_task: t.id });
  await S.picker.rpc('lg_pick_scan', { p_task: t.id, p_code: 'RIZ-5', p_event: ev() });
  const code = (await S.picker.rpc('lg_pack', { p_task: t.id, p_event: ev(), p_packages: [{ weight_g: 5000 }] })).packages[0].code;
  await S.picker.rpc('lg_stage', { p_code: code, p_event: ev() });
  const trip = await sealedTrip(S, [{ order: { id: r.data.id }, codes: [code] }]);
  await S.driver.rpc('lg_trip_start', { p_trip: trip, p_event: ev() });
  st = await call(env, 'GET', '/api/v1/orders/NXM-2026-0042', key);
  assert.deepEqual([st.data.status, st.data.delivery.courier, Boolean(st.data.delivery.eta)], ['in_transit', 'Moussa', true]);
  const stop = (await S.driver.rpc('lg_my_day')).trips[0].stops[0];
  await S.driver.rpc('lg_deliver', { p_stop: stop.id, p_event: ev(), p_codes: [code], p_otp: otpOf(env, r.data.id).code, p_photo_path: 'p.jpg', p_payments: [] });
  st = await call(env, 'GET', '/api/v1/orders/NXM-2026-0042', key);
  assert.deepEqual([st.data.status, Boolean(st.data.steps.delivered_at)], ['delivered', true]);
  assert.match(st.data.invoice, /^FAC-/);
  const events = db(env).prepare('SELECT event FROM webhook_events ORDER BY created_at, rowid').all().map((e) => e.event);
  assert.deepEqual(events, ['order.prepared', 'order.in_transit', 'order.delivered']);
  // envoi signé par la tâche planifiée : la boutique vérifie la signature avec son secret
  const calls = []; const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url, headers: init.headers, body: init.body }); return new Response('ok'); };
  try { assert.equal((await cron(env)).status, 200); } finally { globalThis.fetch = real; }
  assert.equal(calls.length, 3);
  const c = calls[2];
  const expected = createHmac('sha256', secret).update(`${c.headers['x-nexus-timestamp']}.${c.body}`).digest('hex');
  assert.equal(c.headers['x-nexus-signature'], `sha256=${expected}`);
  const body = JSON.parse(c.body);
  assert.deepEqual([body.event, body.external_ref, body.status, body.data.proof], ['order.delivered', 'NXM-2026-0042', 'delivered', 'otp']);
  assert.equal(db(env).prepare("SELECT count(*) AS n FROM webhook_events WHERE status = 'sent'").get().n, 3);
  // une commande saisie à la main (sans référence externe) ne déclenche rien
  await S.support.rpc('lg_order_create', { p_customer: { name: 'Client Test', phone: '770009988' }, p_zone: 'Yoff', p_items: [{ product_id: S.P.oil, quantity: 1 }], p_payment_method: 'cod' });
  await S.support.rpc('lg_cancel_unconfirmed', { p_order: db(env).prepare("SELECT id FROM orders WHERE buyer_phone LIKE '%770009988'").get().id, p_reason: 'test' }).catch(() => {});
  assert.equal(db(env).prepare('SELECT count(*) AS n FROM webhook_events').get().n, 3);
});

test('boutique : annulation renvoyée ; adresse en échec réessayée puis abandonnée', async () => {
  const env = makeEnv(); env.SECRETS_KEY = 'k'.repeat(32); env.CRON_SECRET = 'c'.repeat(32);
  const S = await setup(env);
  const key = (await S.admin.rpc('lg_api_key_create', {})).key;
  await S.admin.rpc('lg_webhook_save', { p_url: 'https://boutique.sn/hook' });
  const r = await call(env, 'POST', '/api/v1/orders', key, { external_ref: 'B-1', customer: { name: 'Client Test', phone: '771230000' }, zone: 'Yoff',
    payment_method: 'cod', items: [{ product_id: S.P.oil, quantity: 1 }] });
  await S.support.rpc('lg_cancel_unconfirmed', { p_order: r.data.id, p_reason: 'Client injoignable' });
  const e = db(env).prepare('SELECT * FROM webhook_events').get();
  assert.equal(e.event, 'order.cancelled');
  assert.equal(JSON.parse(e.payload).data.reason, 'Client injoignable');
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('err', { status: 500 });
  try { for (let i = 0; i < 6; i++) await cron(env); } finally { globalThis.fetch = real; }
  const after = db(env).prepare('SELECT status, attempts, last_error FROM webhook_events').get();
  assert.deepEqual([after.status, after.attempts, after.last_error], ['failed', 6, 'HTTP 500']);
  assert.match((await S.admin.rpc('lg_webhook_get')).endpoint.last_error, /HTTP 500/);
  // signature déterministe pour un horodatage donné
  const h = await signedHeaders('s3cret', '{"a":1}', 1700000000);
  assert.equal(h['x-nexus-signature'], `sha256=${createHmac('sha256', 's3cret').update('1700000000.{"a":1}').digest('hex')}`);
});

test('isolation et rôles : la clé d\'une entreprise ne lit pas les commandes d\'une autre ; adresse de rappel à l\'administrateur', async () => {
  const env = makeEnv(); env.SECRETS_KEY = 'k'.repeat(32);
  const S = await setup(env);
  const X = await setup(env, 'binta@rapide.sn', 'Rapide Thiès');
  const kS = (await S.admin.rpc('lg_api_key_create', {})).key;
  const kX = (await X.admin.rpc('lg_api_key_create', {})).key;
  await call(env, 'POST', '/api/v1/orders', kS, { external_ref: 'REF-1', customer: { name: 'Client Test', phone: '771230001' }, zone: 'Yoff', items: [{ product_id: S.P.oil, quantity: 1 }] });
  assert.equal((await call(env, 'GET', '/api/v1/orders/REF-1', kX)).status, 404);
  assert.equal((await call(env, 'GET', '/api/v1/orders/REF-1', kS)).status, 200);
  await S.admin.rpc('lg_webhook_save', { p_url: 'https://boutique.sn/hook' });
  assert.equal((await X.admin.rpc('lg_webhook_get')).endpoint, null);
  for (const fn of ['lg_webhook_get', 'lg_webhook_save']) assert.equal(await S.support.rpcError(fn, {}), 'forbidden', fn);
  assert.equal(await new Client(env).rpcError('lg_webhook_get', {}), 'auth');
});
