// Tableau de bord d'administration de la plateforme (/admin/) : connexion par compte Devizo (AUTH_DB, lecture seule)
// limitée à ADMIN_EMAILS, session séparée, fonctions de plateforme seulement, journal des actions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../../server/app.js';
import { D1Mock } from '../helpers/d1-mock.js';
import { makeEnv, Client, invite } from '../helpers/api-client.js';
import { devizoHash } from '../../server/devizo.js';
import { REGISTRY } from '../../server/rpc/index.js';

const ADMIN = 'admin@nexus.sn';
async function envWithDevizo() {
  const env = makeEnv();
  env.ADMIN_EMAILS = `${ADMIN}, autre-admin@nexus.sn`;
  env.AUTH_DB = new D1Mock(':memory:');
  env.AUTH_DB.db.exec('CREATE TABLE tenants (id TEXT PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT, company TEXT)');
  const add = async (id, email, pass, company = '{}') => env.AUTH_DB.db.prepare('INSERT INTO tenants VALUES (?, ?, ?, ?)').run(id, email, await devizoHash(pass), company);
  await add('t1', ADMIN, 'mot-de-passe-devizo');
  await add('t2', 'artisan@exemple.sn', 'mot-de-passe-artisan');
  await add('t3', 'autre-admin@nexus.sn', 'mot-de-passe-suspendu', JSON.stringify({ suspended_at: '2026-01-01' }));
  return env;
}

class Admin extends Client {
  async login(email = ADMIN, password = 'mot-de-passe-devizo') { return this.post('/api/admin/login', { email, password }); }
  async call(name, args = {}) {
    const r = await this.post(`/api/admin/rpc/${name}`, args);
    if (r.status !== 200) { const e = new Error(`${name} → ${r.status} ${r.data.error}`); e.code = r.data.error; e.status = r.status; throw e; }
    return r.data;
  }
  async callError(name, args = {}) { try { await this.call(name, args); return null; } catch (e) { return e.code; } }
}
// le cookie d'administration est limité à /api/admin : le client de test le renvoie partout, ce qui ne change rien ici

test('connexion : compte Devizo ET adresse dans ADMIN_EMAILS, sinon refus', async () => {
  const env = await envWithDevizo();
  const a = new Admin(env);
  assert.equal((await a.get('/api/admin/me')).data.email, null);
  assert.equal((await a.login(ADMIN, 'faux')).status, 401);
  assert.equal((await a.login('artisan@exemple.sn', 'mot-de-passe-artisan')).data.error, 'not_admin');
  assert.equal((await a.login('autre-admin@nexus.sn', 'mot-de-passe-suspendu')).data.error, 'suspended');
  assert.equal((await a.login()).status, 200);
  assert.equal((await a.get('/api/admin/me')).data.email, ADMIN);
  // retiré de ADMIN_EMAILS : session refusée immédiatement
  env.ADMIN_EMAILS = 'quelquun@nexus.sn';
  assert.equal((await a.get('/api/admin/me')).data.email, null);
  env.ADMIN_EMAILS = ADMIN;
  await a.post('/api/admin/logout');
  assert.equal(await a.callError('lg_platform_overview'), 'admin_auth');
  delete env.AUTH_DB;
  assert.equal((await new Admin(env).login()).data.error, 'no_auth_db');
});

test('seules les fonctions de plateforme sont joignables par /api/admin/rpc ; aucune n\'est joignable par un compte d\'entreprise', async () => {
  const env = await envWithDevizo();
  const a = new Admin(env); await a.login();
  assert.equal(await a.callError('lg_me'), 'unknown_function');
  assert.equal(await a.callError('lg_staff_list'), 'unknown_function');
  const owner = new Client(env); await owner.register('awa@express.sn');
  for (const [name, def] of Object.entries(REGISTRY)) if (def.roles === 'platform') assert.equal(await owner.rpcError(name), 'forbidden', name);
});

test('gestion complète : entreprise, membres, propriété, comptes, commandes, journal', async () => {
  const env = await envWithDevizo();
  const owner = new Client(env); await owner.register('awa@express.sn');
  const fatou = await invite(env, owner, 'fatou@express.sn', { staff: ['picker'] });
  const a = new Admin(env); await a.login();

  const ov = await a.call('lg_platform_overview');
  assert.equal(ov.totals.companies, 1);
  const cid = ov.companies[0].id;
  const d = await a.call('lg_platform_company_detail', { p_company: cid });
  assert.deepEqual(d.members.map((m) => [m.email, m.role]), [['awa@express.sn', 'owner'], ['fatou@express.sn', 'staff']]);
  assert.deepEqual(d.members[1].staff, ['picker']);
  assert.equal(await a.callError('lg_platform_company_detail', { p_company: 'inconnue' }), 'unknown_company');

  await a.call('lg_platform_company_update', { p_company: cid, p_name: 'Express Dakar SARL' });
  assert.equal((await owner.rpc('lg_me')).company.name, 'Express Dakar SARL');

  // propriétaire : ne peut ni être retiré ni rétrogradé directement ; transfert de propriété
  assert.equal(await a.callError('lg_platform_member_set', { p_company: cid, p_user: owner.user.id, p_remove: true }), 'cannot_remove_owner');
  assert.equal(await a.callError('lg_platform_member_set', { p_company: cid, p_user: owner.user.id, p_role: 'staff' }), 'owner_transfer_required');
  await a.call('lg_platform_member_set', { p_company: cid, p_user: fatou.user.id, p_role: 'owner' });
  assert.equal((await fatou.rpc('lg_me')).is_owner, true);
  assert.equal((await owner.rpc('lg_me')).member_role, 'admin');
  await a.call('lg_platform_member_set', { p_company: cid, p_user: owner.user.id, p_remove: true });
  assert.equal(await owner.rpcError('lg_me'), 'no_company');

  // comptes : recherche, déconnexion partout, suspension
  const users = await a.call('lg_platform_users', { p_q: 'fatou' });
  assert.deepEqual(users.map((u) => u.email), ['fatou@express.sn']);
  assert.equal(users[0].companies[0].role, 'owner');
  await a.call('lg_platform_user_set', { p_user: fatou.user.id, p_logout: true });
  assert.equal(await fatou.rpcError('lg_me'), 'auth');
  await a.call('lg_platform_user_set', { p_user: fatou.user.id, p_suspend: true });
  assert.equal((await fatou.login('fatou@express.sn')).status, 403);
  await a.call('lg_platform_user_set', { p_user: fatou.user.id, p_suspend: false });
  assert.equal((await fatou.login('fatou@express.sn')).status, 200);

  // suspension de l'entreprise (fonction C9) : plus d'accès
  await a.call('lg_platform_company_set', { p_company: cid, p_suspend: true });
  assert.equal(await fatou.rpcError('lg_me'), 'no_company');

  // commandes, système, journal
  assert.deepEqual(await a.call('lg_platform_orders', { p_q: '' }), []);
  const sys = await a.call('lg_platform_system');
  assert.equal(sys.volumes.companies, 1);
  assert.equal(sys.config.devizo_accounts, true);
  const log = await a.call('lg_platform_audit');
  const actions = log.map((l) => l.action);
  assert.ok(actions.includes('connexion') && actions.includes('lg_platform_member_set') && actions.includes('lg_platform_company_set'));
  assert.equal(actions.includes('lg_platform_overview'), false, 'les lectures ne sont pas journalisées');
  assert.ok(log.every((l) => l.admin === ADMIN));
});
