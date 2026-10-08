// Réponses des clients par WhatsApp : POST /api/whatsapp/<secret>, adresse donnée à l'instance Green API de
// l'entreprise (le secret, propre à chaque entreprise, l'identifie). OUI / NON, note 1 à 5, choix 1 / 2 / 3.
// La réponse de remerciement repart par la même instance. Toujours 200 (sinon Green API rejoue le message).
import { json, readJson } from '../http.js';
import { companyConfig } from '../config.js';
import { decryptSecret } from '../crypto.js';
import { handleReply } from '../rpc/messages.js';

export async function incoming(request, env, { secret }, waitCtx) {
  const ch = await env.DB.prepare(
    `SELECT ch.*, c.name, c.settings, c.slug, c.phone, c.city FROM channels ch JOIN companies c ON c.id = ch.company_id
      WHERE ch.webhook_secret = ? AND ch.active = 1 AND c.suspended_at IS NULL`,
  ).bind(secret).first();
  if (!ch) return json({ ok: true, ignored: 'unknown' });
  const body = await readJson(request, 100_000).catch(() => null);
  if (body?.typeWebhook !== 'incomingMessageReceived') return json({ ok: true, ignored: body?.typeWebhook ?? 'empty' });
  const chat = String(body.senderData?.chatId ?? '');
  if (!chat.endsWith('@c.us')) return json({ ok: true, ignored: 'group' });
  const text = body.messageData?.textMessageData?.textMessage ?? body.messageData?.extendedTextMessageData?.text ?? '';
  const company = { id: ch.company_id, name: ch.name, slug: ch.slug, phone: ch.phone, city: ch.city, settings: ch.settings };
  const ctx = { env, db: env.DB, now: new Date().toISOString(), user: null, company: { ...company, config: companyConfig(company) }, member: null, roles: [],
    isAdmin: false, courierId: null, request };
  const r = await handleReply(ctx, chat.replace('@c.us', ''), text);
  if (r.reply && env.SECRETS_KEY) {
    const send = decryptSecret(env.SECRETS_KEY, ch.token_enc)
      .then((token) => fetch(`https://api.green-api.com/waInstance${ch.instance_id}/sendMessage/${token}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: chat, message: r.reply }) }))
      .catch((e) => console.error('whatsapp reply', e?.message));
    if (waitCtx?.waitUntil) waitCtx.waitUntil(send); else await send;
  }
  return json({ ok: true, handled: r.handled, action: r.action ?? null });
}
