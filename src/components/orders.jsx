// Version Cloudflare (cycle C2) — commandes saisies chez l'entreprise : liste, saisie au téléphone,
// import par fichier (gabarit CSV), catalogue logistique. Les commandes des boutiques en ligne arrivent
// aussi par l'API par clé (Administration → API).
import React, { useState } from 'react';
import { rpc } from '../lib/backend.js';
import { errText } from '../lib/errors.js';
import { parseOrdersCsv } from '../lib/csv.js';
import { useRpc, useAction, Btn, Card, Badge, Empty, Loading, ErrorBox, Modal, Field, Chips, formatF, dmy, hhmm, ago } from './ui.jsx';

const ST = { pending: ['À traiter', 'todo'], processing: ['En préparation', 'info'], in_transit: ['En route', 'info'], delivered: ['Livrée', 'ok'], cancelled: ['Annulée', ''] };
const SRC = { manual: 'saisie', csv: 'fichier', api: 'boutique en ligne' };
const OrderStatus = ({ s }) => <Badge kind={ST[s]?.[1] ?? ''}>{ST[s]?.[0] ?? s}</Badge>;
const IMPORT_MAX = 50;
const newEvent = () => crypto.randomUUID();

export function Orders() {
  const [status, setStatus] = useState('open'); const [q, setQ] = useState(''); const [query, setQuery] = useState('');
  const { data, error, loading, reload } = useRpc('lg_orders_list', { p_status: status, p_q: query || null }, { refresh: 30000 });
  const [modal, setModal] = useState(null);
  return <div className="stack">
    <div className="row between">
      <Chips options={[['open', 'En cours'], ['delivered', 'Livrées'], ['cancelled', 'Annulées'], ['all', 'Toutes']]} value={status} onChange={setStatus} />
      <div className="row"><Btn kind="primary" onClick={() => setModal({ kind: 'new' })}>＋ Nouvelle commande</Btn><Btn onClick={() => setModal({ kind: 'import' })}>Importer un fichier</Btn></div></div>
    <form className="row" onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}>
      <input className="input" style={{ flex: 1 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="N°, nom, téléphone ou référence boutique" />
      <Btn type="submit">Chercher</Btn></form>
    <ErrorBox error={error} />
    {loading && !data ? <Loading /> : !data?.length ? <Card><Empty>Aucune commande.</Empty></Card> : data.map((o) =>
      <Card key={o.id} kind={o.status === 'pending' && o.payment_method === 'cod' && !o.cod_confirmed_at ? 'todo' : ''}>
        <div className="row between"><div><b>n° {o.number}</b> · {o.customer} · {o.zone ?? '—'} <OrderStatus s={o.status} />
          <div className="small muted">{o.phone} · {formatF(o.total_fcfa)}{o.amount_due_fcfa ? ` · à encaisser ${formatF(o.amount_due_fcfa)}` : ' · payée'} · {SRC[o.source]}{o.external_ref ? ` ${o.external_ref}` : ''} · {ago(o.created_at)}</div>
          {o.promised_at && o.status !== 'delivered' && o.status !== 'cancelled' && <div className="small">promise le {dmy(o.promised_at)} avant {hhmm(o.promised_at)}</div>}</div>
          <Btn size="sm" onClick={() => setModal({ kind: 'detail', id: o.id })}>Ouvrir</Btn></div></Card>)}
    {modal?.kind === 'new' && <NewOrder onClose={() => setModal(null)} onDone={(r) => { setModal({ kind: 'detail', id: r.id }); reload(); }} />}
    {modal?.kind === 'import' && <ImportOrders onClose={() => setModal(null)} onDone={reload} />}
    {modal?.kind === 'detail' && <OrderDetail id={modal.id} onClose={() => { setModal(null); reload(); }} />}
  </div>;
}

function OrderDetail({ id, onClose }) {
  const { data: o, error, reload } = useRpc('lg_order_detail', { p_order: id });
  const [run, busy] = useAction();
  const [insure, setInsure] = useState('');
  return <Modal title={o ? `Commande n° ${o.number}` : 'Commande'} onClose={onClose}>{!o ? (error ? <ErrorBox error={error} /> : <Loading />) : <div className="stack">
    <div className="row between"><OrderStatus s={o.status} /><span className="small muted">{SRC[o.source]}{o.external_ref ? ` · réf. ${o.external_ref}` : ''} · {dmy(o.created_at)} {hhmm(o.created_at)}</span></div>
    <div><b>{o.customer}</b> · <a href={`tel:${o.phone}`}>{o.phone}</a><div className="small">{[o.zone, o.address, o.landmark].filter(Boolean).join(' · ')}</div>
      {o.recipient_name && <div className="small">Remise à : {o.recipient_name} ({o.recipient_phone})</div>}</div>
    <table className="tbl"><tbody>{o.items.map((x) => <tr key={x.id}><td>{x.quantity} × {x.product_name}</td><td className="num">{formatF(x.quantity * x.unit_price_fcfa)}</td></tr>)}
      {o.discount_fcfa > 0 && <tr><td>Remise</td><td className="num">− {formatF(o.discount_fcfa)}</td></tr>}
      <tr><td>Livraison ({o.service})</td><td className="num">{formatF(o.delivery_fee_fcfa)}</td></tr>
      {o.insurance_fee_fcfa > 0 && <tr><td>Assurance (valeur {formatF(o.insured_value_fcfa)})</td><td className="num">{formatF(o.insurance_fee_fcfa)}</td></tr>}
      <tr><td><b>Total</b></td><td className="num"><b>{formatF(o.total_fcfa)}</b></td></tr></tbody></table>
    <div className={`flash ${o.amount_due_fcfa ? 'todo' : 'ok'}`}>{o.amount_due_fcfa ? `À encaisser à la livraison : ${formatF(o.amount_due_fcfa)}` : 'Payée d\'avance : rien à encaisser.'}
      {o.payment_method === 'cod' && <span className="small">{o.cod_confirmed_at ? ` · confirmée le ${dmy(o.cod_confirmed_at)}` : ' · pas encore confirmée par le client'}</span>}</div>
    {o.note && <p className="small">Note : {o.note}</p>}
    <div className="row"><a className="btn sm" href={o.tracking_url} target="_blank" rel="noreferrer">Page de suivi ↗</a>
      <a className="btn sm" target="_blank" rel="noreferrer" href={`https://wa.me/${o.phone.replace(/\D/g, '')}?text=${encodeURIComponent(`Bonjour ${o.customer.split(' ')[0]}, suivez votre commande n° ${o.number} ici : ${o.tracking_url}`)}`}>Envoyer le lien (WhatsApp)</a>
      <Btn size="sm" onClick={() => navigator.clipboard?.writeText(o.tracking_url)}>Copier le lien</Btn></div>
    {['pending', 'processing'].includes(o.status) && <>
      {o.payment_method === 'cod' && !o.cod_confirmed_at && <Btn kind="ok" disabled={busy} onClick={() => run(async () => { const r = await rpc('lg_confirm_cod', { p_order: o.id, p_via: 'appel' }); reload(); return r; }, { ok: 'Commande confirmée' })}>Le client confirme</Btn>}
      <div className="row"><input className="input" style={{ flex: 1 }} inputMode="numeric" placeholder="Valeur à assurer (F)" value={insure} onChange={(e) => setInsure(e.target.value.replace(/\D/g, ''))} />
        <Btn disabled={busy || !insure} onClick={() => run(async () => { const r = await rpc('lg_order_insure', { p_order: o.id, p_value: Number(insure) }); setInsure(''); reload(); return r; }, { ok: 'Assurance enregistrée' })}>Assurer</Btn></div>
      <Btn kind="bad" disabled={busy} onClick={() => { if (confirm('Annuler cette commande ?')) run(async () => { const r = await rpc('lg_cancel_unconfirmed', { p_order: o.id, p_reason: 'Annulée par le service client' }); reload(); return r; }, { ok: 'Commande annulée' }); }}>Annuler la commande</Btn></>}
    {o.requests.length > 0 && <><h3>Demandes du client</h3>{o.requests.map((r) => <div key={r.id} className="small">{dmy(r.created_at)} · {r.kind} · {r.status}{r.payload?.message ? ` · ${r.payload.message}` : ''}</div>)}</>}
    <Btn size="sm" kind="ghost" onClick={() => { if (confirm(`Bannir le numéro ${o.phone} ? Ses prochaines commandes seront refusées.`)) run(async () => rpc('lg_ban_number', { p_phone: o.phone, p_reason: `Commande n° ${o.number}` }), { ok: 'Numéro banni' }); }}>Bannir ce numéro</Btn>
  </div>}</Modal>;
}

const emptyLine = () => ({ product_id: '', name: '', quantity: 1, unit_price_fcfa: '', weight_kg: '' });
function NewOrder({ onClose, onDone }) {
  const pricing = useRpc('lg_pricing', {});
  const products = useRpc('lg_products_list', {});
  const [c, setC] = useState({ name: '', phone: '', address: '', landmark: '' });
  const [f, setF] = useState({ zone: '', service: 'standard', payment_method: 'cod', fee: '', declared: '', note: '', vendor_name: '' });
  const [lines, setLines] = useState([emptyLine()]);
  const [quote, setQuote] = useState(null);
  const [event] = useState(newEvent);
  const [run, busy] = useAction();
  const items = lines.filter((l) => l.name.trim() || l.product_id).map((l) => ({ product_id: l.product_id || null, name: l.name.trim() || null,
    quantity: Number(l.quantity) || 0, unit_price_fcfa: l.unit_price_fcfa === '' ? null : Number(l.unit_price_fcfa),
    weight_g: l.weight_kg === '' ? null : Math.round(Number(String(l.weight_kg).replace(',', '.')) * 1000) }));
  const subtotal = items.reduce((s, x) => s + (x.unit_price_fcfa ?? 0) * x.quantity, 0);
  const weight = items.reduce((s, x) => s + (x.weight_g ?? 0) * x.quantity, 0) || 1000;
  const setLine = (i, k, v) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const pick = (i, id) => {
    const p = products.data?.find((x) => x.id === id);
    setLines(lines.map((l, j) => (j === i ? { ...l, product_id: id, name: p?.name ?? l.name, unit_price_fcfa: p ? String(p.price_fcfa) : l.unit_price_fcfa,
      weight_kg: p?.weight_g ? String(p.weight_g / 1000) : l.weight_kg } : l)));
  };
  const zones = pricing.data?.zones?.filter((z) => z.served) ?? [];
  const doQuote = async () => setQuote(await rpc('lg_quote', { p_zone: f.zone, p_weight_g: weight, p_subtotal_fcfa: subtotal, p_service: f.service,
    p_declared_value_fcfa: f.declared ? Number(f.declared) : null }).catch((e) => ({ ok: false, error: e.code })));
  return <Modal title="Nouvelle commande" onClose={onClose}><div className="stack">
    <div className="grid cols-2">
      <Field label="Client"><input className="input" value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} /></Field>
      <Field label="Téléphone"><input className="input" inputMode="tel" value={c.phone} onChange={(e) => setC({ ...c, phone: e.target.value })} /></Field>
      <Field label="Adresse"><input className="input" value={c.address} onChange={(e) => setC({ ...c, address: e.target.value })} /></Field>
      <Field label="Repère (« en face de la pharmacie »)"><input className="input" value={c.landmark} onChange={(e) => setC({ ...c, landmark: e.target.value })} /></Field></div>
    <Field label="Zone de livraison">{pricing.error ? <ErrorBox error={pricing.error} /> : <select className="input" value={f.zone} onChange={(e) => { setF({ ...f, zone: e.target.value }); setQuote(null); }}>
      <option value="">— choisir —</option>{zones.map((z) => <option key={z.name}>{z.name}</option>)}</select>}</Field>
    {pricing.data && !zones.length && <p className="small muted">Aucune zone : ajoutez-les dans Administration → Tarifs et zones.</p>}
    <h3 style={{ margin: 0 }}>Articles</h3>
    {lines.map((l, i) => <div key={i} className="grid cols-3">
      {products.data?.length > 0 && <select className="input" value={l.product_id} onChange={(e) => pick(i, e.target.value)}><option value="">article libre…</option>
        {products.data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
      <input className="input" placeholder="Désignation" value={l.name} onChange={(e) => setLine(i, 'name', e.target.value)} />
      <input className="input" inputMode="numeric" placeholder="Quantité" value={l.quantity} onChange={(e) => setLine(i, 'quantity', e.target.value.replace(/\D/g, ''))} />
      <input className="input" inputMode="numeric" placeholder="Prix unitaire (F)" value={l.unit_price_fcfa} onChange={(e) => setLine(i, 'unit_price_fcfa', e.target.value.replace(/\D/g, ''))} />
      <input className="input" inputMode="decimal" placeholder="Poids unitaire (kg)" value={l.weight_kg} onChange={(e) => setLine(i, 'weight_kg', e.target.value)} />
    </div>)}
    <Btn size="sm" kind="ghost" onClick={() => setLines([...lines, emptyLine()])}>＋ Article</Btn>
    <div className="grid cols-2">
      <Field label="Paiement"><Chips options={[['cod', 'À la livraison'], ['prepaid', 'Payé d\'avance']]} value={f.payment_method} onChange={(v) => setF({ ...f, payment_method: v })} /></Field>
      <Field label="Service"><Chips options={[['standard', 'Standard'], ['express', 'Express'], ['programme', 'Programmé']]} value={f.service} onChange={(v) => { setF({ ...f, service: v }); setQuote(null); }} /></Field>
      <Field label="Frais de livraison (vide = grille)"><input className="input" inputMode="numeric" value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value.replace(/\D/g, '') })} /></Field>
      <Field label="Valeur assurée (facultatif, F)"><input className="input" inputMode="numeric" value={f.declared} onChange={(e) => { setF({ ...f, declared: e.target.value.replace(/\D/g, '') }); setQuote(null); }} /></Field>
      <Field label="Vendeur (facultatif)"><input className="input" value={f.vendor_name} onChange={(e) => setF({ ...f, vendor_name: e.target.value })} /></Field>
      <Field label="Note pour le livreur"><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field></div>
    <div className="row"><Btn disabled={!f.zone} onClick={doQuote}>Calculer la livraison</Btn>
      <span className="small">Articles : <b>{formatF(subtotal)}</b>{quote && (quote.ok ? <> · livraison <b>{formatF(quote.price_fcfa)}</b>{quote.free ? ' (offerte)' : ''}{quote.insurance_fee_fcfa ? ` · assurance ${formatF(quote.insurance_fee_fcfa)}` : ''} · promise le {dmy(quote.promised_at)}</>
        : <span style={{ color: 'var(--bad)' }}> · {errText(quote.error)}</span>)}</span></div>
    <Btn kind="primary" size="xl" disabled={busy || !items.length || !f.zone} onClick={() => run(async () => {
      const r = await rpc('lg_order_create', { p_event: event, p_customer: c, p_zone: f.zone, p_items: items, p_payment_method: f.payment_method, p_service: f.service,
        p_delivery_fee_fcfa: f.fee === '' ? null : Number(f.fee), p_declared_value_fcfa: f.declared ? Number(f.declared) : null, p_note: f.note || null, p_vendor_name: f.vendor_name || null });
      onDone(r); return r;
    }, { ok: 'Commande enregistrée' })}>Enregistrer la commande</Btn></div></Modal>;
}

// ----------------------------------------------------------------- import par fichier
const COLS = ['reference', 'client', 'telephone', 'adresse', 'repere', 'zone', 'article', 'quantite', 'prix_unitaire', 'poids_kg', 'paiement', 'frais_livraison', 'note'];
const TEMPLATE = [COLS.join(';'), 'CMD-1001;Aminata Diop;771234567;Villa 12 Mermoz;face pharmacie;Mermoz;Huile 5 L;2;6000;5;livraison;;Appeler avant',
  'CMD-1001;Aminata Diop;771234567;Villa 12 Mermoz;face pharmacie;Mermoz;Savon;3;500;0,2;livraison;;', 'CMD-1002;Ousmane Fall;781112233;Cité Keur Gorgui;;Cité Keur Gorgui;Robe wax;1;15000;0,5;payé;1500;'].join('\r\n');

function ImportOrders({ onClose, onDone }) {
  const [orders, setOrders] = useState(null); const [report, setReport] = useState(null); const [busy, setBusy] = useState(false);
  const template = () => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + TEMPLATE], { type: 'text/csv' })); a.download = 'commandes-gabarit.csv'; a.click();
  };
  const send = async () => {
    setBusy(true);
    const out = { created: 0, duplicates: 0, errors: [] };
    try {
      for (let i = 0; i < orders.length; i += IMPORT_MAX) {
        const part = orders.slice(i, i + IMPORT_MAX);
        const r = await rpc('lg_order_import', { p_orders: part.map(({ _line, ...o }) => o) });
        out.created += r.created; out.duplicates += r.duplicates;
        r.errors.forEach((e) => out.errors.push({ ...e, line: part[e.line - 1]?._line, ref: e.external_ref }));
      }
    } catch (e) { out.errors.push({ line: '—', error: e.code ?? e.message }); }
    setReport(out); setBusy(false); onDone();
  };
  return <Modal title="Importer des commandes" onClose={onClose}><div className="stack">
    <p className="small" style={{ margin: 0 }}>Une ligne par article ; les lignes de même <b>reference</b> forment une commande. Paiement : « livraison » ou « payé ». Frais de livraison vides = grille de prix. Une référence déjà importée n'est jamais créée deux fois.</p>
    <div className="row"><Btn size="sm" onClick={template}>Télécharger le gabarit</Btn>
      <label className="btn sm">Choisir le fichier<input type="file" accept=".csv,text/csv" hidden onChange={async (e) => { const fl = e.target.files[0]; if (fl) { setOrders(parseOrdersCsv(await fl.text())); setReport(null); } }} /></label></div>
    {orders && <div className="flash info">{orders.length} commande(s) lue(s), {orders.reduce((s, o) => s + o.items.length, 0)} article(s).</div>}
    {orders && !report && <Btn kind="primary" size="xl" disabled={busy || !orders.length} onClick={send}>{busy ? 'Envoi…' : 'Importer'}</Btn>}
    {report && <Card kind={report.errors.length ? 'todo' : 'ok'}><b>{report.created} créée(s)</b>{report.duplicates ? ` · ${report.duplicates} déjà importée(s)` : ''}
      {report.errors.length > 0 && <ul className="small">{report.errors.map((e, i) => <li key={i}>Ligne {e.line}{e.ref ? ` (${e.ref})` : ''} : {errText(e.error)}</li>)}</ul>}</Card>}
  </div></Modal>;
}

