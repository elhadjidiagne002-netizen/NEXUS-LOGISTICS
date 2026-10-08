// Cycle 5 : prévision, anomalies, classement, contrôle des retours, livraison à un tiers.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, U, IDS } from '../helpers/db.mjs';
import { runScenario } from '../../src/demo/scenario.js';

let t; let A;
before(async () => {
  t = await createDb();
  const r = await runScenario((n, a, uid) => t.rpc(uid ?? null, n, a), (q, p) => t.db.query(q, p));
  [A] = r.trips;
});

test('prévision : même jour des 4 dernières semaines pondéré, pic déclaré, besoin en véhicules', async () => {
  await t.as(null);
  // 5 commandes Thiès (zone absente de l'historique de démo) le même jour de semaine que demain, il y a 1 à 4 semaines
  await t.db.exec(`insert into orders (status, payment_status, payment_method, total, buyer_name, delivery_zone, created_at)
    select 'delivered', 'paid', 'mobile', 10, 'Historique', 'Thiès', (now() at time zone 'Africa/Dakar')::date + 1 - w * 7 + time '10:00'
      from generate_series(1, 4) w, generate_series(1, 5) n`);
  const tomorrow = new Date(Date.now() + 864e5).toLocaleDateString('en-CA', { timeZone: 'Africa/Dakar' });
  // la démo déclare un pic « Louma du vendredi » : sans cette remise à zéro, le test échoue chaque jeudi
  await t.rpc(U.admin, 'lg_set_config', { p: { peak_days: [] } });
  let f = await t.rpc(U.dispatcher, 'lg_forecast', { p_days: 3 });
  const d1 = f.days.find((d) => d.date === tomorrow);
  const thies = (d) => Number(d.zones.find((z) => z.zone === 'Thiès')?.orders);
  assert.equal(thies(d1), 5, '5 × (0,4 + 0,3 + 0,2 + 0,1)');
  await t.rpc(U.admin, 'lg_set_config', { p: { peak_days: [{ date: tomorrow, factor: 4, label: 'Tabaski' }] } });
  f = await t.rpc(U.dispatcher, 'lg_forecast', { p_days: 3 });
  const p1 = f.days.find((d) => d.date === tomorrow);
  assert.deepEqual([thies(p1), p1.peak], [20, 'Tabaski']);
  assert.equal(Number(p1.orders), Number(d1.orders) * 4, 'le coefficient de pic s\'applique à tout le jour');
  assert.equal(p1.vehicles_needed, Math.ceil(Number(p1.orders) * 1.15 / f.per_trip));
  await assert.rejects(t.rpc(U.driver, 'lg_forecast', {}), /forbidden/);
});

test('anomalies : écarts de caisse répétés signalés sur le bon chauffeur', async () => {
  await t.as(null);
  await t.db.query(`insert into lg_cash_remittances (trip_id, courier_id, expected_fcfa, remitted_fcfa, cashier_id)
    select id, courier_id, 10000, 9000, $1 from lg_trips where courier_id = $2 limit 1`, [U.cashier, IDS.courier]);
  const trip2 = (await t.one("select id from lg_trips where courier_id = $1", [IDS.courier2])).id;
  await t.db.query(`insert into lg_cash_remittances (trip_id, courier_id, expected_fcfa, remitted_fcfa, cashier_id) values ($1, $2, 5000, 4000, $3)`,
    [trip2, IDS.courier, U.cashier]);
  const a = await t.rpc(U.support, 'lg_anomalies', {});
  const gap = a.find((x) => x.kind === 'cash_gaps');
  assert.ok(gap, JSON.stringify(a));
  assert.equal(gap.subject, 'Moussa K.');
  assert.equal(gap.severity, 'critical');
});

test('classement : chaque chauffeur voit son rang de la semaine', async () => {
  const lb = await t.rpc(U.driver, 'lg_leaderboard', {});
  assert.equal(lb.length, 3);
  assert.equal(lb[0].name, 'Moussa K.', 'seul à avoir livré');
  assert.equal(lb.filter((x) => x.me).length, 1);
  const day = await t.rpc(U.driver, 'lg_my_day', {});
  assert.deepEqual([day.week.rank, day.week.of, day.week.delivered], [1, 3, 1]);
});

test('livraison à un tiers : le voisin reçoit un nouveau code, qui seul permet la livraison', async () => {
  const stop = (await t.rpc(U.driver, 'lg_my_day', {})).trips[0].stops.find((s) => s.status === 'en_route');
  const { tracking_token: tok } = await t.one('select tracking_token from orders where id = $1', [stop.order_id]);
  assert.equal((await t.rpc(null, 'lg_track_third_party', { p_token: tok, p_name: 'X', p_phone: '12' })).error, 'invalid_recipient');
  const r = await t.rpc(null, 'lg_track_third_party', { p_token: tok, p_name: 'Modou le gardien', p_phone: '+221 77 555 44 33' });
  assert.equal(r.ok, true);
  const msg = await t.one("select recipient, vars from notification_outbox where event_key = 'lg_third_party_code' order by created_at desc limit 1");
  assert.equal(msg.recipient.phone, '+221 77 555 44 33');
  assert.match(msg.vars.texte, /^Bonjour Modou, .* Code de livraison à lui donner : \d{4}\.$/);
  const after = (await t.rpc(U.driver, 'lg_my_day', {})).trips[0].stops.find((s) => s.id === stop.id);
  assert.match(after.contact_name, /remis à Modou le gardien/);
  const first = await t.one(`select vars->>'code' c from notification_outbox where event_key = 'lg_out_for_delivery'
    and vars->>'commande' = upper(left($1::text, 8)) order by created_at limit 1`, [stop.order_id]);
  if (first.c !== msg.vars.code) {
    const old = await t.rpc(U.driver, 'lg_deliver', { p_stop: stop.id, p_event: t.ev(), p_codes: after.packages.map((p) => p.code),
      p_otp: first.c, p_photo_path: 'p.jpg', p_payments: after.cod_due_fcfa ? [{ method: 'cash', amount: after.cod_due_fcfa }] : [] });
    assert.equal(old.error, 'bad_code', 'l\'ancien code ne vaut plus');
  }
  const ok = await t.rpc(U.driver, 'lg_deliver', { p_stop: stop.id, p_event: t.ev(), p_codes: after.packages.map((p) => p.code),
    p_otp: msg.vars.code, p_photo_path: 'p.jpg', p_payments: after.cod_due_fcfa ? [{ method: 'cash', amount: after.cod_due_fcfa }] : [] });
  assert.equal(ok.ok, true, JSON.stringify(ok));
});

test('contrôle des retours : remise en vente seulement si le produit est revendable', async () => {
  // le colis en échec de la journée de démo revient au quai
  const failed = (await t.one("select p.code from lg_packages p where p.status = 'failed' limit 1")).code;
  await t.rpc(U.dock, 'lg_return_hub', { p_code: failed, p_event: t.ev() });
  await t.as(null);
  await t.db.query('update lg_packages set attempts = 2 where code = $1', [failed]);
  const todo = await t.rpc(U.dock, 'lg_returns_to_inspect', {});
  assert.ok(todo.some((x) => x.code === failed));
  const pid = (await t.one(`select oi.product_id from lg_package_items pi join order_items oi on oi.id = pi.order_item_id
    join lg_packages p on p.id = pi.package_id where p.code = $1 limit 1`, [failed])).product_id;
  const before = (await t.one('select stock from products where id = $1', [pid])).stock;
  assert.equal((await t.rpc(U.dock, 'lg_return_inspect', { p_code: failed, p_condition: 'abime', p_decision: 'restock', p_event: t.ev() })).error, 'not_resellable');
  const r = await t.rpc(U.dock, 'lg_return_inspect', { p_code: failed, p_condition: 'neuf', p_decision: 'restock', p_event: t.ev() });
  assert.equal(r.ok, true);
  assert.ok((await t.one('select stock from products where id = $1', [pid])).stock > before, 'stock remis en vente');
  assert.equal((await t.one('select status from lg_packages where code = $1', [failed])).status, 'cancelled');
});
