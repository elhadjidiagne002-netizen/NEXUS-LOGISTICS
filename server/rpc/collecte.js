// Cycle D1 — collecte automatique des données avant la préparation des commandes.
// Documents reçus par e-mail (route /api/inbound/email, Worker mail/) ou déposés dans l'application ; lecture par
// l'IA selon un modèle d'extraction (server/extract.js) ; vérification humaine ; correspondances apprises ;
// transformation en commande (bons de commande) ou export Excel (toutes données).
import { fail, audit, hasRole, text, int, uuid, parseJson } from './core.js';
import { createOrders } from './commandes.js';
import { findAccount, priceChecks } from './enseignes.js';
import { documentToText, llmJson, buildPrompt, normalizeExtraction, normAlias, scopeOf, guessType, DOC_TYPES, MAX_TEXT } from '../extract.js';

const VIEW = ['support', 'dispatcher', 'dock_chief', 'accountant'];
const KINDS = ['order', 'invoice', 'delivery_note', 'price_list', 'custom'];
const MAX_FILE = 1_500_000;
export const INBOUND_DOMAIN = 'commandes.nexusmarket.sn';
// Une seule règle de routage (bons@…) pour toutes les entreprises : chacune reçoit sur bons+<clé>@… (adressage plus,
// RFC 5233, activé dans le routage e-mail Cloudflare). Pas de règle par entreprise (plafond de 200 par domaine).
export const INBOUND_MAILBOX = 'bons';
const view = (ctx) => { if (!hasRole(ctx, VIEW)) fail('forbidden', 403); };

const fieldList = (v) => (Array.isArray(v) ? v : []).slice(0, 40).map((f) => ({
  key: String(f?.key ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9_]+/g, '_').replace(/^_|_$/g, '').slice(0, 40),
  label: text(f?.label, 80) ?? String(f?.key ?? ''), type: ['text', 'number', 'date'].includes(f?.type) ? f.type : 'text',
})).filter((f) => f.key);

/** Modèle d'extraction applicable : le plus spécifique dont le filtre correspond à l'expéditeur ou au sujet. */
export async function pickTemplate(db, companyId, { sender, subject, templateId }) {
  const all = (await db.prepare('SELECT * FROM extraction_templates WHERE company_id = ? AND active = 1 ORDER BY created_at').bind(companyId).all()).results;
  if (templateId) return all.find((t) => t.id === templateId) ?? null;
  const hay = `${sender ?? ''} ${subject ?? ''}`.toLowerCase();
  const hit = all.filter((t) => t.sender_match && hay.includes(t.sender_match.toLowerCase().trim())).sort((a, b) => b.sender_match.length - a.sender_match.length)[0];
  return hit ?? all.find((t) => !t.sender_match && t.kind === 'order') ?? all.find((t) => !t.sender_match) ?? null;
}
const tpl = (t) => (t ? { ...t, fields: parseJson(t.fields, []), line_fields: parseJson(t.line_fields, []), active: Boolean(t.active) } : null);

/** Fichier d'un document : R2 (PROOFS) si relié, sinon table files (repli gratuit). */
export async function storeFile(env, companyId, path, contentType, bytes, by) {
  if (env.PROOFS) await env.PROOFS.put(`${companyId}/${path}`, bytes, { httpMetadata: { contentType } });
  else await env.DB.prepare('INSERT OR IGNORE INTO files (company_id, path, content_type, size, data, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(companyId, path, contentType, bytes.byteLength, bytes, by ?? null).run();
}
export async function readFile(env, companyId, path) {
  if (env.PROOFS) { const o = await env.PROOFS.get(`${companyId}/${path}`); if (o) return new Uint8Array(await o.arrayBuffer()); }
  const r = await env.DB.prepare('SELECT data FROM files WHERE company_id = ? AND path = ?').bind(companyId, path).first();
  return r ? new Uint8Array(r.data) : null;
}

/** Enregistre un document reçu (sans le lire). Renvoie son id, ou null si déjà reçu (même e-mail, même fichier). */
export async function addDocument(env, { companyId, source, sender = null, subject = null, messageId = null, filename, contentType, bytes, by = null }) {
  const id = uuid(); const type = guessType(filename, contentType);
  const safe = String(filename || 'document').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 100) || 'document';
  const path = `inbox/${id}/${safe}`;
  const r = await env.DB.prepare(`INSERT OR IGNORE INTO inbox_documents (id, company_id, source, sender, subject, message_id, filename, content_type, size, file_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, companyId, source, sender, subject, messageId, filename ?? safe, type, bytes.byteLength, path).run();
  if (!r.meta.changes) return null;
  await storeFile(env, companyId, path, type || 'application/octet-stream', bytes, by);
  return id;
}

/** Lecture complète d'un document : texte, IA, rapprochement. Ne lève pas : l'erreur est écrite sur le document. */
export async function extractDocument(env, companyId, docId, { templateId = null, fetchImpl } = {}) {
  const now = () => new Date().toISOString();
  const doc = await env.DB.prepare('SELECT * FROM inbox_documents WHERE id = ? AND company_id = ?').bind(docId, companyId).first();
  if (!doc) return { ok: false, error: 'unknown_document' };
  await env.DB.prepare("UPDATE inbox_documents SET status = 'extracting', error = NULL, updated_at = ? WHERE id = ?").bind(now(), docId).run();
  try {
    let content = doc.text;
    if (!content) {
      const bytes = await readFile(env, companyId, doc.file_path);
      if (!bytes) throw Object.assign(new Error('file_missing'), { code: 'file_missing' });
      content = await documentToText(env, { filename: doc.filename, contentType: doc.content_type, bytes });
    }
    if (!content || content.length < 10) throw Object.assign(new Error('empty_document'), { code: 'empty_document' });
    const template = tpl(await pickTemplate(env.DB, companyId, { sender: doc.sender, subject: doc.subject, templateId: templateId ?? doc.template_id }));
    const company = await env.DB.prepare('SELECT name FROM companies WHERE id = ?').bind(companyId).first();
    const { system, schema } = buildPrompt(template ?? { kind: 'order' }, { companyName: company?.name });
    const user = `Format de réponse attendu :\n${schema}\n\nDocument${doc.subject ? ` (e-mail « ${doc.subject} »)` : ''}${doc.filename ? ` — fichier ${doc.filename}` : ''} :\n"""\n${content.slice(0, MAX_TEXT)}\n"""`;
    const raw = await llmJson(env, system, user, { fetchImpl });
    const [products, aliases, members] = await env.DB.batch([
      env.DB.prepare('SELECT id, name, sku, barcode FROM products WHERE company_id = ? AND active = 1').bind(companyId),
      env.DB.prepare('SELECT alias, scope, product_id, units_per_case FROM product_aliases WHERE company_id = ?').bind(companyId),
      env.DB.prepare('SELECT u.email, u.phone FROM members m JOIN users u ON u.id = m.user_id WHERE m.company_id = ?').bind(companyId),
    ]);
    const self = await env.DB.prepare('SELECT name, phone, settings FROM companies WHERE id = ?').bind(companyId).first();
    const cfg = parseJson(self?.settings, {});
    const own = { name: self?.name, phones: [self?.phone, cfg.manager_phone, ...members.results.map((m) => m.phone)].filter(Boolean),
      emails: [cfg.manager_email, ...members.results.map((m) => m.email)].filter(Boolean) };
    const data = normalizeExtraction(raw, { products: products.results, aliases: aliases.results, scope: scopeOf(doc.sender), sourceText: content, own });
    await env.DB.prepare(`UPDATE inbox_documents SET status = 'to_review', text = ?, data = ?, confidence = ?, template_id = ?, extracted_at = ?, updated_at = ?
        WHERE id = ? AND company_id = ?`).bind(content.slice(0, 100000), JSON.stringify(data), data.confidence, template?.id ?? null, now(), now(), docId, companyId).run();
    return { ok: true, data };
  } catch (e) {
    const code = e.code ?? 'extract_failed';
    await env.DB.prepare("UPDATE inbox_documents SET status = 'error', error = ?, updated_at = ? WHERE id = ? AND company_id = ?").bind(code, now(), docId, companyId).run();
    return { ok: false, error: code };
  }
}

const b64ToBytes = (s) => { const bin = atob(String(s).replace(/^data:[^,]*,/, '')); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; };
export { b64ToBytes };

const summary = (d) => {
  const x = parseJson(d.data, null);
  return { id: d.id, source: d.source, sender: d.sender, subject: d.subject, filename: d.filename, content_type: d.content_type, size: d.size,
    status: d.status, confidence: d.confidence, error: d.error, order_id: d.order_id, received_at: d.received_at, extracted_at: d.extracted_at,
    order_number: x?.order_number ?? null, customer: x?.customer?.name ?? x?.customer?.store ?? null, delivery_date: x?.delivery_date ?? null,
    lines: x?.lines?.length ?? 0, matched: x?.lines?.filter((l) => l.product_id).length ?? 0 };
};

export default {
  // ----------------------------------------------------------------- adresse de réception
  lg_inbox_address: {
    roles: 'admin',
    async handler(ctx) {
      let key = ctx.company.inbound_key;
      if (!key) {
        key = `${ctx.company.slug}-${uuid().slice(0, 6)}`;
        await ctx.db.prepare('UPDATE companies SET inbound_key = ? WHERE id = ? AND inbound_key IS NULL').bind(key, ctx.company.id).run();
        key = await ctx.db.prepare('SELECT inbound_key FROM companies WHERE id = ?').bind(ctx.company.id).first('inbound_key');
      }
      return { address: `${INBOUND_MAILBOX}+${key}@${INBOUND_DOMAIN}`, active: Boolean(ctx.env.INBOUND_SECRET) };
    },
  },

  // ----------------------------------------------------------------- documents
  lg_inbox_list: {
    roles: 'member',
    async handler(ctx, a) {
      view(ctx);
      const st = ['received', 'extracting', 'to_review', 'converted', 'done', 'rejected', 'error'].includes(a.p_status) ? a.p_status : null;
      const open = a.p_status === 'open' ? 1 : 0;
      const r = await ctx.db.prepare(`SELECT id, source, sender, subject, filename, content_type, size, status, confidence, error, order_id, received_at, extracted_at, data
          FROM inbox_documents WHERE company_id = ? AND (? IS NULL OR status = ?) AND (? = 0 OR status IN ('received', 'extracting', 'to_review', 'error'))
          ORDER BY received_at DESC LIMIT 300`).bind(ctx.company.id, st, st, open).all();
      return r.results.map(summary);
    },
  },

  lg_inbox_detail: {
    roles: 'member',
    async handler(ctx, a) {
      view(ctx);
      const d = await ctx.db.prepare('SELECT * FROM inbox_documents WHERE id = ? AND company_id = ?').bind(String(a.p_id ?? ''), ctx.company.id).first();
      if (!d) fail('unknown_document', 404);
      const order = d.order_id ? await ctx.db.prepare('SELECT id, number, status FROM orders WHERE id = ? AND company_id = ?').bind(d.order_id, ctx.company.id).first() : null;
      const zones = (await ctx.db.prepare('SELECT name FROM zones WHERE company_id = ? AND served = 1 ORDER BY name').bind(ctx.company.id).all()).results.map((z) => z.name);
      const data = parseJson(d.data, null);
      // enseigne reconnue (adresse de l'expéditeur, nom lu) : ses magasins, et les prix du bon face aux prix convenus
      const account = data ? await findAccount(ctx, { sender: d.sender, names: [data.customer?.name, data.customer?.store, data.delivery_place] }) : null;
      const checks = account ? await priceChecks(ctx, account, data.lines) : [];
      return { ...summary(d), text: d.text, data, template_id: d.template_id, order, zones, account, price_checks: checks };
    },
  },

  // Dépôt d'un fichier (PDF, Excel, Word, photo, texte) en base64, lu aussitôt.
  lg_inbox_upload: {
    roles: 'member',
    async handler(ctx, a) {
      view(ctx);
      const bytes = b64ToBytes(a.p_data ?? '');
      if (!bytes.byteLength) fail('empty_file');
      if (bytes.byteLength > MAX_FILE) fail('file_too_large');
      const type = guessType(a.p_filename, a.p_content_type);
      if (!DOC_TYPES.includes(type)) fail('unsupported_type');
      const id = await addDocument(ctx.env, { companyId: ctx.company.id, source: 'upload', sender: ctx.user.email, subject: text(a.p_note, 200),
        filename: text(a.p_filename, 120) ?? 'document', contentType: type, bytes, by: ctx.user.id });
      await audit(ctx, 'inbox_upload', 'inbox_document', id, { filename: a.p_filename });
      const r = await extractDocument(ctx.env, ctx.company.id, id, { templateId: a.p_template ?? null });
      return { ok: true, id, extracted: r.ok, error: r.ok ? null : r.error };
    },
  },

  // Relire un document (après correction d'un modèle, ou en choisissant un autre modèle).
  lg_inbox_extract: {
    roles: 'member',
    async handler(ctx, a) {
      view(ctx);
      const d = await ctx.db.prepare('SELECT id, status FROM inbox_documents WHERE id = ? AND company_id = ?').bind(String(a.p_id ?? ''), ctx.company.id).first();
      if (!d) fail('unknown_document', 404);
      if (d.status === 'converted') return { ok: false, error: 'already_converted' };
      if (a.p_template) await ctx.db.prepare('UPDATE inbox_documents SET template_id = ? WHERE id = ? AND company_id = ?').bind(String(a.p_template), d.id, ctx.company.id).run();
      return extractDocument(ctx.env, ctx.company.id, d.id, { templateId: a.p_template ?? null });
    },
  },

  /**
   * Enregistrer les données vérifiées. p_learn (par défaut) : chaque ligne rattachée à un produit apprend ses codes
   * (EAN, référence, libellé) pour cet expéditeur — le prochain bon du même client sera rapproché tout seul.
   */
  lg_inbox_save: {
    roles: 'member',
    async handler(ctx, a) {
      view(ctx);
      const d = await ctx.db.prepare('SELECT * FROM inbox_documents WHERE id = ? AND company_id = ?').bind(String(a.p_id ?? ''), ctx.company.id).first();
      if (!d) fail('unknown_document', 404);
      if (d.status === 'converted') return { ok: false, error: 'already_converted' };
      const data = a.p_data && typeof a.p_data === 'object' ? a.p_data : null;
      if (!data) fail('invalid_data');
      const lines = Array.isArray(data.lines) ? data.lines.slice(0, 200) : [];
      const ids = [...new Set(lines.map((l) => l.product_id).filter(Boolean).map(String))];
      if (ids.length) {
        const n = await ctx.db.prepare(`SELECT count(*) AS n FROM products WHERE company_id = ? AND id IN (${ids.map(() => '?').join(',')})`).bind(ctx.company.id, ...ids).first('n');
        if (n !== ids.length) fail('unknown_product', 404);
      }
      const stmts = [ctx.db.prepare('UPDATE inbox_documents SET data = ?, status = ?, reviewed_by = ?, updated_at = ? WHERE id = ? AND company_id = ?')
        .bind(JSON.stringify({ ...data, lines, matched: lines.filter((l) => l.product_id).length }), a.p_done ? 'done' : 'to_review', ctx.user.id, ctx.now, d.id, ctx.company.id)];
      let learned = 0;
      if (a.p_learn !== false) {
        const scope = scopeOf(d.sender);
        for (const l of lines.filter((x) => x.product_id)) {
          for (const k of [l.ean, l.ref, l.label].filter(Boolean).map(normAlias).filter((x) => x.length >= 3)) {
            stmts.push(ctx.db.prepare(`INSERT INTO product_aliases (company_id, alias, scope, product_id, units_per_case, created_by) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (company_id, alias, scope) DO UPDATE SET product_id = excluded.product_id, units_per_case = coalesce(excluded.units_per_case, product_aliases.units_per_case)`)
              .bind(ctx.company.id, k, scope, String(l.product_id), int(l.units_per_case), ctx.user.id));
            learned++;
          }
        }
      }
      for (let i = 0; i < stmts.length; i += 90) await ctx.db.batch(stmts.slice(i, i + 90));
      return { ok: true, learned };
    },
  },

  /**
   * Bon de commande vérifié → commande (référence externe = n° du bon : un même bon ne crée jamais deux commandes).
   * p_customer {name, phone, address}, p_zone, p_payment_method ('cod' | 'prepaid' | 'account' ; défaut : 'account'
   * si le bon porte un délai de paiement, sinon le mode habituel du client), p_terms_days, p_promised_at (défaut :
   * la date de livraison impérative du bon). Lignes sans produit du catalogue : reprises en
   * article libre (libellé, prix) si p_free_lines, sinon refus.
   */
  lg_inbox_convert: {
    roles: 'member',
    async handler(ctx, a) {
      view(ctx);
      const d = await ctx.db.prepare('SELECT * FROM inbox_documents WHERE id = ? AND company_id = ?').bind(String(a.p_id ?? ''), ctx.company.id).first();
      if (!d) fail('unknown_document', 404);
      if (d.status === 'converted') return { ok: false, error: 'already_converted', order_id: d.order_id };
      const data = parseJson(d.data, null);
      if (!data?.lines?.length) return { ok: false, error: 'no_lines' };
      const unmatched = data.lines.filter((l) => !l.product_id);
      if (unmatched.length && !a.p_free_lines) return { ok: false, error: 'unmatched_lines', count: unmatched.length };
      const items = data.lines.filter((l) => (l.quantity ?? 0) > 0 && (l.product_id || l.label)).map((l) => ({
        product_id: l.product_id ?? undefined, name: l.product_id ? undefined : l.label, quantity: Math.round(l.quantity),
        unit_price_fcfa: l.unit_price != null ? Math.round(l.unit_price) : undefined }));
      if (!items.length) return { ok: false, error: 'no_lines' };
      const c = a.p_customer && typeof a.p_customer === 'object' ? a.p_customer : {};
      // enseigne : prix du bon exprimés comme ses prix convenus (HT par défaut) ; « tarif » = le prix convenu prime
      const acc = a.p_account ? await ctx.db.prepare('SELECT id, prices_ht FROM accounts WHERE id = ? AND company_id = ?').bind(String(a.p_account), ctx.company.id).first() : null;
      if (a.p_account && !acc) fail('unknown_account', 404);
      if (acc) {
        const priced = a.p_prices === 'tariff'
          ? new Set((await ctx.db.prepare('SELECT product_id FROM account_prices WHERE account_id = ? AND company_id = ?').bind(acc.id, ctx.company.id).all()).results.map((x) => x.product_id))
          : new Set();
        for (const it of items) {
          const doc = it.unit_price_fcfa; delete it.unit_price_fcfa;
          if (it.product_id && priced.has(it.product_id)) continue;      // le prix convenu s'applique
          if (doc != null) it[acc.prices_ht ? 'unit_price_ht' : 'unit_price_fcfa'] = doc;
        }
      }
      const [r] = await createOrders(ctx, [{
        account_id: acc?.id,
        external_ref: data.order_number ? `${scopeOf(d.sender) || 'bon'}:${data.order_number}` : `doc:${d.id}`,
        customer: { name: text(c.name, 80) ?? data.customer?.store ?? data.customer?.name, phone: text(c.phone, 30) ?? data.customer?.phone,
          address: text(c.address, 200) ?? data.delivery_place ?? data.customer?.address },
        zone: a.p_zone, items,
        payment_method: ['cod', 'prepaid', 'account'].includes(a.p_payment_method) ? a.p_payment_method : data.payment_terms_days != null ? 'account' : undefined,
        payment_terms_days: a.p_terms_days ?? data.payment_terms_days ?? undefined,
        promised_at: a.p_promised_at ?? data.delivery_date ?? undefined,
        note: `Bon ${data.order_number ?? ''} lu par l'IA (${d.filename ?? 'document'})${data.delivery_date ? ` · livraison impérative ${data.delivery_date}` : ''}`.trim(),
      }], 'manual');
      if (!r.ok) return { ok: false, error: r.error };
      await ctx.db.prepare("UPDATE inbox_documents SET status = 'converted', order_id = ?, reviewed_by = ?, updated_at = ? WHERE id = ? AND company_id = ?")
        .bind(r.id, ctx.user.id, ctx.now, d.id, ctx.company.id).run();
      await audit(ctx, 'inbox_convert', 'inbox_document', d.id, { order: r.number, duplicate: Boolean(r.duplicate) });
      return { ok: true, order_id: r.id, number: r.number, duplicate: Boolean(r.duplicate) };
    },
  },

  lg_inbox_reject: {
    roles: 'member',
    async handler(ctx, a) {
      view(ctx);
      const r = await ctx.db.prepare("UPDATE inbox_documents SET status = 'rejected', error = ?, reviewed_by = ?, updated_at = ? WHERE id = ? AND company_id = ? AND status <> 'converted'")
        .bind(text(a.p_reason, 200) ?? 'écarté', ctx.user.id, ctx.now, String(a.p_id ?? ''), ctx.company.id).run();
      if (!r.meta.changes) fail('unknown_document', 404);
      return { ok: true };
    },
  },

  // Données extraites d'une période, pour l'export Excel (une ligne par document, colonnes par produit côté écran).
  lg_inbox_export: {
    roles: 'member',
    async handler(ctx, a) {
      view(ctx);
      const since = a.p_from ? `${a.p_from}T00:00:00.000Z` : new Date(Date.parse(ctx.now) - 31 * 86400000).toISOString();
      const until = a.p_to ? `${a.p_to}T23:59:59.999Z` : ctx.now;
      const r = await ctx.db.prepare(`SELECT id, sender, filename, status, received_at, data FROM inbox_documents WHERE company_id = ? AND received_at BETWEEN ? AND ?
          AND status IN ('to_review', 'converted', 'done') ORDER BY received_at`).bind(ctx.company.id, since, until).all();
      return r.results.map((d) => ({ id: d.id, sender: d.sender, filename: d.filename, status: d.status, received_at: d.received_at, data: parseJson(d.data, null) }));
    },
  },

  // ----------------------------------------------------------------- modèles d'extraction
  lg_extraction_templates_list: {
    roles: 'member',
    async handler(ctx) {
      view(ctx);
      return (await ctx.db.prepare('SELECT * FROM extraction_templates WHERE company_id = ? ORDER BY active DESC, name').bind(ctx.company.id).all()).results.map(tpl);
    },
  },

  lg_extraction_template_upsert: {
    roles: 'member',
    async handler(ctx, a) {
      if (!ctx.isAdmin && !hasRole(ctx, ['support', 'dock_chief'])) fail('forbidden', 403);
      const p = a.p && typeof a.p === 'object' ? a.p : {};
      const name = text(p.name, 80);
      if (!name) fail('invalid_name');
      const kind = KINDS.includes(p.kind) ? p.kind : 'order';
      const vals = [name, kind, text(p.sender_match, 120), JSON.stringify(fieldList(p.fields)), JSON.stringify(fieldList(p.line_fields)), text(p.instructions, 2000), p.active === false ? 0 : 1];
      if (p.id) {
        const r = await ctx.db.prepare('UPDATE extraction_templates SET name = ?, kind = ?, sender_match = ?, fields = ?, line_fields = ?, instructions = ?, active = ?, updated_at = ? WHERE id = ? AND company_id = ?')
          .bind(...vals, ctx.now, String(p.id), ctx.company.id).run();
        if (!r.meta.changes) fail('unknown_template', 404);
        return { ok: true, id: p.id };
      }
      const id = uuid();
      await ctx.db.prepare('INSERT INTO extraction_templates (id, company_id, name, kind, sender_match, fields, line_fields, instructions, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, ctx.company.id, ...vals).run();
      return { ok: true, id };
    },
  },

  // Correspondances apprises (EAN, référence, libellé d'un client → produit) : liste et suppression.
  lg_product_aliases_list: {
    roles: 'member',
    async handler(ctx) {
      view(ctx);
      return (await ctx.db.prepare(`SELECT a.alias, a.scope, a.units_per_case, a.created_at, p.id AS product_id, p.name AS product FROM product_aliases a
          JOIN products p ON p.id = a.product_id WHERE a.company_id = ? ORDER BY a.scope, p.name, a.alias LIMIT 2000`).bind(ctx.company.id).all()).results;
    },
  },
  lg_product_alias_delete: {
    roles: 'member',
    async handler(ctx, a) {
      view(ctx);
      await ctx.db.prepare('DELETE FROM product_aliases WHERE company_id = ? AND alias = ? AND scope = ?').bind(ctx.company.id, String(a.p_alias ?? ''), String(a.p_scope ?? '')).run();
      return { ok: true };
    },
  },
};
