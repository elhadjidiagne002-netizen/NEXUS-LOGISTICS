// Import de commandes par fichier (gabarit CSV de l'écran Service client → Commandes).

/** Lecture du CSV (séparateur ; ou ,, guillemets) → une commande par référence (plusieurs lignes = plusieurs articles). */
export function parseOrdersCsv(textIn) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  const sep = (textIn.split(/\r?\n/)[0].match(/;/g) || []).length >= (textIn.split(/\r?\n/)[0].match(/,/g) || []).length ? ';' : ',';
  const t = textIn.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (quoted) { if (ch === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch; }
    else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = (rows.shift() ?? []).map((h) => h.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '_'));
  const get = (r, k) => (r[head.indexOf(k)] ?? '').trim();
  const nb = (v) => (v === '' ? null : Number(v.replace(/\s/g, '').replace(',', '.')));
  const orders = new Map();
  rows.filter((r) => r.some((x) => x.trim())).forEach((r, i) => {
    const ref = get(r, 'reference') || `ligne-${i + 2}`;
    let o = orders.get(ref);
    if (!o) {
      const pay = get(r, 'paiement').toLowerCase();
      o = { external_ref: get(r, 'reference') || null, customer: { name: get(r, 'client'), phone: get(r, 'telephone'), address: get(r, 'adresse') || null, landmark: get(r, 'repere') || null },
        zone: get(r, 'zone'), items: [], payment_method: /pay|avance|prepa|wave|orange|om/.test(pay) && !/livraison/.test(pay) ? 'prepaid' : 'cod',
        delivery_fee_fcfa: nb(get(r, 'frais_livraison')), note: get(r, 'note') || null, _line: i + 2 };
      orders.set(ref, o);
    }
    const kgv = nb(get(r, 'poids_kg'));
    o.items.push({ name: get(r, 'article'), quantity: nb(get(r, 'quantite')) ?? 1, unit_price_fcfa: nb(get(r, 'prix_unitaire')) ?? 0, weight_g: kgv ? Math.round(kgv * 1000) : null });
  });
  return [...orders.values()];
}

