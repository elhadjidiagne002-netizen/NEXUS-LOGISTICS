// Paiement à terme (sur facture) : commande d'enseigne qui part en préparation sans paiement, livrée sans encaissement,
// facture avec échéance, créance suivie, relances d'impayés, règlement enregistré par la comptabilité, isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, Client } from '../helpers/api-client.js';
import { ev, setup, ready, sealedTrip, otpOf, tokenOf } from '../helpers/scenario.js';
import { paymentReminders } from '../../server/rpc/creances.js';

async function deliverAll(S, trip) {
  await S.driver.rpc('lg_trip_start', { p_trip: trip, p_event: ev() });
  for (const st of (await S.driver.rpc('lg_my_day')).trips.find((t) => t.id === trip).stops) {
    assert.equal(st.cod_due_fcfa, 0, 'à terme : rien à encaisser');
    const r = await S.driver.rpc('lg_deliver', { p_stop: st.id, p_event: ev(), p_codes: st.packages.map((p) => p.code), p_otp: otpOf(S.env, st.order_id).code,
      p_photo_path: `${trip}/p.jpg`, p_payments: [] });
    assert.equal(r.ok, true, JSON.stringify(r));
  }
}

test('à terme : préparation sans paiement, livraison sans encaissement, échéance, relances, règlement', async () => {
  const env = makeEnv(); const S = await setup(env);
  const db = env.DB.db;
  const phone = '771234567';
  // commande créée à terme (15 jours) : rien à encaisser, part tout de suite en préparation (ready() la prépare)
  const A = await ready(S, [[S.P.rice, 1]], { method: 'account', phone });
  let row = db.prepare('SELECT payment_method, payment_status, payment_terms_days FROM orders WHERE id = ?').get(A.order.id);
  assert.deepEqual([A.order.payment_method, A.order.amount_due_fcfa, row.payment_status, row.payment_terms_days], ['account', 0, 'pending', 30]);
  const tr = await new Client(env).rpc('lg_track', { p_token: tokenOf(env, A.order.id) });
  assert.deepEqual([tr.order.payment_method, tr.amount_due_fcfa], ['account', 0]);
  // livraison : aucune somme demandée ; commande livrée mais toujours à régler, échéance = livraison + 30 j
  await deliverAll(S, await sealedTrip(S, [A]));
  row = db.prepare('SELECT status, payment_status, delivered_at, due_at FROM orders WHERE id = ?').get(A.order.id);
  assert.deepEqual([row.status, row.payment_status], ['delivered', 'pending']);
  assert.equal(Math.round((Date.parse(row.due_at) - Date.parse(row.delivered_at)) / 86400000), 30);
  // facture : « à régler » (pas « payée »), avec échéance
  const inv = (await S.accountant.rpc('lg_invoices_list', {}))[0];
  assert.deepEqual([inv.status, inv.payment_method, inv.due_at], ['due', 'account', row.due_at]);
  const doc = await S.accountant.rpc('lg_invoice_get', { p_invoice: inv.id });
  assert.deepEqual([doc.metadata.due_at, doc.settlement.paid], [row.due_at, false]);
  // créances : ouverte, pas encore échue
  let rc = await S.accountant.rpc('lg_receivables', {});
  assert.deepEqual([rc.list.length, rc.list[0].owed_fcfa, rc.list[0].invoice, rc.aging.not_due], [1, inv.ttc, inv.number, inv.ttc]);
  assert.equal((await S.accountant.rpc('lg_receivables', { p_state: 'overdue' })).list.length, 0);
  // relances : rien tant que l'échéance est loin ; échue → un message, une seule fois
  const now = `${new Date().toISOString().slice(0, 10)}T10:00:00.000Z`;
  assert.equal((await paymentReminders(env, now)).payment_reminders, 0);
  db.prepare('UPDATE orders SET due_at = ? WHERE id = ?').run(new Date(Date.parse(now) - 2 * 86400000).toISOString(), A.order.id);
  assert.equal((await paymentReminders(env, now)).payment_reminders, 1);
  assert.equal((await paymentReminders(env, now)).payment_reminders, 0, 'pas de doublon');
  assert.equal((await paymentReminders(env, now.replace('T10', 'T22'))).payment_reminders, 0, 'jamais la nuit');
  const msg = db.prepare("SELECT text FROM outbox WHERE event_key = 'lg_invoice_overdue'").get();
  assert.match(msg.text, new RegExp(inv.number));
  rc = await S.accountant.rpc('lg_receivables', { p_state: 'overdue' });
  assert.deepEqual([rc.list.length, rc.list[0].days_late, rc.overdue_fcfa], [1, 2, inv.ttc]);
  assert.equal((await S.accountant.rpc('lg_invoices_list', {}))[0].status, 'overdue');
  // règlement : réservé à la comptabilité ; rejouable
  assert.equal(await S.support.rpcError('lg_order_record_payment', { p_order: A.order.id }), 'forbidden');
  assert.deepEqual(await S.accountant.rpc('lg_order_record_payment', { p_order: A.order.id, p_ref: 'VIR-2026-118', p_via: 'transfer' }), { ok: true });
  assert.equal((await S.accountant.rpc('lg_order_record_payment', { p_order: A.order.id })).already, true);
  assert.equal((await S.accountant.rpc('lg_receivables', {})).list.length, 0);
  assert.equal((await S.accountant.rpc('lg_receivables', { p_state: 'paid' })).list[0].payment_ref, 'VIR-2026-118');
  assert.equal((await S.accountant.rpc('lg_invoices_list', {}))[0].status, 'paid');
});

test('client en compte : délai mémorisé, mode par défaut, date imposée ; refus et isolation', async () => {
  const env = makeEnv(); const S = await setup(env);
  const db = env.DB.db;
  const create = (extra) => S.support.rpc('lg_order_create', { p_customer: { name: 'Auchan Sacré-Cœur', phone: '338001234' }, p_zone: 'Yoff',
    p_items: [{ product_id: S.P.oil, quantity: 2 }], ...extra });
  const day = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const a = await create({ p_payment_method: 'account', p_payment_terms_days: 15, p_promised_at: day });
  assert.deepEqual([a.payment_method, a.payment_terms_days, a.promised_at.slice(0, 10)], ['account', 15, day]);
  // le client garde son délai : sa commande suivante est à terme par défaut
  const b = await create({});
  assert.deepEqual([b.payment_method, b.payment_terms_days], ['account', 15]);
  // une commande à terme est dans la file de préparation sans confirmation
  assert.ok((await S.picker.rpc('lg_pick_queue')).some((t) => t.order_id === b.id));
  // retour au paiement à la livraison
  const cust = db.prepare('SELECT id FROM customers WHERE phone_key = ?').get('338001234').id;
  assert.deepEqual(await S.accountant.rpc('lg_customer_terms_set', { p_customer: cust, p_days: null }), { ok: true, days: null });
  assert.equal((await create({})).payment_method, 'cod');
  assert.equal(await S.support.rpcError('lg_order_create', { p_customer: { name: 'X Y', phone: '338001235' }, p_zone: 'Yoff',
    p_items: [{ product_id: S.P.oil, quantity: 1 }], p_payment_method: 'account', p_payment_terms_days: 999 }), 'invalid_terms');
  // une commande payée à la livraison n'est pas une créance
  const c = await create({ p_payment_method: 'cod' });
  assert.equal(await S.accountant.rpcError('lg_order_record_payment', { p_order: c.id }), 'not_on_account');
  // autre entreprise : ne voit ni ne règle rien
  const T = await setup(env, 'bob@autre.sn', 'Autre Express');
  assert.equal((await T.accountant.rpc('lg_receivables', {})).list.length, 0);
  assert.equal(await T.accountant.rpcError('lg_order_record_payment', { p_order: a.id }), 'unknown_order');
  assert.equal(await T.accountant.rpcError('lg_customer_terms_set', { p_customer: cust, p_days: 30 }), 'unknown_customer');
});
