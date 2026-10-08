// Modules 06/13 — Service client : confirmations à appeler, demandes des clients,
// incidents, fiche colis (chaîne de garde : « chez qui était-il ? » en une requête).
import React, { useState } from 'react';
import { rpc } from '../lib/backend.js';
import { Orders } from '../components/orders.jsx';
import { Icon, useRpc, useAction, useNav, Btn, Card, Badge, Empty, Loading, ErrorBox, PageHead, Modal, Field, Tabs, Chips, StatusBadge,
  formatF, hhmm, dmy, ago } from '../components/ui.jsx';

const KIND = { reschedule: 'Nouvelle date', callback: 'Rappel demandé', help: 'Aide', address: 'Adresse', third_party: 'Livraison à un tiers', stockout_choice: 'Choix après rupture' };
const INC = { damaged: 'Colis abîmé', lost: 'Colis perdu', missing_item: 'Article manquant', wrong_product: 'Mauvais produit', refused: 'Refus',
  cash_gap: 'Écart de caisse', driver_behavior: 'Comportement livreur', vehicle_breakdown: 'Panne', accident: 'Accident', late: 'Retard', other: 'Autre' };
const EV = { pack: 'Emballé', stage: 'Mis à quai', load: 'Chargé', unload: 'Déchargé', deliver: 'Livré', fail: 'Échec', return_hub: 'Rendu au quai',
  return_vendor: 'Rendu au vendeur', receive: 'Reçu', inventory: 'Inventaire', damage: 'Dommage' };

export default function Support({ code }) {
  // version complète (Cloudflare) : les commandes naissent ici (saisie, fichier, API des boutiques)
  const api = true; // fonctions de la version Cloudflare (commandes, catalogue)
  const [tab, setTab] = useState(code ? 'package' : api ? 'orders' : 'confirm');
  return <>
    <PageHead title="Service client" back="/" />
    <Tabs value={tab} onChange={setTab} tabs={[...(api ? [['orders', 'Commandes']] : []), ['confirm', 'À confirmer'], ['requests', 'Demandes'],
      ['incidents', 'Incidents'], ['package', 'Fiche colis']]} />
    {tab === 'orders' && <Orders />}
    {tab === 'confirm' && <Confirm />}{tab === 'requests' && <Requests />}{tab === 'incidents' && <Incidents />}{tab === 'package' && <PackageCard initial={code} />}
  </>;
}

function Confirm() {
  const { data, error, loading, reload } = useRpc('lg_cod_pending', {}, { refresh: 30000 });
  const [run, busy] = useAction();
  if (loading && !data) return <Loading />;
  return <div className="stack"><ErrorBox error={error} />
    <p className="small muted">Paiement à la livraison sans réponse au message WhatsApp : appelez avant toute préparation (limite les refus à la porte).</p>
    {!data?.length ? <Card><Empty>Toutes les commandes sont confirmées.</Empty></Card> : data.map((o) => <Card key={o.order_id} kind={o.previous_refusals ? 'bad' : 'todo'}>
      <div className="row between"><div><b>{o.customer}</b> · {o.zone}<div className="small muted">Cde {o.order_short} · {formatF(o.amount_fcfa)} · attend depuis {o.hours_waiting} h</div>
        <div className="small">{o.previous_orders ? `✔ ${o.previous_orders} commande(s) déjà livrée(s)` : 'Nouveau client'}{o.previous_refusals ? ` · ⚠ ${o.previous_refusals} refus passé(s)` : ''}</div></div>
        <div className="row"><a className="btn" href={`tel:${o.phone}`}>📞 {o.phone}</a><TrackLink url={o.tracking_url} /></div></div>
      <div className="row" style={{ marginTop: 8 }}>
        <Btn kind="ok" disabled={busy} onClick={() => run(async () => { const r = await rpc('lg_confirm_cod', { p_order: o.order_id, p_via: 'appel' }); reload(); return r; }, { ok: 'Confirmée : la préparation est ouverte' })}>Le client confirme</Btn>
        <Btn kind="bad" disabled={busy} onClick={() => { if (confirm('Annuler cette commande ?')) run(async () => { const r = await rpc('lg_cancel_unconfirmed', { p_order: o.order_id, p_reason: 'Non confirmée au téléphone' }); reload(); return r; }, { ok: 'Commande annulée' }); }}>Annuler</Btn>
      </div></Card>)}</div>;
}

function Requests() {
  const { data, error, loading, reload } = useRpc('lg_requests_list', { p_status: 'open' }, { refresh: 30000 });
  const [run] = useAction();
  if (loading && !data) return <Loading />;
  return <div className="stack"><ErrorBox error={error} />
    {!data?.length ? <Card><Empty>Aucune demande en attente.</Empty></Card> : data.map((r) => <Card key={r.id} kind="todo">
      <div className="row between"><div><b>{KIND[r.kind] ?? r.kind}</b> · {r.customer} <Badge>{r.channel}</Badge>
        <div className="small muted">Cde {r.order_short} · {r.zone ?? ''} · {ago(r.created_at)}</div>
        <div className="small">{Object.entries(r.payload ?? {}).filter(([k]) => k !== 'line_id').map(([k, v]) => `${k} : ${v}`).join(' · ')}</div></div>
        <div className="row"><a className="btn sm" href={`tel:${r.phone}`}>📞</a><TrackLink url={r.tracking_url} small /></div></div>
      <div className="row" style={{ marginTop: 8 }}>
        {r.kind === 'stockout_choice' && r.payload?.line_id && <Btn size="sm" onClick={() => run(async () => rpc('lg_resolve_short', { p_order_item: r.payload.line_id, p_choice: r.payload.choice }), { ok: 'Choix appliqué' })}>Appliquer « {r.payload.choice} »</Btn>}
        <Btn size="sm" kind="ok" onClick={() => run(async () => { const x = await rpc('lg_request_done', { p_id: r.id }); reload(); return x; }, { ok: 'Traitée' })}>Traitée</Btn></div>
    </Card>)}</div>;
}

function Incidents() {
  const [status, setStatus] = useState('open');
  const { data, error, loading, reload } = useRpc('lg_incidents_list', { p_status: status }, { refresh: 30000 });
  const [res, setRes] = useState(null);
  const [create, setCreate] = useState(false);
  return <div className="stack">
    <div className="row between"><Chips options={[['open', 'Ouverts'], ['closed', 'Clos']]} value={status} onChange={setStatus} /><Btn onClick={() => setCreate(true)}>＋ Incident</Btn></div>
    <ErrorBox error={error} />
    {loading && !data ? <Loading /> : !data?.length ? <Card><Empty>Aucun incident.</Empty></Card> : data.map((i) =>
      <Card key={i.id} kind={i.overdue || i.severity === 'critical' ? 'bad' : 'todo'}>
        <div className="row between"><b>n° {i.number} · {INC[i.kind] ?? i.kind}</b><span><StatusBadge s={i.status} /> {i.overdue && <Badge kind="bad">hors délai</Badge>}</span></div>
        <div className="small">{i.description}</div>
        <div className="small muted">{i.package && <span className="mono">{i.package} · </span>}{i.trip_number ? `V${i.trip_number} · ` : ''}responsable au moment des faits : {i.responsible_type ?? '—'} · {ago(i.created_at)}</div>
        {i.resolution && <div className="small">→ {i.resolution}{i.compensation_fcfa ? ` · indemnité ${formatF(i.compensation_fcfa)}` : ''}{i.credit_note ? ` · avoir ${i.credit_note}` : ''}</div>}
        <div className="chips">{i.awaiting_customer && <Badge kind="todo">attend la réponse du client</Badge>}
          {i.customer_agreed_at && <Badge kind="ok">accord du client{i.agreement_via === 'tracking' ? ' (page de suivi)' : ' (téléphone)'}</Badge>}
          {i.customer_refused_at && i.status !== 'closed' && <Badge kind="bad">proposition refusée par le client</Badge>}
          {i.insured_value_fcfa && <Badge kind="info">assuré {formatF(i.insured_value_fcfa)}</Badge>}</div>
        {['open', 'investigating', 'resolved'].includes(i.status) && <Btn size="sm" onClick={() => setRes(i)}>{i.status === 'resolved' ? 'Reprendre' : 'Résoudre'}</Btn>}</Card>)}
    {res && <Resolve i={res} onClose={() => setRes(null)} onDone={() => { setRes(null); reload(); }} />}
    {create && <NewIncident onClose={() => setCreate(false)} onDone={() => { setCreate(false); reload(); }} />}
  </div>;
}

function Resolve({ i, onClose, onDone }) {
  const [text, setText] = useState(i.resolution ?? ''); const [comp, setComp] = useState(i.compensation_fcfa ? String(i.compensation_fcfa) : ''); const [ded, setDed] = useState('');
  const [credit, setCredit] = useState(true); const [agreed, setAgreed] = useState(false);
  const [run, busy] = useAction();
  const over = i.cap_fcfa != null && Number(comp) > i.cap_fcfa;
  return <Modal title={`Incident n° ${i.number}`} onClose={onClose}><div className="stack">
    <p>{i.description}</p>
    <Field label="Décision"><textarea className="input" value={text} onChange={(e) => setText(e.target.value)} /></Field>
    <div className="grid cols-2"><Field label="Indemnisation client (F)"><input className="input" inputMode="numeric" value={comp} onChange={(e) => setComp(e.target.value.replace(/\D/g, ''))} /></Field>
      {i.responsible_type === 'driver' && <Field label="Retenue chauffeur (F)"><input className="input" inputMode="numeric" value={ded} onChange={(e) => setDed(e.target.value.replace(/\D/g, ''))} /></Field>}</div>
    {i.cap_fcfa != null && <div className={`small ${over ? '' : 'muted'}`} style={over ? { color: 'var(--bad)' } : undefined}>Plafond d'indemnisation : <b>{formatF(i.cap_fcfa)}</b>
      {i.insured_value_fcfa ? ' (valeur assurée)' : ' (colis non assuré : valeur des produits, plafonnée)'}</div>}
    {Number(comp) > 0 && i.has_order && <div className="stack" style={{ gap: 6 }}>
      <label className="row small"><input type="checkbox" checked={credit} onChange={(e) => setCredit(e.target.checked)} /> Émettre un avoir de ce montant sur la facture</label>
      <label className="row small"><input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} /> Le client a donné son accord (par téléphone)</label>
      {!agreed && <p className="small muted" style={{ margin: 0 }}>Sans accord, la proposition lui est envoyée par WhatsApp : il accepte ou refuse depuis sa page de suivi.</p>}</div>}
    {i.kind === 'cash_gap' && <p className="small muted">Clore l'écart permet le rapprochement du voyage et le calcul des gains.</p>}
    <Btn kind="primary" size="xl" disabled={!text.trim() || busy || over} onClick={() => run(async () => {
      const r = await rpc('lg_resolve_incident', { p_id: i.id, p_resolution: text, p_compensation_fcfa: Number(comp) || 0, p_deduction_fcfa: Number(ded) || 0,
        p_credit_note: credit && Number(comp) > 0, p_customer_agreed: agreed });
      if (r.ok) onDone(); return r;
    }, { ok: 'Décision enregistrée' })}>{Number(comp) > 0 && i.has_order && !agreed ? 'Proposer au client' : 'Clore'}</Btn></div></Modal>;
}

function NewIncident({ onClose, onDone }) {
  const [kind, setKind] = useState('damaged'); const [code, setCode] = useState(''); const [desc, setDesc] = useState('');
  const [run, busy] = useAction();
  return <Modal title="Nouvel incident" onClose={onClose}><div className="stack">
    <Chips options={Object.entries(INC)} value={kind} onChange={setKind} />
    <Field label="Code colis (facultatif)"><input className="input mono" value={code} onChange={(e) => setCode(e.target.value)} /></Field>
    <Field label="Description"><textarea className="input" value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
    <Btn kind="primary" size="xl" disabled={!desc.trim() || busy} onClick={() => run(async () => {
      const r = await rpc('lg_open_incident', { p_kind: kind, p_description: desc, p_code: code || null }); onDone(); return r;
    }, { ok: 'Incident ouvert' })}>Ouvrir</Btn></div></Modal>;
}

function PackageCard({ initial }) {
  const [code, setCode] = useState(initial ?? '');
  const [q, setQ] = useState(initial ?? '');
  const { data, error, loading } = useRpc('lg_package_card', { p_code: q }, { skip: !q });
  return <div className="stack">
    <form className="row" onSubmit={(e) => { e.preventDefault(); setQ(code); }}>
      <input className="input mono" style={{ flex: 1 }} value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code colis NXP-… ou 6 derniers caractères" />
      <Btn kind="primary" type="submit">Chercher</Btn></form>
    <ErrorBox error={error} />
    {q && loading && <Loading />}
    {data && <div className="split">
      <Card><div className="row between"><h2 className="mono" style={{ margin: 0 }}>{data.package.code}</h2><StatusBadge s={data.package.status} /></div>
        <p className="small">Commande {data.order.short} · {data.order.zone} · {data.order.vendor_name} · {data.package.seq_in_order}/{data.package.count_in_order}
          · {data.package.attempts} présentation(s) en échec</p>
        <div className="flash info"><Icon name="user" /><div><div className="small">Détenteur actuel</div><b>{data.holder.name ?? '—'}</b> <span className="small">({data.holder.type})</span></div></div>
        <h3 style={{ marginTop: 14 }}>Chaîne de garde</h3>
        <ul className="timeline">{data.timeline.map((e, i) => <li key={i}><span className={`dot ${e.event === 'deliver' ? 'ok' : ['fail', 'damage'].includes(e.event) ? 'bad' : 'todo'}`} />
          <b>{EV[e.event] ?? e.event}</b> · {dmy(e.at)} {hhmm(e.at)}<div className="small muted">{e.actor}{e.trip_number ? ` · V${e.trip_number}` : ''}{e.manual ? ' · saisie manuelle' : ''}
            {e.meta?.reason ? ` · ${e.meta.reason}` : ''}</div></li>)}</ul></Card>
      <div className="stack">
        <Card><h3>Preuves</h3>{data.proofs.length === 0 ? <Empty>—</Empty> : data.proofs.map((p, i) => <div key={i} className="small">{p.kind} · {p.recipient ?? ''} {p.distance_m != null ? `· à ${p.distance_m} m de l'adresse` : ''} · {hhmm(p.at)}</div>)}</Card>
        <Card><h3>Incidents</h3>{data.incidents.length === 0 ? <Empty>—</Empty> : data.incidents.map((i) => <div key={i.number}>n° {i.number} · {INC[i.kind]} · <StatusBadge s={i.status} /></div>)}</Card>
      </div></div>}
  </div>;
}

// Lien de la page de suivi du client : ouvrir, ou copier pour le renvoyer par WhatsApp
function TrackLink({ url, small }) {
  if (!url) return null;
  const local = url.replace(/^https?:\/\/[^/]+/, '');
  return <><a className={`btn ${small ? 'sm' : ''}`} href={location.origin + local} target="_blank" rel="noreferrer">Suivi client ↗</a>
    <Btn size={small ? 'sm' : ''} onClick={() => navigator.clipboard?.writeText(url)}>Copier le lien</Btn></>;
}
