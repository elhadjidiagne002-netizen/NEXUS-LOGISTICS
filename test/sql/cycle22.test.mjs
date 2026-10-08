// Cycle 22 : appel de livreurs en renfort pour un jour de pic.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, U } from '../helpers/db.mjs';

let t; let call;
const day = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Africa/Dakar' });
before(async () => { t = await createDb(); });

test('appel : chaque chauffeur actif est prévenu une fois, relancer met à jour sans renvoyer', async () => {
  await assert.rejects(t.rpc(U.driver, 'lg_reinforcement_call', { p_day: day(2), p_needed: 2 }), /forbidden/);
  await assert.rejects(t.rpc(U.dispatcher, 'lg_reinforcement_call', { p_day: day(-1), p_needed: 2 }), /past_day/);
  const c = await t.rpc(U.dispatcher, 'lg_reinforcement_call', { p_day: day(2), p_needed: 2, p_zones: ['Rufisque'], p_note: 'Tabaski' });
  assert.equal(c.notified, 3, 'les 3 chauffeurs actifs de la démo');
  call = c.id;
  const msg = await t.one("select recipient, vars from notification_outbox where event_key = 'lg_reinforcement' limit 1");
  assert.match(msg.vars.texte, /renfort le \d\d\/\d\d \(Rufisque\)/);
  assert.ok(msg.recipient.phone);
  const again = await t.rpc(U.dispatcher, 'lg_reinforcement_call', { p_day: day(2), p_needed: 3 });
  assert.deepEqual([again.id, again.notified], [call, 0], 'même appel, personne de prévenu deux fois');
});

test('réponses des chauffeurs, vues par le répartiteur', async () => {
  const mine = await t.rpc(U.driver, 'lg_my_reinforcements', {});
  assert.deepEqual(mine.map((x) => [x.id, x.available]), [[call, null]]);
  await t.rpc(U.driver, 'lg_reinforcement_answer', { p_call: call, p_available: true });
  await t.rpc(U.driver2, 'lg_reinforcement_answer', { p_call: call, p_available: false });
  const r = (await t.rpc(U.dispatcher, 'lg_reinforcements', {})).find((x) => x.id === call);
  assert.deepEqual([r.needed, r.yes, r.no, r.waiting, r.available.map((a) => a.name)], [3, 1, 1, 1, ['Moussa K.']]);
  await assert.rejects(t.rpc(U.picker, 'lg_reinforcement_answer', { p_call: call, p_available: true }), /not_a_courier/);
  await t.rpc(U.dispatcher, 'lg_reinforcement_close', { p_call: call });
  assert.equal((await t.rpc(U.driver2, 'lg_reinforcement_answer', { p_call: call, p_available: true })).error, 'call_closed');
  assert.equal((await t.rpc(U.driver, 'lg_my_reinforcements', {})).length, 0, 'appel clos : plus affiché');
});
