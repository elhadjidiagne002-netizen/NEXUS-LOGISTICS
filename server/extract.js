// Moteur de collecte (cycle D1) : document → texte → données structurées → lignes rapprochées du catalogue.
// Généralisation du script d'extraction MINAM (IMAP + PyPDF2 + expressions régulières) : n'importe quel format,
// n'importe quels champs (modèle d'extraction), sans mot de passe de messagerie.
//  1. texte : Workers AI toMarkdown (PDF, Excel, Word, images ; liaison AI) ; texte brut / CSV / HTML lus ici ;
//  2. lecture : Groq (GROQ_API_KEY, gratuit), repli Workers AI (Llama 3.3) — réponse JSON imposée, température 0 ;
//  3. rapprochement : correspondances apprises (product_aliases), puis EAN / référence / nom exact du catalogue.
// L'IA n'invente rien côté catalogue : elle lit le document ; le rapprochement est fait en code, et un humain valide.

export const MAX_TEXT = 24000;          // caractères envoyés à l'IA (un bon de commande tient en 2 à 6 000)
export const GROQ_MODEL = 'llama-3.3-70b-versatile';
export const CF_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const DOC_TYPES = ['application/pdf', 'text/plain', 'text/csv', 'text/html', 'image/jpeg', 'image/png', 'image/webp',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.oasis.opendocument.spreadsheet'];

/** Type d'un fichier d'après son nom quand l'e-mail ne le précise pas (« application/octet-stream »). */
export function guessType(filename, given) {
  const ext = String(filename ?? '').toLowerCase().split('.').pop();
  const byExt = { pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', htm: 'text/html', html: 'text/html', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    png: 'image/png', webp: 'image/webp', xlsx: DOC_TYPES[7], xls: DOC_TYPES[8], docx: DOC_TYPES[9], ods: DOC_TYPES[10] };
  const g = String(given ?? '').split(';')[0].trim().toLowerCase();
  return DOC_TYPES.includes(g) ? g : byExt[ext] ?? g;
}

const htmlToText = (h) => String(h).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
  .replace(/<\/t[dh]>/gi, '\t').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');

/** Texte d'un document. `bytes` : Uint8Array. Lève une erreur codée si le format n'est pas lisible. */
export async function documentToText(env, { filename, contentType, bytes }) {
  const type = guessType(filename, contentType);
  if (type.startsWith('text/')) {
    const t = new TextDecoder('utf-8').decode(bytes);
    return (type === 'text/html' ? htmlToText(t) : t).trim();
  }
  if (!DOC_TYPES.includes(type)) throw Object.assign(new Error('unsupported_type'), { code: 'unsupported_type' });
  if (!env.AI?.toMarkdown) throw Object.assign(new Error('no_converter'), { code: 'no_converter' });
  const [r] = await env.AI.toMarkdown([{ name: filename || 'document', blob: new Blob([bytes], { type }) }]);
  if (!r || r.format === 'error' || !r.data) throw Object.assign(new Error(r?.error || 'conversion_failed'), { code: 'conversion_failed' });
  return String(r.data).trim();
}

/** Appel au modèle de langue avec réponse JSON. Groq d'abord (si la clé existe), sinon Workers AI. */
export async function llmJson(env, system, user, { fetchImpl = fetch } = {}) {
  let raw;
  if (env.GROQ_API_KEY) {
    const r = await fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { authorization: `Bearer ${env.GROQ_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: env.GROQ_MODEL || GROQ_MODEL, temperature: 0, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) throw Object.assign(new Error(`groq_${r.status}`), { code: r.status === 429 ? 'ai_busy' : 'ai_failed' });
    raw = (await r.json())?.choices?.[0]?.message?.content;
  } else if (env.AI?.run) {
    const r = await env.AI.run(CF_MODEL, { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0, max_tokens: 4096,
      response_format: { type: 'json_object' } });
    raw = typeof r?.response === 'string' ? r.response : JSON.stringify(r?.response ?? '');
  } else {
    throw Object.assign(new Error('no_ai'), { code: 'no_ai' });
  }
  return parseJsonLoose(raw);
}

/** JSON d'une réponse de modèle (tolère ```json … ``` et du texte autour). */
export function parseJsonLoose(raw) {
  const s = String(raw ?? '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try { return JSON.parse(s); } catch { /* on tente le premier objet complet */ }
  const i = s.indexOf('{'); const j = s.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return JSON.parse(s.slice(i, j + 1)); } catch { /* illisible */ } }
  throw Object.assign(new Error('ai_bad_json'), { code: 'ai_bad_json' });
}

const KIND_LABEL = { order: 'un bon de commande reçu d\'un client', invoice: 'une facture', delivery_note: 'un bon de livraison', price_list: 'une liste de prix', custom: 'un document' };

/** Consignes données à l'IA pour un modèle d'extraction (champs standard + champs propres à l'entreprise). */
export function buildPrompt(template, { companyName = null } = {}) {
  const fields = Array.isArray(template?.fields) ? template.fields : [];
  const lineFields = Array.isArray(template?.line_fields) ? template.line_fields : [];
  const extra = (list) => list.map((f) => `"${f.key}": ${f.type === 'number' ? 'nombre' : f.type === 'date' ? '"AAAA-MM-JJ"' : 'texte'}  // ${f.label ?? f.key}`).join(',\n      ');
  const system = `Tu extrais des données de documents commerciaux (Sénégal, Afrique de l'Ouest, montants en francs CFA sauf mention contraire).
Le document est ${KIND_LABEL[template?.kind] ?? KIND_LABEL.order}. Réponds UNIQUEMENT par un objet JSON valide, sans commentaire.
Règles : recopie les valeurs telles qu'elles figurent dans le document ; n'invente rien (null si absent) ; dates au format AAAA-MM-JJ
(le document écrit souvent JJ/MM/AAAA) ; nombres sans espace ni symbole (1 250,50 → 1250.5) ; une entrée dans "lines" par ligne
d'article ; "cases" = nombre de colis/cartons, "units_per_case" = unités par colis (PCB, UVC par colis), "quantity" = quantité totale
en unités si elle est écrite (souvent suivie de « Ar », « UVC » ou « U » : 144Ar = 144 unités) ; "unit_price" = prix unitaire HT ;
"vat_rate" = taux de TVA en % ; "confidence" entre 0 et 1 = ta certitude sur l'ensemble.${companyName ? `
Le document est adressé à « ${companyName} » (le fournisseur, qui utilise ce logiciel) : ce n'est JAMAIS le client, et l'adresse,
le téléphone et l'e-mail du bloc « Destinataire » / « Fournisseur » sont les siens : ne les mets pas dans "customer". Le client est
l'émetteur du bon (enseigne, magasin, entreprise qui commande) ; "delivery_place" = le magasin ou site à livrer.` : ''}
Attention : le texte vient d'un PDF et des valeurs voisines peuvent être COLLÉES sans espace (« 15/08/202223716 » = la date
15/08/2022 suivie du nombre 23716 ; « SURGELES21 » = « SURGELES » et « 21 ») : sépare-les, et recopie chaque numéro exactement.${template?.instructions ? `\nConsignes de l'entreprise : ${template.instructions}` : ''}`;
  const schema = `{
  "document_type": "commande | facture | bon de livraison | liste de prix | autre",
  "customer": { "name": texte, "store": texte, "address": texte, "phone": texte, "email": texte },
  "supplier": { "name": texte, "address": texte, "phone": texte, "email": texte },   // destinataire du bon (le fournisseur)
  "order_number": texte, "order_date": "AAAA-MM-JJ", "delivery_date": "AAAA-MM-JJ", "delivery_place": texte,
  "currency": texte, "total_ht": nombre, "total_ttc": nombre, "vat_rate": nombre,
  "fields": {${fields.length ? `\n      ${extra(fields)}\n    ` : ''}},
  "lines": [ { "ref": texte, "ean": texte, "label": texte, "cases": nombre, "units_per_case": nombre, "quantity": nombre,
               "unit_price": nombre, "vat_rate": nombre, "extra": {${lineFields.length ? ` ${extra(lineFields)} ` : ''}} } ],
  "notes": texte, "confidence": nombre
}`;
  return { system, schema };
}

/** Normalisation d'un code ou d'un libellé pour le rapprochement (majuscules, sans accents, espaces simples). */
export const normAlias = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
/** Portée d'une correspondance : le domaine de l'expéditeur (auchan.sn), sinon tout le monde. */
export const scopeOf = (sender) => String(sender ?? '').toLowerCase().match(/@([a-z0-9.-]+)/)?.[1] ?? '';

const num = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/\s| /g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/**
 * Données propres + lignes rapprochées. products : [{id, name, sku, barcode}] ; aliases : [{alias, scope, product_id, units_per_case}].
 * Chaque ligne reçoit product_id et `match` : alias | ean | ref | name | null (à choisir à la main).
 */
export function normalizeExtraction(raw, { products = [], aliases = [], scope = '', sourceText = null, own = {} } = {}) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const byAlias = new Map();
  for (const a of aliases) { const k = `${a.scope}|${a.alias}`; byAlias.set(k, a); }
  const findAlias = (k) => (k ? byAlias.get(`${scope}|${k}`) ?? byAlias.get(`|${k}`) : null);
  const byEan = new Map(products.filter((p) => p.barcode).map((p) => [normAlias(p.barcode), p]));
  const byRef = new Map(products.filter((p) => p.sku).map((p) => [normAlias(p.sku), p]));
  const byName = new Map(products.map((p) => [normAlias(p.name), p]));
  const lines = (Array.isArray(d.lines) ? d.lines : []).slice(0, 200).map((l) => {
    const ean = l?.ean != null ? String(l.ean).replace(/\D/g, '') || null : null;
    const ref = l?.ref != null && String(l.ref).trim() ? String(l.ref).trim() : null;
    const label = l?.label != null ? String(l.label).trim() : null;
    const cases = num(l?.cases); const upc = num(l?.units_per_case);
    let product = null; let match = null; let learnedUpc = null;
    for (const k of [ean, ref, label].map((x) => (x ? normAlias(x) : null))) {
      const a = findAlias(k);
      if (a) { product = products.find((p) => p.id === a.product_id) ?? { id: a.product_id }; match = 'alias'; learnedUpc = a.units_per_case; break; }
    }
    if (!product && ean && byEan.has(normAlias(ean))) { product = byEan.get(normAlias(ean)); match = 'ean'; }
    if (!product && ref && byRef.has(normAlias(ref))) { product = byRef.get(normAlias(ref)); match = 'ref'; }
    if (!product && label && byName.has(normAlias(label))) { product = byName.get(normAlias(label)); match = 'name'; }
    const unitsPerCase = upc ?? learnedUpc ?? null;
    const quantity = num(l?.quantity) ?? (cases != null && unitsPerCase != null ? cases * unitsPerCase : cases);
    return { ref, ean, label, cases, units_per_case: unitsPerCase, quantity, unit_price: num(l?.unit_price), vat_rate: num(l?.vat_rate),
      extra: l?.extra && typeof l.extra === 'object' ? l.extra : {}, product_id: product?.id ?? null, product_name: product?.name ?? null, match };
  });
  const date = (v) => { const s = String(v ?? '').trim(); const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? `${m[3]}-${m[2]}-${m[1]}` : /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };
  const str = (v, n = 200) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, n));
  const c = d.customer && typeof d.customer === 'object' ? d.customer : {};
  const out = {
    document_type: str(d.document_type, 40),
    customer: { name: str(c.name, 120), store: str(c.store, 120), address: str(c.address), phone: str(c.phone, 40), email: str(c.email, 120) },
    order_number: str(d.order_number, 60), order_date: date(d.order_date), delivery_date: date(d.delivery_date), delivery_place: str(d.delivery_place),
    currency: str(d.currency, 10), total_ht: num(d.total_ht), total_ttc: num(d.total_ttc), vat_rate: num(d.vat_rate),
    fields: d.fields && typeof d.fields === 'object' ? d.fields : {}, lines, notes: str(d.notes, 1000),
    confidence: Math.max(0, Math.min(1, num(d.confidence) ?? 0)),
    matched: lines.filter((l) => l.product_id).length,
    // contrôle : somme des lignes (quantité × prix) face au total écrit sur le document (écart > 1 %)
    lines_total: lines.every((l) => l.quantity != null && l.unit_price != null) && lines.length ? Math.round(lines.reduce((t, l) => t + l.quantity * l.unit_price, 0)) : null,
  };
  const written = out.total_ht ?? out.total_ttc;
  out.total_mismatch = out.lines_total != null && written != null && Math.abs(out.lines_total - written) > Math.max(1, written * 0.01);

  // Garde-fous contre les erreurs de l'IA (constatées sur un vrai bon : n° de commande mal découpé, coordonnées du
  // fournisseur prises pour celles du client). Une valeur clé qui ne figure pas dans le document est signalée.
  const warnings = [];
  if (sourceText) {
    const hay = String(sourceText).replace(/\s+/g, '').toUpperCase();
    const inDoc = (v) => hay.includes(String(v).replace(/\s+/g, '').toUpperCase());
    if (out.order_number && !inDoc(out.order_number)) { warnings.push('order_number'); out.order_number_suspect = true; }
    for (const l of lines) {
      l.check = (l.ean ? inDoc(l.ean) : true) && (l.ref ? inDoc(l.ref) : true);
      if (!l.check) warnings.push(`line:${l.ref ?? l.ean ?? l.label}`);
    }
  }
  // coordonnées de l'entreprise elle-même : jamais celles du client
  const digits = (v) => String(v ?? '').replace(/\D/g, '').slice(-9);
  const ownPhones = new Set((own.phones ?? []).map(digits).filter((x) => x.length >= 7));
  const ownEmails = new Set((own.emails ?? []).map((e) => String(e).toLowerCase()));
  const cu = out.customer;
  // tout ce que l'IA a rangé dans le bloc fournisseur (destinataire du bon) ne peut pas être au client
  const sup = d.supplier && typeof d.supplier === 'object' ? d.supplier : {};
  for (const k of ['address', 'phone', 'email']) if (cu[k] && sup[k] && normAlias(cu[k]) === normAlias(sup[k])) cu[k] = null;
  if (sup.phone) ownPhones.add(digits(sup.phone));
  // adresse écrite juste après le nom de l'entreprise elle-même dans le document = la sienne (bloc « Destinataire »)
  if (cu.address && sourceText) {
    const t = normAlias(sourceText); const a = normAlias(cu.address).slice(0, 14);
    const names = [own.name, sup.name].filter(Boolean).map(normAlias).filter((x) => x.length >= 3);
    const at = a ? t.indexOf(a) : -1;
    if (at >= 0 && names.some((nm) => { const i = t.lastIndexOf(nm, at); return i >= 0 && at - i <= 120; })) cu.address = null;
  }
  if (cu.phone && ownPhones.has(digits(cu.phone))) cu.phone = null;
  if (cu.email && ownEmails.has(cu.email.toLowerCase())) { cu.email = null; cu.address = null; }
  if (own.name && cu.name && normAlias(cu.name).includes(normAlias(own.name))) { cu.name = out.delivery_place ?? null; warnings.push('customer'); }
  out.warnings = warnings;
  return out;
}
