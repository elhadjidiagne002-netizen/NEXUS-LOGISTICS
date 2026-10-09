// Réception des bons de commande par e-mail (Cloudflare Email Routing).
// Le message est découpé ici (postal-mime : expéditeur, objet, texte, pièces jointes) puis remis à l'application,
// qui reconnaît l'entreprise par l'adresse (bons+<clé>@commandes.nexusmarket.sn), garde les pièces lisibles et lance
// la lecture par l'IA. Un refus de l'application ou une panne fait REJETER le message avec une explication : l'expéditeur
// est prévenu par son serveur plutôt que de croire sa commande reçue.
import PostalMime from 'postal-mime';

const MAX_ATTACHMENT = 1_500_000;   // même plafond que l'application
const MAX_ATTACHMENTS = 10;

function b64(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function toPayload(message) {
  const raw = await new Response(message.raw).arrayBuffer();
  const p = await PostalMime.parse(raw);
  const from = p.from?.address ? (p.from.name ? `${p.from.name} <${p.from.address}>` : p.from.address) : message.from;
  // images insérées dans le corps (logos de signature) écartées ; le reste est trié par type côté application
  const attachments = (p.attachments ?? [])
    .filter((a) => a.content && a.content.byteLength > 0 && a.content.byteLength <= MAX_ATTACHMENT)
    .filter((a) => !(a.disposition === 'inline' && /^image\//i.test(a.mimeType ?? '')))
    .slice(0, MAX_ATTACHMENTS)
    .map((a) => ({ filename: a.filename || 'piece-jointe', content_type: a.mimeType || 'application/octet-stream', data: b64(a.content) }));
  return { to: message.to, from, subject: p.subject ?? '', message_id: p.messageId ?? null, text: p.text ?? '', attachments };
}

export default {
  async email(message, env) {
    let res;
    try {
      res = await fetch(env.INBOUND_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-inbound-secret': env.INBOUND_SECRET ?? '' },
        body: JSON.stringify(await toPayload(message)),
      });
    } catch (e) {
      console.error('inbound: envoi impossible', String(e?.message ?? e));
      message.setReject('Service momentanement indisponible, merci de renvoyer votre commande plus tard.');
      return;
    }
    if (!res.ok) {
      console.error('inbound: refus', res.status, (await res.text()).slice(0, 300));
      message.setReject('Commande non recue (erreur de traitement), merci de la renvoyer plus tard ou de contacter votre fournisseur.');
      return;
    }
    const r = await res.json().catch(() => ({}));
    console.log('inbound: ok', JSON.stringify({ accepted: r.accepted, reason: r.reason ?? null }));
  },
};
