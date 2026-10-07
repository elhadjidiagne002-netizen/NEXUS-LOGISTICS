// Droits réels, exécutés sous les rôles Postgres de Supabase (et pas en super-utilisateur).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, makeOrder, U } from '../helpers/db.mjs';

let t;
before(async () => {
  t = await createDb();
  // comme Supabase : les rôles API lisent les tables existantes, la RLS filtre
  await t.db.exec('grant select on all tables in schema public to authenticated');
});

const asRole = async (role, uid, sql, params = []) => {
  await t.db.query("select set_config('test.uid', $1, false)", [uid ?? '']);
  await t.db.query(`set role ${role}`);
  try { return (await t.db.query(sql, params)).rows; } finally { await t.db.query('reset role'); }
};

test('aucune fonction lg_ interne n\'est exécutable par anon ou authenticated', async () => {
  const rows = await t.all(`select p.proname,
      has_function_privilege('anon', p.oid, 'execute') anon,
      has_function_privilege('authenticated', p.oid, 'execute') auth
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'lg\\_%'`);
  const anonOk = rows.filter((r) => r.anon).map((r) => r.proname).sort();
  assert.deepEqual(anonOk, ['lg_quote', 'lg_slots_available', 'lg_track', 'lg_track_book_slot', 'lg_track_confirm',
    'lg_track_invoice', 'lg_track_rate', 'lg_track_request', 'lg_track_set_location', 'lg_track_third_party']);
  for (const internal of ['lg_notify', 'lg_idem_put', 'lg_issue_invoice', 'lg_credit_note', 'lg_raise_alert',
    'lg_try_reconcile', 'lg_confirm_cod_internal', 'lg_handle_reply', 'lg_watchdog', 'lg_issue_delivery_code', 'lg_audit']) {
    assert.equal(rows.find((r) => r.proname === internal).auth, false, internal);
  }
});

test('anon : la page de suivi marche, le reste est refusé', async () => {
  const o = await makeOrder(t, {});
  const { tracking_token } = await t.one('select tracking_token from orders where id = $1', [o]);
  const [r] = await asRole('anon', null, 'select public.lg_track($1) r', [tracking_token]);
  assert.equal(r.r.ok, true);
  await assert.rejects(asRole('anon', null, 'select public.lg_pick_queue()'), /permission denied/);
  await assert.rejects(asRole('anon', null, 'select public.lg_cancel_unconfirmed($1)', [o]), /permission denied/);
  await assert.rejects(asRole('anon', null, 'select * from public.lg_packages'), /permission denied/);
});

test('authenticated : écriture directe interdite, lecture filtrée par la RLS', async () => {
  await assert.rejects(asRole('authenticated', U.admin, "update public.lg_trips set status = 'reconciled'"), /permission denied/);
  await assert.rejects(asRole('authenticated', U.admin, "insert into public.lg_alerts (kind, message) values ('sos', 'x')"), /permission denied/);
  // un colis existe (commande payée → préparée)
  const o = await makeOrder(t, { method: 'mobile', paid: true });
  const task = (await t.one('select id from lg_pick_tasks where order_id = $1', [o])).id;
  await t.rpc(U.picker, 'lg_pick_take', { p_task: task });
  for (const c of ['RIZ-5', 'RIZ-5', 'HUI-1']) await t.rpc(U.picker, 'lg_pick_scan', { p_task: task, p_code: c, p_event: t.ev() });
  const line = (await t.rpc(U.picker, 'lg_pick_task_detail', { p_task: task })).lines.find((l) => l.status === 'pending');
  await t.rpc(U.picker, 'lg_pick_short', { p_task: task, p_line: line.id, p_qty_found: 0, p_event: t.ev() });
  await t.rpc(U.picker, 'lg_pack', { p_task: task, p_event: t.ev(), p_packages: [{ weight_g: 11000 }] });
  const see = async (uid) => (await asRole('authenticated', uid, 'select count(*)::int n from public.lg_packages'))[0].n;
  assert.ok(await see(U.picker) >= 1, 'le préparateur voit les colis');
  assert.ok(await see(U.vendor) >= 1, 'le vendeur voit ses colis');
  assert.equal(await see(U.stranger), 0, 'un inconnu ne voit rien');
  assert.equal(await see(U.driver), 0, 'un chauffeur sans voyage ne voit rien');
  // un rôle passe bien la porte de la fonction
  await assert.rejects(asRole('authenticated', U.stranger, 'select public.lg_dashboard()'), /forbidden/);
  const [d] = await asRole('authenticated', U.dispatcher, 'select public.lg_dashboard() r');
  assert.ok(d.r.kpis);
});
