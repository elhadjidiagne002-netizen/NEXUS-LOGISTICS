// Produits et stock : catalogue, stock (réservé, disponible, seuil d'alerte), entrée de marchandise, correction
// motivée, transfert entre emplacements, historique des mouvements, liste « à commander », import / export Excel,
// fournisseurs et bons de commande (components/purchasing.jsx).
// Le stock baisse tout seul à la préparation des commandes et remonte aux retours remis en vente.
import React, { useMemo, useState } from 'react';
import { rpc } from '../lib/backend.js';
import { act } from '../lib/offline.js';
import { parseProductsCsv, downloadCsv, PRODUCTS_TEMPLATE } from '../lib/csv.js';
import { useRpc, useAction, Icon, Btn, Card, Badge, Empty, Loading, ErrorBox, PageHead, Modal, Field, Tabs, Chips, Stat, HANDLING, formatF, dmy, ago } from '../components/ui.jsx';
import { useMe, has } from '../App.jsx';
import { PurchaseOrders, Suppliers } from '../components/purchasing.jsx';

const STATE = { ok: ['en stock', 'ok'], low: ['sous le seuil', 'todo'], out: ['rupture', 'bad'], untracked: ['non suivi', ''] };
const KIND = { in: 'Entrée', pick: 'Préparation', adjust: 'Correction', count: 'Inventaire', discard: 'Rebut', return: 'Retour', transfer: 'Transfert', initial: 'Stock de départ' };
const REASONS = ['Casse', 'Perte ou vol', 'Erreur de saisie', 'Cadeau ou échantillon', 'Périmé', 'Comptage'];
const n = (v) => (v == null ? '—' : Number(v).toLocaleString('fr-FR'));
const isVendor = (me) => me.is_vendor && !me.is_admin && !(me.roles ?? []).length;

export default function Stock() {
  const me = useMe();
  const [tab, setTab] = useState('stock');
  const ov = useRpc('lg_stock_overview', { p_inactive: true }, { refresh: 60000 });
  const t = ov.data?.totals;
  const staff = !isVendor(me);
  const canBuy = me.is_admin || has(me, 'dock_chief', 'accountant');
  const canReceive = me.is_admin || has(me, 'dock_chief', 'picker');
  return <>
    <PageHead title="Produits et stock" back="/" sub="Vos produits, ce qu'il reste, ce qui entre et ce qui sort. Le stock baisse tout seul à chaque préparation." />
    {t && <div className="stats">
      <Stat icon="box" label="produits" value={t.products} /><Stat icon="layers" label="unités en stock" value={n(t.units)} />
      <Stat icon="cash" label="valeur du stock" value={formatF(t.value_fcfa)} />
      <Stat icon="alert" c="#d97706" label="sous le seuil" value={t.low} kind={t.low ? 'todo' : ''} />
      <Stat icon="x" c="#dc2626" label="en rupture" value={t.out} kind={t.out ? 'bad' : ''} />
    </div>}
    <Tabs value={tab} onChange={setTab} tabs={[['stock', 'Stock'], ['receive', 'Entrée de marchandise'], ['moves', 'Mouvements'], ['order', `À commander${t ? ` (${t.low + t.out})` : ''}`],
      ...(staff ? [['po', 'Bons de commande'], ['suppliers', 'Fournisseurs']] : [])]} />
    {tab === 'stock' && <StockList ov={ov} me={me} />}
    {tab === 'receive' && <Receive products={ov.data?.products ?? []} me={me} onDone={ov.reload} />}
    {tab === 'moves' && <Moves />}
    {tab === 'order' && <ToOrder ov={ov} canBuy={canBuy} onCreated={() => setTab('po')} />}
    {tab === 'po' && <PurchaseOrders canWrite={canBuy} canReceive={canReceive} products={ov.data?.products ?? []} />}
    {tab === 'suppliers' && <Suppliers canWrite={canBuy} />}
  </>;
}

// ----------------------------------------------------------------- stock
function StockList({ ov, me }) {
  const [q, setQ] = useState(''); const [f, setF] = useState('all');
  const [edit, setEdit] = useState(null); const [recv, setRecv] = useState(null); const [adj, setAdj] = useState(null);
  const [move, setMove] = useState(null); const [hist, setHist] = useState(null); const [imp, setImp] = useState(false);
  const { data, error, loading, reload } = ov;
  const list = useMemo(() => (data?.products ?? []).filter((p) => (f === 'all' || p.state === f || (f === 'inactive' && !p.active))
    && (f === 'inactive' || p.active) && (!q || `${p.name} ${p.sku ?? ''} ${p.barcode ?? ''} ${p.vendor ?? ''}`.toLowerCase().includes(q.toLowerCase()))), [data, q, f]);
  const canAdjust = me.is_admin || has(me, 'dock_chief') || isVendor(me);
  const canMove = !isVendor(me) && (me.is_admin || has(me, 'dock_chief', 'picker'));
  const exportAll = () => downloadCsv(`stock-${new Date().toISOString().slice(0, 10)}.csv`, [
    ['nom', 'reference', 'code_barres', 'prix', 'prix_achat', 'stock', 'reserve', 'disponible', 'seuil_alerte', 'etat', 'emplacements', 'fournisseur', 'vendeur'],
    ...(data?.products ?? []).map((p) => [p.name, p.sku, p.barcode, p.price_fcfa, p.cost_fcfa, p.stock, p.reserved, p.available, p.min_stock, STATE[p.state][0],
      p.locations.map((l) => `${l.code}:${l.qty}`).join(' '), p.supplier, p.vendor])]);
  if (loading && !data) return <Loading />;
  return <div className="stack">
    <div className="row" style={{ flexWrap: 'wrap' }}>
      <input className="input" style={{ flex: 1, minWidth: 200 }} placeholder="Nom, référence, code-barres…" value={q} onChange={(e) => setQ(e.target.value)} />
      <Btn kind="primary" onClick={() => setEdit({ name: '', price_fcfa: '', handling: [] })}><Icon name="plus" size={16} />Produit</Btn>
      <Btn onClick={() => setImp(true)}><Icon name="download" size={16} />Importer</Btn>
      <Btn onClick={exportAll} disabled={!data?.products.length}>Exporter (Excel)</Btn>
    </div>
    <Chips options={[['all', 'Tous'], ['low', 'Sous le seuil'], ['out', 'Rupture'], ['untracked', 'Non suivis'], ['inactive', 'Archivés']]} value={f} onChange={setF} />
    <ErrorBox error={error} />
    {!list.length ? <Card><Empty icon="box">{data?.products.length ? 'Aucun produit ne correspond.' : <>Aucun produit pour l'instant.<br />
      Ajoutez-les un par un (<b>＋ Produit</b>) ou d'un coup depuis un fichier Excel (<b>Importer</b>).</>}</Empty></Card>
      : <Card><div className="scroll-x"><table className="tbl"><thead><tr><th>Produit</th><th className="num">Stock</th><th className="num">Réservé</th>
        <th className="num">Disponible</th><th className="num">Seuil</th><th>Où</th><th>État</th><th></th></tr></thead><tbody>
        {list.map((p) => <tr key={p.id} style={{ opacity: p.active ? 1 : 0.5 }}>
          <td><b>{p.name}</b><div className="small muted">{[p.sku, p.barcode, formatF(p.price_fcfa), p.vendor].filter(Boolean).join(' · ')}</div></td>
          <td className="num"><b>{n(p.stock)}</b></td><td className="num">{p.reserved ? n(p.reserved) : ''}</td><td className="num">{n(p.available)}{p.on_order > 0 && <div className="small muted">+{n(p.on_order)} en commande</div>}</td>
          <td className="num">{n(p.min_stock)}</td>
          <td className="small">{p.locations.length ? p.locations.map((l) => `${l.code} (${l.qty})`).join(', ') : <span className="muted">—</span>}</td>
          <td><Badge kind={STATE[p.state][1]}>{STATE[p.state][0]}</Badge></td>
          <td><div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
            <Btn size="sm" kind="primary" onClick={() => setRecv(p)} title="Entrée de marchandise">＋ Entrée</Btn>
            {canAdjust && <Btn size="sm" onClick={() => setAdj(p)}>Corriger</Btn>}
            {canMove && p.locations.length > 0 && <Btn size="sm" onClick={() => setMove(p)}>Déplacer</Btn>}
            <Btn size="sm" kind="ghost" onClick={() => setHist(p)} title="Historique"><Icon name="clock" size={16} /></Btn>
            <Btn size="sm" kind="ghost" onClick={() => setEdit(p)}>Fiche</Btn></div></td></tr>)}
      </tbody></table></div></Card>}
    {edit && <ProductForm p={edit} me={me} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(); }} />}
    {recv && <Modal title={`Entrée · ${recv.name}`} onClose={() => setRecv(null)}><ReceiveForm product={recv} me={me} onDone={() => { setRecv(null); reload(); }} /></Modal>}
    {adj && <AdjustForm p={adj} onClose={() => setAdj(null)} onDone={() => { setAdj(null); reload(); }} />}
    {move && <TransferForm p={move} onClose={() => setMove(null)} onDone={() => { setMove(null); reload(); }} />}
    {hist && <Modal title={`Historique · ${hist.name}`} onClose={() => setHist(null)}><Moves product={hist.id} compact /></Modal>}
    {imp && <ImportForm onClose={() => setImp(false)} onDone={() => { setImp(false); reload(); }} />}
  </div>;
}

// ----------------------------------------------------------------- fiche produit
export function ProductForm({ p, me, onClose, onDone }) {
  const [f, setF] = useState({ ...p, weight_kg: p.weight_g ? String(p.weight_g / 1000) : '', price_fcfa: p.price_fcfa ?? '', stock: '' });
  const sups = useRpc('lg_suppliers_list', {}, { skip: isVendor(me) });
  const [run, busy] = useAction();
  const s = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const num = (v) => (v === '' || v == null ? null : Number(String(v).replace(/\s/g, '').replace(',', '.')));
  return <Modal title={p.id ? p.name : 'Nouveau produit'} onClose={onClose}><div className="stack">
    <Field label="Nom du produit"><input className="input" value={f.name} onChange={s('name')} autoFocus={!p.id} /></Field>
    <div className="grid cols-2">
      <Field label="Prix de vente (F)"><input className="input" inputMode="numeric" value={f.price_fcfa} onChange={s('price_fcfa')} /></Field>
      <Field label="Prix d'achat (F, facultatif)"><input className="input" inputMode="numeric" value={f.cost_fcfa ?? ''} onChange={s('cost_fcfa')} /></Field>
      <Field label="Référence (facultatif)"><input className="input mono" value={f.sku ?? ''} onChange={s('sku')} /></Field>
      <Field label="Code-barres (facultatif)"><input className="input mono" value={f.barcode ?? ''} onChange={s('barcode')} /></Field>
      <Field label="Poids (kg)"><input className="input" inputMode="decimal" value={f.weight_kg} onChange={s('weight_kg')} /></Field>
      <Field label="Seuil d'alerte (« à commander » en dessous)"><input className="input" inputMode="numeric" value={f.min_stock ?? ''} onChange={s('min_stock')} placeholder="aucun" /></Field>
      {!p.id && <Field label="Stock de départ (laisser vide si non suivi)"><input className="input" inputMode="numeric" value={f.stock} onChange={s('stock')} /></Field>}
      {isVendor(me) ? <Field label="Fournisseur (facultatif)"><input className="input" value={f.supplier ?? ''} onChange={s('supplier')} /></Field>
        : <Field label="Fournisseur habituel"><select className="input" value={f.supplier_id ?? ''} onChange={(e) => setF({ ...f, supplier_id: e.target.value || null })}>
          <option value="">Aucun</option>{(sups.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>}
      {!isVendor(me) && <Field label="Vendeur (facultatif)"><input className="input" value={f.vendor ?? f.vendor_name ?? ''} onChange={(e) => setF({ ...f, vendor_name: e.target.value, vendor: e.target.value })} /></Field>}
    </div>
    <Field label="Manutention"><Chips multi options={HANDLING} value={f.handling ?? []} onChange={(v) => setF({ ...f, handling: v })} /></Field>
    {p.id && <label className="check"><input type="checkbox" checked={f.active !== false} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Produit actif (décocher pour l'archiver)</label>}
    {p.id && <p className="small muted" style={{ margin: 0 }}>Le stock ne se modifie pas ici : utilisez <b>＋ Entrée</b> ou <b>Corriger</b> (chaque changement est tracé).</p>}
    <Btn kind="primary" size="xl" disabled={busy || !f.name?.trim()} onClick={() => run(async () => {
      const r = await rpc('lg_product_upsert', { p: { id: p.id, name: f.name, price_fcfa: num(f.price_fcfa) ?? 0, cost_fcfa: num(f.cost_fcfa), sku: f.sku || null, barcode: f.barcode || null,
        weight_g: f.weight_kg ? Math.round(num(f.weight_kg) * 1000) : null, min_stock: num(f.min_stock), supplier: f.supplier || null, supplier_id: f.supplier_id || null, vendor_name: f.vendor_name ?? null,
        handling: f.handling ?? [], active: f.active !== false, stock: p.id ? null : num(f.stock),
        length_cm: f.length_cm ?? null, width_cm: f.width_cm ?? null, height_cm: f.height_cm ?? null } });
      if (r?.ok !== false) onDone();
      return r;
    }, { ok: 'Produit enregistré' })}>Enregistrer</Btn></div></Modal>;
}

// ----------------------------------------------------------------- entrée de marchandise
function Receive({ products, me, onDone }) {
  const [q, setQ] = useState(''); const [pick, setPick] = useState(null);
  const found = q.length >= 2 ? products.filter((p) => p.active && `${p.name} ${p.sku ?? ''} ${p.barcode ?? ''}`.toLowerCase().includes(q.toLowerCase())).slice(0, 8) : [];
  const exact = products.find((p) => [p.sku, p.barcode].some((c) => c && c.toUpperCase() === q.trim().toUpperCase()));
  return <div className="split">
    <Card><h3>1. Quel produit ?</h3>
      <input className="input" autoFocus placeholder="Nom, référence ou code-barres (douchette)" value={q} onChange={(e) => { setQ(e.target.value); setPick(null); }}
        onKeyDown={(e) => { if (e.key === 'Enter' && exact) { e.preventDefault(); setPick(exact); } }} />
      <div className="list" style={{ marginTop: 8 }}>{found.map((p) => <button key={p.id} className="line" onClick={() => setPick(p)}
        style={{ width: '100%', textAlign: 'left', background: pick?.id === p.id ? 'var(--brand-50, #ecfdf5)' : 'none', border: 0, cursor: 'pointer' }}>
        <span className="grow"><b>{p.name}</b><div className="small muted">{[p.sku, p.barcode].filter(Boolean).join(' · ')}</div></span><span className="small">stock {n(p.stock)}</span></button>)}</div>
      {q.length >= 2 && !found.length && <p className="small muted">Aucun produit. Créez-le d'abord dans l'onglet Stock (＋ Produit).</p>}
    </Card>
    <Card><h3>2. Combien, et où ?</h3>{!pick ? <Empty icon="box">Choisissez le produit reçu.</Empty>
      : <ReceiveForm product={pick} me={me} onDone={() => { setPick(null); setQ(''); onDone(); }} />}</Card>
  </div>;
}

function ReceiveForm({ product, me, onDone }) {
  const staff = !isVendor(me);
  const locs = useRpc('lg_locations_list', {}, { skip: !staff || !(me.is_admin || has(me, 'picker', 'dock_chief')) });
  const [f, setF] = useState({ qty: '', loc: '', lot: '', dlc: '', ref: '', note: '' });
  const [run, busy] = useAction();
  const s = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return <div className="stack">
    <div className="small muted">Stock actuel : <b>{n(product.stock)}</b></div>
    <Field label="Quantité reçue"><input className="input" inputMode="numeric" autoFocus value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value.replace(/\D/g, '') })} /></Field>
    {staff && (locs.data ?? []).length > 0 && <Field label="Emplacement (facultatif)"><select className="input" value={f.loc} onChange={s('loc')}>
      <option value="">Sans emplacement</option>{locs.data.filter((l) => l.active).map((l) => <option key={l.id} value={l.code}>{l.code}{l.label ? ` · ${l.label}` : ''}</option>)}</select></Field>}
    {staff && f.loc && <div className="grid cols-2"><Field label="N° de lot (facultatif)"><input className="input mono" value={f.lot} onChange={s('lot')} /></Field>
      <Field label="À consommer avant (facultatif)"><input className="input" type="date" value={f.dlc} onChange={s('dlc')} /></Field></div>}
    <div className="grid cols-2"><Field label="Bon de livraison / référence (facultatif)"><input className="input" value={f.ref} onChange={s('ref')} /></Field>
      <Field label="Note (facultatif)"><input className="input" value={f.note} onChange={s('note')} placeholder={product.supplier ?? 'fournisseur…'} /></Field></div>
    <Btn kind="primary" size="xl" disabled={busy || !(Number(f.qty) > 0)} onClick={() => run(async () => {
      const r = await act('lg_stock_receive', { p_product: product.id, p_qty: Number(f.qty), p_location_code: f.loc || null, p_lot: f.lot || null,
        p_expires_on: f.dlc || null, p_ref: f.ref || null, p_note: f.note || null }, `Entrée ${product.name}`);
      if (r?.ok) onDone();
      return r;
    }, { ok: 'Entrée enregistrée' })}>Enregistrer l'entrée</Btn></div>;
}

// ----------------------------------------------------------------- correction, transfert
function AdjustForm({ p, onClose, onDone }) {
  const [qty, setQty] = useState(p.stock == null ? '' : String(p.stock)); const [reason, setReason] = useState(''); const [note, setNote] = useState('');
  const [run, busy] = useAction();
  const delta = qty === '' ? null : Number(qty) - (p.stock ?? 0);
  return <Modal title={`Corriger le stock · ${p.name}`} onClose={onClose}><div className="stack">
    <Field label={`Stock réel compté (actuellement ${n(p.stock)})`}><input className="input" inputMode="numeric" autoFocus value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} /></Field>
    {delta != null && delta !== 0 && <div className={`flash ${delta < 0 ? 'bad' : 'ok'}`}>{delta > 0 ? `+${delta}` : delta} unité(s)</div>}
    <Field label="Motif (obligatoire)"><Chips options={REASONS.map((r) => [r, r])} value={reason} onChange={setReason} /></Field>
    <Field label="Précision (facultatif)"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    <Btn kind="primary" disabled={busy || qty === '' || !reason} onClick={() => run(async () => {
      const r = await act('lg_stock_adjust', { p_product: p.id, p_new_qty: Number(qty), p_reason: note ? `${reason} : ${note}` : reason }, `Correction ${p.name}`);
      if (r?.ok) onDone();
      return r;
    }, { ok: 'Stock corrigé' })}>Enregistrer la correction</Btn></div></Modal>;
}

function TransferForm({ p, onClose, onDone }) {
  const locs = useRpc('lg_locations_list', {});
  const [f, setF] = useState({ from: p.locations[0]?.code ?? '', to: '', qty: '' }); const [run, busy] = useAction();
  const max = p.locations.find((l) => l.code === f.from)?.qty ?? 0;
  return <Modal title={`Déplacer · ${p.name}`} onClose={onClose}><div className="stack">
    <div className="grid cols-2">
      <Field label="Depuis"><select className="input" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })}>{p.locations.map((l) => <option key={l.code} value={l.code}>{l.code} ({l.qty})</option>)}</select></Field>
      <Field label="Vers"><select className="input" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })}><option value="">Choisir…</option>
        {(locs.data ?? []).filter((l) => l.active && l.code !== f.from).map((l) => <option key={l.id} value={l.code}>{l.code}</option>)}</select></Field></div>
    <Field label={`Quantité (au plus ${max})`}><input className="input" inputMode="numeric" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value.replace(/\D/g, '') })} /></Field>
    <Btn kind="primary" disabled={busy || !f.to || !(Number(f.qty) > 0) || Number(f.qty) > max} onClick={() => run(async () => {
      const r = await act('lg_stock_transfer', { p_product: p.id, p_from_code: f.from, p_to_code: f.to, p_qty: Number(f.qty) }, `Transfert ${p.name}`);
      if (r?.ok) onDone();
      return r;
    }, { ok: 'Déplacement enregistré' })}>Déplacer</Btn></div></Modal>;
}

// ----------------------------------------------------------------- mouvements
function Moves({ product, compact }) {
  const [kind, setKind] = useState(''); const [days, setDays] = useState('30');
  const { data, error, loading } = useRpc('lg_stock_moves', { p_product: product ?? null, p_kind: kind || null, p_days: Number(days) });
  return <div className="stack">
    {!compact && <div className="row" style={{ flexWrap: 'wrap' }}>
      <select className="input" style={{ maxWidth: 220 }} value={kind} onChange={(e) => setKind(e.target.value)}><option value="">Tous les mouvements</option>
        {Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      <select className="input" style={{ maxWidth: 160 }} value={days} onChange={(e) => setDays(e.target.value)}>
        {[['7', '7 jours'], ['30', '30 jours'], ['90', '3 mois'], ['366', '1 an']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      {data?.length > 0 && <Btn onClick={() => downloadCsv('mouvements-stock.csv', [['date', 'produit', 'mouvement', 'quantite', 'stock_apres', 'emplacement', 'commande', 'reference', 'motif', 'par'],
        ...data.map((m) => [m.at, m.product, KIND[m.kind], m.qty, m.stock_after, m.location, m.order_number, m.ref, m.reason, m.by])])}>Exporter (Excel)</Btn>}</div>}
    <ErrorBox error={error} />
    {loading && !data ? <Loading /> : !data?.length ? <Card><Empty icon="clock">Aucun mouvement sur la période.</Empty></Card>
      : <Card><div className="scroll-x"><table className="tbl"><thead><tr><th>Quand</th>{!product && <th>Produit</th>}<th>Mouvement</th><th className="num">Quantité</th>
        <th className="num">Stock après</th><th>Détail</th></tr></thead><tbody>{data.map((m) => <tr key={m.id}>
          <td className="small">{dmy(m.at)} <span className="muted">{ago(m.at)}</span></td>{!product && <td>{m.product}</td>}
          <td><Badge kind={m.qty > 0 ? 'ok' : m.kind === 'transfer' ? '' : 'todo'}>{KIND[m.kind]}</Badge></td>
          <td className="num"><b>{m.kind === 'transfer' ? m.qty : m.qty > 0 ? `+${m.qty}` : m.qty}</b></td><td className="num">{n(m.stock_after)}</td>
          <td className="small">{[m.location, m.order_number && `commande n° ${m.order_number}`, m.ref, m.reason, m.by].filter(Boolean).join(' · ')}</td></tr>)}</tbody></table></div></Card>}
  </div>;
}

// ----------------------------------------------------------------- à commander
function ToOrder({ ov, canBuy, onCreated }) {
  const [run, busy] = useAction();
  const list = (ov.data?.products ?? []).filter((p) => p.active && ['low', 'out'].includes(p.state)).sort((a, b) => (a.supplier ?? '').localeCompare(b.supplier ?? '') || a.name.localeCompare(b.name));
  const text = () => {
    const by = new Map(); for (const p of list) (by.get(p.supplier || 'Sans fournisseur') ?? by.set(p.supplier || 'Sans fournisseur', []).get(p.supplier || 'Sans fournisseur')).push(p);
    return [...by].map(([s, ps]) => `${s} :\n${ps.filter((p) => p.to_order > 0).map((p) => `- ${p.name}${p.sku ? ` (${p.sku})` : ''} : ${p.to_order}`).join('\n')}`).join('\n\n');
  };
  if (ov.loading && !ov.data) return <Loading />;
  if (!list.length) return <Card><Empty icon="check">Rien à commander : aucun produit sous son seuil d'alerte.<br /><span className="small">Fixez un seuil dans la fiche de chaque produit pour être prévenu.</span></Empty></Card>;
  return <div className="stack">
    <div className="row" style={{ flexWrap: 'wrap' }}>{canBuy && <Btn kind="primary" disabled={busy} onClick={() => run(async () => {
      const r = await rpc('lg_purchase_orders_from_alerts', {});
      if (r.without_supplier?.length) alert(`Sans fournisseur (à compléter dans la fiche) : ${r.without_supplier.join(', ')}`);
      if (r.created.length) onCreated(); ov.reload();
      return r.created.length ? r : { ok: false, error: 'nothing_to_order' };
    }, { ok: 'Bons de commande créés (brouillons à vérifier)' })}><Icon name="receipt" size={16} />Créer les bons de commande</Btn>}
      <Btn onClick={() => window.open(`https://wa.me/?text=${encodeURIComponent(`Commande de réassort :\n\n${text()}`)}`, '_blank', 'noopener')}><Icon name="message" size={16} />Envoyer par WhatsApp</Btn>
      <Btn onClick={() => navigator.clipboard?.writeText(text())}>Copier la liste</Btn>
      <Btn onClick={() => downloadCsv('a-commander.csv', [['fournisseur', 'produit', 'reference', 'stock', 'reserve', 'disponible', 'seuil', 'a_commander'],
        ...list.map((p) => [p.supplier, p.name, p.sku, p.stock, p.reserved, p.available, p.min_stock, p.to_order])])}>Exporter (Excel)</Btn></div>
    <Card><div className="scroll-x"><table className="tbl"><thead><tr><th>Produit</th><th>Fournisseur</th><th className="num">Disponible</th><th className="num">Seuil</th><th className="num">En commande</th><th className="num">À commander</th><th>État</th></tr></thead>
      <tbody>{list.map((p) => <tr key={p.id}><td><b>{p.name}</b><div className="small muted">{p.sku}</div></td><td>{p.supplier ?? '—'}</td><td className="num">{n(p.available)}</td>
        <td className="num">{n(p.min_stock)}</td><td className="num">{p.on_order ? n(p.on_order) : ''}</td><td className="num"><b>{p.to_order ? n(p.to_order) : '—'}</b></td><td><Badge kind={STATE[p.state][1]}>{STATE[p.state][0]}</Badge></td></tr>)}</tbody></table></div></Card>
    <p className="small muted">Quantité proposée : de quoi revenir à deux fois le seuil d'alerte, en tenant compte des commandes clients réservées et de ce qui
      est déjà en commande chez les fournisseurs. « Créer les bons de commande » prépare un brouillon par fournisseur.</p>
  </div>;
}

// ----------------------------------------------------------------- import
function ImportForm({ onClose, onDone }) {
  const [rows, setRows] = useState(null); const [update, setUpdate] = useState(false); const [report, setReport] = useState(null);
  const [run, busy] = useAction();
  const template = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + PRODUCTS_TEMPLATE], { type: 'text/csv' })); a.download = 'produits-gabarit.csv'; a.click(); };
  const ERR = { invalid_name: 'nom manquant', invalid_amount: 'nombre invalide', duplicate_code: 'référence déjà prise' };
  return <Modal title="Importer des produits" onClose={onClose}><div className="stack">
    <p className="small" style={{ margin: 0 }}>Depuis Excel : <b>Fichier → Enregistrer sous → CSV (séparateur point-virgule)</b>. Colonnes : nom, reference, code_barres, prix,
      poids_kg, stock, seuil_alerte, prix_achat, fournisseur (seul « nom » est obligatoire).</p>
    <div className="row"><Btn size="sm" onClick={template}>Télécharger le gabarit</Btn>
      <label className="btn sm primary">Choisir le fichier<input type="file" accept=".csv,text/csv" hidden onChange={async (e) => {
        const fl = e.target.files[0]; if (fl) { setRows(parseProductsCsv(await fl.text())); setReport(null); } }} /></label></div>
    {rows && <><div className="flash ok">{rows.length} produit(s) lu(s) dans le fichier.</div>
      <label className="check"><input type="checkbox" checked={update} onChange={(e) => setUpdate(e.target.checked)} /> Mettre à jour les produits qui existent déjà (même référence ou code-barres) — le stock n'est jamais écrasé</label>
      <Btn kind="primary" disabled={busy || !rows.length} onClick={() => run(async () => {
        const tot = { created: 0, updated: 0, skipped: 0, errors: [] };
        for (let i = 0; i < rows.length; i += 200) {
          const r = await rpc('lg_products_import', { p_rows: rows.slice(i, i + 200), p_update: update });
          tot.created += r.created; tot.updated += r.updated; tot.skipped += r.skipped; tot.errors.push(...r.errors.map((x) => ({ ...x, line: x.line + i })));
        }
        setReport(tot); return { ok: true };
      }, { ok: 'Import terminé' })}>Importer</Btn></>}
    {report && <div className="card flat"><b>{report.created} créé(s), {report.updated} mis à jour, {report.skipped} déjà présent(s)</b>
      {report.errors.length > 0 && <ul className="small">{report.errors.slice(0, 30).map((e) => <li key={e.line}>ligne {e.line}{e.name ? ` (${e.name})` : ''} : {ERR[e.error] ?? e.error}</li>)}</ul>}
      <Btn size="sm" kind="primary" onClick={onDone}>Voir les produits</Btn></div>}
  </div></Modal>;
}
