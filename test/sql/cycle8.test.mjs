// Cycle 8 : retours — causes, frais selon la cause, statistiques par motif, vendeur et quartier.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, U } from '../helpers/db.mjs';
import { runScenario } from '../../src/demo/scenario.js';

let t; let B; let failed; let ret;
before(async () => {
  t = await createDb();
  const r = await runScenario((n, a, uid) => t.rpc(uid ?? null, n, a), (q, p) => t.db.query(q, p));
  [, B] = r.trips;
});

test('cause suggérée depuis le motif d\'échec, frais à la charge du bon payeur, reclassement sans doublon', async () => {
  failed = await t.one(`select p.code, p.order_id, s.failure_reason from lg_packages p join lg_trip_packages tp on tp.package_id = p.id
    join lg_trip_stops s on s.id = tp.stop_id where p.status = 'failed' limit 1`);
  await t.rpc(U.dock, 'lg_return_hub', { p_code: failed.code, p_event: t.ev() });
  await t.as(null);
  await t.db.query('update lg_packages set attempts = 2 where code = $1', [failed.code]);
  const todo = (await t.rpc(U.dock, 'lg_returns_to_inspect', {})).find((x) => x.code === failed.code);
  const expected = { absent: 'customer_absent', unreachable: 'customer_absent', refused: 'refused_at_door', damaged: 'transport_damage', wrong_product: 'vendor_error' }[failed.failure_reason] ?? null;
  assert.deepEqual([todo.suggested_cause, todo.cause], [expected, null]);

  const fee = (await t.one('select delivery_fee_fcfa from orders where id = $1', [failed.order_id])).delivery_fee_fcfa;
  const c = await t.rpc(U.dock, 'lg_return_classify', { p_code: failed.code, p_cause: 'customer_absent', p_event: t.ev() });
  assert.deepEqual([c.ok, c.payer, c.amount_fcfa], [true, 'customer', fee], 'frais de livraison de la commande');
  const c2 = await t.rpc(U.support, 'lg_return_classify', { p_code: failed.code, p_cause: 'transport_damage', p_event: t.ev(), p_note: 'carton écrasé' });
  assert.deepEqual([c2.payer, c2.amount_fcfa], ['nexus', 0]);
  assert.equal((await t.one('select count(*)::int n from lg_return_charges')).n, 1, 'reclassé, pas dupliqué');
  assert.equal((await t.rpc(U.dock, 'lg_returns_to_inspect', {})).find((x) => x.code === failed.code).cause, 'transport_damage');

  assert.equal((await t.rpc(U.dock, 'lg_return_classify', { p_code: failed.code, p_cause: 'nimporte', p_event: t.ev() })).error, 'unknown_cause');
  const staged = (await t.one("select code from lg_packages where status in ('staged', 'loaded') and attempts = 0 and direction = 'outbound' limit 1")).code;
  assert.equal((await t.rpc(U.dock, 'lg_return_classify', { p_code: staged, p_cause: 'other', p_event: t.ev() })).error, 'not_a_return');
  await assert.rejects(t.rpc(U.driver, 'lg_return_classify', { p_code: failed.code, p_cause: 'other' }), /forbidden/);
});

test('retour client : cause suggérée d\'après la demande, tarif réglé par l\'administrateur', async () => {
  const delivered = (await t.one("select id from orders where status = 'delivered' order by delivered_at limit 1")).id;
  await t.as(null);
  const { rows } = await t.db.query(`insert into return_requests (order_id, buyer_name, vendor_name, category, description, status)
    values ($1, 'Client', 'Boutique Ndèye', 'autre', 'Je n''en ai plus besoin', 'approved') returning id`, [delivered]);
  ret = await t.rpc(U.dispatcher, 'lg_trip_add_return', { p_trip: B, p_return: rows[0].id });
  assert.equal((await t.one('select public.lg_return_suggest(id) s from lg_packages where code = $1', [ret.code])).s, 'changed_mind');

  await assert.rejects(t.rpc(U.dock, 'lg_return_cause_save', { p: { code: 'changed_mind', payer: 'customer', fee_mode: 'fixed', fee_fcfa: 1000 } }), /forbidden/);
  await t.rpc(U.admin, 'lg_return_cause_save', { p: { code: 'changed_mind', label: 'Changement d\'avis', payer: 'customer', fee_mode: 'fixed', fee_fcfa: 1000 } });
  const c = await t.rpc(U.dock, 'lg_return_classify', { p_code: ret.code, p_cause: 'changed_mind', p_event: t.ev() });
  assert.deepEqual([c.payer, c.amount_fcfa], ['customer', 1000]);
  assert.equal((await t.rpc(U.support, 'lg_return_causes', {})).find((x) => x.code === 'changed_mind').fee_fcfa, 1000);
});

test('statistiques : par motif, par vendeur (taux de retour), par quartier', async () => {
  const s = await t.rpc(U.accountant, 'lg_return_stats', {});
  assert.deepEqual([s.totals.returns, s.totals.customer_fcfa, s.totals.nexus_fcfa, s.totals.vendor_fcfa], [2, 1000, 0, 0]);
  assert.deepEqual(s.by_cause.map((x) => [x.cause, x.count]).sort(), [['changed_mind', 1], ['transport_damage', 1]]);
  assert.equal(s.by_vendor.length, 1);
  assert.equal(s.by_vendor[0].count, 2);
  assert.ok(s.by_vendor[0].delivered > 0 && s.by_vendor[0].return_pct > 0 && s.by_vendor[0].return_pct < 100);
  assert.equal(s.by_zone.reduce((n, z) => n + z.count, 0), 2);
  await assert.rejects(t.rpc(U.driver, 'lg_return_stats', {}), /forbidden/);
});
