// Cycle 18 : canal de secours e-mail — chaque message porte l'adresse e-mail quand on la connaît.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, makeOrder, U, IDS } from '../helpers/db.mjs';

let t;
before(async () => { t = await createDb(); });

test('relance vendeur et rapport du soir : adresse e-mail jointe pour le secours', async () => {
  await t.rpc(U.vendor, 'lg_vendor_commitment_set', { p_hours: 4 });
  const o = await makeOrder(t, { method: 'mobile', paid: true, lines: [[IDS.soap, 1]] });
  await t.as(null);
  await t.db.query("update lg_pick_tasks set cutoff_at = now() + interval '1 hour' where order_id = $1", [o]);
  await t.rpc(null, 'lg_vendor_reminders', {});
  const vendorEmail = (await t.one('select email from profiles where id = $1', [U.vendor])).email;
  const rem = await t.one("select recipient from notification_outbox where event_key = 'lg_vendor_prep_soon'");
  assert.equal(rem.recipient.email, vendorEmail);

  await t.rpc(U.admin, 'lg_set_config', { p: { manager_phone: '+221770000000', manager_email: 'gerant@nexusmarket.sn' } });
  await t.rpc(null, 'lg_evening_report', {});
  const rep = await t.one("select recipient, vars from notification_outbox where event_key = 'lg_evening_report' order by created_at desc limit 1");
  assert.deepEqual([rep.recipient.phone, rep.recipient.email], ['+221770000000', 'gerant@nexusmarket.sn']);
  assert.ok(rep.vars.texte.length > 10, 'texte final prêt pour WhatsApp comme pour l\'e-mail');
});

test('file d\'envoi : statut par canal (WhatsApp ou e-mail de secours) et totaux', async () => {
  // NEXUS Market a envoyé le rapport par e-mail après l'échec de WhatsApp
  await t.as(null);
  await t.db.query("update notification_outbox set whatsapp_status = 'fallback_email', email_status = 'sent', status = 'done' where event_key = 'lg_evening_report'");
  const q = await t.rpc(U.support, 'lg_outbox_recent', { p_limit: 10 });
  const r = q.find((m) => m.event_key === 'lg_evening_report');
  assert.deepEqual([r.email, r.has_email], ['sent', true]);
  const s = await t.rpc(U.support, 'lg_outbox_channels', { p_days: 7 });
  assert.equal(s.email_fallback, 1);
  await assert.rejects(t.rpc(U.driver, 'lg_outbox_channels', {}), /forbidden/);
});
