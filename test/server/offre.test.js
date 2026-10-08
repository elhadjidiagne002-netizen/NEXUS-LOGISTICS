// Cycle C9 — offre payante : quotas de la formule gratuite, paiement déclaré puis validé par la plateforme,
// administration de la plateforme (ADMIN_EMAILS), formules publiques, remontée des erreurs ; isolation et rôles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../../server/app.js';
import { makeEnv, Client, invite } from '../helpers/api-client.js';
import { setup } from '../helpers/scenario.js';

const db = (env) => env.DB.db;
const order = (c, phone = '770001122') => c.rpc('lg_order_create', { p_customer: { name: 'Client Test', phone }, p_zone: 'Yoff', p_items: [{ name: 'Colis', quantity: 1, price_fcfa: 1000 }] });

test('formule gratuite : quotas de commandes, de chauffeurs et de lieux ; la formule Pro les lève', async () => {
  const env = makeEnv();
  const S = await setup(env);
  db(env).prepare("INSERT INTO app_settings (key, value) VALUES ('plans', ?)").run(JSON.stringify({ free: { orders_month: 2, couriers: 2, hubs: 2 } }));
  await order(S.support); await order(S.support);
  assert.equal(await S.support.rpcError('lg_order_create', { p_customer: { name: 'Client Test', phone: '770001133' }, p_zone: 'Yoff', p_items: [{ name: 'Colis', quantity: 1 }] }), 'quota_orders');
  assert.equal(await S.admin.rpcError('lg_invite_create', { p_role: 'courier' }), 'quota_couriers', 'déjà 2 chauffeurs');
  assert.equal(await S.admin.rpcError('lg_courier_upsert', { p_name: 'Troisième' }), 'quota_couriers');
  await S.admin.rpc('lg_hub_upsert', { p_name: 'Relais', p_kind: 'relay' });
  assert.equal(await S.admin.rpcError('lg_hub_upsert', { p_name: 'Encore' }), 'quota_hubs');
  const st = await S.admin.rpc('lg_plan_status');
  assert.deepEqual([st.plan, st.usage.orders_month, st.usage.couriers, st.limits.orders_month], ['free', 2, 2, 2]);
  // Pro : plus de limite
  db(env).prepare("UPDATE companies SET plan = 'pro', plan_until = ? WHERE id = ?").run(new Date(Date.now() + 864e5).toISOString(), S.admin.companyId);
  assert.ok((await order(S.support, '770001144')).id);
  assert.ok((await S.admin.rpc('lg_courier_upsert', { p_name: 'Troisième' })).ok);
  assert.equal((await S.admin.rpc('lg_me')).plan, 'pro');
  // Pro expirée : retour aux quotas
  db(env).prepare("UPDATE companies SET plan_until = ? WHERE id = ?").run(new Date(Date.now() - 864e5).toISOString(), S.admin.companyId);
  assert.equal(await S.admin.rpcError('lg_courier_upsert', { p_name: 'Quatrième' }), 'quota_couriers');
});

test('abonnement : paiement déclaré, validé par l\'administrateur de la plateforme, formule prolongée', async () => {
  const env = makeEnv();
  env.ADMIN_EMAILS = 'chef@nexusmarket.sn, autre@x.sn';
  const S = await setup(env);
  const boss = new Client(env); await boss.register('Chef@NexusMarket.sn', { company: 'NEXUS Plateforme' });
  assert.equal((await boss.rpc('lg_me')).is_platform_admin, true);
  assert.equal((await S.admin.rpc('lg_me')).is_platform_admin, false);
  assert.equal(await S.admin.rpcError('lg_plan_declare', { p_months: 13, p_method: 'wave', p_ref: 'WV-1234' }), 'invalid_months');
  assert.equal(await S.admin.rpcError('lg_plan_declare', { p_months: 1, p_method: 'cash', p_ref: 'WV-1234' }), 'invalid_method');
  const d = await S.admin.rpc('lg_plan_declare', { p_months: 3, p_method: 'wave', p_ref: 'WV-1234' });
  assert.deepEqual([d.ok, d.amount_fcfa], [true, 45000]);
  assert.equal(await S.admin.rpcError('lg_plan_declare', { p_months: 1, p_method: 'wave', p_ref: 'WV-9999' }), 'payment_pending');
  assert.equal(await S.support.rpcError('lg_plan_declare', { p_months: 1, p_method: 'wave', p_ref: 'WV-1' }), 'forbidden');
  // plateforme
  assert.equal(await S.admin.rpcError('lg_platform_overview'), 'forbidden');
  const ov = await boss.rpc('lg_platform_overview');
  assert.deepEqual([ov.totals.companies, ov.totals.payments_pending, ov.payments[0].company], [2, 1, 'Express Dakar']);
  const r = await boss.rpc('lg_platform_payment_decide', { p_id: d.id, p_approve: true });
  assert.equal(r.ok, true);
  const days = (Date.parse(r.plan_until) - Date.now()) / 864e5;
  assert.ok(days > 89 && days < 91, '3 × 30 jours');
  assert.equal((await boss.rpc('lg_platform_payment_decide', { p_id: d.id, p_approve: false })).error, 'already_decided');
  const st = await S.admin.rpc('lg_plan_status');
  assert.deepEqual([st.plan, st.payments[0].status, st.limits.couriers], ['pro', 'approved', null]);
  // un second paiement prolonge depuis la fin en cours
  const d2 = await S.admin.rpc('lg_plan_declare', { p_months: 1, p_method: 'orange_money', p_ref: 'OM-5555' });
  const r2 = await boss.rpc('lg_platform_payment_decide', { p_id: d2.id, p_approve: true });
  assert.ok(Math.abs(Date.parse(r2.plan_until) - Date.parse(r.plan_until) - 30 * 864e5) < 5000);
  // refus avec motif
  const d3 = await S.admin.rpc('lg_plan_declare', { p_months: 1, p_method: 'wave', p_ref: 'FAUX-000' });
  await boss.rpc('lg_platform_payment_decide', { p_id: d3.id, p_approve: false, p_note: 'Référence introuvable' });
  assert.equal((await S.admin.rpc('lg_plan_status')).payments[0].note, 'Référence introuvable');
  // formules : quotas et prix réglés par la plateforme, affichés publiquement
  await boss.rpc('lg_platform_settings_save', { p: { free: { orders_month: 500 }, pro: { price_fcfa: 20000 }, payment: { wave: '77 000 00 00' } } });
  const pub = await (await handle(new Request('https://logistique.test/api/plans'), env)).json();
  assert.deepEqual([pub.free.orders_month, pub.pro.price_fcfa, pub.free.couriers], [500, 20000, 3]);
  assert.equal((await S.admin.rpc('lg_plan_status')).payment.wave, '77 000 00 00');
});

test('suspension d\'une entreprise par la plateforme : plus d\'accès ni de page de suivi', async () => {
  const env = makeEnv();
  env.ADMIN_EMAILS = 'chef@nexusmarket.sn';
  const S = await setup(env);
  const boss = new Client(env); await boss.register('chef@nexusmarket.sn', { company: 'NEXUS Plateforme' });
  const o = await order(S.support);
  await boss.rpc('lg_platform_company_set', { p_company: S.admin.companyId, p_suspend: true });
  assert.equal(await S.support.rpcError('lg_orders_list', {}), 'no_company');
  const tok = db(env).prepare('SELECT tracking_token FROM orders WHERE id = ?').get(o.id).tracking_token;
  assert.equal((await new Client(env).rpc('lg_track', { p_token: tok })).error, 'not_found');
  assert.equal((await boss.rpc('lg_platform_overview')).totals.suspended, 1);
  await boss.rpc('lg_platform_company_set', { p_company: S.admin.companyId, p_suspend: false });
  assert.ok(Array.isArray(await S.support.rpc('lg_orders_list', {})));
  assert.equal(await boss.rpcError('lg_platform_company_set', { p_company: 'inconnue', p_suspend: true }), 'unknown_company');
  assert.equal(await boss.rpcError('lg_platform_company_set', { p_company: S.admin.companyId }), 'nothing_to_change');
});

test('erreurs de l\'interface : enregistrées, limitées, visibles par la plateforme seulement', async () => {
  const env = makeEnv();
  env.ADMIN_EMAILS = 'chef@nexusmarket.sn';
  const S = await setup(env);
  const boss = new Client(env); await boss.register('chef@nexusmarket.sn', { company: 'NEXUS Plateforme' });
  const r = await S.driver.req('POST', '/api/errors', { message: 'TypeError: x is undefined', stack: 'at Driver.jsx:12', url: '/chauffeur' });
  assert.equal(r.status, 200);
  assert.equal((await S.driver.req('POST', '/api/errors', {})).status, 400);
  const errs = await boss.rpc('lg_platform_errors', {});
  assert.deepEqual([errs[0].message, errs[0].company, errs[0].url], ['TypeError: x is undefined', 'Express Dakar', '/chauffeur']);
  assert.equal(await S.admin.rpcError('lg_platform_errors', {}), 'forbidden');
  const anon = new Client(env);
  for (let i = 0; i < 20; i++) await anon.req('POST', '/api/errors', { message: `e${i}` });
  assert.equal((await anon.req('POST', '/api/errors', { message: 'trop' })).status, 429);
});

test('rôles : fonctions de la plateforme refusées sans ADMIN_EMAILS, abonnement réservé à l\'administrateur', async () => {
  const env = makeEnv();
  const S = await setup(env);
  for (const fn of ['lg_platform_overview', 'lg_platform_payment_decide', 'lg_platform_company_set', 'lg_platform_settings_save', 'lg_platform_errors']) {
    assert.equal(await S.admin.rpcError(fn, {}), 'forbidden', fn);
    assert.equal(await new Client(env).rpcError(fn, {}), 'auth', fn);
  }
  for (const fn of ['lg_plan_status', 'lg_plan_declare']) assert.equal(await S.picker.rpcError(fn, {}), 'forbidden', fn);
  // isolation : la plateforme seule voit toutes les entreprises ; une entreprise ne voit que son abonnement
  const X = await setup(env, 'binta@rapide.sn', 'Rapide Thiès');
  await X.admin.rpc('lg_plan_declare', { p_months: 1, p_method: 'wave', p_ref: 'WV-7777' });
  assert.deepEqual((await S.admin.rpc('lg_plan_status')).payments, []);
});
