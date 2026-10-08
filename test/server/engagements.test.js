// Cycle C11 — engagement de délai de préparation des vendeurs (porté de test/sql/cycle9) : heure limite des
// préparations, suivi, relances (avant l'échéance puis en retard, une fois par étape) ; isolation et rôles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../../server/app.js';
import { makeEnv, invite } from '../helpers/api-client.js';
import { setup } from '../helpers/scenario.js';

const db = (env) => env.DB.db;
const cron = (env, task) => handle(new Request(`https://logistique.test/api/cron/${task}`, { method: 'POST', headers: { 'x-cron-secret': env.CRON_SECRET } }), env).then((r) => r.json());

async function vendorShop(env, S, email = 'ndeye@boutique.sn') {
  const vendor = await invite(env, S.admin, email, { role: 'vendor', name: 'Ndèye Sarr' });
  db(env).prepare('UPDATE users SET phone = ? WHERE id = ?').run('776665544', vendor.user.id);
  const pr = await vendor.rpc('lg_product_upsert', { p: { name: 'Bissap', sku: `BIS-${email.length}`, price_fcfa: 2000, weight_g: 1000 } });
  const order = () => vendor.rpc('lg_order_create', { p_customer: { name: 'Client Test', phone: '770001122' }, p_zone: 'Yoff', p_items: [{ product_id: pr.id, quantity: 1 }], p_payment_method: 'prepaid' });
  return { vendor, order };
}

test('engagement : heure limite = commande + délai, suivi, relances avant l\'échéance puis en retard', async () => {
  const env = makeEnv(); env.CRON_SECRET = 'c'.repeat(32);
  const S = await setup(env);
  const { vendor, order } = await vendorShop(env, S);
  assert.equal(await vendor.rpcError('lg_vendor_commitment_set', { p_hours: 200 }), 'invalid_hours');
  assert.deepEqual(await vendor.rpc('lg_vendor_commitment_set', { p_hours: 4 }), { ok: true, vendor_id: vendor.user.id, prep_hours: 4 });
  const o = await order();
  const t = db(env).prepare('SELECT * FROM pick_tasks WHERE order_id = ?').get(o.id);
  const h = (Date.parse(t.cutoff_at) - Date.parse(t.created_at)) / 3600000;
  assert.ok(Math.abs(h - 4) < 0.01, `heure limite à 4 h (${h})`);
  let me = await vendor.rpc('lg_my_commitment');
  assert.deepEqual([me.prep_hours, me.open, me.tasks.length, me.tasks[0].order_short], [4, 1, 1, String(o.number)]);
  assert.ok(me.tasks[0].minutes_left > 230 && me.tasks[0].minutes_left <= 240);
  // à 1 h de l'échéance : relance « bientôt » (une seule)
  db(env).prepare('UPDATE pick_tasks SET cutoff_at = ? WHERE id = ?').run(new Date(Date.now() + 3600000).toISOString(), t.id);
  assert.equal((await cron(env, 'reminders')).reminders, 1);
  assert.equal((await cron(env, 'reminders')).reminders, 0);
  // en retard : relance « en retard »
  db(env).prepare('UPDATE pick_tasks SET cutoff_at = ? WHERE id = ?').run(new Date(Date.now() - 60000).toISOString(), t.id);
  await cron(env, 'reminders');
  const msgs = db(env).prepare("SELECT event_key, phone, text FROM outbox WHERE event_key LIKE 'lg_vendor_prep_%' ORDER BY created_at, rowid").all();
  assert.deepEqual(msgs.map((m) => m.event_key), ['lg_vendor_prep_soon', 'lg_vendor_prep_late']);
  assert.equal(msgs[0].phone, '776665544');
  assert.match(msgs[0].text, new RegExp(`^Bonjour Ndèye, la commande ${o.number} doit être prête avant \\d\\dh\\d\\d \\(votre engagement : 4 h\\)`));
  me = await vendor.rpc('lg_my_commitment');
  assert.deepEqual([me.open_late, me.reminders], [1, 2]);
  // vue d'ensemble pour le quai ; retrait de l'engagement par le chef de quai
  const list = await S.dock.rpc('lg_vendor_commitments_list', {});
  assert.deepEqual([list.length, list[0].name, list[0].prep_hours, list[0].open_late], [1, 'Ndèye Sarr', 4, 1]);
  await S.dock.rpc('lg_vendor_commitment_set', { p_vendor: vendor.user.id, p_hours: null });
  const o2 = await order();
  const t2 = db(env).prepare('SELECT * FROM pick_tasks WHERE order_id = ?').get(o2.id);
  const p2 = db(env).prepare('SELECT promised_at FROM orders WHERE id = ?').get(o2.id).promised_at;
  assert.equal(t2.cutoff_at, new Date(Date.parse(p2) - 3 * 3600000).toISOString(), 'sans engagement : 3 h avant l\'heure promise');
});

test('isolation et rôles : engagement propre à l\'entreprise et au vendeur', async () => {
  const env = makeEnv();
  const S = await setup(env);
  const X = await setup(env, 'binta@rapide.sn', 'Rapide Thiès');
  const { vendor } = await vendorShop(env, S);
  await vendor.rpc('lg_vendor_commitment_set', { p_hours: 6 });
  assert.equal(await X.dock.rpcError('lg_vendor_commitment_set', { p_vendor: vendor.user.id, p_hours: 1 }), 'unknown_vendor');
  assert.deepEqual(await X.dock.rpc('lg_vendor_commitments_list', {}), []);
  assert.equal(db(env).prepare('SELECT prep_hours FROM vendor_commitments').get().prep_hours, 6);
  assert.equal(await S.picker.rpcError('lg_vendor_commitment_set', { p_vendor: vendor.user.id, p_hours: 1 }), 'forbidden');
  assert.equal(await S.picker.rpcError('lg_my_commitment'), 'forbidden');
  assert.equal(await S.picker.rpcError('lg_vendor_commitments_list'), 'forbidden');
  assert.equal(await S.dock.rpcError('lg_vendor_commitment_set', { p_vendor: S.driver.user.id, p_hours: 2 }), 'unknown_vendor', 'un chauffeur n\'est pas un vendeur');
});
