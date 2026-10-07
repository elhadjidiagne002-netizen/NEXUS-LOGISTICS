// Module 11 — Entrepôt : emplacements, rangement, inventaire tournant, recherche de produit.
import React, { useState } from 'react';
import { rpc } from '../lib/backend.js';
import { act } from '../lib/offline.js';
import { useRpc, useAction, feedback, Icon, Btn, Card, Badge, Empty, Loading, ErrorBox, PageHead, Modal, Field, Tabs, Chips, Stat, ago } from '../components/ui.jsx';
import { Scanner } from '../components/field.jsx';
import { useMe, has } from '../App.jsx';

export default function Warehouse() {
  const [tab, setTab] = useState('inventory');
  return <>
    <PageHead title="Entrepôt" back="/" sub="Où est chaque produit, ce qui est rangé, ce qui a été compté." />
    <Tabs value={tab} onChange={setTab} tabs={[['inventory', 'Inventaire du jour'], ['putaway', 'Rangement'], ['find', 'Rechercher'], ['locations', 'Emplacements']]} />
    {tab === 'inventory' && <Inventory />}{tab === 'putaway' && <PutAway />}{tab === 'find' && <Find />}{tab === 'locations' && <Locations />}
  </>;
}

function Inventory() {
  const { data, error, loading, reload } = useRpc('lg_inventory_today', { p_limit: 8 });
  const [loc, setLoc] = useState(null);
  const me = useMe();
  const hist = useRpc('lg_inventory_history', { p_days: 30 }, { skip: !has(me, 'dock_chief') });
  if (loading && !data) return <Loading />;
  return <div className="split">
    <div className="stack"><ErrorBox error={error} />
      <p className="small muted" style={{ margin: 0 }}>Comptage tournant : les emplacements comptés il y a le plus longtemps d'abord. Comptez ce qui est réellement là.</p>
      {!data?.length ? <Card><Empty icon="check">Aucun emplacement à compter.</Empty></Card> : <div className="grid cols-2">{data.map((l) =>
        <Card key={l.id} kind={l.last_counted_at ? '' : 'todo'}><div className="row between"><h3 className="mono" style={{ margin: 0 }}>{l.code}</h3>
          <span className="small muted">{l.last_counted_at ? `compté ${ago(l.last_counted_at)}` : 'jamais compté'}</span></div>
          <div className="small muted" style={{ margin: '6px 0 10px' }}>{l.contents.length} produit(s)</div>
          <Btn kind="primary" block onClick={() => setLoc(l)}><Icon name="scan" size={18} />Compter</Btn></Card>)}</div>}
    </div>
    {has(me, 'dock_chief') && <Card><h3>Écarts des 30 derniers jours</h3>
      {!hist.data?.length ? <Empty icon="check">Aucun écart.</Empty> : <div className="list">{hist.data.map((h, i) => <div key={i} className="line">
        <span className="mono small">{h.location}</span><span className="grow small">{h.product}<div className="muted">{h.reason ?? '—'} · {h.by} · {ago(h.at)}</div></span>
        <b style={{ color: h.gap < 0 ? 'var(--bad)' : 'var(--ok)' }}>{h.gap > 0 ? '+' : ''}{h.gap}</b></div>)}</div>}</Card>}
    {loc && <Count loc={loc} onClose={() => setLoc(null)} onDone={() => { setLoc(null); reload(); hist.reload?.(); }} />}
  </div>;
}

function Count({ loc, onClose, onDone }) {
  const [c, setC] = useState(Object.fromEntries(loc.contents.map((p) => [p.product_id, ''])));
  const [why, setWhy] = useState({});
  const [run, busy] = useAction();
  const ready = loc.contents.every((p) => c[p.product_id] !== '');
  return <Modal title={`Comptage · ${loc.code}`} onClose={onClose}><div className="stack">
    {loc.contents.map((p) => { const gap = c[p.product_id] === '' ? 0 : Number(c[p.product_id]) - p.expected; return <div key={p.product_id} className="stack" style={{ gap: 6 }}>
      <div className="line"><span className="grow"><b>{p.name}</b><div className="small muted mono">{p.barcode ?? '—'}</div></span>
        <input className="input" style={{ width: 96, textAlign: 'center', fontWeight: 700 }} inputMode="numeric" placeholder="compté" value={c[p.product_id]}
          onChange={(e) => setC({ ...c, [p.product_id]: e.target.value.replace(/\D/g, '') })} /></div>
      {gap !== 0 && <div className="row"><Badge kind={gap < 0 ? 'bad' : 'info'}>{gap > 0 ? '+' : ''}{gap} (attendu {p.expected})</Badge>
        <Chips options={[['casse', 'Casse'], ['erreur de rangement', 'Rangement'], ['vol', 'Vol'], ['réception non saisie', 'Réception']]} value={why[p.product_id]} onChange={(v) => setWhy({ ...why, [p.product_id]: v })} /></div>}
    </div>; })}
    <p className="small muted">Les quantités attendues ne sont révélées qu'en cas d'écart : comptez sans vous laisser influencer.</p>
    <Btn kind="primary" size="xl" disabled={!ready || busy} onClick={() => run(async () => {
      const r = await act('lg_inventory_count', { p_location: loc.id, p_counts: loc.contents.map((p) => ({ product_id: p.product_id, counted: Number(c[p.product_id]), reason: why[p.product_id] ?? null })) }, `Inventaire ${loc.code}`);
      if (r.ok) onDone(); return r;
    }, { ok: 'Comptage enregistré' })}>Valider le comptage</Btn></div></Modal>;
}

function PutAway() {
  const [prod, setProd] = useState(''); const [qty, setQty] = useState('1'); const [last, setLast] = useState(null);
  const [run, busy] = useAction();
  return <Card style={{ maxWidth: 640 }}><h2>Ranger de la marchandise</h2>
    <p className="small muted">1. Scannez le produit · 2. indiquez la quantité · 3. scannez l'étiquette de l'emplacement.</p>
    <Field label="Produit (code-barres, référence ou code NXI)"><input className="input mono" value={prod} onChange={(e) => setProd(e.target.value)} /></Field>
    <Field label="Quantité rangée"><input className="input" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} /></Field>
    <div style={{ marginTop: 10 }}><Scanner autoFocusInput={false} busy={busy} placeholder="Code de l'emplacement (ex. A-02-1)" onCode={(loc) => run(async () => {
      const r = await act('lg_put_away', { p_product_code: prod, p_location_code: loc, p_qty: Number(qty) }, `Rangement ${loc}`);
      if (r.ok && !r.queued) { feedback('ok'); setLast(r); setProd(''); setQty('1'); }
      return r;
    })} /></div>
    {last && <div className="flash ok" style={{ marginTop: 10 }}><Icon name="check" /><div><b>{last.product}</b> → <span className="mono">{last.location}</span><div className="small">{last.qty} en place maintenant</div></div></div>}
  </Card>;
}

function Find() {
  const [q, setQ] = useState(''); const [res, setRes] = useState(null);
  return <div className="stack" style={{ maxWidth: 760 }}>
    <form className="row" onSubmit={async (e) => { e.preventDefault(); setRes(await rpc('lg_product_find', { p_q: q })); }}>
      <input className="input" style={{ flex: 1 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nom, code-barres, référence…" />
      <Btn kind="primary" type="submit"><Icon name="search" size={18} />Chercher</Btn></form>
    {res && (res.length === 0 ? <Card><Empty icon="search">Aucun produit.</Empty></Card> : res.map((p) => <Card key={p.id}>
      <div className="row between"><b>{p.name}</b><span className="small muted">stock site : {p.stock ?? '—'}</span></div>
      <div className="small muted mono">{p.barcode ?? p.sku ?? ''} · {p.vendor}</div>
      <div className="chips" style={{ marginTop: 8 }}>{p.locations.length ? p.locations.map((l) => <span key={l.code} className="badge info plain"><Icon name="pin" size={12} /> {l.code} · {l.qty}</span>)
        : <Badge kind="todo">pas en entrepôt (chez le vendeur)</Badge>}</div></Card>))}
  </div>;
}

function Locations() {
  const { data, error, loading, reload } = useRpc('lg_locations_list', {});
  const [form, setForm] = useState(null);
  const [run, busy] = useAction();
  const me = useMe();
  if (loading && !data) return <Loading />;
  const used = (data ?? []).filter((l) => l.contents.length).length;
  return <div className="stack"><ErrorBox error={error} />
    <div className="stats"><Stat icon="layers" label="emplacements" value={data?.length ?? 0} /><Stat icon="box" c="#059669" label="occupés" value={used} />
      <Stat icon="clock" c="#ea580c" label="jamais comptés" value={(data ?? []).filter((l) => !l.last_counted_at).length} /></div>
    {has(me, 'dock_chief') && <div className="row"><Btn kind="primary" onClick={() => setForm({ code: '', kind: 'shelf', label: '' })}><Icon name="plus" size={18} />Emplacement</Btn></div>}
    <Card><div className="scroll-x"><table className="tbl"><thead><tr><th>Code</th><th>Type</th><th>Libellé</th><th>Contenu</th><th>Compté</th></tr></thead>
      <tbody>{(data ?? []).map((l) => <tr key={l.id}><td className="mono"><b>{l.code}</b></td><td>{{ shelf: 'Étagère', floor: 'Sol', cold: 'Froid', bulk: 'Vrac' }[l.kind]}</td>
        <td>{l.label}</td><td className="small">{l.contents.map((p) => `${p.name} (${p.qty})`).join(' · ') || <span className="muted">vide</span>}</td>
        <td className="small muted">{l.last_counted_at ? ago(l.last_counted_at) : 'jamais'}</td></tr>)}</tbody></table></div></Card>
    {form && <Modal title="Nouvel emplacement" onClose={() => setForm(null)}><div className="stack">
      <Field label="Code (allée-étagère-niveau)"><input className="input mono" value={form.code} placeholder="A-03-2" onChange={(e) => setForm({ ...form, code: e.target.value })} /></Field>
      <Chips options={[['shelf', 'Étagère'], ['floor', 'Sol'], ['cold', 'Froid'], ['bulk', 'Vrac']]} value={form.kind} onChange={(kind) => setForm({ ...form, kind })} />
      <Field label="Libellé"><input className="input" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></Field>
      <Btn kind="primary" disabled={!form.code || busy} onClick={() => run(async () => { const r = await rpc('lg_location_upsert', { p: form }); setForm(null); reload(); return r; }, { ok: 'Emplacement créé' })}>Créer</Btn>
    </div></Modal>}
  </div>;
}
