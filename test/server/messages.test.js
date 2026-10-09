// Cycle C8 — messages : modèles modifiables, file d'envoi, envoi manuel (wa.me) ou automatique (instance WhatsApp de
// l'entreprise), e-mail de secours, réponses du client, rapport du soir. Comportement porté de test/sql/parcours
// (messages du parcours, 16 · réponses OUI / note), cycle2 (modèles), cycle18 (secours e-mail)
// + isolation entre entreprises et rôles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../../server/app.js';
import { makeEnv, Client } from '../helpers/api-client.js';
import { ev, setup, ready, sealedTrip, otpOf } from '../helpers/scenario.js';

const db = (env) => env.DB.db;
const outbox = (env, event) => db(env).prepare('SELECT * FROM outbox WHERE event_key = ? ORDER BY created_at, rowid').all(event);

/** Remplace fetch le temps d'un test : enregistre les appels sortants (Green API, Brevo). */
function stubFetch(status = 200) {
  const calls = []; const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null }); return new Response('{}', { status }); };
  return { calls, restore: () => { globalThis.fetch = real; } };
}
const cron = (env, task) => handle(new Request(`https://logistique.test/api/cron/${task}`, { method: 'POST', headers: { 'x-cron-secret': env.CRON_SECRET } }), env);
const webhook = (env, secret, phone, text) => handle(new Request(`https://logistique.test/api/whatsapp/${secret}`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ typeWebhook: 'incomingMessageReceived', senderData: { chatId: `221${phone}@c.us` }, messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: text } } }),
}), env).then((r) => r.json());

test('messages du parcours : confirmation, préparée, en route avec le code, à l\'approche, livrée avec la facture, échec', async () => {
  const env = makeEnv();
  const S = await setup(env);
  const A = await ready(S, [[S.P.rice, 2]], { method: 'cod', phone: '771112233' });
  const cod = outbox(env, 'lg_cod_confirm');
  assert.equal(cod.length, 1);
  assert.match(cod[0].text, /^Bonjour Awa, votre commande \d+ chez Express Dakar est enregistrée : 11 500 F à payer à la livraison\. Répondez OUI/);
  assert.equal(cod[0].phone, '771112233');
  assert.equal(outbox(env, 'lg_order_confirmed').length, 1, 'confirmation par le service client → message « confirmée »');
  assert.match(outbox(env, 'lg_prepared')[0].text, /est prête \(1 colis\)/);
  const B = await ready(S, [[S.P.oil, 1]]);
  assert.equal(outbox(env, 'lg_order_confirmed').length, 2, 'payée d\'avance : « confirmée » tout de suite');
  const trip = await sealedTrip(S, [A, B]);
  await S.driver.rpc('lg_trip_start', { p_trip: trip, p_event: ev() });
  const out = outbox(env, 'lg_out_for_delivery');
  assert.equal(out.length, 2);
  assert.ok(out[0].text.includes(`Votre code de livraison : ${otpOf(env, A.order.id).code}`));
  assert.match(out[0].text, /en route avec Moussa\. Arrivée vers \d\dh\d\d/);
  assert.match(outbox(env, 'lg_approaching')[0].text, /^Moussa arrive dans environ \d+ minutes\. Montant à préparer : 11 500 F\.$/);
  const [sa, sb] = (await S.driver.rpc('lg_my_day')).trips[0].stops;
  await S.driver.rpc('lg_deliver', { p_stop: sa.id, p_event: ev(), p_codes: A.codes, p_otp: otpOf(env, A.order.id).code, p_photo_path: 'p.jpg', p_payments: [{ method: 'cash', amount: sa.cod_due_fcfa }] });
  assert.match(outbox(env, 'lg_delivered')[0].text, /Votre facture FAC-\d{4}-000001 est disponible ici : https:\/\/logistique\.test\/suivi\//);
  assert.equal(outbox(env, 'lg_approaching').length, 2, 'arrêt suivant : à l\'approche');
  await S.driver.rpc('lg_stop_call', { p_stop: sb.id });
  await S.driver.rpc('lg_fail', { p_stop: sb.id, p_event: ev(), p_reason: 'absent', p_photo_path: 'f.jpg' });
  assert.match(outbox(env, 'lg_failed')[0].text, /\(client absent\)\. Répondez 1/);
  // file d'envoi : envoi manuel gratuit par lien wa.me
  const q = await S.support.rpc('lg_outbox_recent', {});
  const m = q.find((x) => x.event_key === 'lg_cod_confirm');
  assert.equal(m.to, '77 *** 33');
  assert.ok(m.wa_link.startsWith('https://wa.me/221771112233?text=Bonjour%20Awa'));
  assert.deepEqual(await S.support.rpc('lg_outbox_mark_sent', { p_id: m.id }), { ok: true });
  assert.deepEqual(await S.support.rpc('lg_outbox_mark_sent', { p_id: m.id }), { ok: false });
  const after = (await S.support.rpc('lg_outbox_recent', {})).find((x) => x.id === m.id);
  assert.deepEqual([after.status, after.whatsapp, after.wa_link], ['sent', 'manual', null]);
  const ch = await S.support.rpc('lg_outbox_channels', {});
  assert.deepEqual([ch.whatsapp_sent, ch.automatic, ch.pending > 0], [1, false, true]);
});

test('modèles : liste, modification, désactivation, aperçu', async () => {
  const env = makeEnv();
  const S = await setup(env);
  const list = await S.support.rpc('lg_templates_list');
  assert.equal(list.length, 18);
  assert.equal(list[0].event_key, 'lg_cod_confirm');
  assert.equal(list[0].sample.entreprise, 'Express Dakar');
  assert.equal(await S.support.rpcError('lg_template_save', { p_event: 'lg_prepared', p_body_fr: 'court' }), 'message_too_short');
  assert.equal(await S.support.rpcError('lg_template_save', { p_event: 'lg_inconnu', p_body_fr: 'assez long pour passer' }), 'unknown_template');
  await S.support.rpc('lg_template_save', { p_event: 'lg_prepared', p_body_fr: 'Salut {prenom}, {colis} colis prêts chez {entreprise}.' });
  await S.support.rpc('lg_template_save', { p_event: 'lg_order_confirmed', p_body_fr: 'Merci {prenom}, commande {commande} confirmée.', p_active: false });
  await ready(S, [[S.P.oil, 1]]);
  assert.equal(outbox(env, 'lg_order_confirmed').length, 0, 'modèle désactivé : rien n\'est envoyé');
  assert.equal(outbox(env, 'lg_prepared')[0].text, 'Salut Awa, 1 colis prêts chez Express Dakar.');
  assert.equal(await S.support.rpc('lg_preview_message', { p_event: 'lg_cod_confirm', p_body: 'Payez {montant} F, {inconnu}fin', p_vars: { montant: 12500 } }), 'Payez 12 500 F, fin');
  assert.equal((await S.support.rpc('lg_templates_list')).find((t) => t.event_key === 'lg_order_confirmed').active, false);
});

test('WhatsApp de l\'entreprise : branchement chiffré, envoi automatique, réponses OUI / note / choix, e-mail de secours', async () => {
  const env = makeEnv();
  const S = await setup(env);
  assert.equal(await S.admin.rpcError('lg_channel_save', { p_instance_id: '1101000001', p_token: 'a'.repeat(40) }), 'secrets_key_missing');
  env.SECRETS_KEY = 'k'.repeat(32); env.CRON_SECRET = 'c'.repeat(32);
  assert.equal(await S.admin.rpcError('lg_channel_save', { p_instance_id: 'abc', p_token: 'court' }), 'invalid_channel');
  assert.equal(await S.support.rpcError('lg_channel_save', { p_instance_id: '1101000001', p_token: 'a'.repeat(40) }), 'forbidden');
  await S.admin.rpc('lg_channel_save', { p_instance_id: '1101000001', p_token: 'T0ken'.repeat(8) });
  const chan = await S.admin.rpc('lg_channel_get');
  assert.equal(chan.connected, true);
  assert.equal(JSON.stringify(chan).includes('T0ken'), false, 'le jeton n\'est jamais renvoyé');
  assert.equal(db(env).prepare('SELECT token_enc FROM channels').get().token_enc.includes('T0ken'), false, 'jeton chiffré en base');
  const secret = chan.webhook_url.split('/').pop();
  const A = await ready(S, [[S.P.rice, 1]], { method: 'cod', phone: '772223344' });
  db(env).prepare("UPDATE outbox SET status = 'cancelled' WHERE event_key <> 'lg_cod_confirm'").run();
  const f = stubFetch();
  try {
    await (await cron(env, 'messages')).json();
    assert.equal(f.calls[0].url, `https://api.green-api.com/waInstance1101000001/sendMessage/${'T0ken'.repeat(8)}`);
    assert.equal(f.calls[0].body.chatId, '221772223344@c.us');
    assert.deepEqual([outbox(env, 'lg_cod_confirm')[0].status, outbox(env, 'lg_cod_confirm')[0].whatsapp_status], ['sent', 'sent']);
    // réponse OUI : commande confirmée, remerciement renvoyé par la même instance
    db(env).prepare('UPDATE orders SET cod_confirmed_at = NULL WHERE id = ?').run(A.order.id);
    const r = await webhook(env, secret, '772223344', 'Oui !');
    assert.deepEqual([r.handled, r.action], [true, 'confirmed']);
    assert.ok(db(env).prepare('SELECT cod_confirmed_via FROM orders WHERE id = ?').get(A.order.id).cod_confirmed_via === 'whatsapp');
    assert.equal(f.calls.at(-1).body.message, 'Merci ! Votre commande est confirmée.');
    assert.equal((await webhook(env, secret, '779999999', 'OUI')).handled, false, 'numéro inconnu');
    assert.equal((await webhook(env, 'x'.repeat(32), '772223344', 'OUI')).ignored, 'unknown');
    // livrée puis note 5 : note enregistrée, moyenne du livreur recalculée
    const trip = await sealedTrip(S, [A]);
    await S.driver.rpc('lg_trip_start', { p_trip: trip, p_event: ev() });
    const st = (await S.driver.rpc('lg_my_day')).trips[0].stops[0];
    await S.driver.rpc('lg_deliver', { p_stop: st.id, p_event: ev(), p_codes: A.codes, p_otp: otpOf(env, A.order.id).code, p_photo_path: 'p.jpg', p_payments: [{ method: 'cash', amount: st.cod_due_fcfa }] });
    assert.equal((await webhook(env, secret, '772223344', '4')).action, 'rated');
    assert.deepEqual({ ...db(env).prepare('SELECT rating, courier_id FROM ratings').get() }, { rating: 4, courier_id: S.C.moussa });
    assert.equal(db(env).prepare('SELECT rating_avg FROM couriers WHERE id = ?').get(S.C.moussa).rating_avg, 4);
    // échec chez un autre client, réponse 3 : demande de rappel pour le service client
    const B = await ready(S, [[S.P.oil, 1]], { phone: '773334455' });
    const t2 = await sealedTrip(S, [B], { vehicle: S.V.moto, courier: S.C.ibou });
    await S.driver2.rpc('lg_trip_start', { p_trip: t2, p_event: ev() });
    const sb = (await S.driver2.rpc('lg_my_day')).trips[0].stops[0];
    await S.driver2.rpc('lg_fail', { p_stop: sb.id, p_event: ev(), p_reason: 'refused', p_photo_path: 'f.jpg' });
    assert.equal((await webhook(env, secret, '773334455', '3')).action, 'request');
    assert.equal((await S.support.rpc('lg_requests_list', {})).some((x) => x.kind === 'callback' && x.channel === 'whatsapp'), true);
  } finally { f.restore(); }
  // e-mail de secours : WhatsApp en échec, adresse connue, clé Brevo de la plateforme
  env.BREVO_API_KEY = 'xkeysib-test';
  db(env).prepare("UPDATE outbox SET status = 'cancelled' WHERE status = 'pending'").run();
  db(env).prepare("INSERT INTO outbox (id, company_id, event_key, phone, email, text) VALUES ('m1', ?, 'lg_prepared', '774445566', 'awa@exemple.sn', 'Votre colis est prêt.')").run(S.admin.companyId);
  const g = stubFetch(500);
  try {
    await cron(env, 'messages');
    const row = db(env).prepare("SELECT * FROM outbox WHERE id = 'm1'").get();
    assert.deepEqual([row.whatsapp_status, row.email_status, row.status, row.attempts], ['failed', 'failed', 'pending', 1]);
    assert.ok(g.calls.some((c) => c.url === 'https://api.brevo.com/v3/smtp/email'));
  } finally { g.restore(); }
  await S.admin.rpc('lg_channel_save', { p_disconnect: true });
  assert.equal((await S.admin.rpc('lg_channel_get')).connected, false);
});

test('rapport du soir au gérant et appel de renfort aux chauffeurs', async () => {
  const env = makeEnv();
  const S = await setup(env);
  env.CRON_SECRET = 'c'.repeat(32);
  await S.admin.rpc('lg_set_config', { p: { manager_phone: '+221 77 000 11 22' } });
  const r = await (await cron(env, 'evening')).json();
  assert.deepEqual([r.ok, r.reports], [true, 1]);
  const rep = outbox(env, 'lg_evening_report')[0];
  assert.equal(rep.phone, '770001122');
  assert.match(rep.text, /^Rapport du soir : 0 livrés, 0 échecs/);
  db(env).prepare('UPDATE couriers SET phone = ? WHERE id = ?').run('776667788', S.C.moussa);
  db(env).prepare('UPDATE couriers SET phone = NULL WHERE id = ?').run(S.C.ibou);
  await S.disp.rpc('lg_reinforcement_call', { p_day: new Date(Date.now() + 864e5).toISOString().slice(0, 10), p_needed: 2, p_zones: ['Yoff'] });
  const rf = outbox(env, 'lg_reinforcement').sort((a, b) => String(a.phone).localeCompare(String(b.phone)));
  assert.equal(rf.length, 2, 'chaque chauffeur actif : par WhatsApp, ou par e-mail sans numéro');
  assert.deepEqual([rf[0].phone, rf[1].phone, Boolean(rf[1].email)], ['776667788', null, true]);
  assert.match(rf[0].text, /^Bonjour Moussa, Express Dakar a besoin de livreurs en renfort le \d\d\/\d\d \(Yoff\)/);
});

test('isolation : une autre entreprise ne voit ni ne touche rien du cycle C8', async () => {
  const env = makeEnv();
  const S = await setup(env);
  const X = await setup(env, 'binta@rapide.sn', 'Rapide Thiès');
  env.SECRETS_KEY = 'k'.repeat(32);
  await ready(S, [[S.P.oil, 1]], { method: 'cod', phone: '775556677' });
  await S.admin.rpc('lg_channel_save', { p_instance_id: '1101000001', p_token: 'a'.repeat(40) });
  await S.support.rpc('lg_template_save', { p_event: 'lg_prepared', p_body_fr: 'Modèle propre à Express Dakar.' });
  const m = (await S.support.rpc('lg_outbox_recent', {}))[0];
  assert.deepEqual(await X.support.rpc('lg_outbox_recent', {}), []);
  assert.deepEqual(await X.support.rpc('lg_outbox_mark_sent', { p_id: m.id }), { ok: false });
  assert.deepEqual(await X.support.rpc('lg_outbox_cancel', { p_id: m.id }), { ok: false });
  assert.equal(db(env).prepare('SELECT status FROM outbox WHERE id = ?').get(m.id).status, 'pending');
  assert.equal((await X.support.rpc('lg_outbox_channels', {})).total, 0);
  assert.equal((await X.admin.rpc('lg_channel_get')).connected, false);
  assert.notEqual((await X.support.rpc('lg_templates_list')).find((t) => t.event_key === 'lg_prepared').body_fr, 'Modèle propre à Express Dakar.');
  // la réponse d'un client de S arrivée sur le webhook de X n'agit pas chez S
  await X.admin.rpc('lg_channel_save', { p_instance_id: '1101000002', p_token: 'b'.repeat(40) });
  const xs = (await X.admin.rpc('lg_channel_get')).webhook_url.split('/').pop();
  const f = stubFetch();
  try { assert.equal((await webhook(env, xs, '775556677', 'NON')).handled, false); } finally { f.restore(); }
  assert.equal(db(env).prepare("SELECT count(*) AS n FROM orders WHERE status = 'cancelled'").get().n, 0);
});

test('rôles : modèles et file au service client, WhatsApp à l\'administrateur', async () => {
  const env = makeEnv();
  const S = await setup(env);
  for (const fn of ['lg_templates_list', 'lg_template_save', 'lg_preview_message', 'lg_outbox_recent', 'lg_outbox_channels', 'lg_outbox_cancel']) {
    assert.equal(await S.picker.rpcError(fn, {}), 'forbidden', fn);
  }
  assert.equal(await S.picker.rpcError('lg_outbox_mark_sent', {}), 'forbidden');
  for (const fn of ['lg_channel_get', 'lg_channel_save']) assert.equal(await S.support.rpcError(fn, {}), 'forbidden', fn);
  assert.equal(await new Client(env).rpcError('lg_outbox_recent', {}), 'auth');
});
