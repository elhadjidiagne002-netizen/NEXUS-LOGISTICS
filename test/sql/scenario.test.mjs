// Le scénario de démonstration est aussi un test d'intégration : il joue une journée
// entière avec les vraies fonctions, sous l'identité de chaque rôle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../helpers/db.mjs';
import { runScenario, P } from '../../src/demo/scenario.js';

test('journée de démonstration complète', async () => {
  const t = await createDb();
  const r = await runScenario((name, args, uid) => t.rpc(uid ?? null, name, args), (q, p) => t.db.query(q, p));
  assert.equal(r.orders.length, 12);
  const d = await t.rpc(P.dispatcher, 'lg_dashboard', {});
  assert.equal(d.kpis.delivered, 1);
  assert.equal(d.kpis.failed, 1);
  assert.equal(d.to_assign.length, 2, 'Pikine et Mermoz restent à affecter');
  assert.ok(d.alerts.some((a) => a.kind === 'failure'));
  assert.ok(d.alerts.some((a) => a.kind === 'doc_expiring'), 'assurance de la fourgonnette sous 15 jours');
  const trips = d.trips.map((x) => [x.status, x.stops_done, x.stops_total]);
  assert.deepEqual(trips.sort(), [['in_progress', 2, 5], ['loading', 0, 2]].sort());
  assert.equal((await t.rpc(P.support, 'lg_cod_pending', {})).length, 2);
  assert.equal((await t.rpc(P.support, 'lg_requests_list', {})).length, 1);
  const audit = await t.all("select action, detail from audit_logs where action like '%failed%'");
  assert.deepEqual(audit, [], 'aucun déclencheur en échec');
});
