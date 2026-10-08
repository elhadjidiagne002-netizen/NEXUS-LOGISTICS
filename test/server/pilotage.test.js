// Cycle C7 — pilotage : tour de contrôle, alertes, indicateurs, coûts, prévision, anomalies, classement, retours,
// renforts, tâches planifiées (surveillance, nettoyage). Comportement porté de test/sql/parcours (tour de contrôle),
// cycle5 (prévision, anomalies, classement), cycle12 (axes), cycle13 (coûts), cycle22 (renforts)
// + isolation entre entreprises et rôles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../../server/app.js';
import { makeEnv, Client } from '../helpers/api-client.js';
import { ev, setup, ready, sealedTrip, otpOf } from '../helpers/scenario.js';

const db = (env) => env.DB.db;
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** Voyage démarré : A livrée, B en échec (refus) ; renvoie { trip, A, B }. */
async function dayOf(S, { phoneB = null } = {}) {
  const A = await ready(S, [[S.P.rice, 1]], { method: 'cod', zone: 'Yoff', lat: 14.75, lng: -17.49 });
  const B = await ready(S, [[S.P.oil, 1]], { zone: 'Ouakam', phone: phoneB });
  const trip = await sealedTrip(S, [A, B]);
  await S.driver.rpc('lg_trip_start', { p_trip: trip, p_event: ev(), p_lat: 14.72, p_lng: -17.46 });
  const [sa, sb] = (await S.driver.rpc('lg_my_day')).trips[0].stops;
  await S.driver.rpc('lg_deliver', { p_stop: sa.id, p_event: ev(), p_codes: A.codes, p_otp: otpOf(S.env, A.order.id).code, p_photo_path: 'p.jpg',
    p_payments: [{ method: 'cash', amount: sa.cod_due_fcfa }] });
  await S.driver.rpc('lg_fail', { p_stop: sb.id, p_event: ev(), p_reason: 'refused', p_photo_path: 'f.jpg' });
  return { trip, A, B, sa, sb };
}

test('tour de contrôle : chiffres du jour, voyages, alertes à acquitter, commandes à affecter', async () => {
  const env = makeEnv();
  const S = await setup(env);
  const { trip } = await dayOf(S);
  const C = await ready(S, [[S.P.rice, 1]], { zone: 'Pikine' });
  const d = await S.disp.rpc('lg_dashboard');
  assert.equal(d.day, today());
  assert.deepEqual([d.kpis.delivered, d.kpis.failed, d.kpis.staged, d.kpis.open_incidents], [1, 1, 1, 1], 'refus : incident ouvert');
  const t = d.trips.find((x) => x.id === trip);
  assert.deepEqual([t.status, t.stops_total, t.stops_done, t.failures, t.plate, t.courier], ['in_progress', 2, 2, 1, 'DK-1234-A', 'Moussa Ndiaye']);
  assert.ok(t.position && t.gauge.capacity_kg === 500);
  assert.deepEqual(d.to_assign.map((o) => o.order_id), [C.order.id]);
  const al = d.alerts.find((x) => x.kind === 'failure');
  assert.ok(al);
  assert.deepEqual(await S.disp.rpc('lg_ack_alert', { p_id: al.id }), { ok: true });
  assert.deepEqual(await S.disp.rpc('lg_ack_alert', { p_id: al.id }), { ok: false });
  assert.equal((await S.disp.rpc('lg_dashboard')).alerts.some((x) => x.id === al.id), false);
  assert.equal(await S.picker.rpcError('lg_dashboard'), 'forbidden');
});

test('indicateurs : livraisons, échecs par motif, zones, chauffeurs, axes ; coûts et marge', async () => {
  const env = makeEnv();
  const S = await setup(env);
  await dayOf(S);
  await S.driver.rpc('lg_add_expense', { p_kind: 'carburant', p_amount_fcfa: 3000 });
  const k = await S.disp.rpc('lg_kpis', { p_from: today(), p_to: today() });
  assert.deepEqual([k.kpis.delivered, k.kpis.failed, k.kpis.failure_rate_pct, k.kpis.first_attempt_pct], [1, 1, 50, 100]);
  assert.deepEqual(k.kpis.failure_reasons, [{ reason: 'Refus du colis', count: 1 }]);
  assert.deepEqual(k.by_zone.map((z) => [z.zone, z.delivered, z.failed]).sort(), [['Ouakam', 0, 1], ['Yoff', 1, 0]]);
  assert.deepEqual(k.by_courier.map((c) => [c.courier, c.delivered, c.failed]), [['Moussa Ndiaye', 1, 1]]);
  assert.equal(k.kpis.cost_per_delivery_fcfa, 3000);
  const ax = await S.support.rpc('lg_kpis_by_axis', { p_axis: 'zone', p_from: today(), p_to: today() });
  assert.deepEqual(ax.rows.map((r) => r.key).sort(), ['Ouakam', 'Yoff']);
  const hours = await S.support.rpc('lg_kpis_by_axis', { p_axis: 'hour', p_from: today(), p_to: today() });
  assert.match(hours.rows[0].label, /^\d\d h$/);
  const wd = await S.support.rpc('lg_kpis_by_axis', { p_axis: 'weekday', p_from: today(), p_to: today() });
  assert.ok(['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'].includes(wd.rows[0].label));
  assert.equal(await S.support.rpcError('lg_kpis_by_axis', { p_axis: 'lune', p_from: today(), p_to: today() }), 'invalid_axis');
  assert.equal(await S.support.rpcError('lg_kpis', { p_from: 'hier', p_to: today() }), 'invalid_period');
  const c = await S.accountant.rpc('lg_costs', { p_from: today(), p_to: today() });
  assert.deepEqual([c.totals.expenses_fcfa, c.totals.presentations, c.totals.delivered, c.totals.revenue_fcfa, c.totals.margin_fcfa], [3000, 2, 1, 1500, -1500]);
  assert.equal(c.totals.failure_cost_fcfa, 1500, 'une présentation ratée coûte autant qu\'une réussie');
  assert.deepEqual(c.by_vehicle.map((v) => [v.plate, v.expenses_fcfa, v.delivered]), [['DK-1234-A', 3000, 1]]);
  assert.equal(await S.support.rpcError('lg_costs', { p_from: today(), p_to: today() }), 'forbidden');
});

test('prévision par jour de semaine et jours de pic ; anomalies ; classement ; retours par cause', async () => {
  const env = makeEnv();
  const S = await setup(env);
  // historique : 2 commandes il y a 7 jours, 4 il y a 14 jours (même jour de semaine que J+7)
  const target = addDays(today(), 7);
  for (const [back, n] of [[0, 2], [7, 4]]) {
    for (let i = 0; i < n; i++) {
      const o = await S.support.rpc('lg_order_create', { p_customer: { name: 'Client Test', phone: `7700000${back}${i}` }, p_zone: 'Yoff', p_items: [{ product_id: S.P.oil, quantity: 1 }] });
      db(env).prepare('UPDATE orders SET created_at = ? WHERE id = ?').run(`${addDays(today(), -back)}T10:00:00.000Z`, o.id);
    }
  }
  await S.admin.rpc('lg_set_config', { p: { peak_days: [{ date: target, label: 'Tabaski', factor: 3 }] } });
  const f = await S.disp.rpc('lg_forecast', { p_days: 7 });
  const day = f.days.find((x) => x.date === target);
  // J+7 : 0,4 × 2 (J) + 0,3 × 4 (J-7) = 2, × 3 (Tabaski)
  assert.deepEqual([f.days.length, day.orders, day.peak, day.zones[0].zone, f.fleet], [7, 6, 'Tabaski', 'Yoff', 2]);
  // anomalies : deux refus du même client
  await dayOf(S, { phoneB: '771119999' });
  await S.driver.rpc('lg_trip_finish', { p_trip: (await S.driver.rpc('lg_my_day')).trips[0].id, p_event: ev() });
  const S2 = { ...S };
  const again = await ready(S2, [[S.P.oil, 1]], { zone: 'Ouakam', phone: '771119999' });
  const t2 = await sealedTrip(S, [again], { vehicle: S.V.moto, courier: S.C.ibou });
  await S.driver2.rpc('lg_trip_start', { p_trip: t2, p_event: ev() });
  const st = (await S.driver2.rpc('lg_my_day')).trips[0].stops[0];
  await S.driver2.rpc('lg_fail', { p_stop: st.id, p_event: ev(), p_reason: 'refused', p_photo_path: 'f.jpg' });
  const an = await S.disp.rpc('lg_anomalies', {});
  const cust = an.find((x) => x.kind === 'customer_refusals');
  assert.deepEqual([cust.severity, cust.subject.endsWith('77****999')], ['critical', true]);
  // classement : le chauffeur se reconnaît
  const lb = await S.driver.rpc('lg_leaderboard', {});
  assert.deepEqual([lb.length, lb[0].name, lb[0].me, lb[0].rank], [2, 'Moussa Ndiaye', true, 1]);
  assert.equal(await S.picker.rpcError('lg_leaderboard', {}), 'forbidden');
  // retours par cause
  const code = db(env).prepare("SELECT p.code FROM packages p JOIN orders o ON o.id = p.order_id WHERE o.buyer_phone = '771119999' AND p.status = 'failed' LIMIT 1").get().code;
  await S.dock.rpc('lg_return_hub', { p_code: code, p_event: ev() });
  await S.dock.rpc('lg_return_classify', { p_code: code, p_cause: 'refused_at_door', p_event: ev() });
  const rs = await S.support.rpc('lg_return_stats', {});
  assert.deepEqual([rs.totals.returns, rs.totals.customer_fcfa, rs.by_cause[0].cause, rs.by_cause[0].label], [1, 1500, 'refused_at_door', 'Refus à la porte']);
});

test('renforts : appel aux chauffeurs, réponses, clôture', async () => {
  const env = makeEnv();
  const S = await setup(env);
  const day = addDays(today(), 2);
  assert.equal(await S.disp.rpcError('lg_reinforcement_call', { p_day: addDays(today(), -1), p_needed: 2 }), 'past_day');
  assert.equal(await S.disp.rpcError('lg_reinforcement_call', { p_day: day, p_needed: 0 }), 'invalid_quantity');
  const c = await S.disp.rpc('lg_reinforcement_call', { p_day: day, p_needed: 3, p_zones: ['Yoff'], p_note: 'Tabaski' });
  assert.deepEqual([c.ok, c.notified], [true, 2]);
  assert.equal((await S.disp.rpc('lg_reinforcement_call', { p_day: day, p_needed: 4 })).notified, 0, 'déjà sollicités : pas de second message');
  const mine = await S.driver.rpc('lg_my_reinforcements');
  assert.deepEqual([mine.length, mine[0].id, mine[0].available], [1, c.id, null]);
  assert.deepEqual(await S.driver.rpc('lg_reinforcement_answer', { p_call: c.id, p_available: true }), { ok: true });
  await S.driver2.rpc('lg_reinforcement_answer', { p_call: c.id, p_available: false });
  const list = await S.disp.rpc('lg_reinforcements', {});
  assert.deepEqual([list[0].needed, list[0].yes, list[0].no, list[0].waiting, list[0].available[0].name, list[0].zones], [4, 1, 1, 0, 'Moussa Ndiaye', []]);
  assert.equal(await S.picker.rpcError('lg_reinforcement_answer', { p_call: c.id, p_available: true }), 'not_a_courier');
  assert.deepEqual(await S.disp.rpc('lg_reinforcement_close', { p_call: c.id }), { ok: true });
  assert.equal((await S.driver.rpc('lg_reinforcement_answer', { p_call: c.id, p_available: false })).error, 'call_closed');
  assert.deepEqual(await S.driver.rpc('lg_my_reinforcements'), []);
  assert.deepEqual(await S.picker.rpc('lg_my_reinforcements'), []);
  assert.equal(await S.driver.rpcError('lg_reinforcement_call', { p_day: day, p_needed: 1 }), 'forbidden');
});

const cron = async (env, task, secret) => {
  const res = await handle(new Request(`https://logistique.test/api/cron/${task}`, { method: 'POST', headers: secret ? { 'x-cron-secret': secret } : {} }), env);
  return { status: res.status, data: await res.json() };
};

test('tâches planifiées : surveillance (retards, arrêts longs, sans position, colis oubliés, documents) et nettoyage', async () => {
  const env = makeEnv();
  const S = await setup(env);
  assert.equal((await cron(env, 'watchdog', 'x'.repeat(32))).status, 503, 'sans secret configuré : désactivé');
  env.CRON_SECRET = 's'.repeat(32);
  assert.equal((await cron(env, 'watchdog', 'x'.repeat(32))).status, 403);
  assert.equal((await cron(env, 'inconnue', env.CRON_SECRET)).status, 404);
  const A = await ready(S, [[S.P.rice, 1]]);
  const B = await ready(S, [[S.P.oil, 1]], { zone: 'Pikine' });
  const trip = await sealedTrip(S, [A, B]);
  await S.driver.rpc('lg_trip_start', { p_trip: trip, p_event: ev() });
  const old = (min) => new Date(Date.now() - min * 60000).toISOString();
  const [sa, sb] = (await S.driver.rpc('lg_my_day')).trips[0].stops;
  db(env).prepare("UPDATE trip_stops SET status = 'arrived', arrived_at = ? WHERE id = ?").run(old(40), sa.id);
  db(env).prepare('UPDATE trip_stops SET eta = ? WHERE id = ?').run(old(45), sb.id);
  db(env).prepare('UPDATE couriers SET last_seen_at = ? WHERE id = ?').run(old(60), S.C.moussa);
  const C = await ready(S, [[S.P.oil, 1]]);
  db(env).prepare('UPDATE packages SET updated_at = ? WHERE code = ?').run(old(26 * 60), C.codes[0]);
  await S.dock.rpc('lg_add_document', { p_vehicle: S.V.moto, p_kind: 'assurance', p_expires_at: addDays(today(), 10) });
  const r = await cron(env, 'watchdog', env.CRON_SECRET);
  assert.deepEqual([r.status, r.data.ok], [200, true]);
  const kinds = db(env).prepare('SELECT kind FROM alerts ORDER BY kind').all().map((x) => x.kind);
  for (const k of ['late', 'long_stop', 'driver_offline', 'stale_package', 'doc_expiring']) assert.ok(kinds.includes(k), k);
  const n = kinds.length;
  await cron(env, 'watchdog', env.CRON_SECRET);
  assert.equal(db(env).prepare('SELECT count(*) AS n FROM alerts').get().n, n, 'une seule alerte par situation');
  // nettoyage : positions de plus de 30 jours
  db(env).prepare('INSERT INTO driver_positions (company_id, courier_id, lat, lng, recorded_at) VALUES (?, ?, 14.7, -17.4, ?)').run(S.admin.companyId, S.C.moussa, old(31 * 1440));
  assert.equal((await cron(env, 'purge', env.CRON_SECRET)).status, 200);
  assert.equal(db(env).prepare('SELECT count(*) AS n FROM driver_positions').get().n, 0);
  assert.equal(db(env).prepare("SELECT count(*) AS n FROM cron_runs WHERE task IN ('watchdog', 'purge')").get().n, 2);
});

test('isolation : une autre entreprise ne voit ni ne touche rien du cycle C7', async () => {
  const env = makeEnv();
  const S = await setup(env);
  const X = await setup(env, 'binta@rapide.sn', 'Rapide Thiès');
  await dayOf(S);
  const c = await S.disp.rpc('lg_reinforcement_call', { p_day: addDays(today(), 1), p_needed: 1 });
  const al = (await S.disp.rpc('lg_dashboard')).alerts[0];
  const d = await X.disp.rpc('lg_dashboard');
  assert.deepEqual([d.trips, d.alerts, d.to_assign, d.kpis.delivered, d.kpis.open_incidents], [[], [], [], 0, 0]);
  assert.deepEqual(await X.disp.rpc('lg_ack_alert', { p_id: al.id }), { ok: false });
  assert.equal(db(env).prepare('SELECT acked_at FROM alerts WHERE id = ?').get(al.id).acked_at, null);
  assert.equal(await X.disp.rpcError('lg_reinforcement_close', { p_call: c.id }), 'unknown_call');
  assert.equal((await X.driver.rpc('lg_reinforcement_answer', { p_call: c.id, p_available: true })).error, 'call_closed');
  assert.deepEqual(await X.disp.rpc('lg_reinforcements', {}), []);
  const k = await X.disp.rpc('lg_kpis', { p_from: today(), p_to: today() });
  assert.deepEqual([k.kpis.delivered, k.by_zone, k.by_courier], [0, [], []]);
  assert.deepEqual((await X.disp.rpc('lg_kpis_by_axis', { p_axis: 'zone', p_from: today(), p_to: today() })).rows, []);
  assert.equal((await X.accountant.rpc('lg_costs', { p_from: today(), p_to: today() })).totals.presentations, 0);
  assert.deepEqual(await X.disp.rpc('lg_anomalies', {}), []);
  assert.deepEqual((await X.disp.rpc('lg_leaderboard', {})).map((x) => x.name).sort(), ['Ibrahima', 'Moussa Ndiaye']);
  assert.equal((await X.disp.rpc('lg_leaderboard', {})).every((x) => x.delivered === 0), true);
  assert.equal((await X.support.rpc('lg_return_stats', {})).totals.returns, 0);
});

test('rôles : un préparateur ne pilote rien, un visiteur non plus', async () => {
  const env = makeEnv();
  const S = await setup(env);
  for (const fn of ['lg_dashboard', 'lg_ack_alert', 'lg_kpis', 'lg_kpis_by_axis', 'lg_costs', 'lg_forecast', 'lg_anomalies', 'lg_return_stats',
    'lg_reinforcements', 'lg_reinforcement_call', 'lg_reinforcement_close']) {
    assert.equal(await S.picker.rpcError(fn, { p_from: today(), p_to: today(), p_axis: 'zone' }), 'forbidden', fn);
    assert.equal(await new Client(env).rpcError(fn, {}), 'auth', fn);
  }
});
