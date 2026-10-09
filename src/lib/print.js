// Impression depuis le navigateur (P1) : étiquette A6 avec QR, bordereau de chargement,
// facture, reçu de caisse. Le QR ne contient QUE le code colis (rien de personnel).
import QRCode from 'qrcode';
import { formatF } from './algo.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dt = (d) => d ? new Date(d).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Dakar' }) : '';
const day10 = (d) => (d ? new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Africa/Dakar' }) : '');

function open(title, css, body) {
  const w = window.open('', '_blank', 'width=820,height=900');
  if (!w) { alert('Autorisez les fenêtres pour imprimer.'); return; }
  w.document.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${esc(title)}</title>
  <style>*{box-sizing:border-box}body{font-family:system-ui,Arial,sans-serif;margin:0;color:#000}${css}</style></head>
  <body>${body}<script>window.onload=()=>setTimeout(()=>window.print(),250)<\/script></body></html>`);
  w.document.close();
}

/** Étiquettes A6 (annexe C) : zone en très gros, code lisible pour la saisie de secours. */
export async function printLabels(labels) {
  const pages = await Promise.all(labels.map(async (l) => {
    const qr = await QRCode.toDataURL(l.code, { margin: 1, width: 300, errorCorrectionLevel: 'M' });
    const kg = l.weight_g ? (l.weight_g / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' kg' : '';
    const hand = (l.handling ?? []).map((h) => h.toUpperCase()).join(' · ');
    return `<section class="lbl">
      <div class="zone">${esc(l.zone)}</div>
      <div class="mid"><img src="${qr}" alt=""><div>
        <div class="code">${esc(l.code)}</div><div class="n">colis ${l.seq} / ${l.count}</div>
        <div>Commande ${esc(l.order_short)}${l.quarter ? ' · ' + esc(l.quarter) : ''}</div>
        <div class="b">${esc(kg)}${hand ? ' · ' + esc(hand) : ''}${l.cod ? ' · À ENCAISSER' : ''}</div></div></div>
      <div class="foot">Préparé le ${dt(l.packed_at)}${l.hub ? ' · ' + esc(l.hub) : ''} · ${esc(l.company ?? 'NEXUS LOGISTICS')}</div></section>`;
  }));
  open('Étiquettes', `@page{size:105mm 148mm;margin:5mm}.lbl{height:138mm;display:flex;flex-direction:column;gap:4mm;page-break-after:always;border:1px solid #000;padding:4mm}
  .zone{font-size:30pt;font-weight:900;text-transform:uppercase;border-bottom:3px solid #000;padding-bottom:2mm;line-height:1}
  .mid{display:flex;gap:4mm;align-items:center}.mid img{width:42mm;height:42mm}.code{font:800 17pt ui-monospace,Consolas,monospace}
  .n{font-size:15pt;font-weight:800;margin:1mm 0}.b{font-weight:800;margin-top:2mm}.foot{margin-top:auto;font-size:8pt;color:#333}`, pages.join(''));
}

/** Bordereau de chargement signé (module 03). */
export function printManifest(v) {
  const rows = v.stops.map((s) => `<tr><td>${s.seq}</td><td>${esc(s.contact_name)}<br><small>${esc(s.zone ?? '')} · ${esc(s.landmark ?? '')}</small></td>
    <td>${s.packages.map((p) => `<span class="m">${esc(p.code)}</span> ${esc(p.load_zone ?? '')}`).join('<br>')}</td>
    <td class="r">${s.cod_due_fcfa ? formatF(s.cod_due_fcfa) : '—'}</td><td class="box"></td><td class="box"></td></tr>`).join('');
  open(`Bordereau voyage ${v.trip.number}`, `@page{size:A4;margin:12mm}h1{font-size:18pt;margin:0}table{width:100%;border-collapse:collapse;margin-top:8mm;font-size:10pt}
  td,th{border:1px solid #000;padding:2mm;vertical-align:top}.r{text-align:right}.m{font-family:ui-monospace,Consolas,monospace}.box{width:14mm}
  .sig{display:flex;gap:10mm;margin-top:10mm}.sig div{flex:1;border-top:1px solid #000;padding-top:2mm;font-size:9pt}`,
  `<h1>Bordereau de chargement — voyage n° ${v.trip.number}</h1>
   <p>${esc(v.trip.label ?? '')} · ${esc(v.vehicle.kind)} ${esc(v.vehicle.plate)} · chauffeur : <b>${esc(v.courier?.name ?? '—')}</b><br>
   Départ prévu : ${dt(v.trip.planned_departure)} · ${v.gauge.count} colis · ${(v.gauge.weight_g / 1000).toFixed(1)} kg · à encaisser : <b>${formatF(v.trip.cod_expected_fcfa)}</b></p>
   <table><thead><tr><th>#</th><th>Client</th><th>Colis · position</th><th>À encaisser</th><th>Livré</th><th>Échec</th></tr></thead><tbody>${rows}</tbody></table>
   <p style="font-size:9pt">En cas de panne de l'application : cocher l'issue de chaque arrêt ; le chef de quai saisira les issues au retour (saisie notée manuelle).</p>
   <div class="sig"><div>Chef de quai</div><div>Chauffeur — je prends en charge les colis ci-dessus</div></div>`);
}

/** Facture ou avoir (module 02) : document figé, mentions du chapitre 11. */
export function printInvoice(inv) {
  const m = inv.metadata ?? {};
  const credit = !!inv.credit_of;
  const lines = (inv.lines ?? []).map((l) => `<tr><td>${esc(l.label)}</td><td class="r">${l.quantity}</td>
    <td class="r">${Number(l.unit_price_ht).toLocaleString('fr-FR', { minimumFractionDigits: 2 })}</td><td class="r">${l.tva_rate} %</td>
    <td class="r">${Number(l.total_ht).toLocaleString('fr-FR', { minimumFractionDigits: 2 })}</td></tr>`).join('');
  open(inv.invoice_number, `@page{size:A4;margin:14mm}body{font-size:10.5pt}.top{display:flex;justify-content:space-between;gap:10mm}
  h1{font-size:20pt;margin:0 0 2mm}.box{border:1px solid #000;padding:3mm;flex:1}table{width:100%;border-collapse:collapse;margin-top:6mm}
  th,td{border-bottom:1px solid #999;padding:2mm;text-align:left}.r{text-align:right}.tot{width:70mm;margin-left:auto;margin-top:4mm}
  .tot div{display:flex;justify-content:space-between;padding:1mm 0}.tot .g{font-size:13pt;font-weight:800;border-top:2px solid #000}
  .foot{margin-top:10mm;font-size:8.5pt;color:#333}`,
  `<div class="top"><div><h1>${credit ? 'AVOIR' : 'FACTURE'} ${esc(inv.invoice_number)}</h1>
    <div>Date : ${dt(inv.issued_at ?? inv.created_at)}</div><div>Commande : ${esc(m.order_short ?? '')}</div>
    ${credit ? `<div>Avoir sur la facture ${esc(m.credit_of_number)} — ${esc(m.reason ?? '')}</div>` : ''}</div>
    <div style="text-align:right"><b>${esc(m.platform?.name ?? 'NEXUS Market')}</b><br>${esc(m.platform?.address ?? 'Dakar, Sénégal')}<br>${esc(m.platform?.phone ?? m.platform?.site ?? 'nexusmarket.sn')}</div></div>
   <div class="top" style="margin-top:6mm"><div class="box"><b>Vendeur</b><br>${esc(m.seller?.name)}<br>${esc(m.seller?.address ?? '')}<br>
     NINEA : ${esc(m.seller?.ninea ?? 'non communiqué')} · RC : ${esc(m.seller?.rc ?? '—')}<br>
     <small>${m.issuer_mode === 'company' ? `Facture émise par ${esc(m.seller?.name)}` : m.issuer_mode === 'nexus' ? 'Facture émise par NEXUS Market'
       : `Facture émise par ${esc(m.platform?.name ?? 'NEXUS Market')} au nom et pour le compte du vendeur`}</small></div>
    <div class="box"><b>Client</b><br>${esc(m.customer?.name)}<br>${esc(m.customer?.phone ?? '')}<br>${esc(m.customer?.address ?? '')}</div></div>
   <table><thead><tr><th>Désignation</th><th class="r">Qté</th><th class="r">P.U. HT</th><th class="r">TVA</th><th class="r">Total HT</th></tr></thead><tbody>${lines}</tbody></table>
   <div class="tot"><div><span>Total HT</span><b>${formatF(inv.amount_ht)}</b></div><div><span>TVA</span><b>${formatF(inv.tva)}</b></div>
    <div class="g"><span>Total TTC</span><span>${formatF(inv.amount_ttc)}</span></div></div>
   <p><i>${esc(m.amount_words ?? '')}</i></p>
   <p>Paiement : ${esc({ cod: 'à la livraison', prepaid: "payée d'avance", account: `à terme, ${m.payment_terms_days ?? ''} jours`, mobile: 'mobile (PayTech)', card: 'carte' }[m.payment_method] ?? m.payment_method ?? '')}${m.payment_ref ? ' · réf. ' + esc(m.payment_ref) : ''}</p>
   ${m.payment_method === 'account' && !credit ? `<p><b>${inv.settlement?.paid ? `Réglée le ${day10(inv.settlement.paid_at)}` : `À régler avant le ${day10(m.due_at)}`}</b>${m.customer_ref ? ` · Votre bon de commande n° ${esc(m.customer_ref)}` : ''}</p>` : ''}
   <div class="foot">Document non modifiable. Toute correction fait l'objet d'un avoir numéroté. Montants en francs CFA.</div>`);
}

export function printReceipt(text, title = 'Reçu') {
  open(title, '@page{size:80mm auto;margin:4mm}body{font:11pt ui-monospace,Consolas,monospace}', `<pre style="white-space:pre-wrap">${esc(text)}</pre>`);
}

/** Bon de commande fournisseur (achats de réassort) : à imprimer, signer ou enregistrer en PDF. */
export function printPurchaseOrder(po) {
  const c = po.company ?? {}; const s = po.supplier ?? {};
  const lines = (po.lines ?? []).map((l) => `<tr><td>${esc(l.name)}${l.sku ? `<br><small>${esc(l.sku)}</small>` : ''}</td><td class="r">${l.qty_ordered}</td>
    <td class="r">${formatF(l.unit_cost_fcfa)}</td><td class="r">${formatF(l.qty_ordered * l.unit_cost_fcfa)}</td></tr>`).join('');
  const day = (d) => (d ? d.split('-').reverse().join('/') : '');
  open(po.number, `@page{size:A4;margin:14mm}body{font-size:10.5pt}.top{display:flex;justify-content:space-between;gap:10mm}
  h1{font-size:20pt;margin:0 0 2mm}.box{border:1px solid #000;padding:3mm;flex:1}table{width:100%;border-collapse:collapse;margin-top:6mm}
  th,td{border-bottom:1px solid #999;padding:2mm;text-align:left}.r{text-align:right}.tot{width:70mm;margin-left:auto;margin-top:4mm;font-size:13pt;font-weight:800;
  display:flex;justify-content:space-between;border-top:2px solid #000;padding-top:2mm}.sig{display:flex;gap:10mm;margin-top:14mm}.sig div{flex:1;border-top:1px solid #000;padding-top:2mm;font-size:9pt}`,
  `<div class="top"><div><h1>BON DE COMMANDE</h1><div><b>${esc(po.number)}</b></div><div>Date : ${dt(po.created_at)}</div>
    ${po.expected_on ? `<div>Livraison souhaitée : <b>${day(po.expected_on)}</b></div>` : ''}</div>
    <div style="text-align:right"><b>${esc(c.name)}</b><br>${esc(c.address ?? c.city ?? '')}<br>${esc(c.phone ?? '')}
      ${c.ninea ? `<br>NINEA : ${esc(c.ninea)}` : ''}${c.rc ? ` · RC : ${esc(c.rc)}` : ''}</div></div>
   <div class="top" style="margin-top:6mm"><div class="box"><b>Fournisseur</b><br>${esc(s.name)}${s.contact_name ? `<br>${esc(s.contact_name)}` : ''}
     ${s.phone ? `<br>${esc(s.phone)}` : ''}${s.email ? `<br>${esc(s.email)}` : ''}${s.address ? `<br>${esc(s.address)}` : ''}</div>
     <div class="box"><b>Conditions</b><br>Paiement : ${esc(s.payment_terms ?? 'à convenir')}${po.note ? `<br>${esc(po.note)}` : ''}</div></div>
   <table><thead><tr><th>Article</th><th class="r">Quantité</th><th class="r">Prix unitaire</th><th class="r">Montant</th></tr></thead><tbody>${lines}</tbody></table>
   <div class="tot"><span>Total</span><span>${formatF(po.total_fcfa)}</span></div>
   <p style="font-size:9pt">Merci de rappeler le n° ${esc(po.number)} sur votre bon de livraison et votre facture. Montants en francs CFA.</p>
   <div class="sig"><div>Pour ${esc(c.name)}</div><div>Le fournisseur — bon pour accord</div></div>`);
}
