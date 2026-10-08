// Achats de réassort (écran Produits et stock) : fournisseurs et bons de commande — création, envoi par WhatsApp ou
// impression, réception partielle ou totale (entrée en stock), annulation, solde d'un reliquat.
import React, { useMemo, useState } from 'react';
import { rpc } from '../lib/backend.js';
import { act } from '../lib/offline.js';
import { printPurchaseOrder } from '../lib/print.js';
import { useRpc, useAction, Icon, Btn, Card, Badge, Empty, Loading, ErrorBox, Modal, Field, Chips, formatF, dmy, ago } from './ui.jsx';
import { Scanner } from './field.jsx';

export const PO_STATUS = { draft: ['brouillon', ''], sent: ['envoyé', 'info'], partial: ['reçu en partie', 'todo'], received: ['reçu', 'ok'], cancelled: ['annulé', 'bad'] };
const day = (d) => (d ? d.split('-').reverse().join('/') : '—');
const waPhone = (p) => String(p ?? '').replace(/\D/g, '').replace(/^(7\d{8})$/, '221$1');

/** Texte du bon pour WhatsApp (le fournisseur le reçoit tel quel). */
function poText(po) {
  return [`Bonjour${po.supplier?.contact_name ? ` ${po.supplier.contact_name}` : ''},`, `Voici notre bon de commande ${po.number} (${po.company?.name ?? ''}) :`, '',
    ...po.lines.map((l) => `- ${l.name}${l.sku ? ` (${l.sku})` : ''} : ${l.qty_ordered}${l.unit_cost_fcfa ? ` × ${formatF(l.unit_cost_fcfa)}` : ''}`), '',
    `Total : ${formatF(po.total_fcfa)}`, po.expected_on ? `Livraison souhaitée : ${day(po.expected_on)}` : null,
    'Merci de rappeler ce numéro sur le bon de livraison et la facture.'].filter((x) => x != null).join('\n');
}

// ----------------------------------------------------------------- bons de commande
export function PurchaseOrders({ canWrite, canReceive, products }) {
  const [st, setSt] = useState('open'); const [open, setOpen] = useState(null); const [create, setCreate] = useState(false);
  const { data, error, loading, reload } = useRpc('lg_purchase_orders_list', { p_status: st === 'all' ? null : st });
  return <div className="stack">
    <div className="row" style={{ flexWrap: 'wrap' }}>
      <Chips options={[['open', 'En cours'], ['draft', 'Brouillons'], ['received', 'Reçus'], ['cancelled', 'Annulés'], ['all', 'Tous']]} value={st} onChange={setSt} />
      <span className="spacer" />{canWrite && <Btn kind="primary" onClick={() => setCreate(true)}><Icon name="plus" size={16} />Bon de commande</Btn>}</div>
    <ErrorBox error={error} />
    {loading && !data ? <Loading /> : !data?.length ? <Card><Empty icon="receipt">Aucun bon de commande.{canWrite && <><br />Créez-en un, ou laissez l'onglet « À commander » les proposer.</>}</Empty></Card>
      : <Card><div className="scroll-x"><table className="tbl"><thead><tr><th>N°</th><th>Fournisseur</th><th>État</th><th className="num">Articles</th><th className="num">Montant</th><th>Livraison</th><th></th></tr></thead>
        <tbody>{data.map((o) => <tr key={o.id}><td className="mono">{o.number}<div className="small muted">{ago(o.created_at)}</div></td><td>{o.supplier}</td>
          <td><Badge kind={PO_STATUS[o.status][1]}>{PO_STATUS[o.status][0]}</Badge>{o.late && <Badge kind="bad">en retard</Badge>}</td>
          <td className="num">{o.status === 'partial' ? `${o.units_received}/${o.units}` : o.units}</td><td className="num">{formatF(o.total_fcfa)}</td>
          <td className="small">{day(o.expected_on)}</td><td><Btn size="sm" onClick={() => setOpen(o.id)}>Ouvrir</Btn></td></tr>)}</tbody></table></div></Card>}
    {open && <PoDetail id={open} canWrite={canWrite} canReceive={canReceive} onClose={() => setOpen(null)} onChange={reload} />}
    {create && <PoForm products={products} onClose={() => setCreate(false)} onDone={(id) => { setCreate(false); reload(); setOpen(id); }} />}
  </div>;
}

function PoDetail({ id, canWrite, canReceive, onClose, onChange }) {
  const { data: po, error, loading, reload } = useRpc('lg_purchase_order_detail', { p_id: id });
  const [recv, setRecv] = useState(false); const [edit, setEdit] = useState(false);
  const [run, busy] = useAction();
  const refresh = () => { reload(); onChange(); };
  const send = (how) => run(async () => {
    const r = await rpc('lg_purchase_order_send', { p_id: po.id });
    if (how === 'wa') window.open(`https://wa.me/${waPhone(po.supplier.phone)}?text=${encodeURIComponent(poText(po))}`, '_blank', 'noopener');
    if (how === 'print') printPurchaseOrder(po);
    refresh(); return r;
  }, { ok: how === 'wa' ? 'Bon envoyé' : undefined });
  return <Modal title={po ? `Bon ${po.number}` : 'Bon de commande'} onClose={onClose}>
    {loading && !po ? <Loading /> : error ? <ErrorBox error={error} /> : <div className="stack">
      <div className="row between"><div><b>{po.supplier.name}</b><div className="small muted">{[po.supplier.phone, po.supplier.payment_terms].filter(Boolean).join(' · ')}</div></div>
        <Badge kind={PO_STATUS[po.status][1]}>{PO_STATUS[po.status][0]}</Badge></div>
      <div className="small">Créé le {dmy(po.created_at)}{po.sent_at ? ` · envoyé le ${dmy(po.sent_at)}` : ''}{po.expected_on ? ` · livraison souhaitée le ${day(po.expected_on)}` : ''}
        {po.received_at ? ` · reçu le ${dmy(po.received_at)}` : ''}{po.cancel_reason ? ` · annulé : ${po.cancel_reason}` : ''}</div>
      {po.note && <div className="small muted">{po.note}</div>}
      <div className="scroll-x"><table className="tbl"><thead><tr><th>Article</th><th className="num">Commandé</th><th className="num">Reçu</th><th className="num">Prix</th><th className="num">Montant</th></tr></thead>
        <tbody>{po.lines.map((l) => <tr key={l.id}><td>{l.name}<div className="small muted">{l.sku}</div></td><td className="num">{l.qty_ordered}</td>
          <td className="num">{l.qty_received || ''}</td><td className="num">{formatF(l.unit_cost_fcfa)}</td><td className="num">{formatF(l.qty_ordered * l.unit_cost_fcfa)}</td></tr>)}</tbody></table></div>
      <div className="row between"><b>Total</b><b className="money">{formatF(po.total_fcfa)}</b></div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {canWrite && ['draft', 'sent'].includes(po.status) && <Btn kind="primary" disabled={busy} onClick={() => send('wa')}><Icon name="message" size={16} />{po.status === 'draft' ? 'Envoyer' : 'Renvoyer'} par WhatsApp</Btn>}
        <Btn disabled={busy} onClick={() => (canWrite && po.status === 'draft' ? send('print') : printPurchaseOrder(po))}><Icon name="print" size={16} />Imprimer / PDF</Btn>
        {canReceive && ['draft', 'sent', 'partial'].includes(po.status) && <Btn kind="primary" onClick={() => setRecv(true)}>Réceptionner</Btn>}
        {canWrite && po.status === 'draft' && <Btn onClick={() => setEdit(true)}>Modifier</Btn>}
        {canWrite && ['draft', 'sent'].includes(po.status) && <Btn kind="bad" disabled={busy} onClick={() => { const reason = prompt('Motif de l’annulation ?'); if (reason) run(async () => { const r = await rpc('lg_purchase_order_cancel', { p_id: po.id, p_reason: reason }); refresh(); return r; }, { ok: 'Bon annulé' }); }}>Annuler</Btn>}
        {canWrite && po.status === 'partial' && <Btn disabled={busy} onClick={() => { const reason = prompt('Le reste ne viendra pas. Motif ?', 'rupture chez le fournisseur'); if (reason !== null) run(async () => { const r = await rpc('lg_purchase_order_close', { p_id: po.id, p_reason: reason }); refresh(); return r; }, { ok: 'Bon soldé' }); }}>Solder le reliquat</Btn>}
      </div>
      {recv && <ReceivePo po={po} onClose={() => setRecv(false)} onDone={() => { setRecv(false); refresh(); }} />}
      {edit && <PoForm po={po} onClose={() => setEdit(false)} onDone={() => { setEdit(false); refresh(); }} />}
    </div>}
  </Modal>;
}

function ReceivePo({ po, onClose, onDone }) {
  const locs = useRpc('lg_locations_list', {});
  const left = (l) => l.qty_ordered - l.qty_received;
  const [q, setQ] = useState(() => Object.fromEntries(po.lines.map((l) => [l.id, { qty: String(left(l)), loc: '' }])));
  const [ref, setRef] = useState(''); const [run, busy] = useAction();
  const [counting, setCounting] = useState(false); const [msg, setMsg] = useState(null);
  const set = (id, k, v) => setQ({ ...q, [id]: { ...q[id], [k]: v } });
  // comptage au scan : on part de zéro, chaque article scanné ajoute 1 à sa ligne (sans dépasser le reste à recevoir)
  const startCounting = () => { setCounting(true); setQ(Object.fromEntries(po.lines.map((l) => [l.id, { ...q[l.id], qty: '0' }]))); };
  const onScan = (code) => {
    const c = code.trim().toUpperCase();
    const l = po.lines.find((x) => x.barcode?.toUpperCase() === c || x.sku?.toUpperCase() === c || `NXI-${x.product_id.slice(0, 8)}`.toUpperCase() === c);
    if (!l) { setMsg({ bad: true, text: `${code} : pas sur ce bon` }); return; }
    setQ((cur) => {
      const now = Number(cur[l.id]?.qty || 0);
      if (now >= left(l)) { setMsg({ bad: true, text: `${l.name} : déjà ${now}, tout est reçu` }); return cur; }
      setMsg({ text: `${l.name} : ${now + 1} / ${left(l)}` });
      return { ...cur, [l.id]: { ...cur[l.id], qty: String(now + 1) } };
    });
  };
  return <Modal title={`Réception · ${po.number}`} onClose={onClose}><div className="stack">
    <p className="small muted" style={{ margin: 0 }}>Indiquez ce qui est réellement arrivé (0 si une ligne manque), ou comptez au scan. Le reste reste attendu.</p>
    {!counting ? <Btn onClick={startCounting}><Icon name="scan" size={16} />Compter au scan (caméra ou douchette)</Btn>
      : <><Scanner onCode={onScan} placeholder="Scanner chaque article" />{msg && <div className={`flash ${msg.bad ? 'bad' : 'ok'}`}>{msg.text}</div>}</>}
    {po.lines.filter((l) => left(l) > 0).map((l) => <div key={l.id} className="grid cols-3" style={{ alignItems: 'end' }}>
      <div><b>{l.name}</b><div className="small muted">reste {left(l)} sur {l.qty_ordered}</div></div>
      <Field label="Reçu"><input className="input" inputMode="numeric" value={q[l.id].qty} onChange={(e) => set(l.id, 'qty', e.target.value.replace(/\D/g, ''))} /></Field>
      {(locs.data ?? []).length > 0 ? <Field label="Emplacement"><select className="input" value={q[l.id].loc} onChange={(e) => set(l.id, 'loc', e.target.value)}>
        <option value="">—</option>{locs.data.filter((x) => x.active).map((x) => <option key={x.id} value={x.code}>{x.code}</option>)}</select></Field> : <span />}
    </div>)}
    <Field label="N° du bon de livraison du fournisseur (facultatif)"><input className="input" value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
    <Btn kind="primary" size="xl" disabled={busy} onClick={() => run(async () => {
      const lines = po.lines.filter((l) => Number(q[l.id]?.qty) > 0).map((l) => ({ line_id: l.id, qty: Number(q[l.id].qty), location_code: q[l.id].loc || null }));
      const r = await act('lg_purchase_order_receive', { p_id: po.id, p_lines: lines, p_ref: ref || null }, `Réception ${po.number}`);
      if (r?.ok) onDone();
      return r;
    }, { ok: 'Marchandise entrée en stock' })}>Valider la réception</Btn></div></Modal>;
}

function PoForm({ po, products: given, onClose, onDone }) {
  const sups = useRpc('lg_suppliers_list', {});
  const ov = useRpc('lg_stock_overview', {}, { skip: !!given });
  const products = given ?? ov.data?.products ?? [];
  const [sup, setSup] = useState(po?.supplier_id ?? '');
  const [lines, setLines] = useState(() => po ? po.lines.map((l) => ({ product_id: l.product_id, qty: String(l.qty_ordered), cost: String(l.unit_cost_fcfa) })) : []);
  const [expected, setExpected] = useState(po?.expected_on ?? ''); const [note, setNote] = useState(po?.note ?? '');
  const [q, setQ] = useState(''); const [run, busy] = useAction();
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const found = q.length >= 2 ? products.filter((p) => p.active && `${p.name} ${p.sku ?? ''} ${p.barcode ?? ''}`.toLowerCase().includes(q.toLowerCase())).slice(0, 6) : [];
  const ofSupplier = products.filter((p) => p.active && sup && p.supplier_id === sup && !lines.some((l) => l.product_id === p.id));
  const add = (p) => { setLines([...lines, { product_id: p.id, qty: String(p.to_order || 1), cost: String(p.cost_fcfa ?? '') }]); setQ(''); };
  const total = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.cost) || 0), 0);
  return <Modal title={po ? `Modifier ${po.number}` : 'Nouveau bon de commande'} onClose={onClose}><div className="stack">
    {!po && <Field label="Fournisseur"><select className="input" value={sup} onChange={(e) => setSup(e.target.value)}><option value="">Choisir…</option>
      {(sups.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>}
    {!po && !(sups.data ?? []).length && <p className="small muted">Aucun fournisseur : créez-le d'abord dans l'onglet Fournisseurs.</p>}
    {ofSupplier.length > 0 && <div className="small">Produits de ce fournisseur : {ofSupplier.slice(0, 12).map((p) => <button key={p.id} className="badge info plain" style={{ border: 0, cursor: 'pointer', margin: 2 }} onClick={() => add(p)}>＋ {p.name}</button>)}</div>}
    <input className="input" placeholder="Ajouter un produit (nom, référence, code-barres)" value={q} onChange={(e) => setQ(e.target.value)} />
    {found.length > 0 && <div className="list">{found.map((p) => <button key={p.id} className="line" style={{ width: '100%', textAlign: 'left', background: 'none', border: 0, cursor: 'pointer' }} onClick={() => add(p)}>
      <span className="grow">{p.name}<span className="small muted"> · stock {p.stock ?? '—'}</span></span><Icon name="plus" size={16} /></button>)}</div>}
    {lines.length > 0 && <div className="scroll-x"><table className="tbl"><thead><tr><th>Article</th><th className="num">Quantité</th><th className="num">Prix d'achat (F)</th><th></th></tr></thead><tbody>
      {lines.map((l, i) => <tr key={l.product_id}><td>{byId.get(l.product_id)?.name ?? po?.lines.find((x) => x.product_id === l.product_id)?.name}</td>
        <td className="num"><input className="input" style={{ width: 90 }} inputMode="numeric" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value.replace(/\D/g, '') } : x)))} /></td>
        <td className="num"><input className="input" style={{ width: 110 }} inputMode="numeric" value={l.cost} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, cost: e.target.value.replace(/\D/g, '') } : x)))} /></td>
        <td><button className="icon-btn" aria-label="Retirer" onClick={() => setLines(lines.filter((_, j) => j !== i))}><Icon name="x" size={16} /></button></td></tr>)}</tbody></table></div>}
    <div className="grid cols-2"><Field label="Livraison souhaitée (facultatif)"><input className="input" type="date" value={expected} onChange={(e) => setExpected(e.target.value)} /></Field>
      <Field label="Note (facultatif)"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field></div>
    <div className="row between"><b>Total</b><b className="money">{formatF(total)}</b></div>
    <Btn kind="primary" size="xl" disabled={busy || (!po && !sup) || !lines.length || lines.some((l) => !(Number(l.qty) > 0))} onClick={() => run(async () => {
      const payload = lines.map((l) => ({ product_id: l.product_id, qty: Number(l.qty), unit_cost_fcfa: l.cost === '' ? null : Number(l.cost) }));
      const r = po ? await rpc('lg_purchase_order_update', { p_id: po.id, p_lines: payload, p_expected_on: expected || null, p_note: note || null })
        : await rpc('lg_purchase_order_create', { p_supplier: sup, p_lines: payload, p_expected_on: expected || null, p_note: note || null });
      if (r?.ok !== false) onDone(r.id);
      return r;
    }, { ok: po ? 'Bon modifié' : 'Bon créé (brouillon)' })}>{po ? 'Enregistrer' : 'Créer le bon'}</Btn></div></Modal>;
}

// ----------------------------------------------------------------- fournisseurs
export function Suppliers({ canWrite }) {
  const [all, setAll] = useState(false);
  const { data, error, loading, reload } = useRpc('lg_suppliers_list', { p_all: all });
  const [edit, setEdit] = useState(null);
  return <div className="stack">
    <div className="row"><label className="check"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Afficher les fournisseurs archivés</label>
      <span className="spacer" />{canWrite && <Btn kind="primary" onClick={() => setEdit({ name: '' })}><Icon name="plus" size={16} />Fournisseur</Btn>}</div>
    <ErrorBox error={error} />
    {loading && !data ? <Loading /> : !data?.length ? <Card><Empty icon="store">Aucun fournisseur.{canWrite && ' Ajoutez ceux chez qui vous achetez.'}</Empty></Card>
      : <div className="grid cols-2">{data.map((s) => <Card key={s.id} style={{ opacity: s.active ? 1 : 0.55 }}>
        <div className="row between"><h3 style={{ margin: 0 }}>{s.name}</h3>{canWrite && <Btn size="sm" onClick={() => setEdit(s)}>Modifier</Btn>}</div>
        <div className="small muted">{[s.contact_name, s.phone, s.email].filter(Boolean).join(' · ') || 'pas de contact'}</div>
        <div className="small">{s.products} produit(s) · {s.open_orders} bon(s) en cours{s.lead_days != null ? ` · livre en ${s.lead_days} j` : ''}{s.payment_terms ? ` · ${s.payment_terms}` : ''}</div>
        <div className="small muted">Acheté sur 12 mois : {formatF(s.spent_365d)}{s.last_order_at ? ` · dernière commande ${ago(s.last_order_at)}` : ''}</div>
        {s.phone && <a className="btn sm" style={{ marginTop: 8 }} href={`https://wa.me/${waPhone(s.phone)}`} target="_blank" rel="noopener"><Icon name="message" size={14} />WhatsApp</a>}
      </Card>)}</div>}
    {edit && <SupplierForm s={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(); }} />}
  </div>;
}

function SupplierForm({ s, onClose, onDone }) {
  const [f, setF] = useState({ ...s }); const [run, busy] = useAction();
  const x = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return <Modal title={s.id ? s.name : 'Nouveau fournisseur'} onClose={onClose}><div className="stack">
    <Field label="Nom"><input className="input" autoFocus={!s.id} value={f.name ?? ''} onChange={x('name')} /></Field>
    <div className="grid cols-2">
      <Field label="Contact"><input className="input" value={f.contact_name ?? ''} onChange={x('contact_name')} /></Field>
      <Field label="Téléphone / WhatsApp"><input className="input" type="tel" value={f.phone ?? ''} onChange={x('phone')} /></Field>
      <Field label="E-mail"><input className="input" type="email" value={f.email ?? ''} onChange={x('email')} /></Field>
      <Field label="Délai de livraison habituel (jours)"><input className="input" inputMode="numeric" value={f.lead_days ?? ''} onChange={x('lead_days')} /></Field>
      <Field label="Conditions de paiement"><input className="input" value={f.payment_terms ?? ''} onChange={x('payment_terms')} placeholder="comptant, 30 jours…" /></Field>
      <Field label="Adresse"><input className="input" value={f.address ?? ''} onChange={x('address')} /></Field></div>
    <Field label="Note"><input className="input" value={f.note ?? ''} onChange={x('note')} /></Field>
    {s.id && <label className="check"><input type="checkbox" checked={f.active !== false} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Fournisseur actif</label>}
    <Btn kind="primary" size="xl" disabled={busy || !f.name?.trim()} onClick={() => run(async () => {
      const r = await rpc('lg_supplier_upsert', { p: { ...f, lead_days: f.lead_days === '' || f.lead_days == null ? null : Number(f.lead_days) } });
      if (r?.ok !== false) onDone();
      return r;
    }, { ok: 'Fournisseur enregistré' })}>Enregistrer</Btn></div></Modal>;
}
