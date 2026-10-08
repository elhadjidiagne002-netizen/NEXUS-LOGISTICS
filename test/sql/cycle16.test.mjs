// Cycle 16 : relevé de reversement des vendeurs — produits livrés, commission, retenues, rapprochement.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, U } from '../helpers/db.mjs';
import { runScenario } from '../../src/demo/scenario.js';

let t; let A;
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Dakar' });
before(async () => {
  t = await createDb();
  const r = await runScenario((n, a, uid) => t.rpc(uid ?? null, n, a), (q, p) => t.db.query(q, p));
  [A] = r.trips;
});

test('relevé du vendeur : commission sur les produits livrés, espèces en attente tant que le voyage n\'est pas rapproché', async () => {
  const s = await t.rpc(U.vendor, 'lg_vendor_statement', { p_from: today, p_to: today, p_vendor: U.admin });
  assert.equal(s.vendor_id, U.vendor, 'un vendeur ne voit que son relevé');
  const delivered = (await t.one("select count(*)::int n from orders where vendor_id = $1 and status = 'delivered' and delivered_at::date = current_date", [U.vendor])).n;
  assert.ok(delivered > 0);
  assert.equal(s.totals.orders, delivered);
  for (const o of s.orders) {
    assert.equal(o.commission_fcfa, Math.round(o.goods_fcfa * Number(s.commission_rate) / 100));
    assert.equal(o.net_fcfa, o.goods_fcfa - o.commission_fcfa);
  }
  const cod = s.orders.find((o) => o.payment_method === 'cod');
  if (cod) assert.equal(cod.settled, false, 'voyage pas encore rapproché');
  const settledNet = s.orders.filter((o) => o.settled).reduce((n, o) => n + o.net_fcfa, 0);
  assert.equal(s.totals.net_payable_fcfa, settledNet - s.totals.deductions_fcfa);
  assert.equal(s.totals.pending_fcfa, s.orders.filter((o) => !o.settled).reduce((n, o) => n + o.net_fcfa, 0));
});

test('rapprochement et retenue : la commande devient reversable, la faute du vendeur est déduite', async () => {
  await t.as(null);
  await t.db.query("update lg_trips set status = 'reconciled' where id = $1", [A]);
  // un retour classé « erreur du vendeur » : frais de livraison à sa charge
  const failed = (await t.one("select code from lg_packages where status = 'failed' limit 1")).code;
  await t.rpc(U.dock, 'lg_return_hub', { p_code: failed, p_event: t.ev() });
  const c = await t.rpc(U.dock, 'lg_return_classify', { p_code: failed, p_cause: 'vendor_error', p_event: t.ev() });
  const s = await t.rpc(U.vendor, 'lg_vendor_statement', { p_from: today, p_to: today });
  assert.ok(s.orders.every((o) => o.settled), 'voyage rapproché : tout est reversable');
  assert.deepEqual([s.deductions.length, s.totals.deductions_fcfa], [1, c.amount_fcfa]);
  assert.equal(s.totals.net_payable_fcfa, s.totals.goods_fcfa - s.totals.commission_fcfa - c.amount_fcfa);
  assert.equal(s.totals.pending_fcfa, 0);
});

test('comptable : synthèse de tous les vendeurs ; droits', async () => {
  const all = await t.rpc(U.accountant, 'lg_vendor_statements', { p_from: today, p_to: today });
  const v = all.find((x) => x.vendor_id === U.vendor);
  const one = await t.rpc(U.accountant, 'lg_vendor_statement', { p_from: today, p_to: today, p_vendor: U.vendor });
  assert.deepEqual([v.net_payable_fcfa, v.goods_fcfa], [one.totals.net_payable_fcfa, one.totals.goods_fcfa]);
  await assert.rejects(t.rpc(U.accountant, 'lg_vendor_statement', { p_from: today, p_to: today }), /vendor_required/);
  await assert.rejects(t.rpc(U.driver, 'lg_vendor_statement', { p_from: today, p_to: today }), /forbidden/);
  await assert.rejects(t.rpc(U.vendor, 'lg_vendor_statements', { p_from: today, p_to: today }), /forbidden/);
});
