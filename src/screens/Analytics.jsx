// Module 14 — Les douze indicateurs de pilotage (chapitre 12), calculés depuis le journal de scans.
import React, { useState } from 'react';
import { PickProductivity } from '../components/productivity.jsx';
import { rpc } from '../lib/backend.js';
import { useMe } from '../App.jsx';
import { useRpc, useAction, Card, Badge, Btn, Modal, Empty, Icon, Loading, ErrorBox, PageHead, Field, Chips, Stat, Tabs, formatF, dmy } from '../components/ui.jsx';

const iso = (d) => d.toISOString().slice(0, 10);
const pct = (v) => (v == null ? '—' : `${v} %`);

export default function Analytics() {
  const [tab, setTab] = useState('kpis');
  return <>
    <PageHead title="Pilotage" back="/" sub="Mesurer ce qui coûte et ce qui fâche, anticiper la charge, repérer les dérives." />
    <Tabs value={tab} onChange={setTab} tabs={[['kpis', 'Indicateurs'], ['forecast', 'Prévision'], ['anomalies', 'Anomalies'], ['drivers', 'Chauffeurs'], ['picking', 'Préparation'], ['returns', 'Retours']]} />
    {tab === 'kpis' && <Kpis />}{tab === 'forecast' && <Forecast />}{tab === 'anomalies' && <Anomalies />}{tab === 'drivers' && <Leaderboard />}{tab === 'picking' && <PickProductivity />}{tab === 'returns' && <ReturnStats />}
  </>;
}

function Kpis() {
  const [range, setRange] = useState('7');
  const to = new Date(); const from = new Date(Date.now() - (Number(range) - 1) * 864e5);
  const { data, error, loading } = useRpc('lg_kpis', { p_from: iso(from), p_to: iso(to) });
  const k = data?.kpis;
  return <>
    <div style={{ marginBottom: 14 }}><Chips options={[['1', 'Aujourd\'hui'], ['7', '7 jours'], ['30', '30 jours']]} value={range} onChange={setRange} /></div>
    <ErrorBox error={error} />
    {loading && !data ? <Loading /> : k && <>
      <div className="stats">
        <Stat label="livrés à la 1re présentation" value={pct(k.first_attempt_pct)} kind={k.first_attempt_pct >= 90 ? 'ok' : 'todo'} />
        <Stat label="ponctualité" value={pct(k.on_time_pct)} />
        <Stat label="délai de bout en bout" value={k.end_to_end_hours != null ? `${k.end_to_end_hours} h` : '—'} />
        <Stat label="délai de préparation" value={k.prep_hours != null ? `${k.prep_hours} h` : '—'} />
        <Stat label="taux de rupture" value={pct(k.stockout_pct)} kind={k.stockout_pct > 5 ? 'bad' : ''} />
        <Stat label="erreurs de préparation" value={pct(k.prep_error_pct)} />
        <Stat label="taux de remplissage" value={pct(k.fill_pct)} />
        <Stat label="colis par voyage · par heure" value={`${k.packages_per_trip ?? '—'} · ${k.packages_per_hour ?? '—'}`} />
        <Stat label="coût par livraison" value={k.cost_per_delivery_fcfa != null ? formatF(k.cost_per_delivery_fcfa) : '—'} />
        <Stat label="taux d'échec" value={pct(k.failure_rate_pct)} kind={k.failure_rate_pct > 10 ? 'bad' : ''} />
        <Stat label="écart de caisse" value={`${formatF(k.cash_gap_fcfa)} (${pct(k.cash_gap_pct)})`} kind={k.cash_gap_fcfa ? 'bad' : 'ok'} />
        <Stat label="colis à quai depuis +24 h" value={k.staged_over_24h} kind={k.staged_over_24h ? 'bad' : 'ok'} />
      </div>
      <div className="grid cols-2" style={{ marginTop: 12 }}>
        <Card><h3>Motifs d'échec</h3><Bars rows={k.failure_reasons.map((r) => [r.reason, r.count])} /></Card>
        <Card><h3>Par zone</h3><Bars rows={data.by_zone.map((z) => [z.zone ?? '—', z.delivered, z.failure_pct != null ? `${z.failure_pct} % échec` : ''])} /></Card>
        <Card><h3>Par chauffeur</h3><Bars rows={data.by_courier.map((c) => [c.courier, c.delivered, `${c.failed} échec · ★ ${c.rating}`])} /></Card>
        <Card><h3>Par vendeur</h3><Bars rows={data.by_vendor.map((v) => [v.vendor, v.tasks, `${v.prep_hours ?? '—'} h · ${v.stockout_lines} rupture(s)`])} /></Card>
      </div>
      <p className="small muted">Les seuils d'alerte se fixent après quatre semaines de mesure réelle, pas avant.</p>
    </>}
  </>;
}

function Bars({ rows }) {
  if (!rows.length) return <p className="muted small">Pas encore de données.</p>;
  const max = Math.max(...rows.map((r) => Number(r[1]) || 0), 1);
  return <div className="bars">{rows.map(([l, v, note]) => <div key={l} className="b"><span title={l} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l}</span>
    <div><i style={{ width: `${(100 * (Number(v) || 0)) / max}%` }} />{note && <span className="small muted">{note}</span>}</div><b className="right">{v}</b></div>)}</div>;
}

// jour de la semaine en français (Postgres formate selon sa propre langue)
const wd = (date, opts = { weekday: 'long' }) => new Date(`${date}T12:00:00`).toLocaleDateString('fr-FR', opts);

function Forecast() {
  const { data, error, loading } = useRpc('lg_forecast', { p_days: 7 });
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const max = Math.max(...data.days.map((d) => Number(d.orders)), 1);
  const short = data.days.filter((d) => d.under_capacity);
  return <div className="stack">
    {short.length > 0 && <div className="flash bad"><Icon name="alert" /><div>Sous-capacité prévue : {short.map((d) => `${wd(d.date)} ${dmy(d.date)} (${d.vehicles_needed} véhicules pour ${data.fleet})`).join(' · ')}. Appelez des livreurs en renfort.</div></div>}
    <Card><div className="card-title"><h2>7 prochains jours</h2><span className="small muted">{data.per_trip} colis par voyage en moyenne · flotte : {data.fleet}</span></div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${data.days.length}, 1fr)`, gap: 10, alignItems: 'end', height: 220 }}>
        {data.days.map((d) => <div key={d.date} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, height: '100%', justifyContent: 'flex-end' }}>
          <b className="small">{Math.round(d.orders)}</b>
          <div title={`${d.orders} commandes`} style={{ width: '70%', borderRadius: '8px 8px 2px 2px', height: `${(100 * Number(d.orders)) / max}%`, minHeight: 4,
            background: d.peak ? 'linear-gradient(180deg,#fbbf24,#d97706)' : d.under_capacity ? 'linear-gradient(180deg,#f87171,#dc2626)' : 'linear-gradient(180deg,#34d399,#059669)' }} />
          <span className="small" style={{ textTransform: 'capitalize' }}>{wd(d.date, { weekday: 'short' }).replace('.', '')}</span>
          <span className="small muted">{d.vehicles_needed} véh.</span>{d.peak && <Badge kind="todo">{d.peak}</Badge>}</div>)}</div></Card>
    <div className="grid cols-3">{data.days.slice(0, 3).map((d) => <Card key={d.date}><h3 style={{ textTransform: 'capitalize' }}>{wd(d.date)} {dmy(d.date)}</h3>
      {d.zones.length === 0 ? <p className="small muted">Pas d'historique ce jour-là.</p> : <div className="list">{d.zones.map((z) =>
        <div key={z.zone} className="line small"><span className="grow">{z.zone}</span><b>{z.orders}</b></div>)}</div>}</Card>)}</div>
    <p className="small muted">Méthode : moyenne pondérée du même jour de la semaine sur les 4 dernières semaines (0,4 · 0,3 · 0,2 · 0,1), × coefficient des jours de pic déclarés dans les réglages (Tabaski, Korité, Magal, Louma…), marge de 15 % pour les véhicules.</p>
  </div>;
}

const KIND = { far_deliveries: ['pin', 'Livraisons loin de l\'adresse'], cash_gaps: ['cash', 'Écarts de caisse répétés'], driver_failures: ['x', 'Taux d\'échec élevé'],
  customer_refusals: ['user', 'Client à risque (paiement à la livraison)'], vendor_stockouts: ['store', 'Ruptures fréquentes'], zone_failures: ['map', 'Zone difficile'] };
function Anomalies() {
  const { data, error, loading } = useRpc('lg_anomalies', { p_days: 30 });
  if (loading && !data) return <Loading />;
  return <div className="stack"><ErrorBox error={error} />
    <p className="small muted" style={{ margin: 0 }}>Schémas repérés sur 30 jours. Ce sont des signaux à vérifier, pas des accusations : croisez avec la fiche colis et les preuves.</p>
    {!data?.length ? <Card><Empty icon="shield">Aucune anomalie détectée.</Empty></Card> : <div className="grid cols-2">{data.map((a, i) => { const [ic, label] = KIND[a.kind] ?? ['alert', a.kind]; return <Card key={i} kind={a.severity === 'critical' ? 'bad' : a.severity === 'warning' ? 'todo' : 'info'}>
      <div className="line"><span className="chip-ico" style={{ '--c': a.severity === 'critical' ? '#dc2626' : a.severity === 'warning' ? '#ea580c' : '#2563eb' }}><Icon name={ic} /></span>
        <div className="grow"><div className="small muted">{label}</div><b>{a.subject}</b></div><Badge kind={a.severity === 'critical' ? 'bad' : a.severity === 'warning' ? 'todo' : 'info'}>{a.score}</Badge></div>
      <p className="small" style={{ margin: '8px 0 0' }}>{a.metric}</p></Card>; })}</div>}
  </div>;
}

function Leaderboard() {
  const [days, setDays] = useState('7');
  const { data, error, loading } = useRpc('lg_leaderboard', { p_days: Number(days) });
  if (loading && !data) return <Loading />;
  return <div className="stack"><ErrorBox error={error} />
    <Chips options={[['7', '7 jours'], ['30', '30 jours']]} value={days} onChange={setDays} />
    <Card><div className="scroll-x"><table className="tbl"><thead><tr><th>#</th><th>Chauffeur</th><th className="num">Livrés</th><th className="num">1re présentation</th>
      <th className="num">Ponctualité</th><th className="num">Note</th><th className="num">Gains</th><th className="num">Score</th></tr></thead>
      <tbody>{(data ?? []).map((r) => <tr key={r.courier_id}><td><b>{r.rank}</b></td><td>{r.name}</td><td className="num">{r.delivered}</td>
        <td className="num">{r.first_attempt_pct ?? '—'}{r.first_attempt_pct != null && ' %'}</td><td className="num">{r.on_time_pct ?? '—'}{r.on_time_pct != null && ' %'}</td>
        <td className="num">★ {Number(r.rating).toFixed(1)}</td><td className="num">{formatF(r.earnings)}</td><td className="num"><b>{r.score}</b></td></tr>)}</tbody></table></div></Card>
    <p className="small muted">Score : volume (40) + réussite à la 1re présentation (30) + ponctualité (20) + note des clients (10).</p>
  </div>;
}

// Retours : frais et causes (P2) — par motif, par vendeur, par quartier ; réglage des causes par l'administrateur
const PAYER = { vendor: 'Vendeur', customer: 'Client', nexus: 'NEXUS', none: 'Personne' };
const PAYER_KIND = { vendor: 'todo', customer: 'info', nexus: 'bad', none: '' };
function ReturnStats() {
  const [range, setRange] = useState('30');
  const to = new Date(); const from = new Date(Date.now() - (Number(range) - 1) * 864e5);
  const { data, error, loading } = useRpc('lg_return_stats', { p_from: iso(from), p_to: iso(to) });
  const me = useMe();
  const causes = useRpc('lg_return_causes', {});
  const [edit, setEdit] = useState(null);
  const [run, busy] = useAction();
  const k = data?.totals;
  return <div className="stack">
    <Chips options={[['7', '7 jours'], ['30', '30 jours'], ['90', '90 jours']]} value={range} onChange={setRange} />
    <ErrorBox error={error} />
    {loading && !data ? <Loading /> : data && <>
      <div className="stats">
        <Stat icon="refresh" label="retours classés" value={k.returns} />
        <Stat icon="store" c="#ea580c" label="frais vendeurs" value={formatF(k.vendor_fcfa)} />
        <Stat icon="user" c="#2563eb" label="frais clients" value={formatF(k.customer_fcfa)} />
        <Stat icon="alert" c="#dc2626" label="à la charge de NEXUS" value={formatF(k.nexus_fcfa)} />
        <Stat icon="clock" label="retours sans cause" value={k.unclassified} kind={k.unclassified ? 'todo' : 'ok'} />
      </div>
      <div className="grid cols-2">
        <Card><h3>Par motif</h3>{!data.by_cause.length ? <Empty icon="check">Aucun retour classé.</Empty> :
          <div className="list">{data.by_cause.map((c) => <div key={c.cause} className="line"><span className="grow">{c.label}
            <div><Badge kind={PAYER_KIND[c.payer]}>{PAYER[c.payer]}</Badge></div></span>
            <span style={{ textAlign: 'right' }}><b>{c.count}</b><div className="small muted">{formatF(c.amount_fcfa)}</div></span></div>)}</div>}</Card>
        <Card><h3>Par quartier</h3>{!data.by_zone.length ? <Empty icon="map">Rien.</Empty> :
          <div className="list">{data.by_zone.map((z) => <div key={z.zone} className="line"><span className="grow">{z.zone}
            <div className="small muted">{Object.entries(z.causes).map(([c, n]) => `${(causes.data ?? []).find((x) => x.code === c)?.label ?? c} : ${n}`).join(' · ')}</div></span><b>{z.count}</b></div>)}</div>}</Card>
      </div>
      <Card><h3>Par vendeur</h3>{!data.by_vendor.length ? <Empty icon="store">Rien.</Empty> :
        <div className="scroll-x"><table className="tbl"><thead><tr><th>Vendeur</th><th className="num">Retours</th><th className="num">Dont sa faute</th>
          <th className="num">Livrées</th><th className="num">Taux de retour</th><th className="num">Frais à sa charge</th></tr></thead>
          <tbody>{data.by_vendor.map((v) => <tr key={v.vendor_id ?? v.name}><td>{v.name}</td><td className="num">{v.count}</td><td className="num">{v.vendor_fault}</td>
            <td className="num">{v.delivered}</td><td className="num" style={{ color: v.return_pct > 10 ? 'var(--bad)' : undefined }}>{v.return_pct ?? '—'}{v.return_pct != null && ' %'}</td>
            <td className="num">{formatF(v.amount_fcfa)}</td></tr>)}</tbody></table></div>}
        <p className="small muted">Frais constatés, pas encaissés : la retenue sur reversement ou la facturation au client reste une décision.</p></Card>
    </>}
    <Card><h3>Causes et frais</h3><div className="list">{(causes.data ?? []).map((c) => <div key={c.code} className="line">
      <span className="grow" style={{ opacity: c.active ? 1 : .5 }}>{c.label}<div className="small muted">{PAYER[c.payer]} · {c.payer === 'none' || c.fee_mode === 'none' ? 'sans frais' : c.fee_mode === 'delivery' ? 'frais de livraison de la commande' : formatF(c.fee_fcfa)}</div></span>
      {me?.is_admin && <Btn size="sm" onClick={() => setEdit({ ...c })}>Modifier</Btn>}</div>)}</div></Card>
    {edit && <Modal title={edit.label} onClose={() => setEdit(null)}><div className="stack">
      <Field label="Libellé"><input className="input" value={edit.label} onChange={(e) => setEdit({ ...edit, label: e.target.value })} /></Field>
      <Field label="Qui supporte les frais"><Chips options={Object.entries(PAYER)} value={edit.payer} onChange={(payer) => setEdit({ ...edit, payer })} /></Field>
      <Field label="Montant"><Chips options={[['none', 'Aucun'], ['delivery', 'Frais de livraison'], ['fixed', 'Montant fixe']]} value={edit.fee_mode} onChange={(fee_mode) => setEdit({ ...edit, fee_mode })} /></Field>
      {edit.fee_mode === 'fixed' && <Field label="Montant fixe (F CFA)"><input className="input" inputMode="numeric" value={edit.fee_fcfa} onChange={(e) => setEdit({ ...edit, fee_fcfa: e.target.value.replace(/\D/g, '') })} /></Field>}
      <Chips options={[['on', 'Active'], ['off', 'Désactivée']]} value={edit.active ? 'on' : 'off'} onChange={(v) => setEdit({ ...edit, active: v === 'on' })} />
      <Btn kind="primary" disabled={busy} onClick={() => run(async () => {
        const r = await rpc('lg_return_cause_save', { p: { ...edit, fee_fcfa: Number(edit.fee_fcfa) || 0 } }); setEdit(null); causes.reload(); return r;
      }, { ok: 'Cause enregistrée' })}>Enregistrer</Btn></div></Modal>}
  </div>;
}
