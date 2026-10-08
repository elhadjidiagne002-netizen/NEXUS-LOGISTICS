// Cycle 17 : dépôt par le vendeur — créneaux, réservation, plus de collecte prévue, réception directe.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, makeOrder, U, IDS } from '../helpers/db.mjs';

let t; let code; let s1; let s2; let booking;
const tomorrow = new Date(Date.now() + 864e5).toLocaleDateString('en-CA', { timeZone: 'Africa/Dakar' });
before(async () => { t = await createDb(); });

test('réservation : le vendeur choisit un créneau pour ses colis prêts ; plus de collecte proposée', async () => {
  assert.equal((await t.rpc(U.vendor, 'lg_dropoff_available', {})).ready_packages, 0);
  // un colis préparé et posé « prêt » chez le vendeur
  const o = await makeOrder(t, { method: 'mobile', paid: true, lines: [[IDS.soap, 1]], city: 'Yoff' });
  const task = (await t.one('select id from lg_pick_tasks where order_id = $1', [o])).id;
  await t.rpc(U.vendor, 'lg_pick_take', { p_task: task });
  await t.rpc(U.vendor, 'lg_pick_scan', { p_task: task, p_code: 'SAV-4', p_event: t.ev() });
  code = (await t.rpc(U.vendor, 'lg_pack', { p_task: task, p_event: t.ev(), p_packages: [{ weight_g: 700 }] })).packages[0].code;
  await t.rpc(U.vendor, 'lg_stage', { p_code: code, p_event: t.ev() });
  assert.equal((await t.rpc(U.dispatcher, 'lg_pickups_pending', {})).length, 1, 'à collecter tant que rien n\'est réservé');

  await assert.rejects(t.rpc(U.vendor, 'lg_dropoff_slots_create', { p_from: tomorrow, p_days: 1, p_times: ['09:00-11:00'], p_capacity: 2 }), /forbidden/);
  assert.equal((await t.rpc(U.dock, 'lg_dropoff_slots_create', { p_from: tomorrow, p_days: 1, p_times: ['09:00-11:00', '14:00-16:00'], p_capacity: 2 })).slots, 2);
  const av = await t.rpc(U.vendor, 'lg_dropoff_available', {});
  assert.deepEqual([av.ready_packages, av.slots.length, av.booking], [1, 2, null]);
  [s1, s2] = av.slots.map((s) => s.id);
  const b = await t.rpc(U.vendor, 'lg_dropoff_book', { p_slot: s1 });
  assert.deepEqual([b.ok, b.packages], [true, 1]);
  assert.equal((await t.rpc(U.dispatcher, 'lg_pickups_pending', {})).length, 0, 'dépôt prévu : pas de chauffeur envoyé');
  // changer d'avis : le nouveau créneau remplace l'ancien
  booking = (await t.rpc(U.vendor, 'lg_dropoff_book', { p_slot: s2 })).id;
  assert.equal((await t.one("select count(*)::int n from lg_dropoff_bookings where status = 'booked'")).n, 1);
  assert.equal((await t.rpc(U.vendor, 'lg_dropoff_available', {})).booking.id, booking);
  await assert.rejects(t.rpc(U.stranger, 'lg_dropoff_available', {}), /forbidden/);
  await assert.rejects(t.rpc(U.driver, 'lg_dropoff_book', { p_slot: s1 }), /forbidden/);
});

test('au hub : le colis est reçu des mains du vendeur, la réservation passe « arrivé »', async () => {
  // le créneau devient celui d'aujourd'hui (le vendeur arrive)
  await t.as(null);
  await t.db.query("update lg_dropoff_slots set day = (now() at time zone 'Africa/Dakar')::date, start_time = '00:00', end_time = '23:59' where id = $1", [s2]);
  const r = await t.rpc(U.dock, 'lg_dropoff_receive', { p_code: code, p_event: t.ev(), p_weight_g: 720 });
  assert.deepEqual([r.ok, r.next, r.booked], [true, 'staged', true]);
  const p = await t.one('select status, holder_type, hub_id, weight_g from lg_packages where code = $1', [code]);
  assert.deepEqual([p.status, p.holder_type, p.weight_g], ['staged', 'hub', 720]);
  assert.ok(p.hub_id, 'au hub, prêt à affecter');
  const today = await t.rpc(U.dock, 'lg_dropoffs_today', {});
  assert.deepEqual(today.map((x) => [x.status, x.received, x.packages]), [['arrived', 1, 1]]);
  assert.equal((await t.rpc(U.dock, 'lg_dropoff_receive', { p_code: code, p_event: t.ev() })).error, 'not_at_vendor');
  assert.equal((await t.rpc(U.vendor, 'lg_dropoff_cancel', { p_booking: booking })).error, 'bad_status');
  await assert.rejects(t.rpc(U.driver, 'lg_dropoff_receive', { p_code: code, p_event: t.ev() }), /forbidden/);
});
