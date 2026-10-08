// Cycle C1 — socle multi-entreprises : comptes, invitations, rôles, appareils, isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, Client, invite } from '../helpers/api-client.js';
import { REGISTRY } from '../../server/rpc/index.js';

test('inscription : entreprise, propriétaire, premier lieu, session', async () => {
  const env = makeEnv();
  const a = new Client(env);
  const r = await a.register('awa@express.sn');
  assert.equal(r.companies.length, 1);
  assert.equal(r.companies[0].role, 'owner');
  assert.equal(r.companies[0].slug, 'express-dakar');
  const me = await a.rpc('lg_me');
  assert.equal(me.is_admin, true);
  assert.equal(me.is_owner, true);
  assert.equal(me.company.name, 'Express Dakar');
  assert.equal(me.company.plan, 'free');
  assert.equal(me.hubs.length, 1);
  assert.equal(me.config.max_attempts, 2);
  // même nom d'entreprise → autre adresse publique
  const b = new Client(env);
  const r2 = await b.register('bob@express.sn');
  assert.equal(r2.companies[0].slug, 'express-dakar-2');
});

test('inscription refusée : e-mail déjà pris, mot de passe faible, e-mail invalide', async () => {
  const env = makeEnv();
  await new Client(env).register('awa@express.sn');
  const c = new Client(env);
  const dup = await c.post('/api/auth/register', { email: 'AWA@express.sn', password: 'motdepasse-solide', name: 'X', company: { name: 'Y' } });
  assert.equal(dup.status, 409);
  const weak = await c.post('/api/auth/register', { email: 'x@y.sn', password: 'court', name: 'X', company: { name: 'Y' } });
  assert.equal(weak.data.error, 'weak_password');
  const bad = await c.post('/api/auth/register', { email: 'pas-un-email', password: 'motdepasse-solide', name: 'X', company: { name: 'Y' } });
  assert.equal(bad.data.error, 'invalid_email');
});

test('connexion, session, déconnexion ; mauvais mot de passe', async () => {
  const env = makeEnv();
  await new Client(env).register('awa@express.sn');
  const c = new Client(env);
  assert.equal((await c.get('/api/auth/session')).data.session, null);
  assert.equal((await c.login('awa@express.sn', 'mauvais-mot-de-passe')).status, 401);
  assert.equal((await c.login('awa@express.sn')).status, 200);
  assert.equal((await c.get('/api/auth/session')).data.session.user.email, 'awa@express.sn');
  await c.post('/api/auth/logout');
  assert.equal(await c.rpcError('lg_me'), 'auth');
});

test('toute fonction non publique refuse un visiteur sans session', async () => {
  const env = makeEnv();
  const anon = new Client(env);
  for (const [name, def] of Object.entries(REGISTRY)) {
    if (def.roles === 'public') continue;
    assert.equal(await anon.rpcError(name), 'auth', name);
  }
  assert.equal(await anon.rpcError('lg_inexistante'), 'unknown_function');
});

test('invitation : membre avec rôles logistiques, lien à usage unique', async () => {
  const env = makeEnv();
  const owner = new Client(env);
  await owner.register('awa@express.sn');
  const inv = await owner.rpc('lg_invite_create', { p_role: 'staff', p_staff_roles: ['picker', 'pirate'], p_name: 'Fatou' });
  const preview = await new Client(env).get(`/api/invites/${inv.token}`);
  assert.equal(preview.data.company, 'Express Dakar');
  assert.deepEqual(preview.data.staff_roles, ['picker']);
  const fatou = new Client(env);
  assert.equal((await fatou.post(`/api/invites/${inv.token}/accept`, { email: 'fatou@express.sn', password: 'motdepasse-solide' })).status, 200);
  const me = await fatou.rpc('lg_me');
  assert.equal(me.name, 'Fatou');
  assert.equal(me.is_admin, false);
  assert.deepEqual(me.roles.map((r) => r.role), ['picker']);
  // réutilisation refusée
  const again = await new Client(env).post(`/api/invites/${inv.token}/accept`, { email: 'autre@express.sn', password: 'motdepasse-solide', name: 'Autre' });
  assert.equal(again.status, 404);
  // un membre simple n'administre pas
  assert.equal(await fatou.rpcError('lg_staff_list'), 'forbidden');
  assert.equal(await fatou.rpcError('lg_invite_create', { p_role: 'staff' }), 'forbidden');
});

test('invitation chauffeur : fiche chauffeur créée ; compte existant rattaché à une 2e entreprise', async () => {
  const env = makeEnv();
  const a = new Client(env); await a.register('awa@express.sn');
  const moussa = await invite(env, a, 'moussa@gmail.com', { role: 'courier', name: 'Moussa' });
  const me = await moussa.rpc('lg_me');
  assert.ok(me.courier_id);
  assert.equal((await a.rpc('lg_couriers_list'))[0].name, 'Moussa');
  // Moussa travaille aussi pour une autre entreprise : même compte, mot de passe exigé
  const b = new Client(env); await b.register('bob@rapide.sn', { company: 'Rapide' });
  const inv = await b.rpc('lg_invite_create', { p_role: 'courier' });
  const m2 = new Client(env);
  assert.equal((await m2.post(`/api/invites/${inv.token}/accept`, { email: 'moussa@gmail.com', password: 'faux-mot-de-passe' })).status, 401);
  const ok = await m2.post(`/api/invites/${inv.token}/accept`, { email: 'moussa@gmail.com', password: 'motdepasse-solide' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.companies.length, 2);
  assert.equal((await m2.rpc('lg_me')).company.name, 'Rapide');
  // changement d'entreprise active
  const first = ok.data.companies.find((c) => c.name === 'Express Dakar');
  assert.equal((await m2.post('/api/auth/company', { company_id: first.id })).status, 200);
  assert.equal((await m2.rpc('lg_me')).company.name, 'Express Dakar');
  // pas d'accès à une entreprise dont on n'est pas membre
  const c = new Client(env); await c.register('cheikh@autre.sn', { company: 'Autre' });
  assert.equal((await c.post('/api/auth/company', { company_id: first.id })).status, 403);
});

test('rôles : attribuer, retirer, lieu ; la recherche ne voit que les membres', async () => {
  const env = makeEnv();
  const a = new Client(env); await a.register('awa@express.sn');
  const fatou = await invite(env, a, 'fatou@express.sn');
  const hub = (await a.rpc('lg_me')).hubs[0].id;
  assert.equal(await a.rpcError('lg_grant_role', { p_user: fatou.user.id, p_role: 'roi' }), 'invalid_role');
  await a.rpc('lg_grant_role', { p_user: fatou.user.id, p_role: 'dock_chief', p_hub: hub });
  assert.deepEqual((await fatou.rpc('lg_me')).roles, [{ role: 'dock_chief', hub_id: hub, hub: 'Dépôt principal' }]);
  assert.equal((await a.rpc('lg_staff_list'))[0].role, 'dock_chief');
  // chef de quai : liste des chauffeurs autorisée
  assert.deepEqual(await fatou.rpc('lg_couriers_list'), []);
  assert.equal((await a.rpc('lg_revoke_role', { p_user: fatou.user.id, p_role: 'dock_chief' })).ok, true);
  assert.equal(await fatou.rpcError('lg_couriers_list'), 'forbidden');
  // une autre entreprise ne trouve pas Fatou et ne peut pas lui donner de rôle
  const b = new Client(env); await b.register('bob@rapide.sn', { company: 'Rapide' });
  assert.deepEqual(await b.rpc('lg_find_users', { p_q: 'fatou' }), []);
  assert.equal(await b.rpcError('lg_grant_role', { p_user: fatou.user.id, p_role: 'picker' }), 'unknown_user');
  assert.equal((await a.rpc('lg_find_users', { p_q: 'fatou' })).length, 1);
});

test('retrait d\'un membre : plus aucun accès, propriétaire intouchable', async () => {
  const env = makeEnv();
  const a = new Client(env); await a.register('awa@express.sn');
  const fatou = await invite(env, a, 'fatou@express.sn', { staff: ['support'] });
  assert.equal(await a.rpcError('lg_member_remove', { p_user: a.user.id }), 'cannot_remove_self');
  assert.equal((await a.rpc('lg_member_remove', { p_user: fatou.user.id })).ok, true);
  assert.equal(await fatou.rpcError('lg_me'), 'no_company');
  assert.equal((await a.rpc('lg_team_list')).length, 1);
});

test('réglages : clés connues seulement, valeurs vérifiées, propres à chaque entreprise', async () => {
  const env = makeEnv();
  const a = new Client(env); await a.register('awa@express.sn');
  const b = new Client(env); await b.register('bob@rapide.sn', { company: 'Rapide' });
  const r = await a.rpc('lg_set_config', { p: { max_attempts: 3, require_photo: false, pirate: 1, proof_radius_m: -5 } });
  assert.deepEqual(r.config, { max_attempts: 3, require_photo: false });
  assert.equal((await a.rpc('lg_me')).config.max_attempts, 3);
  assert.equal((await b.rpc('lg_me')).config.max_attempts, 2);
  assert.equal((await a.rpc('lg_config')).config.proof_radius_m, 300);
});

test('appareils : blocage appliqué côté serveur, déconnexion à distance, isolation', async () => {
  const env = makeEnv();
  const a = new Client(env, { device: 'appareil-admin-1' }); await a.register('awa@express.sn');
  const moussa = await invite(env, a, 'moussa@gmail.com', { role: 'courier', name: 'Moussa', device: 'telephone-moussa' });
  assert.equal((await a.rpc('lg_device_ping', { p_device: 'appareil-admin-1', p_label: 'PC' })).ok, true);
  assert.equal((await moussa.rpc('lg_device_ping', { p_device: 'telephone-moussa', p_label: 'Android · Chrome' })).ok, true);
  const list = await a.rpc('lg_devices_list');
  assert.equal(list.length, 2);
  const mine = list.find((d) => d.this_device);
  const his = list.find((d) => d.user === 'Moussa');
  assert.equal((await a.rpc('lg_device_block', { p_id: mine.id })).error, 'cannot_block_self');
  // une autre entreprise ne voit ni ne bloque l'appareil de Moussa
  const b = new Client(env); await b.register('bob@rapide.sn', { company: 'Rapide' });
  assert.deepEqual(await b.rpc('lg_devices_list'), []);
  assert.equal(await b.rpcError('lg_device_block', { p_id: his.id }), 'unknown_device');
  // blocage : tout est refusé depuis ce téléphone, le ping le dit
  await a.rpc('lg_device_block', { p_id: his.id, p_blocked: true });
  assert.equal(await moussa.rpcError('lg_me'), 'device_blocked');
  assert.equal((await moussa.rpc('lg_device_ping', { p_device: 'telephone-moussa' })).error, 'device_blocked');
  await a.rpc('lg_device_block', { p_id: his.id, p_blocked: false });
  assert.ok(await moussa.rpc('lg_me'));
  // déconnexion à distance : la session en cours est refusée, une nouvelle connexion passe
  assert.equal((await a.rpc('lg_device_revoke', { p_id: his.id })).ok, true);
  assert.equal(await moussa.rpcError('lg_me'), 'device_blocked');
  assert.equal((await moussa.login('moussa@gmail.com')).status, 200);
  assert.equal((await moussa.rpc('lg_device_ping', { p_device: 'telephone-moussa' })).ok, true);
  assert.ok(await moussa.rpc('lg_me'));
});

test('lieux et chauffeurs : création, modification limitée à son entreprise', async () => {
  const env = makeEnv();
  const a = new Client(env); await a.register('awa@express.sn');
  const b = new Client(env); await b.register('bob@rapide.sn', { company: 'Rapide' });
  const h = await a.rpc('lg_hub_upsert', { p_name: 'Relais Sandaga', p_kind: 'relay', p_lat: 14.67, p_lng: -17.43 });
  assert.equal((await a.rpc('lg_me')).hubs.length, 2);
  assert.equal(await b.rpcError('lg_hub_upsert', { p_id: h.id, p_name: 'Volé' }), 'unknown_hub');
  assert.equal(await a.rpcError('lg_hub_upsert', { p_name: 'X', p_lat: 200 }), 'invalid_position');
  const k = await a.rpc('lg_courier_upsert', { p_name: 'Ibrahima', p_phone: '+221770000000', p_vehicle_kind: 'moto' });
  assert.equal(await b.rpcError('lg_courier_upsert', { p_id: k.id, p_name: 'Volé' }), 'unknown_courier');
  assert.deepEqual((await b.rpc('lg_couriers_list')), []);
  assert.equal((await a.rpc('lg_couriers_list')).length, 1);
});

test('protection CSRF : une autre origine est refusée', async () => {
  const env = makeEnv();
  const a = new Client(env); await a.register('awa@express.sn');
  const r = await a.req('POST', '/api/rpc/lg_me', {}, { origin: 'https://pirate.example' });
  assert.equal(r.status, 403);
});
