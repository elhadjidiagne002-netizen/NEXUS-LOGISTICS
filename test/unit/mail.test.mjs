import { test } from "node:test";
import assert from "node:assert/strict";
import { toPayload } from "../../mail/src/index.js";

test("e-mail entrant : expéditeur, objet, pièce jointe gardée, logo de signature écarté", async () => {
  const pdf = Buffer.from('%PDF-1.4 faux').toString('base64');
  const raw = [
   'From: Achats Enseigne <achats@enseigne.sn>', 'To: bons+express-abc123@commandes.nexusmarket.sn', 'Subject: Commande 23716', 'Message-ID: <x1@enseigne.sn>',
   'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="B"', '', '--B', 'Content-Type: text/plain; charset=utf-8', '', 'Veuillez trouver notre bon.', '',
   '--B', 'Content-Type: image/png', 'Content-Disposition: inline; filename="logo.png"', 'Content-Transfer-Encoding: base64', '', Buffer.from('PNG').toString('base64'), '',
   '--B', 'Content-Type: application/pdf', 'Content-Disposition: attachment; filename="CDE_23716.PDF"', 'Content-Transfer-Encoding: base64', '', pdf, '', '--B--', ''].join('\r\n');
  const message = { raw: new Blob([raw]).stream(), to: 'bons+express-abc123@commandes.nexusmarket.sn', from: 'achats@enseigne.sn' };
  const p = await toPayload(message);
  assert.deepEqual([p.to, p.from, p.subject, p.message_id], ["bons+express-abc123@commandes.nexusmarket.sn", "Achats Enseigne <achats@enseigne.sn>", "Commande 23716", "<x1@enseigne.sn>"]);
  assert.deepEqual(p.attachments.map((a) => [a.filename, a.content_type, Buffer.from(a.data, "base64").toString()]), [["CDE_23716.PDF", "application/pdf", "%PDF-1.4 faux"]]);
  assert.match(p.text, /notre bon/);
});
