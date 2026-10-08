// Cycle 15 : appareils — liste, déconnexion à distance, blocage appliqué côté serveur.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, U } from '../helpers/db.mjs';

let t; let pickerDev;
// ce que PostgREST met à disposition : en-têtes de la requête et revendications du jeton
const as = async (device, session) => {
  await t.db.query("select set_config('request.headers', $1, false), set_config('request.jwt.claims', $2, false)",
    [device ? JSON.stringify({ 'x-lg-device': device, 'user-agent': 'Test/1.0' }) : '', session ? JSON.stringify({ session_id: session }) : '']);
};
before(async () => { t = await createDb(); });

test('l\'app s\'annonce : appareil enregistré, visible par son titulaire et par l\'administrateur', async () => {
  await as('tel-fatou-0001', 's-fatou-1');
  assert.equal((await t.rpc(U.picker, 'lg_device_ping', { p_device: 'tel-fatou-0001', p_label: 'Téléphone de Fatou' })).ok, true);
  await assert.rejects(t.rpc(U.picker, 'lg_device_ping', { p_device: 'x' }), /invalid_device/);
  const mine = await t.rpc(U.picker, 'lg_devices_list', {});
  assert.deepEqual([mine.length, mine[0].this_device, mine[0].user_agent], [1, true, 'Test/1.0']);
  pickerDev = mine[0].id;
  await as('tel-admin-0001', 's-admin-1');
  await t.rpc(U.admin, 'lg_device_ping', { p_device: 'tel-admin-0001' });
  assert.equal((await t.rpc(U.admin, 'lg_devices_list', {})).length, 2);
  await as('tel-moussa-0001', 's-moussa-1');
  assert.equal((await t.rpc(U.driver, 'lg_devices_list', {})).length, 0, 'un autre ne voit pas les appareils de Fatou');
});

test('appareil perdu : bloqué par l\'administrateur, plus aucun droit ; débloqué, tout revient', async () => {
  await as('tel-moussa-0001', 's-moussa-1');
  await assert.rejects(t.rpc(U.driver, 'lg_device_block', { p_id: pickerDev }), /forbidden/);
  await as('tel-admin-0001', 's-admin-1');
  const self = (await t.rpc(U.admin, 'lg_devices_list', {})).find((d) => d.this_device).id;
  assert.equal((await t.rpc(U.admin, 'lg_device_block', { p_id: self })).error, 'cannot_block_self');
  assert.equal((await t.rpc(U.admin, 'lg_device_block', { p_id: pickerDev })).blocked, true);

  await as('tel-fatou-0001', 's-fatou-1');
  await assert.rejects(t.rpc(U.picker, 'lg_inventory_today', {}), /forbidden/, 'le téléphone perdu ne peut plus rien');
  assert.equal((await t.rpc(U.picker, 'lg_device_ping', { p_device: 'tel-fatou-0001' })).error, 'device_blocked');
  await as('tel-fatou-0002', 's-fatou-2');
  assert.ok(Array.isArray(await t.rpc(U.picker, 'lg_inventory_today', {})), 'son nouveau téléphone marche');
  await as(null, null);
  assert.ok(Array.isArray(await t.rpc(U.picker, 'lg_inventory_today', {})), 'sans en-tête (ancienne app) : inchangé');

  await as('tel-admin-0001', 's-admin-1');
  await t.rpc(U.admin, 'lg_device_block', { p_id: pickerDev, p_blocked: false });
  await as('tel-fatou-0001', 's-fatou-1');
  assert.ok(Array.isArray(await t.rpc(U.picker, 'lg_inventory_today', {})));
});

test('déconnexion à distance : la session coupée ne passe plus, une nouvelle connexion oui', async () => {
  await as('tel-moussa-0001', 's-moussa-1');
  await t.rpc(U.driver, 'lg_device_ping', { p_device: 'tel-moussa-0001' });
  assert.ok((await t.one('select public.lg_my_courier_id() c')).c, 'chauffeur reconnu');
  await as('tel-admin-0001', 's-admin-1');
  const dev = (await t.rpc(U.admin, 'lg_devices_list', { p_user: U.driver }))[0];
  assert.equal(dev.active_session, true);
  await t.rpc(U.admin, 'lg_device_revoke', { p_id: dev.id });
  await as('tel-moussa-0001', 's-moussa-1');
  await t.as(U.driver);
  assert.equal((await t.one('select public.lg_my_courier_id() c')).c, null, 'session coupée : plus chauffeur');
  assert.equal((await t.rpc(U.driver, 'lg_device_ping', { p_device: 'tel-moussa-0001' })).error, 'device_revoked');
  await as('tel-moussa-0001', 's-moussa-2');
  assert.equal((await t.rpc(U.driver, 'lg_device_ping', { p_device: 'tel-moussa-0001' })).ok, true, 'reconnecté par mot de passe');
  await t.as(U.driver);
  assert.ok((await t.one('select public.lg_my_courier_id() c')).c);
  // le titulaire peut couper lui-même une session, pas celle d'un autre
  await as('tel-fatou-0001', 's-fatou-1');
  await assert.rejects(t.rpc(U.picker, 'lg_device_revoke', { p_id: dev.id }), /forbidden/);
  await as(null, null);
});
