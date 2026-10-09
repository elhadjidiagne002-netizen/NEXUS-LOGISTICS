// Fichiers CSV (Excel) : lecture générique, gabarits et import des commandes et du catalogue, export.

/**
 * Lecture d'un CSV (séparateur ; ou , deviné sur la 1re ligne, guillemets, BOM d'Excel) → { head, rows } ;
 * en-têtes normalisés (minuscules, sans accents, espaces → _). Lignes vides ignorées.
 */
export function parseCsvRows(textIn) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  const first = textIn.split(/\r?\n/)[0];
  const sep = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? ';' : ',';
  const t = textIn.replace(/^\uFEFF/, '');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (quoted) { if (ch === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch; }
    else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = (rows.shift() ?? []).map((h) => h.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '_'));
  return { head, rows: rows.filter((r) => r.some((x) => x.trim())) };
}

/** Téléchargement d'un tableau au format Excel français (point-virgule, BOM UTF-8 pour les accents). */
export function downloadCsv(filename, lines) {
  const cell = (v) => { const s = v == null ? '' : String(v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\uFEFF' + lines.map((l) => l.map(cell).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  a.download = filename; a.click();
}

// Gabarit d'import du catalogue (Produits et stock → Importer). Colonnes reconnues, dans n'importe quel ordre.
export const PRODUCTS_TEMPLATE = 'nom;reference;code_barres;prix;poids_kg;stock;seuil_alerte;prix_achat;fournisseur\r\n'
  + 'Riz parfumé 5 kg;RIZ-5;6111000000017;5500;5;40;10;4800;Grossiste Sandaga\r\n'
  + 'Huile 1 L;HUI-1;;1500;1;24;6;;\r\n';

/** Lignes du catalogue → corps de lg_products_import (nombres laissés en texte : le serveur les vérifie). */
export function parseProductsCsv(textIn) {
  const { head, rows } = parseCsvRows(textIn);
  const col = (...names) => names.map((n) => head.indexOf(n)).find((i) => i >= 0) ?? -1;
  const c = { name: col('nom', 'produit', 'designation', 'article', 'name'), sku: col('reference', 'ref', 'sku'), barcode: col('code_barres', 'code-barres', 'codebarre', 'ean', 'barcode'),
    price: col('prix', 'prix_vente', 'prix_unitaire', 'price'), kg: col('poids_kg', 'poids'), stock: col('stock', 'quantite', 'qte'),
    min: col('seuil_alerte', 'seuil', 'stock_mini', 'stock_minimum'), cost: col('prix_achat', 'cout'), supplier: col('fournisseur', 'supplier') };
  const get = (r, i) => (i >= 0 ? (r[i] ?? '').trim() : '');
  return rows.map((r) => ({ name: get(r, c.name), sku: get(r, c.sku) || null, barcode: get(r, c.barcode) || null, price_fcfa: get(r, c.price),
    weight_kg: get(r, c.kg), stock: get(r, c.stock), min_stock: get(r, c.min), cost_fcfa: get(r, c.cost), supplier: get(r, c.supplier) || null }));
}

/** Lecture du CSV de commandes → une commande par référence (plusieurs lignes = plusieurs articles). */
const ON_ACCOUNT = /terme|jours?\b|facture|compte/;
export function parseOrdersCsv(textIn) {
  const { head, rows } = parseCsvRows(textIn);
  const get = (r, k) => (r[head.indexOf(k)] ?? '').trim();
  const nb = (v) => (v === '' ? null : Number(v.replace(/\s/g, '').replace(',', '.')));
  const orders = new Map();
  rows.forEach((r, i) => {
    const ref = get(r, 'reference') || `ligne-${i + 2}`;
    let o = orders.get(ref);
    if (!o) {
      const pay = get(r, 'paiement').toLowerCase();
      o = { external_ref: get(r, 'reference') || null, customer: { name: get(r, 'client'), phone: get(r, 'telephone'), address: get(r, 'adresse') || null, landmark: get(r, 'repere') || null },
        zone: get(r, 'zone'), items: [],
        // « à terme », « 30 jours », « facture » : à terme (le nombre de jours, s'il y en a un, est le délai)
        payment_method: ON_ACCOUNT.test(pay) ? 'account' : /pay|avance|prepa|wave|orange|om/.test(pay) && !/livraison/.test(pay) ? 'prepaid' : 'cod',
        payment_terms_days: ON_ACCOUNT.test(pay) && /\d+/.test(pay) ? Number(pay.match(/\d+/)[0]) : undefined,
        delivery_fee_fcfa: nb(get(r, 'frais_livraison')), note: get(r, 'note') || null, _line: i + 2 };
      orders.set(ref, o);
    }
    const kgv = nb(get(r, 'poids_kg'));
    o.items.push({ name: get(r, 'article'), quantity: nb(get(r, 'quantite')) ?? 1, unit_price_fcfa: nb(get(r, 'prix_unitaire')) ?? 0, weight_g: kgv ? Math.round(kgv * 1000) : null });
  });
  return [...orders.values()];
}

