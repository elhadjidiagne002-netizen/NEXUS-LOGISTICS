// Enseignes (clients professionnels) : conditions de vente, magasins, prix convenus par produit (HT ou TTC), TVA.
// Les prix convenus s'appliquent seuls aux commandes des magasins (saisie, import, bons collectés) ; la facture est
// adressée à la raison sociale de l'enseigne, livrée au magasin.
import React, { useMemo, useState } from 'react';
import { rpc } from '../lib/backend.js';
import { parseCsvRows, downloadCsv } from '../lib/csv.js';
import { useRpc, useAction, Icon, Btn, Card, Badge, Empty, Loading, ErrorBox, PageHead, Modal, Field, Tabs, formatF } from '../components/ui.jsx';
import { useMe, has } from '../App.jsx';

const EMPTY = { name: '', prices_ht: true, vat_exempt: false, discount_pct: '', payment_terms_days: '', sender_match: '', ninea: '', rc: '', address: '', email: '', phone: '', note: '', active: true };

export default function Accounts() {
  const me = useMe();
  const { data, error, loading, reload } = useRpc('lg_accounts_list', {});
  const [open, setOpen] = useState(null);
  const [edit, setEdit] = useState(null);
  const write = has(me, 'accountant', 'support');
  if (open) return <AccountDetail id={open} write={write} onBack={() => { setOpen(null); reload(); }} />;
  return <>
    <PageHead title="Enseignes" back="/" sub="Clients professionnels : magasins, prix convenus, TVA, délai de paiement.">
      {write && <Btn kind="primary" onClick={() => setEdit({ ...EMPTY })}>＋ Enseigne</Btn>}</PageHead>
    <ErrorBox error={error} />
    {loading && !data ? <Loading /> : !data?.length ? <Card><Empty icon="store">Aucune enseigne. Créez-en une pour appliquer ses prix et ses conditions à ses commandes.</Empty></Card> :
      <Card><div className="scroll-x"><table className="tbl"><thead><tr><th>Enseigne</th><th>Conditions</th><th className="num">Magasins</th><th className="num">Prix convenus</th><th className="num">À recevoir</th></tr></thead>
        <tbody>{data.map((a) => <tr key={a.id} style={{ cursor: 'pointer', opacity: a.active ? 1 : 0.5 }} onClick={() => setOpen(a.id)}>
          <td><b>{a.name}</b>{a.sender_match && <div className="small muted">bons de « {a.sender_match} »</div>}</td>
          <td className="small">{terms(a)}</td><td className="num">{a.stores}</td><td className="num">{a.prices}</td><td className="num">{a.open_fcfa ? formatF(a.open_fcfa) : '—'}</td></tr>)}</tbody></table></div></Card>}
    {edit && <AccountForm a={edit} onClose={() => setEdit(null)} onDone={(id) => { setEdit(null); reload(); if (id) setOpen(id); }} />}
  </>;
}

const terms = (a) => [a.prices_ht ? 'prix HT' : 'prix TTC', a.vat_exempt && 'exonéré de TVA', a.discount_pct > 0 && `remise ${a.discount_pct} %`,
  a.payment_terms_days != null ? `à ${a.payment_terms_days} jours` : 'paiement à la livraison'].filter(Boolean).join(' · ');

function AccountForm({ a, onClose, onDone }) {
  const [f, setF] = useState({ ...EMPTY, ...a, discount_pct: a.discount_pct ? String(a.discount_pct) : '', payment_terms_days: a.payment_terms_days ?? '' });
  const [run, busy] = useAction();
  const s = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return <Modal title={a.id ? a.name : 'Nouvelle enseigne'} onClose={onClose}><div className="stack">
    <Field label="Raison sociale (nom sur la facture)"><input className="input" value={f.name} onChange={s('name')} autoFocus={!a.id} /></Field>
    <div className="grid cols-2">
      <Field label="Délai de paiement (jours, vide = à la livraison)"><input className="input" inputMode="numeric" value={f.payment_terms_days} onChange={(e) => setF({ ...f, payment_terms_days: e.target.value.replace(/\D/g, '') })} /></Field>
      <Field label="Remise sur les produits sans prix convenu (%)"><input className="input" inputMode="decimal" value={f.discount_pct} onChange={s('discount_pct')} /></Field>
      <Field label="Ses bons arrivent de (domaine ou adresse e-mail)"><input className="input" placeholder="ex. enseigne.sn" value={f.sender_match ?? ''} onChange={s('sender_match')} /></Field>
      <Field label="E-mail de sa comptabilité"><input className="input" type="email" value={f.email ?? ''} onChange={s('email')} /></Field>
      <Field label="NINEA"><input className="input" value={f.ninea ?? ''} onChange={s('ninea')} /></Field>
      <Field label="RC"><input className="input" value={f.rc ?? ''} onChange={s('rc')} /></Field>
      <Field label="Adresse de facturation"><input className="input" value={f.address ?? ''} onChange={s('address')} /></Field>
      <Field label="Téléphone"><input className="input" type="tel" value={f.phone ?? ''} onChange={s('phone')} /></Field>
    </div>
    <label className="check"><input type="checkbox" checked={f.prices_ht} onChange={(e) => setF({ ...f, prices_ht: e.target.checked })} /> Prix convenus et prix de ses bons exprimés hors taxes (HT)</label>
    <label className="check"><input type="checkbox" checked={f.vat_exempt} onChange={(e) => setF({ ...f, vat_exempt: e.target.checked })} /> Client exonéré de TVA (attestation à conserver)</label>
    {a.id && <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Enseigne active</label>}
    <Field label="Note"><input className="input" value={f.note ?? ''} onChange={s('note')} /></Field>
    <Btn kind="primary" size="xl" disabled={busy || !f.name.trim()} onClick={() => run(async () => {
      const r = await rpc('lg_account_upsert', { p: { ...f, discount_pct: f.discount_pct === '' ? 0 : Number(String(f.discount_pct).replace(',', '.')),
        payment_terms_days: f.payment_terms_days === '' ? null : Number(f.payment_terms_days) } });
      onDone(a.id ? null : r.id); return r;
    }, { ok: 'Enseigne enregistrée' })}>Enregistrer</Btn></div></Modal>;
}

function AccountDetail({ id, write, onBack }) {
  const { data: a, error, loading, reload } = useRpc('lg_account_get', { p_id: id });
  const [tab, setTab] = useState('prices');
  const [edit, setEdit] = useState(false);
  if (loading && !a) return <Loading />;
  if (error) return <><PageHead title="Enseigne" /><ErrorBox error={error} /><Btn onClick={onBack}>Retour</Btn></>;
  return <>
    <div className="page-head"><button className="back" aria-label="Retour" onClick={onBack}><Icon name="arrowLeft" size={18} /></button><h1>{a.name}</h1>
      {write && <Btn onClick={() => setEdit(true)}>Conditions</Btn>}</div>
    <p className="page-sub">{terms(a)}{a.ninea ? ` · NINEA ${a.ninea}` : ''}</p>
    <Tabs tabs={[['prices', `Prix convenus (${a.prices.filter((p) => p.tariff != null).length})`], ['stores', `Magasins (${a.stores.length})`]]} value={tab} onChange={setTab} />
    {tab === 'prices' ? <Prices a={a} write={write} reload={reload} /> : <Stores a={a} write={write} reload={reload} />}
    {edit && <AccountForm a={a} onClose={() => setEdit(false)} onDone={() => { setEdit(false); reload(); }} />}
  </>;
}

function Prices({ a, write, reload }) {
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState({});
  const [imported, setImported] = useState(null);
  const [run, busy] = useAction();
  const unit = a.prices_ht ? 'HT' : 'TTC';
  const list = useMemo(() => a.prices.filter((p) => !q || `${p.name} ${p.sku ?? ''} ${p.barcode ?? ''}`.toLowerCase().includes(q.toLowerCase())), [a.prices, q]);
  const changed = Object.keys(draft).length;
  const importFile = (file) => run(async () => {
    const { head, rows } = parseCsvRows(await file.text());
    const ci = head.findIndex((h) => /^(reference|ref|code|code_barres|ean|sku|nom|produit|article)$/.test(h));
    const pi = head.findIndex((h) => /^(prix|prix_ht|prix_ttc|tarif|price)/.test(h));
    if (ci < 0 || pi < 0) return { ok: false, error: 'invalid_file' };
    const r = await rpc('lg_account_prices_import', { p_account: a.id, p_rows: rows.map((x) => ({ code: x[ci], price: x[pi] })) });
    reload(); setImported(r);
    return r;
  });
  return <Card style={{ marginTop: 12 }}>
    <div className="row" style={{ flexWrap: 'wrap' }}>
      <input className="input" style={{ flex: 1, minWidth: 180 }} placeholder="Chercher un produit" value={q} onChange={(e) => setQ(e.target.value)} />
      {write && <label className="btn">Importer une grille (Excel/CSV)<input type="file" accept=".csv,text/csv" hidden onChange={(e) => e.target.files[0] && importFile(e.target.files[0])} /></label>}
      <Btn onClick={() => downloadCsv(`tarifs_${a.name}.csv`, [['reference', 'code_barres', 'produit', `prix_${unit.toLowerCase()}`, 'tva'],
        ...a.prices.map((p) => [p.sku, p.barcode, p.name, p.tariff ?? '', p.vat_rate])])}>Exporter</Btn></div>
    {imported && <div className={`flash ${imported.unknown_count ? 'todo' : 'ok'}`}>{imported.imported} prix importés{imported.unknown_count ? ` · ${imported.unknown_count} code(s) inconnu(s) : ${imported.unknown.slice(0, 8).join(', ')}` : ''}</div>}
    <p className="small muted">Prix {unit} par unité. Un produit sans prix convenu est vendu au prix catalogue{a.discount_pct > 0 ? ` moins ${a.discount_pct} %` : ''}.
      {a.vat_exempt ? ' Client exonéré : aucune TVA facturée.' : ''} Grille importée : colonnes « reference » (ou code-barres, ou nom) et « prix ».</p>
    <div className="scroll-x"><table className="tbl"><thead><tr><th>Produit</th><th className="num">Catalogue TTC</th><th className="num">TVA</th><th className="num">Prix convenu {unit}</th><th className="num">Soit TTC</th></tr></thead>
      <tbody>{list.map((p) => {
        const v = draft[p.product_id] ?? (p.tariff ?? '');
        const n = v === '' ? null : Number(v);
        const ttc = n == null ? null : a.prices_ht ? Math.round(n * (1 + p.vat_rate / 100)) : n;
        return <tr key={p.product_id}><td>{p.name}<div className="small muted mono">{[p.sku, p.barcode].filter(Boolean).join(' · ')}</div></td>
          <td className="num">{formatF(p.catalogue_fcfa)}</td><td className="num">{p.vat_rate} %</td>
          <td className="num">{write ? <input className="input" style={{ width: 110 }} inputMode="numeric" value={v} placeholder="—"
            onChange={(e) => setDraft({ ...draft, [p.product_id]: e.target.value.replace(/\D/g, '') })} /> : (p.tariff != null ? formatF(p.tariff) : '—')}</td>
          <td className="num">{ttc == null ? '' : formatF(ttc)}{ttc != null && ttc > p.catalogue_fcfa && <div className="small" style={{ color: 'var(--bad)' }}>au-dessus du catalogue</div>}</td></tr>;
      })}</tbody></table></div>
    {write && changed > 0 && <div className="row" style={{ marginTop: 10 }}><Btn kind="primary" disabled={busy} onClick={() => run(async () => {
      const r = await rpc('lg_account_prices_set', { p_account: a.id, p_prices: Object.entries(draft).map(([product_id, v]) => ({ product_id, price_fcfa: v === '' ? null : Number(v) })) });
      setDraft({}); reload(); return r;
    }, { ok: 'Prix enregistrés' })}>Enregistrer {changed} prix</Btn><Btn kind="ghost" onClick={() => setDraft({})}>Annuler</Btn></div>}
  </Card>;
}

function Stores({ a, write, reload }) {
  const pricing = useRpc('lg_pricing', {});
  const [s, setS] = useState(null);
  const [run, busy] = useAction();
  const zones = pricing.data?.zones?.filter((z) => z.served) ?? [];
  return <Card style={{ marginTop: 12 }}>
    {write && <Btn kind="primary" onClick={() => setS({ name: '', phone: '', address: '', landmark: '', zone: '' })}>＋ Magasin</Btn>}
    <p className="small muted">Un magasin est le lieu livré : ses commandes prennent les prix et les conditions de l'enseigne, et la conversion d'un bon reçu le propose directement.</p>
    {!a.stores.length ? <Empty icon="store">Aucun magasin.</Empty> : <div className="scroll-x"><table className="tbl"><thead><tr><th>Magasin</th><th>Téléphone</th><th>Zone</th><th>Adresse</th><th></th></tr></thead>
      <tbody>{a.stores.map((x) => <tr key={x.id}><td><b>{x.name}</b></td><td>{x.phone}</td><td>{x.zone ?? '—'}</td><td className="small">{[x.address, x.landmark].filter(Boolean).join(' · ')}</td>
        <td>{write && <><Btn size="sm" onClick={() => setS({ ...x })}>Modifier</Btn> <Btn size="sm" kind="ghost" disabled={busy}
          onClick={() => run(async () => { const r = await rpc('lg_account_store_unlink', { p_customer: x.id }); reload(); return r; }, { ok: 'Magasin détaché' })}>Détacher</Btn></>}</td></tr>)}</tbody></table></div>}
    {s && <Modal title={s.id ? s.name : 'Nouveau magasin'} onClose={() => setS(null)}><div className="stack">
      <Field label="Nom du magasin"><input className="input" value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} /></Field>
      <div className="grid cols-2"><Field label="Téléphone (réception)"><input className="input" type="tel" value={s.phone} onChange={(e) => setS({ ...s, phone: e.target.value })} /></Field>
        <Field label="Zone"><select className="input" value={s.zone ?? ''} onChange={(e) => setS({ ...s, zone: e.target.value })}><option value="">—</option>
          {zones.map((z) => <option key={z.name}>{z.name}</option>)}</select></Field></div>
      <Field label="Adresse"><input className="input" value={s.address ?? ''} onChange={(e) => setS({ ...s, address: e.target.value })} /></Field>
      <Field label="Repère / quai de réception"><input className="input" value={s.landmark ?? ''} onChange={(e) => setS({ ...s, landmark: e.target.value })} /></Field>
      <Btn kind="primary" size="xl" disabled={busy || !s.name || !s.phone} onClick={() => run(async () => {
        const r = await rpc('lg_account_store_upsert', { p_account: a.id, p_store: { ...s, zone: s.zone || null } }); setS(null); reload(); return r;
      }, { ok: 'Magasin enregistré' })}>Enregistrer</Btn></div></Modal>}
  </Card>;
}
