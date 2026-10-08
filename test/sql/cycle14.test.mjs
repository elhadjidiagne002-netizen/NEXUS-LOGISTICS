// Cycle 14 : assurance colis, plafond d'indemnisation, avoir, accord du client.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, makeOrder, U, IDS } from '../helpers/db.mjs';
import { runScenario } from '../../src/demo/scenario.js';

let t; let inc; let order; let token;
before(async () => {
  t = await createDb();
  await runScenario((n, a, uid) => t.rpc(uid ?? null, n, a), (q, p) => t.db.query(q, p));
  await t.rpc(U.admin, 'lg_upsert_rate_card', { p: { max_weight_g: 20000, price_fcfa: 1500 } });
});

test('assurance au devis : prime en % de la valeur déclarée, minimum, valeur maximale', async () => {
  const q = await t.rpc(null, 'lg_quote', { p_zone: 'Yoff', p_weight_g: 3000, p_declared_value_fcfa: 100000 });
  assert.deepEqual([q.insurance_fee_fcfa, q.total_fcfa, q.price_fcfa], [2000, q.price_fcfa + 2000, q.price_fcfa]);
  assert.equal((await t.rpc(null, 'lg_quote', { p_zone: 'Yoff', p_weight_g: 3000, p_declared_value_fcfa: 5000 })).insurance_fee_fcfa, 300);
  assert.equal((await t.rpc(null, 'lg_quote', { p_zone: 'Yoff', p_weight_g: 3000, p_declared_value_fcfa: 2000000 })).error, 'value_too_high');
  const plain = await t.rpc(null, 'lg_quote', { p_zone: 'Yoff', p_weight_g: 3000 });
  assert.deepEqual([plain.insurance_fee_fcfa, plain.total_fcfa], [0, plain.price_fcfa], 'sans valeur déclarée : comme avant');
});

test('plafond : indemnité refusée au-delà ; avoir émis ; sans accord du client, l\'incident attend sa réponse', async () => {
  const row = await t.one(`select p.code, o.id, o.tracking_token, o.total from lg_packages p join orders o on o.id = p.order_id
    join invoices i on i.order_id = o.id and i.type = 'buyer' and i.credit_of is null where p.status = 'delivered' limit 1`);
  [order, token] = [row.id, row.tracking_token];
  inc = (await t.rpc(U.support, 'lg_open_incident', { p_kind: 'damaged', p_description: 'Bouteille cassée à l\'ouverture', p_code: row.code })).id;
  const cap = Number((await t.one('select public.lg_incident_cap($1) c', [inc])).c);
  const goods = Number((await t.one('select public.lg_fcfa(total) v from orders where id = $1', [order])).v);
  assert.equal(cap, Math.min(goods, 50000), 'non assurée : valeur des produits, plafonnée à 50 000 F');
  const over = await t.rpc(U.support, 'lg_resolve_incident', { p_id: inc, p_resolution: 'Remboursement', p_compensation_fcfa: cap + 1 });
  assert.deepEqual([over.error, over.cap_fcfa, over.insured], ['over_cap', cap, false]);

  const r = await t.rpc(U.support, 'lg_resolve_incident', { p_id: inc, p_resolution: 'Remboursement de la bouteille', p_compensation_fcfa: 1000, p_credit_note: true });
  assert.deepEqual([r.ok, r.closed, r.awaiting_customer], [true, false, true]);
  assert.match(r.credit_note, /^AV-/);
  const list = await t.rpc(U.support, 'lg_incidents_list', { p_status: 'open' });
  const it = list.find((x) => x.id === inc);
  assert.deepEqual([it.status, it.awaiting_customer, it.credit_note], ['resolved', true, r.credit_note]);
  const msg = await t.one("select vars from notification_outbox where event_key = 'lg_incident_proposal' order by created_at desc limit 1");
  assert.match(msg.vars.texte, /Remboursement de la bouteille \(indemnité de 1.000 F\)/);
  // avoir émis une seule fois même si on reprend la résolution
  await t.rpc(U.support, 'lg_resolve_incident', { p_id: inc, p_resolution: 'Remboursement de la bouteille', p_compensation_fcfa: 1000, p_credit_note: true });
  assert.equal((await t.one("select count(*)::int n from invoices where metadata ->> 'reason' like 'Indemnisation incident%'")).n, 1);
});

test('page de suivi : le client accepte (clôture) ; une seule réponse possible', async () => {
  const pending = await t.rpc(null, 'lg_track_incidents', { p_token: token });
  assert.deepEqual(pending.map((x) => [x.id, x.compensation_fcfa]), [[inc, 1000]]);
  assert.equal((await t.rpc(null, 'lg_track_incident_answer', { p_token: token, p_incident: inc, p_accept: true })).closed, true);
  assert.equal((await t.one('select status, agreement_via from lg_incidents where id = $1', [inc])).status, 'closed');
  assert.equal((await t.rpc(null, 'lg_track_incident_answer', { p_token: token, p_incident: inc, p_accept: false })).error, 'nothing_to_answer');
  assert.equal((await t.rpc(null, 'lg_track_incidents', { p_token: '00000000-0000-4000-a000-000000000000' })).length, 0);
});

test('refus du client : l\'incident est rouvert ; accord par téléphone : clôture immédiate', async () => {
  const code = (await t.one("select p.code from lg_packages p where p.order_id <> $1 and p.direction = 'outbound' limit 1", [order])).code;
  const i2 = (await t.rpc(U.support, 'lg_open_incident', { p_kind: 'missing_item', p_description: 'Il manque un article', p_code: code })).id;
  await t.rpc(U.support, 'lg_resolve_incident', { p_id: i2, p_resolution: 'Geste commercial', p_compensation_fcfa: 500 });
  const tok = (await t.one('select o.tracking_token from orders o join lg_packages p on p.order_id = o.id where p.code = $1', [code])).tracking_token;
  await t.rpc(null, 'lg_track_incident_answer', { p_token: tok, p_incident: i2, p_accept: false });
  assert.equal((await t.one('select status from lg_incidents where id = $1', [i2])).status, 'investigating');
  const r = await t.rpc(U.support, 'lg_resolve_incident', { p_id: i2, p_resolution: 'Remboursement complet', p_compensation_fcfa: 900, p_customer_agreed: true });
  assert.equal(r.closed, true);
  assert.equal((await t.one('select agreement_via from lg_incidents where id = $1', [i2])).agreement_via, 'support');
  // incident sans commande (panne) : pas de plafond client, pas d'accord à recueillir
  const i3 = (await t.rpc(U.dispatcher, 'lg_open_incident', { p_kind: 'vehicle_breakdown', p_description: 'Crevaison' })).id;
  assert.equal((await t.rpc(U.dispatcher, 'lg_resolve_incident', { p_id: i3, p_resolution: 'Réparé', p_compensation_fcfa: 0 })).closed, true);
});

test('assurer une commande par téléphone relève le plafond ; impossible une fois chargée', async () => {
  const o = await makeOrder(t, { method: 'mobile', paid: true, lines: [[IDS.fan, 1]] });
  const r = await t.rpc(U.support, 'lg_order_insure', { p_order: o, p_value: 200000 });
  assert.deepEqual([r.insured_value_fcfa, r.insurance_fee_fcfa], [200000, 4000]);
  await t.as(null);
  const { code } = await t.one(`insert into lg_packages (code, order_id, status) values (public.lg_new_package_code(), $1, 'staged') returning code`, [o]);
  const i = (await t.rpc(U.support, 'lg_open_incident', { p_kind: 'lost', p_description: 'Introuvable', p_code: code })).id;
  assert.equal(Number((await t.one('select public.lg_incident_cap($1) c', [i])).c), 200000);
  const loaded = (await t.one("select order_id from lg_packages where status = 'delivered' limit 1")).order_id;
  assert.equal((await t.rpc(U.support, 'lg_order_insure', { p_order: loaded, p_value: 10000 })).error, 'already_loaded');
  await assert.rejects(t.rpc(U.driver, 'lg_order_insure', { p_order: o, p_value: 1000 }), /forbidden/);
});
