// Cycle C8 — messages : modèles modifiables (annexe B), aperçu, file d'envoi, envoi et réponses.
// Portage de 20261007000200 (lg_notify, lg_render_message), cycle2 (modèles), cycle18 (file, e-mail de secours) et
// 20261007000600 (lg_handle_reply). Envoi GRATUIT par défaut : le message attend dans la file avec un lien wa.me
// pré-rempli (un geste du service client) ; envoi automatique si l'entreprise branche sa propre instance WhatsApp
// (Green API, jeton chiffré) ; e-mail de secours par Brevo (clé de la plateforme) quand WhatsApp échoue ou manque.
// Un message ne bloque jamais l'action qui le crée : les fonctions renvoient une instruction à mettre dans le lot.
import { fail, audit, text, int, uuid, parseJson, phoneKey } from './core.js';
import { encryptSecret, decryptSecret, randomToken } from '../crypto.js';
import { amountDue, confirmCod, cancelOrder } from './commandes.js';
import { rateOrder } from './suivi.js';

export const DEFAULT_TEMPLATES = [
  ['lg_cod_confirm', 'Confirmation (paiement à la livraison)', "Bonjour {prenom}, votre commande {commande} chez {vendeur} est enregistrée : {montant} F à payer à la livraison. Répondez OUI pour la confirmer, NON pour l'annuler."],
  ['lg_order_confirmed', 'Commande confirmée', 'Merci {prenom}. Commande {commande} confirmée, nous la préparons. Suivi : {lien}'],
  ['lg_stockout', 'Rupture', "{prenom}, « {produit} » n'est plus disponible. Répondez 1 pour un remplacement, 2 pour être remboursé de cette ligne, 3 pour attendre son retour en stock."],
  ['lg_prepared', 'Commande préparée', '{prenom}, votre commande {commande} est prête ({colis} colis). Elle partira avec la prochaine tournée. Suivi : {lien}'],
  ['lg_out_for_delivery', 'En route', "Votre colis est en route avec {livreur}. Arrivée vers {heure}. Votre code de livraison : {code}. Ne le donnez qu'au livreur, à la remise du colis. Suivi : {lien}"],
  ['lg_approaching', "À l'approche", '{livreur} arrive dans environ {minutes} minutes. Montant à préparer : {montant} F.'],
  ['lg_delivered', 'Livré', "Colis remis à {heure}. Merci {prenom} ! Votre facture {facture} est disponible ici : {lien}. Comment s'est passée la livraison ? Répondez de 1 à 5."],
  ['lg_failed', 'Échec de livraison', 'Nous sommes passés à {heure} sans pouvoir vous remettre votre colis ({motif}). Répondez 1 pour une livraison demain, 2 pour choisir un autre jour, 3 pour être rappelé.'],
  ['lg_invoice_issued', 'Facture', 'Merci pour votre paiement, {prenom}. Votre facture {facture} : {lien}'],
  ['lg_return_scheduled', 'Reprise planifiée', '{prenom}, un livreur passera reprendre votre article (commande {commande}). Préparez-le dans son emballage. Suivi : {lien}'],
  ['lg_evening_report', 'Rapport du soir (gérant)', 'Rapport du soir : {livres} livrés, {echecs} échecs, 1re présentation {premiere_presentation} %, ponctualité {ponctualite} %, écart de caisse {especes} F, colis à quai depuis +24 h : {a_quai}.'],
  ['lg_third_party_code', 'Code pour la personne désignée', 'Bonjour {destinataire}, {prenom} vous a désigné pour recevoir son colis {entreprise}. Le livreur arrive vers {heure}. Code de livraison à lui donner : {code}.'],
  ['lg_vendor_prep_soon', 'Vendeur : commande à préparer bientôt', 'Bonjour {vendeur}, la commande {commande} doit être prête avant {heure} (votre engagement : {delai} h). Pensez à la préparer et à la remettre au livreur.'],
  ['lg_vendor_prep_late', 'Vendeur : commande en retard', "Bonjour {vendeur}, la commande {commande} devait être prête à {heure}. Le client attend : préparez-la dès que possible ou signalez une rupture dans l'application."],
  ['lg_incident_proposal', "Proposition d'indemnisation", 'Bonjour {prenom}, suite au problème sur votre commande {commande}, nous vous proposons : {resolution}{indemnite}. Acceptez ou refusez ici : {lien}'],
  ['lg_invoice_due_soon', 'Échéance proche (facture à terme)', 'Bonjour {prenom}, la facture {facture} ({montant} F, commande {commande}) arrive à échéance le {echeance}. Merci de prévoir son règlement. Détail : {lien}'],
  ['lg_invoice_overdue', "Relance d'impayé (facture à terme)", "Bonjour {prenom}, sauf erreur de notre part, la facture {facture} ({montant} F, commande {commande}), échue le {echeance}, reste à régler. Si le paiement est déjà parti, merci de nous en donner la référence. Détail : {lien}"],
  ['lg_reinforcement', 'Appel de renfort (chauffeurs)', "Bonjour {prenom}, {entreprise} a besoin de livreurs en renfort le {jour}{zones}. Êtes-vous disponible ? Répondez dans l'application (Ma journée)."],
].map(([event_key, label, body_fr], i) => ({ event_key, label, body_fr, body_wo: null, active: true, position: i + 1 }));

const SAMPLE = { prenom: 'Awa', commande: '1024', vendeur: 'Boutique Ndèye', montant: 12500, lien: 'https://logistique.nexusmarket.sn/suivi/…', livreur: 'Moussa',
  heure: '14h30', code: '4812', echeance: '24/10/2026', minutes: 10, motif: 'client absent', produit: 'Huile 1 L', facture: 'FAC-2026-000001', colis: 2, entreprise: 'Express Dakar' };

/** Modèles de l'entreprise (défauts + modifications), gardés le temps de la requête. */
export function loadTemplates(ctx) {
  // la promesse elle-même est gardée : 50 messages créés en parallèle ne lisent les modèles qu'une fois
  ctx._templates ??= (async () => {
    const rows = (await ctx.db.prepare('SELECT event_key, body_fr, body_wo, active, updated_at FROM message_templates WHERE company_id = ?').bind(ctx.company.id).all()).results;
    const m = new Map(DEFAULT_TEMPLATES.map((t) => [t.event_key, { ...t, updated_at: null }]));
    for (const r of rows) if (m.has(r.event_key)) Object.assign(m.get(r.event_key), { body_fr: r.body_fr, body_wo: r.body_wo, active: Boolean(r.active), updated_at: r.updated_at });
    return m;
  })();
  return ctx._templates;
}

/** {variable} → valeur ; montants avec séparateur de milliers ; variable absente → vide (lg_render_message). */
export function render(body, vars) {
  return String(body ?? '').replace(/\{([a-z_]+)\}/g, (_, k) => {
    const v = vars?.[k];
    if (v == null) return '';
    if (typeof v === 'number' && ['montant', 'especes'].includes(k)) return v.toLocaleString('fr-FR').replace(/[  ]/g, ' ');
    return String(v);
  });
}

const BASE_URL = 'https://logistique.nexusmarket.sn';
export function linkFor(ctx, token) {
  const base = ctx.company?.config?.tracking_base_url || (ctx.request ? new URL(ctx.request.url).origin : BASE_URL);
  return `${String(base).replace(/\/(suivi\/?)?$/, '')}/suivi/${token}`;
}
export const hhmm = (iso) => (iso ? `${iso.slice(11, 13)}h${iso.slice(14, 16)}` : null);

function outboxStatement(ctx, event, phone, email, orderId, vars, body) {
  return ctx.db.prepare('INSERT INTO outbox (id, company_id, event_key, order_id, phone, email, vars, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(uuid(), ctx.company.id, event, orderId ?? null, phoneKey(phone), text(email, 200), JSON.stringify(vars), render(body, vars).slice(0, 1500), ctx.now);
}

/** Message au client d'une commande (lg_notify) : instruction à mettre dans le lot, ou null (modèle désactivé, pas de contact). */
export async function notifyOrder(ctx, event, o, vars = {}) {
  const t = (await loadTemplates(ctx)).get(event);
  if (!t || !t.active || !o || (!phoneKey(o.buyer_phone) && !o.buyer_email)) return null;
  const due = amountDue(o);
  const v = { prenom: String(o.buyer_name ?? '').split(' ')[0], commande: String(o.number), vendeur: o.vendor_name ?? ctx.company.name, entreprise: ctx.company.name,
    montant: due || o.total_fcfa, lien: linkFor(ctx, o.tracking_token), ...vars };
  return outboxStatement(ctx, event, o.buyer_phone, o.buyer_email, o.id, v, t.body_fr);
}

/** Message à une personne (chauffeur, vendeur, gérant, personne désignée). */
export async function notifyPerson(ctx, event, { phone = null, email = null, orderId = null } = {}, vars = {}) {
  const t = (await loadTemplates(ctx)).get(event);
  if (!t || !t.active || (!phoneKey(phone) && !email)) return null;
  return outboxStatement(ctx, event, phone, email, orderId, { entreprise: ctx.company.name, ...vars }, t.body_fr);
}

/** Lance les instructions de message sans jamais faire échouer l'action (un message perdu vaut mieux qu'une livraison refusée). */
export async function sendLater(ctx, stmts) {
  const s = stmts.filter(Boolean);
  if (!s.length) return;
  try { await ctx.db.batch(s); } catch (e) { await audit(ctx, 'message_failed', 'outbox', null, { error: String(e?.message ?? e) }); }
}

const waLink = (phone, txt) => (phone ? `https://wa.me/221${phone}?text=${encodeURIComponent(txt)}` : null);
const mask = (p) => (p ? `${p.slice(0, 2)} *** ${p.slice(-2)}` : '');

// ----------------------------------------------------------------- envoi automatique (tâche planifiée « messages »)
async function greenSend(channel, token, phone, message) {
  const r = await fetch(`https://api.green-api.com/waInstance${channel.instance_id}/sendMessage/${token}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: `221${phone}@c.us`, message }),
  });
  if (!r.ok) throw new Error(`WhatsApp ${r.status}`);
}
async function brevoSend(env, company, to, subject, body) {
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST', headers: { 'content-type': 'application/json', 'api-key': env.BREVO_API_KEY },
    body: JSON.stringify({ sender: { name: company, email: env.BREVO_SENDER || 'no-reply@nexusmarket.sn' }, to: [{ email: to }], subject, textContent: body }),
  });
  if (!r.ok) throw new Error(`E-mail ${r.status}`);
}

/**
 * Envoie la file (30 messages au plus par passage) : WhatsApp par l'instance de l'entreprise si elle existe, sinon
 * e-mail de secours si l'adresse et la clé Brevo existent ; sinon le message reste en attente (envoi manuel wa.me).
 */
export async function sendPending(env, now) {
  const rows = (await env.DB.prepare(
    `SELECT o.*, c.name AS company, ch.instance_id, ch.token_enc FROM outbox o JOIN companies c ON c.id = o.company_id
       LEFT JOIN channels ch ON ch.company_id = o.company_id AND ch.active = 1
      WHERE o.status = 'pending' AND o.attempts < 5 AND c.suspended_at IS NULL
        AND (ch.company_id IS NOT NULL OR (o.email IS NOT NULL AND ?1 = 1 AND (o.phone IS NULL OR o.created_at < ?2)))
      ORDER BY o.created_at LIMIT 30`,
  ).bind(env.BREVO_API_KEY ? 1 : 0, new Date(Date.parse(now) - 6 * 3600000).toISOString()).all()).results;
  const tokens = new Map(); const updates = [];
  for (const m of rows) {
    let wa = null; let mail = null; let err = null;
    if (m.instance_id && m.phone && env.SECRETS_KEY) {
      try {
        if (!tokens.has(m.company_id)) tokens.set(m.company_id, await decryptSecret(env.SECRETS_KEY, m.token_enc));
        await greenSend(m, tokens.get(m.company_id), m.phone, m.text); wa = 'sent';
      } catch (e) { wa = 'failed'; err = String(e?.message ?? e).slice(0, 200); }
    } else wa = 'skipped';
    if (wa !== 'sent' && m.email && env.BREVO_API_KEY) {
      try { await brevoSend(env, m.company, m.email, `${m.company} — votre commande`, m.text); mail = 'sent'; } catch (e) { mail = 'failed'; err = String(e?.message ?? e).slice(0, 200); }
    }
    const done = wa === 'sent' || mail === 'sent';
    updates.push(env.DB.prepare(`UPDATE outbox SET status = ?, whatsapp_status = ?, email_status = ?, attempts = attempts + 1, last_error = ?, sent_at = ?
        WHERE id = ? AND status = 'pending'`).bind(done ? 'sent' : m.attempts + 1 >= 5 ? 'failed' : 'pending', wa, mail, err, done ? now : null, m.id));
  }
  if (updates.length) await env.DB.batch(updates);
  return { processed: rows.length };
}

// ----------------------------------------------------------------- réponses du client (webhook WhatsApp entrant)
/**
 * Réponse à un message (lg_handle_reply) : OUI / NON à la confirmation, note de 1 à 5 après la livraison,
 * 1 / 2 / 3 après un échec ou une rupture. Renvoie { handled, action, reply }.
 */
export async function handleReply(ctx, phone, body) {
  const key = phoneKey(phone);
  const v = String(body ?? '').normalize('NFD').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (!key) return { handled: false };
  const m = await ctx.db.prepare(
    `SELECT event_key, order_id, vars FROM outbox WHERE company_id = ? AND phone = ? AND event_key IN ('lg_cod_confirm', 'lg_delivered', 'lg_failed', 'lg_stockout')
        AND created_at > ? ORDER BY created_at DESC LIMIT 1`,
  ).bind(ctx.company.id, key, new Date(Date.parse(ctx.now) - 7 * 86400000).toISOString()).first();
  if (!m?.order_id) return { handled: false };
  const o = await ctx.db.prepare('SELECT * FROM orders WHERE id = ? AND company_id = ?').bind(m.order_id, ctx.company.id).first();
  if (!o) return { handled: false };
  const request = (kind, payload) => ctx.db.prepare("INSERT INTO customer_requests (id, company_id, order_id, kind, channel, payload) VALUES (?, ?, ?, ?, 'whatsapp', ?)")
    .bind(uuid(), ctx.company.id, o.id, kind, JSON.stringify(payload)).run();
  if (m.event_key === 'lg_cod_confirm') {
    if (['OUI', 'WAW', 'YES', '1', 'OK'].includes(v)) {
      const r = await confirmCod(ctx, ctx.company.id, o.id, 'whatsapp');
      if (!r.ok) return { handled: true, action: 'refused', error: r.error, reply: 'Cette commande ne peut plus être confirmée. Un conseiller vous recontacte.' };
      return { handled: true, action: 'confirmed', reply: 'Merci ! Votre commande est confirmée.' };
    }
    if (['NON', 'DEDET', 'NO', '2'].includes(v)) {
      await cancelOrder(ctx, ctx.company.id, o.id, 'Annulée par le client (WhatsApp)');
      return { handled: true, action: 'cancelled', reply: "C'est noté, votre commande est annulée." };
    }
  } else if (m.event_key === 'lg_delivered' && /^[1-5]$/.test(v)) {
    await rateOrder(ctx, o, Number(v), null);
    return { handled: true, action: 'rated', reply: 'Merci pour votre note !' };
  } else if (m.event_key === 'lg_failed' && ['1', '2', '3'].includes(v)) {
    await request(v === '3' ? 'callback' : 'reschedule', { choice: { 1: 'demain', 2: 'autre_jour', 3: 'rappel' }[v] });
    return { handled: true, action: 'request', reply: { 1: 'Entendu, nous repassons demain.', 2: 'Un conseiller vous contacte pour fixer le jour.', 3: 'Un conseiller vous rappelle rapidement.' }[v] };
  } else if (m.event_key === 'lg_stockout' && ['1', '2', '3'].includes(v)) {
    await request('stockout_choice', { choice: { 1: 'replace', 2: 'refund', 3: 'wait' }[v], line_id: parseJson(m.vars, {}).line_id ?? null });
    return { handled: true, action: 'stockout_choice', reply: 'Merci, votre choix est enregistré.' };
  }
  return { handled: false, expected: m.event_key };
}

export default {
  lg_templates_list: {
    roles: ['support'],
    async handler(ctx) {
      const [sent, last] = await ctx.db.batch([
        ctx.db.prepare('SELECT event_key, count(*) AS n FROM outbox WHERE company_id = ? AND created_at > ? GROUP BY event_key')
          .bind(ctx.company.id, new Date(Date.parse(ctx.now) - 7 * 86400000).toISOString()),
        ctx.db.prepare(`SELECT o.event_key, o.vars FROM outbox o WHERE o.company_id = ? AND o.created_at = (SELECT max(created_at) FROM outbox x
            WHERE x.company_id = o.company_id AND x.event_key = o.event_key)`).bind(ctx.company.id),
      ]);
      const tpl = await loadTemplates(ctx);
      return [...tpl.values()].sort((a, b) => a.position - b.position).map((x) => ({
        event_key: x.event_key, label: x.label, body_fr: x.body_fr, body_wo: x.body_wo, active: x.active, updated_at: x.updated_at,
        sent_7d: sent.results.find((s) => s.event_key === x.event_key)?.n ?? 0,
        // dernières variables réellement envoyées : servent d'exemple pour l'aperçu
        sample: parseJson(last.results.find((s) => s.event_key === x.event_key)?.vars, null) ?? { ...SAMPLE, entreprise: ctx.company.name },
      }));
    },
  },

  lg_template_save: {
    roles: ['support'],
    async handler(ctx, a) {
      const def = DEFAULT_TEMPLATES.find((t) => t.event_key === a.p_event);
      if (!def) fail('unknown_template', 404);
      const body = String(a.p_body_fr ?? '').trim();
      if (body.length < 10) fail('message_too_short');
      if (body.length > 1000) fail('message_too_long');
      await ctx.db.prepare(`INSERT INTO message_templates (company_id, event_key, body_fr, body_wo, active, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (company_id, event_key) DO UPDATE SET body_fr = excluded.body_fr, body_wo = excluded.body_wo, active = excluded.active,
            updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .bind(ctx.company.id, def.event_key, body, text(a.p_body_wo, 1000), a.p_active === false ? 0 : 1, ctx.user.id, ctx.now).run();
      await audit(ctx, 'template_save', 'template', def.event_key, { active: a.p_active !== false });
      return { ok: true };
    },
  },

  lg_preview_message: {
    roles: ['support'],
    async handler(ctx, a) {
      return render(String(a.p_body ?? '').slice(0, 1000), a.p_vars && typeof a.p_vars === 'object' ? a.p_vars : SAMPLE);
    },
  },

  lg_outbox_recent: {
    roles: ['support'],
    async handler(ctx, a) {
      const tpl = await loadTemplates(ctx);
      const r = await ctx.db.prepare('SELECT * FROM outbox WHERE company_id = ? ORDER BY created_at DESC LIMIT ?').bind(ctx.company.id, Math.min(Math.max(int(a.p_limit) ?? 50, 1), 200)).all();
      return r.results.map((m) => ({
        id: m.id, event_key: m.event_key, label: tpl.get(m.event_key)?.label ?? m.event_key, created_at: m.created_at, to: mask(m.phone), has_email: Boolean(m.email),
        text: m.text, status: m.status, whatsapp: m.whatsapp_status, email: m.email_status, attempts: m.attempts, error: m.last_error,
        // envoi manuel gratuit : WhatsApp s'ouvre avec le message prêt, il ne reste qu'à appuyer sur « Envoyer »
        wa_link: m.status === 'pending' ? waLink(m.phone, m.text) : null,
      }));
    },
  },

  lg_outbox_channels: {
    roles: ['support'],
    async handler(ctx, a) {
      const since = new Date(Date.parse(ctx.now) - (int(a.p_days) ?? 7) * 86400000).toISOString();
      const [k, ch] = await ctx.db.batch([
        ctx.db.prepare(`SELECT count(*) AS total, coalesce(sum(whatsapp_status IN ('sent', 'manual')), 0) AS whatsapp_sent, coalesce(sum(email_status = 'sent'), 0) AS email_fallback,
            coalesce(sum(status = 'pending'), 0) AS pending, coalesce(sum(status = 'failed'), 0) AS failed FROM outbox WHERE company_id = ? AND created_at > ?`).bind(ctx.company.id, since),
        ctx.db.prepare('SELECT provider FROM channels WHERE company_id = ? AND active = 1').bind(ctx.company.id),
      ]);
      return { ...k.results[0], automatic: Boolean(ch.results[0]) };
    },
  },

  // Envoi manuel fait (lien wa.me ouvert) : le message sort de la file.
  lg_outbox_mark_sent: {
    roles: ['support', 'dispatcher'],
    async handler(ctx, a) {
      const r = await ctx.db.prepare("UPDATE outbox SET status = 'sent', whatsapp_status = 'manual', sent_at = ? WHERE id = ? AND company_id = ? AND status = 'pending'")
        .bind(ctx.now, String(a.p_id ?? ''), ctx.company.id).run();
      return { ok: r.meta.changes > 0 };
    },
  },

  lg_outbox_cancel: {
    roles: ['support'],
    async handler(ctx, a) {
      const r = await ctx.db.prepare("UPDATE outbox SET status = 'cancelled' WHERE id = ? AND company_id = ? AND status = 'pending'").bind(String(a.p_id ?? ''), ctx.company.id).run();
      return { ok: r.meta.changes > 0 };
    },
  },

  // Instance WhatsApp de l'entreprise : état (jamais le jeton), adresse du webhook des réponses.
  lg_channel_get: {
    roles: 'admin',
    async handler(ctx) {
      const c = await ctx.db.prepare('SELECT provider, instance_id, webhook_secret, active, last_error, updated_at FROM channels WHERE company_id = ?').bind(ctx.company.id).first();
      const origin = ctx.request ? new URL(ctx.request.url).origin : BASE_URL;
      return c ? { connected: Boolean(c.active), provider: c.provider, instance_id: c.instance_id, last_error: c.last_error, updated_at: c.updated_at,
        webhook_url: `${origin}/api/whatsapp/${c.webhook_secret}` } : { connected: false, can_encrypt: Boolean(ctx.env.SECRETS_KEY) };
    },
  },

  lg_channel_save: {
    roles: 'admin',
    async handler(ctx, a) {
      if (a.p_disconnect === true) {
        await ctx.db.prepare('DELETE FROM channels WHERE company_id = ?').bind(ctx.company.id).run();
        await audit(ctx, 'channel_disconnect', 'company', ctx.company.id);
        return { ok: true, connected: false };
      }
      if (!ctx.env.SECRETS_KEY) fail('secrets_key_missing', 503);
      const inst = String(a.p_instance_id ?? '').trim(); const token = String(a.p_token ?? '').trim();
      if (!/^\d{6,15}$/.test(inst) || !/^[A-Za-z0-9]{20,80}$/.test(token)) fail('invalid_channel');
      await ctx.db.prepare(`INSERT INTO channels (company_id, provider, instance_id, token_enc, webhook_secret, updated_by, updated_at) VALUES (?, 'green_api', ?, ?, ?, ?, ?)
          ON CONFLICT (company_id) DO UPDATE SET instance_id = excluded.instance_id, token_enc = excluded.token_enc, active = 1, last_error = NULL,
            updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .bind(ctx.company.id, inst, await encryptSecret(ctx.env.SECRETS_KEY, token), randomToken(24), ctx.user.id, ctx.now).run();
      await audit(ctx, 'channel_connect', 'company', ctx.company.id, { provider: 'green_api', instance_id: inst });
      return { ok: true, connected: true };
    },
  },
};
