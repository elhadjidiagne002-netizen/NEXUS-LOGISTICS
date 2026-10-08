// Cycle 9 : engagement de délai des vendeurs — heure limite, mesure, relances automatiques.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, makeOrder, U, IDS } from '../helpers/db.mjs';

let t; let task1;
before(async () => { t = await createDb(); });
const taskOf = async (o) => (await t.one('select id, cutoff_at, created_at from lg_pick_tasks where order_id = $1', [o]));

test('engagement : le vendeur promet un délai, qui fixe l\'heure limite de ses nouvelles commandes', async () => {
  const before = await taskOf(await makeOrder(t, { method: 'mobile', paid: true, lines: [[IDS.soap, 1]] }));
  assert.equal(Math.round((before.cutoff_at - before.created_at) / 36e5), 24, 'sans engagement : 24 h par défaut');

  assert.equal((await t.rpc(U.vendor, 'lg_vendor_commitment_set', { p_hours: 6 })).prep_hours, 6);
  await assert.rejects(t.rpc(U.vendor, 'lg_vendor_commitment_set', { p_hours: 0 }), /invalid_hours/);
  await assert.rejects(t.rpc(U.stranger, 'lg_vendor_commitment_set', { p_hours: 4 }), /forbidden/);
  await assert.rejects(t.rpc(U.picker, 'lg_vendor_commitment_set', { p_hours: 4, p_vendor: U.vendor }), /forbidden/);
  await t.rpc(U.dock, 'lg_vendor_commitment_set', { p_hours: 5, p_vendor: U.vendor });

  const tk = await taskOf(await makeOrder(t, { method: 'mobile', paid: true, lines: [[IDS.soap, 1]] }));
  task1 = tk.id;
  assert.ok(Math.abs((tk.cutoff_at - Date.now()) / 36e5 - 5) < 0.05, 'heure limite = maintenant + 5 h');
});

test('relances : 2 h avant l\'échéance, puis en retard, une seule fois chacune ; pas si le hub a pris la commande', async () => {
  await t.as(null);
  await t.db.query("update lg_pick_tasks set cutoff_at = now() + interval '1 hour' where id = $1", [task1]);
  // une autre commande, déjà prise par un préparateur du hub et en retard : pas de relance au vendeur
  const hub = (await taskOf(await makeOrder(t, { method: 'mobile', paid: true, lines: [[IDS.oil, 1]] }))).id;
  await t.rpc(U.picker, 'lg_pick_take', { p_task: hub });
  await t.as(null);
  // les commandes du premier test (24 h et engagement) : hors fenêtre de relance
  await t.db.query("update lg_pick_tasks set cutoff_at = now() - interval '1 hour' where id = $1", [hub]);

  const send = async () => (await t.rpc(null, 'lg_vendor_reminders', {})).sent;
  assert.equal(await send(), 1);
  assert.equal(await send(), 0, 'déjà relancé pour cette étape');
  await t.db.query("update lg_pick_tasks set cutoff_at = now() - interval '10 minutes' where id = $1", [task1]);
  assert.equal(await send(), 1);
  assert.equal(await send(), 0);
  const msgs = await t.all("select event_key, recipient, vars from notification_outbox where event_key like 'lg_vendor_prep_%' order by created_at");
  assert.deepEqual(msgs.map((m) => m.event_key), ['lg_vendor_prep_soon', 'lg_vendor_prep_late']);
  assert.equal(msgs[0].recipient.userId, U.vendor);
  assert.match(msgs[1].vars.texte, /devait être prête/);
  assert.match(msgs[0].vars.texte, /5 h/);
});

test('mesure : ponctualité visible par le vendeur et par le chef de quai', async () => {
  // commande en retard terminée maintenant ; une autre terminée dans les temps
  await t.rpc(U.vendor, 'lg_pick_take', { p_task: task1 });
  await t.rpc(U.vendor, 'lg_pick_scan', { p_task: task1, p_code: 'SAV-4', p_event: t.ev() });
  await t.rpc(U.vendor, 'lg_pack', { p_task: task1, p_event: t.ev(), p_packages: [{ weight_g: 700 }] });
  const ontime = (await taskOf(await makeOrder(t, { method: 'mobile', paid: true, lines: [[IDS.soap, 1]] }))).id;
  await t.rpc(U.vendor, 'lg_pick_take', { p_task: ontime });
  await t.rpc(U.vendor, 'lg_pick_scan', { p_task: ontime, p_code: 'SAV-4', p_event: t.ev() });
  await t.rpc(U.vendor, 'lg_pack', { p_task: ontime, p_event: t.ev(), p_packages: [{ weight_g: 700 }] });

  const mine = await t.rpc(U.vendor, 'lg_my_commitment', {});
  assert.deepEqual([mine.prep_hours, mine.done, mine.on_time, Number(mine.on_time_pct), mine.reminders], [5, 2, 1, 50, 2]);
  assert.ok(mine.tasks.length >= 1 && mine.tasks.every((x) => 'minutes_left' in x), 'commandes encore ouvertes, avec le temps restant');
  const list = await t.rpc(U.dock, 'lg_vendor_commitments_list', {});
  assert.equal(list.find((v) => v.vendor_id === U.vendor).prep_hours, 5);
  await assert.rejects(t.rpc(U.stranger, 'lg_my_commitment', {}), /forbidden/);
  await assert.rejects(t.rpc(U.driver, 'lg_vendor_commitments_list', {}), /forbidden/);
  // retirer l'engagement : retour à l'heure limite par défaut
  await t.rpc(U.vendor, 'lg_vendor_commitment_set', { p_hours: null });
  const tk = await taskOf(await makeOrder(t, { method: 'mobile', paid: true, lines: [[IDS.soap, 1]] }));
  assert.equal(Math.round((tk.cutoff_at - tk.created_at) / 36e5), 24);
});
