// Cycle D1 — Commandes reçues : collecte automatique avant la préparation. Documents reçus par e-mail (adresse
// dédiée) ou déposés ici (PDF, Excel, Word, photo), lus par l'IA, vérifiés côte à côte avec l'original, puis
// transformés en commande ou exportés vers Excel. Les correspondances apprises rapprochent les bons suivants.
import React, { useMemo, useState } from 'react';
import { rpc } from '../lib/backend.js';
import { downloadCsv } from '../lib/csv.js';
import { useRpc, useAction, Icon, Btn, Card, Badge, Empty, Loading, ErrorBox, PageHead, Modal, Field, Tabs, Chips, Stat, formatF, dmy, ago } from '../components/ui.jsx';
import { useMe } from '../App.jsx';

const STATUS = { received: ['reçu', ''], extracting: ['lecture…', 'info'], to_review: ['à vérifier', 'todo'], converted: ['commande créée', 'ok'],
  done: ['traité', 'ok'], rejected: ['écarté', ''], error: ['erreur', 'bad'] };
const KIND = [['order', 'Bon de commande'], ['invoice', 'Facture'], ['delivery_note', 'Bon de livraison'], ['price_list', 'Liste de prix'], ['custom', 'Autre (champs libres)']];
const MAX = 1_500_000;
const ERR = { conversion_failed: 'document illisible', unsupported_type: 'format non lu', ai_busy: 'IA occupée, relancez', ai_failed: 'IA indisponible',
  ai_bad_json: 'réponse de l’IA illisible', no_ai: 'IA non configurée', no_converter: 'conversion non configurée', empty_document: 'document vide', file_missing: 'fichier perdu' };
const toB64 = (file) => new Promise((ok, ko) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = ko; r.readAsDataURL(file); });

export default function Collecte() {
  const me = useMe();
  const [tab, setTab] = useState('open'); const [open, setOpen] = useState(null);
  const list = useRpc('lg_inbox_list', { p_status: tab === 'all' ? null : tab }, { refresh: 20000, skip: !['open', 'converted', 'all'].includes(tab) });
  const counts = useRpc('lg_inbox_list', { p_status: 'open' }, { refresh: 30000 });
  const toReview = (counts.data ?? []).filter((d) => d.status === 'to_review').length;
  return <>
    <PageHead title="Commandes reçues" back="/" sub="Les bons de commande reçus par e-mail ou déposés ici sont lus par l’IA. Vérifiez, puis créez la commande en un geste." />
    {me.is_admin && <Address />}
    <Upload onDone={(id) => { list.reload(); counts.reload(); if (id) setOpen(id); }} />
    <Tabs value={tab} onChange={setTab} tabs={[['open', `À vérifier${toReview ? ` (${toReview})` : ''}`], ['converted', 'Commandes créées'], ['all', 'Tous'], ['templates', 'Modèles de lecture'], ['aliases', 'Correspondances'], ['export', 'Export Excel']]} />
    {['open', 'converted', 'all'].includes(tab) && <DocList list={list} onOpen={setOpen} />}
    {tab === 'templates' && <Templates />}
    {tab === 'aliases' && <Aliases />}
    {tab === 'export' && <Export />}
    {open && <Review id={open} onClose={() => setOpen(null)} onChange={() => { list.reload(); counts.reload(); }} />}
  </>;
}

// ----------------------------------------------------------------- adresse de réception
function Address() {
  const { data } = useRpc('lg_inbox_address', {});
  const [help, setHelp] = useState(false);
  if (!data) return null;
  return <Card style={{ marginBottom: 12 }}><div className="row between" style={{ flexWrap: 'wrap' }}>
    <div><b>Adresse de réception des commandes</b><div className="mono" style={{ wordBreak: 'break-all' }}>{data.address}</div>
      {!data.active && <div className="small" style={{ color: 'var(--warn, #b45309)' }}>Réception par e-mail pas encore activée sur la plateforme : déposez les fichiers ci-dessous en attendant.</div>}</div>
    <div className="row"><Btn size="sm" onClick={() => navigator.clipboard?.writeText(data.address)}>Copier</Btn><Btn size="sm" kind="ghost" onClick={() => setHelp(!help)}>Comment faire ?</Btn></div></div>
    {help && <ol className="small" style={{ marginBottom: 0 }}>
      <li>Dans Gmail : Paramètres → <b>Transfert et POP/IMAP</b> → « Ajouter une adresse de transfert » → collez l’adresse ci-dessus (Gmail envoie un code de confirmation : il arrive ici, dans « À vérifier »).</li>
      <li>Puis Paramètres → <b>Filtres</b> → « Créer un filtre » : De = l’adresse de l’enseigne (ex. <span className="mono">@enseigne.sn</span>), « Contient une pièce jointe » → <b>Transférer à</b> l’adresse ci-dessus.</li>
      <li>Chaque bon reçu arrive ici, lu par l’IA, en quelques secondes. Aucun mot de passe de messagerie n’est demandé.</li></ol>}
  </Card>;
}

// ----------------------------------------------------------------- dépôt
function Upload({ onDone }) {
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState(null);
  const send = async (files) => {
    setBusy(true); setMsg(null); let last = null; const out = [];
    for (const f of [...files]) {
      if (f.size > MAX) { out.push(`${f.name} : trop lourd (1,5 Mo au plus)`); continue; }
      try {
        const r = await rpc('lg_inbox_upload', { p_filename: f.name, p_content_type: f.type, p_data: await toB64(f) });
        out.push(`${f.name} : ${r.extracted ? 'lu' : `à reprendre (${ERR[r.error] ?? r.error})`}`); last = r.id;
      } catch (e) { out.push(`${f.name} : ${e.text ?? e.code ?? 'refusé'}`); }
    }
    setBusy(false); setMsg(out.join(' · ')); onDone(files.length === 1 ? last : null);
  };
  return <Card style={{ marginBottom: 12 }} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files.length) send(e.dataTransfer.files); }}>
    <div className="row" style={{ flexWrap: 'wrap' }}>
      <span className="grow"><b>Déposer un bon de commande</b><div className="small muted">PDF, Excel, Word, CSV ou photo — glissez les fichiers ici ou choisissez-les.</div></span>
      <label className="btn primary">{busy ? 'Lecture par l’IA…' : 'Choisir des fichiers'}<input type="file" multiple hidden disabled={busy}
        accept=".pdf,.xlsx,.xls,.ods,.docx,.csv,.txt,image/*" onChange={(e) => e.target.files.length && send(e.target.files)} /></label>
      <label className="btn"><Icon name="camera" size={16} />Photo<input type="file" accept="image/*" capture="environment" hidden disabled={busy} onChange={(e) => e.target.files.length && send(e.target.files)} /></label>
    </div>
    {msg && <div className="small" style={{ marginTop: 8 }}>{msg}</div>}
  </Card>;
}

// ----------------------------------------------------------------- liste
function DocList({ list, onOpen }) {
  const { data, error, loading } = list;
  if (loading && !data) return <Loading />;
  return <><ErrorBox error={error} />{!data?.length ? <Card><Empty icon="inbox">Aucun document. Déposez un bon de commande, ou transférez vos e-mails de commande vers l’adresse de réception.</Empty></Card>
    : <Card><div className="scroll-x"><table className="tbl"><thead><tr><th>Reçu</th><th>De</th><th>N° bon</th><th>Client / magasin</th><th>Livraison</th><th className="num">Lignes</th><th>État</th><th></th></tr></thead>
      <tbody>{data.map((d) => <tr key={d.id}><td className="small">{ago(d.received_at)}<div className="muted">{d.source === 'email' ? 'e-mail' : 'dépôt'}</div></td>
        <td className="small">{d.sender ?? '—'}<div className="muted">{d.filename}</div></td><td className="mono">{d.order_number ?? '—'}</td><td>{d.customer ?? '—'}</td>
        <td className="small">{d.delivery_date ? dmy(d.delivery_date) : '—'}</td>
        <td className="num">{d.lines ? <>{d.matched}/{d.lines}</> : '—'}{d.lines > d.matched && <div className="small" style={{ color: 'var(--warn, #b45309)' }}>à rapprocher</div>}</td>
        <td><Badge kind={STATUS[d.status][1]}>{STATUS[d.status][0]}</Badge>{d.error && d.status === 'error' && <div className="small muted">{ERR[d.error] ?? d.error}</div>}</td>
        <td><Btn size="sm" onClick={() => onOpen(d.id)}>Ouvrir</Btn></td></tr>)}</tbody></table></div></Card>}</>;
}

// ----------------------------------------------------------------- vérification
function Review({ id, onClose, onChange }) {
  const { data: d, error, loading, reload } = useRpc('lg_inbox_detail', { p_id: id });
  const prods = useRpc('lg_stock_overview', {});
  const tpls = useRpc('lg_extraction_templates_list', {});
  const [f, setF] = useState(null); const [conv, setConv] = useState(null); const [run, busy] = useAction();
  const data = f ?? d?.data;
  const set = (k, v) => setF({ ...data, [k]: v });
  const setLine = (i, k, v) => setF({ ...data, lines: data.lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)) });
  const products = prods.data?.products ?? [];
  const isOrder = !data?.document_type || /commande/i.test(data.document_type);
  const fileUrl = `/api/inbox/${id}/file`;
  const refresh = () => { setF(null); reload(); onChange(); };
  const save = (done) => run(async () => { const r = await rpc('lg_inbox_save', { p_id: id, p_data: data, p_done: done }); refresh(); return r; }, { ok: done ? 'Marqué traité' : 'Enregistré — correspondances apprises' });
  return <Modal title={d ? `${d.filename ?? 'Document'}${data?.order_number ? ` · bon ${data.order_number}` : ''}` : 'Document'} onClose={onClose}>
    {loading && !d ? <Loading /> : error ? <ErrorBox error={error} /> : <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap' }}><Badge kind={STATUS[d.status][1]}>{STATUS[d.status][0]}</Badge>
        {d.confidence != null && <Badge kind={d.confidence >= 0.8 ? 'ok' : 'todo'}>certitude {Math.round(d.confidence * 100)} %</Badge>}
        <span className="small muted">{d.sender} · {dmy(d.received_at)}</span><span className="spacer" />
        <a className="btn sm" href={fileUrl} target="_blank" rel="noopener"><Icon name="eye" size={14} />Original</a></div>
      {d.status === 'error' && <div className="flash bad">Lecture impossible : {ERR[d.error] ?? d.error}.</div>}
      {d.order && <div className="flash ok">Commande n° {d.order.number} créée à partir de ce document.</div>}
      {data && <>
        {/^image\//.test(d.content_type) ? <img src={fileUrl} alt="Document d'origine" style={{ maxWidth: '100%', maxHeight: 320, objectFit: 'contain' }} />
          : d.content_type === 'application/pdf' ? <object data={fileUrl} type="application/pdf" style={{ width: '100%', height: 320 }} aria-label="Document d'origine"><a href={fileUrl}>Ouvrir le PDF</a></object>
          : <details><summary className="small">Texte du document</summary><pre className="small mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto' }}>{d.text}</pre></details>}
        <div className="grid cols-3">
          <Field label={data.order_number_suspect ? 'N° du bon — à vérifier' : 'N° du bon'}><input className="input mono" style={data.order_number_suspect ? { borderColor: '#dc2626' } : undefined}
            value={data.order_number ?? ''} onChange={(e) => setF({ ...data, order_number: e.target.value, order_number_suspect: false })} /></Field>
          <Field label="Date de commande"><input className="input" type="date" value={data.order_date ?? ''} onChange={(e) => set('order_date', e.target.value || null)} /></Field>
          <Field label="Livraison impérative"><input className="input" type="date" value={data.delivery_date ?? ''} onChange={(e) => set('delivery_date', e.target.value || null)} /></Field>
          <Field label="Client / enseigne"><input className="input" value={data.customer?.name ?? ''} onChange={(e) => set('customer', { ...data.customer, name: e.target.value })} /></Field>
          <Field label="Magasin / lieu de livraison"><input className="input" value={data.delivery_place ?? data.customer?.store ?? ''} onChange={(e) => set('delivery_place', e.target.value)} /></Field>
          <Field label="Total du document"><input className="input" inputMode="decimal" value={data.total_ht ?? data.total_ttc ?? ''} onChange={(e) => set('total_ht', e.target.value === '' ? null : Number(e.target.value.replace(',', '.')))} /></Field>
        </div>
        {Object.keys(data.fields ?? {}).length > 0 && <div className="small">{Object.entries(data.fields).map(([k, v]) => <span key={k} className="badge plain" style={{ marginRight: 6 }}>{k} : {String(v ?? '—')}</span>)}</div>}
        {data.order_number_suspect && <div className="flash bad">Le n° du bon lu par l’IA ne figure pas tel quel dans le document : comparez avec l’original avant de créer la commande.</div>}
        {data.lines.some((l) => l.check === false) && <div className="flash todo">Certaines lignes ont un code (EAN ou référence) introuvable dans le document : elles sont marquées ⚠.</div>}
        {data.total_mismatch && <div className="flash todo">Écart : les lignes font {formatF(data.lines_total)}, le document annonce {formatF(data.total_ht ?? data.total_ttc)}. Vérifiez les quantités et les prix.</div>}
        <div className="scroll-x"><table className="tbl"><thead><tr><th>Sur le document</th><th>Produit du catalogue</th><th className="num">Colis</th><th className="num">PCB</th><th className="num">Quantité</th><th className="num">Prix</th></tr></thead>
          <tbody>{data.lines.map((l, i) => <tr key={i} style={{ background: l.product_id ? undefined : 'var(--warn-bg, #fffbeb)' }}>
            <td className="small"><b>{l.check === false && '⚠ '}{l.label}</b><div className="muted mono">{[l.ref, l.ean].filter(Boolean).join(' · ')}</div></td>
            <td><select className="input" style={{ minWidth: 180 }} value={l.product_id ?? ''} onChange={(e) => setLine(i, 'product_id', e.target.value || null)}>
              <option value="">— à rapprocher —</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name}{p.sku ? ` (${p.sku})` : ''}</option>)}</select>
              {l.match && l.product_id && <div className="small muted">{{ alias: 'appris', ean: 'par EAN', ref: 'par référence', name: 'par nom' }[l.match]}</div>}</td>
            {['cases', 'units_per_case', 'quantity', 'unit_price'].map((k) => <td key={k} className="num"><input className="input" style={{ width: 80 }} inputMode="decimal" value={l[k] ?? ''}
              onChange={(e) => { const v = e.target.value === '' ? null : Number(e.target.value.replace(',', '.')); const nl = { ...l, [k]: v };
                if ((k === 'cases' || k === 'units_per_case') && nl.cases != null && nl.units_per_case != null) nl.quantity = nl.cases * nl.units_per_case;
                setF({ ...data, lines: data.lines.map((x, j) => (j === i ? nl : x)) }); }} /></td>)}
          </tr>)}</tbody></table></div>
        <p className="small muted" style={{ margin: 0 }}>Rattachez une ligne une fois : ses codes et son libellé sont mémorisés pour les prochains bons de cet expéditeur.</p>
        {d.status !== 'converted' && <div className="row" style={{ flexWrap: 'wrap' }}>
          <Btn disabled={busy} onClick={() => save(false)}>Enregistrer</Btn>
          {isOrder && <Btn kind="primary" disabled={busy || !data.lines.length} onClick={async () => { if (f) await rpc('lg_inbox_save', { p_id: id, p_data: data }); setConv({ name: data.delivery_place ?? data.customer?.store ?? data.customer?.name ?? '', phone: data.customer?.phone ?? '', address: data.delivery_place ?? '', zone: '', free: false,
            pay: data.payment_terms_days != null ? 'account' : 'cod', terms: String(data.payment_terms_days ?? 30), promised: data.delivery_date ?? '' }); }}>Créer la commande</Btn>}
          {!isOrder && <Btn kind="primary" disabled={busy} onClick={() => save(true)}>Marquer traité</Btn>}
          <select className="input" style={{ maxWidth: 220 }} value="" onChange={(e) => e.target.value && run(async () => { const r = await rpc('lg_inbox_extract', { p_id: id, p_template: e.target.value }); refresh(); return r; }, { ok: 'Relu' })}>
            <option value="">Relire avec un modèle…</option>{(tpls.data ?? []).filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          <Btn kind="ghost" disabled={busy} onClick={() => run(async () => { const r = await rpc('lg_inbox_extract', { p_id: id }); refresh(); return r; }, { ok: 'Relu' })}>Relire</Btn>
          <Btn kind="bad" disabled={busy} onClick={() => { const reason = prompt('Pourquoi écarter ce document ?', 'pas une commande'); if (reason !== null) run(async () => { const r = await rpc('lg_inbox_reject', { p_id: id, p_reason: reason }); refresh(); onClose(); return r; }); }}>Écarter</Btn>
        </div>}
      </>}
      {!data && d.status !== 'error' && <Loading />}
      {d.status === 'error' && <Btn onClick={() => run(async () => { const r = await rpc('lg_inbox_extract', { p_id: id }); refresh(); return r; })}>Relancer la lecture</Btn>}
      {conv && <Modal title="Créer la commande" onClose={() => setConv(null)}><div className="stack">
        <Field label="Client (magasin)"><input className="input" value={conv.name} onChange={(e) => setConv({ ...conv, name: e.target.value })} /></Field>
        <div className="grid cols-2"><Field label="Téléphone du magasin"><input className="input" type="tel" value={conv.phone} onChange={(e) => setConv({ ...conv, phone: e.target.value })} /></Field>
          <Field label="Zone de livraison"><select className="input" value={conv.zone} onChange={(e) => setConv({ ...conv, zone: e.target.value })}><option value="">Choisir…</option>
            {(d.zones ?? []).map((z) => <option key={z} value={z}>{z}</option>)}</select></Field></div>
        <Field label="Adresse"><input className="input" value={conv.address} onChange={(e) => setConv({ ...conv, address: e.target.value })} /></Field>
        <div className="grid cols-2"><Field label="Paiement"><select className="input" value={conv.pay} onChange={(e) => setConv({ ...conv, pay: e.target.value })}>
            <option value="account">À terme, sur facture</option><option value="cod">À la livraison</option><option value="prepaid">Déjà payé</option></select></Field>
          {conv.pay === 'account' ? <Field label="Délai (jours après livraison)"><input className="input" inputMode="numeric" value={conv.terms} onChange={(e) => setConv({ ...conv, terms: e.target.value.replace(/\D/g, '') })} /></Field>
            : <div />}</div>
        <Field label="Livraison imposée le"><input className="input" type="date" value={conv.promised} onChange={(e) => setConv({ ...conv, promised: e.target.value })} /></Field>
        {conv.pay === 'account' && <p className="small muted">La commande part tout de suite en préparation ; rien n'est encaissé à la livraison ; la facture porte l'échéance et le n° du bon, puis la créance est suivie dans Factures (relances automatiques).</p>}
        {data.lines.some((l) => !l.product_id) && <label className="check"><input type="checkbox" checked={conv.free} onChange={(e) => setConv({ ...conv, free: e.target.checked })} /> Reprendre les lignes non rapprochées en articles libres (sans stock)</label>}
        <Btn kind="primary" size="xl" disabled={busy || !conv.zone || !conv.name} onClick={() => run(async () => {
          const r = await rpc('lg_inbox_convert', { p_id: id, p_customer: { name: conv.name, phone: conv.phone, address: conv.address }, p_zone: conv.zone, p_free_lines: conv.free,
            p_payment_method: conv.pay, p_terms_days: conv.pay === 'account' && conv.terms !== '' ? Number(conv.terms) : undefined, p_promised_at: conv.promised || undefined });
          if (r.ok) { setConv(null); refresh(); }
          return r;
        }, { ok: 'Commande créée : elle part en préparation' })}>Créer la commande</Btn></div></Modal>}
    </div>}
  </Modal>;
}

// ----------------------------------------------------------------- modèles de lecture
function Templates() {
  const { data, error, loading, reload } = useRpc('lg_extraction_templates_list', {});
  const [edit, setEdit] = useState(null);
  return <div className="stack">
    <div className="row"><span className="grow small muted">Un modèle dit à l’IA quoi lire pour un expéditeur : champs en plus, consignes (« le PCB est le nombre de sachets par carton »).
      Sans modèle, l’IA lit un bon de commande standard.</span><Btn kind="primary" onClick={() => setEdit({ name: '', kind: 'order', fields: [], line_fields: [] })}><Icon name="plus" size={16} />Modèle</Btn></div>
    <ErrorBox error={error} />
    {loading && !data ? <Loading /> : !data?.length ? <Card><Empty icon="layers">Aucun modèle : la lecture standard s’applique.</Empty></Card>
      : <div className="grid cols-2">{data.map((t) => <Card key={t.id} style={{ opacity: t.active ? 1 : 0.55 }}><div className="row between"><b>{t.name}</b><Btn size="sm" onClick={() => setEdit(t)}>Modifier</Btn></div>
        <div className="small">{KIND.find(([k]) => k === t.kind)?.[1]}{t.sender_match ? ` · pour « ${t.sender_match} »` : ' · par défaut'}</div>
        {(t.fields.length > 0 || t.line_fields.length > 0) && <div className="small muted">Champs : {[...t.fields, ...t.line_fields].map((x) => x.label).join(', ')}</div>}
        {t.instructions && <div className="small muted">{t.instructions}</div>}</Card>)}</div>}
    {edit && <TemplateForm t={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(); }} />}
  </div>;
}

function FieldsEditor({ value, onChange, label }) {
  return <Field label={label}><div className="stack" style={{ gap: 6 }}>{value.map((x, i) => <div key={i} className="row" style={{ flexWrap: 'nowrap' }}>
    <input className="input" placeholder="Nom (ex. Rayon)" value={x.label ?? ''} onChange={(e) => onChange(value.map((y, j) => (j === i ? { ...y, label: e.target.value, key: y.key || e.target.value } : y)))} />
    <select className="input" style={{ maxWidth: 120 }} value={x.type ?? 'text'} onChange={(e) => onChange(value.map((y, j) => (j === i ? { ...y, type: e.target.value } : y)))}>
      <option value="text">texte</option><option value="number">nombre</option><option value="date">date</option></select>
    <button className="icon-btn" aria-label="Retirer" onClick={() => onChange(value.filter((_, j) => j !== i))}><Icon name="x" size={16} /></button></div>)}
    <Btn size="sm" onClick={() => onChange([...value, { label: '', type: 'text' }])}><Icon name="plus" size={14} />Ajouter un champ</Btn></div></Field>;
}

function TemplateForm({ t, onClose, onDone }) {
  const [f, setF] = useState({ ...t }); const [run, busy] = useAction();
  return <Modal title={t.id ? t.name : 'Nouveau modèle de lecture'} onClose={onClose}><div className="stack">
    <div className="grid cols-2"><Field label="Nom"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="ex. Enseigne X" /></Field>
      <Field label="Type de document"><select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{KIND.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field></div>
    <Field label="S’applique quand l’expéditeur ou le sujet contient (vide = par défaut)"><input className="input" value={f.sender_match ?? ''} onChange={(e) => setF({ ...f, sender_match: e.target.value })} placeholder="@enseigne.sn" /></Field>
    <Field label="Consignes pour l’IA"><textarea className="input" rows={3} value={f.instructions ?? ''} onChange={(e) => setF({ ...f, instructions: e.target.value })}
      placeholder="Nb colis = cartons ; PCB = unités par carton ; la colonne AR n’est pas une quantité." /></Field>
    <FieldsEditor label="Champs à lire en plus (en-tête)" value={f.fields ?? []} onChange={(v) => setF({ ...f, fields: v })} />
    <FieldsEditor label="Colonnes à lire en plus (lignes)" value={f.line_fields ?? []} onChange={(v) => setF({ ...f, line_fields: v })} />
    {t.id && <label className="check"><input type="checkbox" checked={f.active !== false} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Actif</label>}
    <Btn kind="primary" size="xl" disabled={busy || !f.name?.trim()} onClick={() => run(async () => { const r = await rpc('lg_extraction_template_upsert', { p: f }); if (r.ok !== false) onDone(); return r; }, { ok: 'Modèle enregistré' })}>Enregistrer</Btn>
  </div></Modal>;
}

// ----------------------------------------------------------------- correspondances
function Aliases() {
  const { data, error, loading, reload } = useRpc('lg_product_aliases_list', {});
  const [run, busy] = useAction(); const [q, setQ] = useState('');
  const list = (data ?? []).filter((a) => !q || `${a.alias} ${a.product} ${a.scope}`.toLowerCase().includes(q.toLowerCase()));
  if (loading && !data) return <Loading />;
  return <div className="stack"><ErrorBox error={error} />
    <input className="input" style={{ maxWidth: 320 }} placeholder="Filtrer" value={q} onChange={(e) => setQ(e.target.value)} />
    {!list.length ? <Card><Empty icon="layers">Aucune correspondance apprise pour l’instant : elles se créent quand vous rattachez une ligne à un produit.</Empty></Card>
      : <Card><div className="scroll-x"><table className="tbl"><thead><tr><th>Sur les bons</th><th>Expéditeur</th><th>Produit</th><th className="num">PCB</th><th></th></tr></thead>
        <tbody>{list.map((a) => <tr key={`${a.scope}|${a.alias}`}><td className="mono small">{a.alias}</td><td className="small">{a.scope || 'tous'}</td><td>{a.product}</td><td className="num">{a.units_per_case ?? ''}</td>
          <td><button className="icon-btn" aria-label="Oublier" disabled={busy} onClick={() => run(async () => { const r = await rpc('lg_product_alias_delete', { p_alias: a.alias, p_scope: a.scope }); reload(); return r; })}><Icon name="x" size={16} /></button></td></tr>)}</tbody></table></div></Card>}</div>;
}

// ----------------------------------------------------------------- export Excel (format du tableau croisé MINAM)
function Export() {
  const today = new Date().toISOString().slice(0, 10);
  const [p, setP] = useState({ from: new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10), to: today });
  const [run, busy] = useAction();
  return <Card style={{ maxWidth: 640 }}><h3>Tableau des commandes reçues</h3>
    <p className="small muted" style={{ marginTop: -6 }}>Une ligne par bon : date de commande, date de livraison impérative, lieu de livraison, n° de commande, montant,
      puis pour chaque produit : nombre de colis, PCB, quantité, prix (comme le fichier Excel produit jusqu’ici à la main).</p>
    <div className="grid cols-2"><Field label="Du"><input className="input" type="date" value={p.from} onChange={(e) => setP({ ...p, from: e.target.value })} /></Field>
      <Field label="Au"><input className="input" type="date" value={p.to} onChange={(e) => setP({ ...p, to: e.target.value })} /></Field></div>
    <Btn kind="primary" disabled={busy} onClick={() => run(async () => {
      const docs = (await rpc('lg_inbox_export', { p_from: p.from, p_to: p.to })).filter((d) => d.data);
      if (!docs.length) return { ok: false, error: 'nothing_to_export' };
      const name = (l) => l.product_name ?? l.label ?? '?';
      const products = [...new Set(docs.flatMap((d) => d.data.lines.map(name)))].sort();
      const fr = (s) => (s ? s.split('-').reverse().join('/') : '');
      const head1 = ['Date de commande', 'Date de livraison impérative', 'Lieu de livraison', 'N° commande', "Montant d'achat", ...products.flatMap((x) => [x, '', '', ''])];
      const head2 = ['', '', '', '', '', ...products.flatMap(() => ['Nb colis', 'PCB', 'Qté', 'Prix'])];
      const rows = docs.map((d) => { const x = d.data; return [fr(x.order_date), fr(x.delivery_date), x.delivery_place ?? x.customer?.store ?? '', x.order_number ?? '', x.total_ht ?? x.total_ttc ?? '',
        ...products.flatMap((pn) => { const l = x.lines.find((y) => name(y) === pn); return l ? [l.cases ?? '', l.units_per_case ?? '', l.quantity ?? '', l.unit_price ?? ''] : ['', '', '', '']; })]; });
      downloadCsv(`commandes-recues-${p.from}-${p.to}.csv`, [head1, head2, ...rows]);
      return { ok: true };
    }, { ok: 'Fichier téléchargé' })}>Télécharger (Excel)</Btn></Card>;
}
