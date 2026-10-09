// Cycle D1 — collecte : dépôt et e-mail entrant, conversion en texte, lecture IA (simulée), rapprochement,
// apprentissage des correspondances, conversion en commande, modèles d'extraction, isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../../server/app.js';
import { makeEnv, Client } from '../helpers/api-client.js';
import { setup } from '../helpers/scenario.js';
import { normalizeExtraction, parseJsonLoose, buildPrompt, guessType } from '../../server/extract.js';

// Bon de commande fictif, au format des enseignes (n° article, EAN, libellé, colis, PCB, prix)
const BON = `BON DE COMMANDE N° commande 123456 Date de commande 07/10/2026 Date de livraison impérative 10/10/2026
Lieu de livraison
SUPERMARCHE TEST ALMADIES
1234567 6111000000017 500G SURGELE ATTIEKE 10 12 1AR 450.00
1234568 6111000000024 HUILE 1 L 2 6 1AR 1100
Montant achat 66600 XOF`;

const IA = { document_type: 'commande', customer: { name: 'Enseigne Test', store: 'SUPERMARCHE TEST ALMADIES' }, order_number: '123456',
  order_date: '07/10/2026', delivery_date: '2026-10-10', delivery_place: 'SUPERMARCHE TEST ALMADIES', total_ht: 66600, confidence: 0.92, payment_terms_days: '15 JOURS',
  lines: [{ ref: '1234567', ean: '6111000000017', label: '500G SURGELE ATTIEKE', cases: 10, units_per_case: 12, unit_price: 450 },
    { ref: '1234568', ean: '6111000000024', label: 'HUILE 1 L', cases: 2, units_per_case: 6, unit_price: 1100 }] };

/** IA simulée : toMarkdown renvoie le texte du fichier, run() renvoie la lecture. */
function fakeAI(answer = IA) {
  const calls = { convert: 0, run: 0, prompts: [] };
  return { calls, toMarkdown: async (files) => { calls.convert++; return files.map((f) => ({ name: f.name, format: 'markdown', data: BON })); },
    run: async (_m, { messages }) => { calls.run++; calls.prompts.push(messages); return { response: JSON.stringify(answer) }; } };
}
const b64 = (s) => Buffer.from(s).toString('base64');
const fileStatus = (env, client, id) => handle(new Request(`https://logistique.test/api/inbox/${id}/file`, { headers: client.cookie ? { cookie: client.cookie } : {} }), env).then((r) => r.status);

test('moteur : lecture tolérante, dates, quantités = colis × PCB, rapprochement EAN / référence / nom', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Voici : {"a":2} merci'), { a: 2 });
  assert.equal(guessType('BON.PDF', 'application/octet-stream'), 'application/pdf');
  const d = normalizeExtraction(IA, { products: [{ id: 'p1', name: 'Huile 1 L', sku: 'HUI-1', barcode: '6111000000024' }] });
  assert.deepEqual([d.order_date, d.delivery_date, d.lines[0].quantity, d.lines[1].product_id, d.lines[1].match, d.lines[0].product_id], ['2026-10-07', '2026-10-10', 120, 'p1', 'ean', null]);
  const p = buildPrompt({ kind: 'order', instructions: 'Le PCB est le nombre de sachets', fields: [{ key: 'rayon', label: 'Rayon' }] });
  assert.match(p.system, /PCB est le nombre de sachets/);
  assert.match(p.schema, /"rayon"/);
});

test('dépôt d\'un bon : lu, rapproché, correction apprise, réutilisée au bon suivant, convertie en commande une seule fois', async () => {
  const env = makeEnv(); env.AI = fakeAI(); const S = await setup(env);
  await S.admin.rpc('lg_product_upsert', { p: { id: S.P.oil, name: 'Huile 1 L', sku: 'HUI-1', price_fcfa: 1500, weight_g: 1000, barcode: '6111000000024' } });
  const attieke = (await S.admin.rpc('lg_product_upsert', { p: { name: 'Attiéké Dabou 500 g', sku: 'ATT-500', price_fcfa: 500, weight_g: 500, stock: 500 } })).id;
  const up = await S.support.rpc('lg_inbox_upload', { p_filename: 'commande-123456.pdf', p_content_type: 'application/pdf', p_data: b64('%PDF-1.4 faux') });
  assert.deepEqual([up.ok, up.extracted], [true, true]);
  let d = await S.support.rpc('lg_inbox_detail', { p_id: up.id });
  assert.deepEqual([d.status, d.order_number, d.lines, d.matched, d.data.lines[0].quantity], ['to_review', '123456', 2, 1, 120]);
  assert.match(d.text, /SUPERMARCHE TEST ALMADIES/);
  // la personne rattache la 1re ligne au bon produit : correspondance apprise
  d.data.lines[0].product_id = attieke;
  const sv = await S.support.rpc('lg_inbox_save', { p_id: up.id, p_data: d.data });
  assert.ok(sv.learned >= 3);
  // un 2e bon du même expéditeur : rapproché tout seul
  const up2 = await S.support.rpc('lg_inbox_upload', { p_filename: 'commande-123457.pdf', p_data: b64('%PDF faux 2') });
  const d2 = await S.support.rpc('lg_inbox_detail', { p_id: up2.id });
  assert.deepEqual([d2.data.lines[0].product_id, d2.data.lines[0].match, d2.matched], [attieke, 'alias', 2]);
  // conversion : client et zone choisis, référence = n° du bon (pas de doublon)
  const cv = await S.support.rpc('lg_inbox_convert', { p_id: up.id, p_customer: { name: 'Supermarché Test Almadies', phone: '338200000' }, p_zone: 'Yoff' });
  assert.equal(cv.ok, true);
  const o = await S.support.rpc('lg_order_detail', { p_order: cv.order_id });
  assert.deepEqual(o.items.map((i) => [i.product_name, i.quantity]).sort(), [['Attiéké Dabou 500 g', 120], ['Huile 1 L', 12]]);
  assert.deepEqual([o.payment_method, o.payment_terms_days, o.amount_due_fcfa], ['account', 15, 0], 'bon « 15 JOURS » : commande à terme');
  assert.equal((await S.support.rpc('lg_inbox_convert', { p_id: up.id, p_zone: 'Yoff' })).error, 'already_converted');
  const cv2 = await S.support.rpc('lg_inbox_convert', { p_id: up2.id, p_customer: { name: 'Supermarché', phone: '338200000' }, p_zone: 'Yoff' });
  assert.equal(cv2.duplicate, true, 'même n° de bon : la commande existante est rendue');
  // listes et export
  assert.equal((await S.support.rpc('lg_inbox_list', { p_status: 'converted' })).length, 2);
  assert.equal((await S.support.rpc('lg_inbox_export', {})).length, 2);
});

test('e-mail entrant : secret obligatoire, adresse de l\'entreprise, pièces jointes, pas de doublon', async () => {
  const env = makeEnv(); env.AI = fakeAI(); env.INBOUND_SECRET = 's'.repeat(32); const S = await setup(env);
  const { address } = await S.admin.rpc('lg_inbox_address');
  assert.match(address, /^bons\+express-dakar-[0-9a-f]{6}@commandes\.nexusmarket\.sn$/);
  const post = (body, secret = env.INBOUND_SECRET) => handle(new Request('https://logistique.test/api/inbound/email', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-inbound-secret': secret }, body: JSON.stringify(body) }), env).then(async (r) => ({ status: r.status, data: await r.json() }));
  const mail = { to: address, from: 'Achats <achats@enseigne-test.sn>', subject: 'Commande 123456', message_id: '<abc@enseigne-test.sn>',
    attachments: [{ filename: 'BC123456.PDF', content_type: 'application/octet-stream', data: b64('%PDF faux') }, { filename: 'logo.gif', content_type: 'image/gif', data: b64('GIF') }] };
  assert.equal((await post(mail, 'x'.repeat(32))).status, 403);
  assert.equal((await post(mail)).data.accepted, 1, 'le logo (format non lu) est ignoré');
  assert.equal((await post(mail)).data.accepted, 0, 'même e-mail renvoyé : rien de nouveau');
  assert.deepEqual((await post({ ...mail, to: 'bons+inconnu@commandes.nexusmarket.sn', message_id: '<z>' })).data, { ok: true, accepted: 0, reason: 'unknown_address' });
  const [doc] = await S.support.rpc('lg_inbox_list', {});
  assert.deepEqual([doc.source, doc.sender, doc.status, doc.order_number], ['email', 'Achats <achats@enseigne-test.sn>', 'to_review', '123456']);
  // le fichier d'origine se relit avec la session
  assert.equal(await fileStatus(env, S.support, doc.id), 200);
  assert.equal(await fileStatus(env, S.driver, doc.id), 403);
});

test('modèle d\'extraction : choisi par expéditeur, champs et consignes envoyés à l\'IA ; erreurs tracées', async () => {
  const env = makeEnv(); env.AI = fakeAI({ ...IA, fields: { rayon: 'Surgelés' } }); const S = await setup(env);
  await S.support.rpc('lg_extraction_template_upsert', { p: { name: 'Enseigne Test', kind: 'order', sender_match: '@enseigne-test.sn',
    instructions: 'Le PCB est le nombre de sachets par carton.', fields: [{ key: 'Rayon', label: 'Rayon' }] } });
  await S.support.rpc('lg_extraction_template_upsert', { p: { name: 'Factures fournisseurs', kind: 'invoice', sender_match: 'facture' } });
  const tpls = await S.support.rpc('lg_extraction_templates_list');
  assert.deepEqual(tpls.map((t) => t.name).sort(), ['Enseigne Test', 'Factures fournisseurs']);
  assert.deepEqual(tpls.find((t) => t.name === 'Enseigne Test').fields, [{ key: 'rayon', label: 'Rayon', type: 'text' }]);
  env.INBOUND_SECRET = 's'.repeat(32);
  const { address } = await S.admin.rpc('lg_inbox_address');
  await handle(new Request('https://logistique.test/api/inbound/email', { method: 'POST', headers: { 'content-type': 'application/json', 'x-inbound-secret': env.INBOUND_SECRET },
    body: JSON.stringify({ to: address, from: 'achats@enseigne-test.sn', subject: 'Cde', message_id: '<1>', attachments: [{ filename: 'a.pdf', data: b64('%PDF') }] }) }), env);
  const last = env.AI.calls.prompts.at(-1);
  assert.match(last[0].content, /nombre de sachets par carton/);
  assert.match(last[1].content, /"rayon"/);
  const [doc] = await S.support.rpc('lg_inbox_list', {});
  assert.equal((await S.support.rpc('lg_inbox_detail', { p_id: doc.id })).data.fields.rayon, 'Surgelés');
  // document illisible : erreur visible, rien n'est perdu
  env.AI.toMarkdown = async () => [{ format: 'error', error: 'bad pdf' }];
  const bad = await S.support.rpc('lg_inbox_upload', { p_filename: 'abime.pdf', p_data: b64('xx') });
  assert.deepEqual([bad.extracted, bad.error], [false, 'conversion_failed']);
  assert.equal((await S.support.rpc('lg_inbox_detail', { p_id: bad.id })).status, 'error');
});

test('isolation et droits', async () => {
  const env = makeEnv(); env.AI = fakeAI(); const S = await setup(env);
  const up = await S.support.rpc('lg_inbox_upload', { p_filename: 'c.pdf', p_data: b64('%PDF') });
  assert.equal(await S.driver.rpcError('lg_inbox_list'), 'forbidden');
  assert.equal(await S.support.rpcError('lg_inbox_upload', { p_filename: 'virus.exe', p_data: b64('MZ') }), 'unsupported_type');
  const other = new Client(env); await other.register('bob@rapide.sn', { company: 'Rapide' });
  assert.deepEqual(await other.rpc('lg_inbox_list'), []);
  assert.equal(await other.rpcError('lg_inbox_detail', { p_id: up.id }), 'unknown_document');
  assert.equal(await other.rpcError('lg_inbox_convert', { p_id: up.id, p_zone: 'Yoff' }), 'unknown_document');
  assert.equal(await fileStatus(env, other, up.id), 404);
  const d = await S.support.rpc('lg_inbox_detail', { p_id: up.id });
  d.data.lines[0].product_id = (await other.rpc('lg_product_upsert', { p: { name: 'Chez Bob', price_fcfa: 1 } })).id;
  assert.equal(await S.support.rpcError('lg_inbox_save', { p_id: up.id, p_data: d.data }), 'unknown_product', 'pas de produit d\'une autre entreprise');
});

test('garde-fous : n° absent du document signalé, coordonnées du fournisseur retirées du client, code ligne vérifié', () => {
  // texte inventé qui reproduit les pièges d'un vrai bon converti : valeurs collées, bloc « Destinataire » = le fournisseur
  const src = `Lieu de livraison Destinataire FacturationMAGASIN TEST\n1013 FOURNISSEUR TEST\nRUE\n12, RUE DES EXEMPLES\n0 DAKAR\n+221770000099\n`
    + `N° commande Date de commande 15/08/202223716 Date de livraison\n21001054 6040042404507 ATTIEKE 500G 12 12 144Ar 650.00 18.00`;
  const raw = { order_number: '231716', customer: { name: 'MAGASIN TEST', address: '12, RUE DES EXEMPLES, 0 DAKAR', phone: '+221 77 000 00 99' },
    supplier: { name: 'FOURNISSEUR TEST' }, lines: [{ ref: '21001054', ean: '6040042404507', label: 'ATTIEKE 500G', quantity: 144, unit_price: 650 },
      { ref: '99999999', ean: '1234567890123', label: 'INVENTÉ', quantity: 1, unit_price: 1 }] };
  const d = normalizeExtraction(raw, { sourceText: src, own: { name: 'Fournisseur Test', phones: ['770000099'] } });
  assert.equal(d.order_number_suspect, true, '231716 ne figure pas dans le document');
  assert.deepEqual([d.customer.address, d.customer.phone, d.customer.name], [null, null, 'MAGASIN TEST']);
  assert.deepEqual(d.lines.map((l) => l.check), [true, false]);
  assert.deepEqual(d.warnings, ['order_number', 'line:99999999']);
  assert.equal(normalizeExtraction({ ...raw, order_number: '23716', lines: raw.lines.slice(0, 1) }, { sourceText: src }).warnings.length, 0);
});
