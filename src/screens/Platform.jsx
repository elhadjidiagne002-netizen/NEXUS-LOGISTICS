// Administration de la plateforme (adresses ADMIN_EMAILS) : entreprises, abonnements déclarés, quotas et prix,
// suspension, erreurs remontées par les navigateurs.
import React, { useState } from 'react';
import { rpc } from '../lib/backend.js';
import { useRpc, useAction, Btn, Card, Badge, Empty, Loading, ErrorBox, PageHead, Tabs, Stat, Field, formatF, dmy, ago } from '../components/ui.jsx';

const METHOD = { wave: 'Wave', orange_money: 'Orange Money' };
export default function Platform() {
  const { data, error, loading, reload } = useRpc('lg_platform_overview', {}, { refresh: 60000 });
  const [tab, setTab] = useState('companies');
  if (loading && !data) return <Loading />;
  if (error) return <><PageHead title="Plateforme" back="/" /><ErrorBox error={error} /></>;
  const t = data.totals;
  return <>
    <PageHead title="Plateforme" back="/" sub="Toutes les entreprises clientes de NEXUS Logistics." />
    <div className="stats">
      <Stat icon="store" label="entreprises" value={t.companies} /><Stat icon="star" c="#059669" label="en formule Pro" value={t.pro} />
      <Stat icon="truck" label="livrées sur 30 jours" value={t.delivered_30d} /><Stat icon="cash" c="#d97706" label="paiements à valider" value={t.payments_pending} kind={t.payments_pending ? 'todo' : ''} />
      <Stat icon="alert" c="#dc2626" label="erreurs (24 h)" value={t.errors_24h} kind={t.errors_24h ? 'bad' : ''} /><Stat icon="receipt" label="encaissé (abonnements)" value={formatF(t.revenue_fcfa)} />
    </div>
    <Tabs value={tab} onChange={setTab} tabs={[['companies', 'Entreprises'], ['payments', `Paiements (${t.payments_pending})`], ['settings', 'Formules'], ['errors', 'Erreurs']]} />
    {tab === 'companies' && <Companies list={data.companies} reload={reload} />}
    {tab === 'payments' && <Payments list={data.payments} reload={reload} />}
    {tab === 'settings' && <Settings s={data.settings} reload={reload} />}
    {tab === 'errors' && <Errors />}
  </>;
}

function Companies({ list, reload }) {
  const [run, busy] = useAction();
  if (!list.length) return <Card><Empty>Aucune entreprise.</Empty></Card>;
  return <Card><div className="scroll-x"><table className="tbl"><thead><tr><th>Entreprise</th><th>Propriétaire</th><th>Formule</th><th className="num">Membres</th>
    <th className="num">Commandes 30 j</th><th>Activité</th><th></th></tr></thead><tbody>{list.map((c) => <tr key={c.id} style={{ opacity: c.suspended ? 0.55 : 1 }}>
      <td><b>{c.name}</b><div className="small muted">{c.city} · créée le {dmy(c.created_at)}</div></td><td className="small">{c.owner_email}</td>
      <td><Badge kind={c.plan_effective === 'pro' ? 'ok' : ''}>{c.plan_effective === 'pro' ? `Pro → ${dmy(c.plan_until)}` : 'Gratuite'}</Badge></td>
      <td className="num">{c.members}</td><td className="num">{c.orders_30d}</td><td className="small">{c.last_activity ? ago(c.last_activity) : '—'}</td>
      <td><Btn size="sm" kind={c.suspended ? 'primary' : 'bad'} disabled={busy} onClick={() => confirm(c.suspended ? `Rétablir ${c.name} ?` : `Suspendre ${c.name} ? Plus personne n'y aura accès.`)
        && run(async () => { const r = await rpc('lg_platform_company_set', { p_company: c.id, p_suspend: !c.suspended }); reload(); return r; })}>{c.suspended ? 'Rétablir' : 'Suspendre'}</Btn></td></tr>)}</tbody></table></div></Card>;
}

function Payments({ list, reload }) {
  const [run, busy] = useAction();
  if (!list.length) return <Card><Empty>Aucun paiement déclaré.</Empty></Card>;
  return <div className="grid cols-2">{list.map((p) => <Card key={p.id} kind={p.status === 'pending' ? 'todo' : ''}>
    <div className="row between"><b>{p.company}</b><Badge kind={{ approved: 'ok', rejected: 'bad' }[p.status] ?? 'todo'}>{{ approved: 'validé', rejected: 'refusé', pending: 'à vérifier' }[p.status]}</Badge></div>
    <div className="money">{formatF(p.amount_fcfa)}</div>
    <div className="small">{p.months} mois · {METHOD[p.method]} · réf. <span className="mono">{p.ref}</span> · déclaré {ago(p.declared_at)}</div>
    {p.status === 'pending' && <div className="row" style={{ marginTop: 10 }}>
      <Btn kind="primary" disabled={busy} onClick={() => run(async () => { const r = await rpc('lg_platform_payment_decide', { p_id: p.id, p_approve: true }); reload(); return r; }, { ok: 'Formule Pro activée' })}>Paiement reçu : activer</Btn>
      <Btn kind="bad" disabled={busy} onClick={() => { const note = prompt('Motif du refus ?'); if (note !== null) run(async () => { const r = await rpc('lg_platform_payment_decide', { p_id: p.id, p_approve: false, p_note: note }); reload(); return r; }); }}>Refuser</Btn></div>}
  </Card>)}</div>;
}

function Settings({ s, reload }) {
  const [f, setF] = useState(s);
  const [run, busy] = useAction();
  const num = (plan, k) => <Field label={k === 'price_fcfa' ? 'Prix (F / mois)' : { orders_month: 'Commandes par mois', couriers: 'Chauffeurs', hubs: 'Lieux' }[k]}>
    <input className="input" inputMode="numeric" placeholder="illimité" value={f[plan][k] ?? ''} onChange={(e) => setF({ ...f, [plan]: { ...f[plan], [k]: e.target.value === '' ? null : Number(e.target.value.replace(/\D/g, '')) } })} /></Field>;
  return <div className="split">
    <Card><h3>Gratuite</h3><div className="grid cols-3">{num('free', 'orders_month')}{num('free', 'couriers')}{num('free', 'hubs')}</div>
      <h3 style={{ marginTop: 14 }}>Pro</h3><div className="grid cols-2">{num('pro', 'price_fcfa')}{num('pro', 'orders_month')}{num('pro', 'couriers')}{num('pro', 'hubs')}</div></Card>
    <Card><h3>Où payer</h3>
      <Field label="Numéro Wave"><input className="input" value={f.payment.wave ?? ''} onChange={(e) => setF({ ...f, payment: { ...f.payment, wave: e.target.value } })} /></Field>
      <Field label="Numéro Orange Money"><input className="input" value={f.payment.orange_money ?? ''} onChange={(e) => setF({ ...f, payment: { ...f.payment, orange_money: e.target.value } })} /></Field>
      <Field label="Au nom de"><input className="input" value={f.payment.name ?? ''} onChange={(e) => setF({ ...f, payment: { ...f.payment, name: e.target.value } })} /></Field>
      <Btn kind="primary" disabled={busy} onClick={() => run(async () => { const r = await rpc('lg_platform_settings_save', { p: f }); reload(); return r; }, { ok: 'Formules enregistrées' })}>Enregistrer</Btn></Card>
  </div>;
}

function Errors() {
  const { data, error, loading } = useRpc('lg_platform_errors', { p_limit: 100 });
  if (loading && !data) return <Loading />;
  return <Card><ErrorBox error={error} />{!data?.length ? <Empty icon="check">Aucune erreur remontée.</Empty> :
    <div className="list">{data.map((e) => <div key={e.id} className="line" style={{ alignItems: 'flex-start' }}><span className="grow"><b>{e.message}</b>
      <div className="small muted">{e.company ?? 'visiteur'} · {e.url} · {ago(e.created_at)}</div>
      {e.stack && <details><summary className="small">Pile</summary><pre className="mono small" style={{ whiteSpace: 'pre-wrap' }}>{e.stack}</pre></details>}</span></div>)}</div>}</Card>;
}
