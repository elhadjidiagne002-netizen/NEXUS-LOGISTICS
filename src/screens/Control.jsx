// Module 04 — Tour de contrôle : indicateurs en haut, carte à gauche, voyages classés par urgence à droite.
import React, { useState } from 'react';
import { rpc } from '../lib/backend.js';
import { useRpc, useAction, useNav, Icon, Btn, Card, Badge, Empty, Loading, ErrorBox, PageHead, Modal, Field, Stat, Tabs, StatusBadge, Gauge,
  formatF, hhmm, kg, ago } from '../components/ui.jsx';
import { MapView } from '../components/field.jsx';

const STOP_COLOR = { delivered: '#14833b', failed: '#c62828', pending: '#c25a00', en_route: '#1d4ed8', arrived: '#1d4ed8' };
const ALERT_ICO = { late: 'clock', long_stop: 'clock', failure: 'x', cash_gap: 'cash', driver_offline: 'wifioff', far_delivery: 'pin', stale_package: 'box',
  doc_expiring: 'receipt', cash_limit: 'cash', sos: 'alert', overload: 'alert', not_scanned: 'scan', maintenance_due: 'wrench' };

export default function Control() {
  const { data: d, error, loading, reload } = useRpc('lg_dashboard', {}, { refresh: 15000 });
  const [tab, setTab] = useState('trips');
  const [focus, setFocus] = useState(null);
  const [move, setMove] = useState(null);
  const [run] = useAction();
  if (loading && !d) return <Loading />;
  if (error) return <><PageHead title="Tour de contrôle" back="/" /><ErrorBox error={error} /></>;
  const k = d.kpis;
  const trips = d.trips.filter((t) => !focus || t.id === focus);
  const markers = [
    ...trips.filter((t) => t.position).map((t) => ({ kind: 'truck', lat: t.position.lat, lng: t.position.lng, icon: t.vehicle_kind === 'moto' ? '🛵' : '🚚',
      popup: `V${t.number} · ${t.courier ?? ''}`, onClick: () => setFocus(t.id) })),
    ...trips.flatMap((t) => t.stops.map((s) => ({ lat: s.lat, lng: s.lng, label: s.seq, color: STOP_COLOR[s.status] ?? '#56655e',
      popup: `V${t.number} · arrêt ${s.seq} · ${s.name ?? ''} · ${s.status}${s.eta ? ' · ' + hhmm(s.eta) : ''}` }))),
    ...(tab === 'assign' ? d.to_assign.map((o) => ({ lat: o.lat, lng: o.lng, label: '＋', color: '#6b21a8', popup: `À affecter · ${o.order_short} · ${o.zone}` })) : []),
  ];
  const lines = trips.map((t) => ({ points: t.stops.filter((s) => s.lat != null).map((s) => [s.lat, s.lng]), color: t.late_min > 15 ? '#c62828' : '#0b6e4f', dashed: t.status !== 'in_progress' }));
  return <>
    <PageHead title="Tour de contrôle" back="/"><Rain /><span className="small muted">mis à jour toutes les 15 s</span></PageHead>
    <div className="stats">
      <Stat icon="box" c="#0284c7" label="colis du jour" value={k.packages_today} />
      <Stat icon="check" c="#059669" label="livrés" value={k.delivered} kind="ok" />
      <Stat icon="x" c="#dc2626" label="échecs" value={k.failed} kind={k.failed ? 'bad' : ''} />
      <Stat icon="clock" c="#ea580c" label="voyages en retard" value={k.trips_late} kind={k.trips_late ? 'bad' : ''} />
      <Stat icon="cash" c="#d97706" label="espèces dehors" value={formatF(k.cash_out_fcfa)} kind="todo" />
      <Stat icon="receipt" c="#4f46e5" label="encore à encaisser" value={formatF(k.cod_to_collect_fcfa)} />
      <Stat icon="layers" c="#7c3aed" label="à préparer · à quai" value={`${k.to_pick} · ${k.staged}`} />
      <Stat icon="store" c="#ea580c" label="à collecter chez les vendeurs" value={k.to_collect ?? 0} />
    </div>
    <div className="split" style={{ marginTop: 12 }}>
      <div className="stack">
        <MapView markers={markers} lines={lines} tall fitKey={focus ?? tab} />
        {focus && <Btn size="sm" onClick={() => setFocus(null)}>Voir tous les voyages</Btn>}
      </div>
      <div>
        <Tabs value={tab} onChange={setTab} tabs={[['trips', `Voyages (${d.trips.length})`], ['alerts', `Alertes (${d.alerts.length})`], ['assign', `À affecter (${d.to_assign.length})`]]} />
        {tab === 'trips' && <div className="stack">{d.trips.length === 0 ? <Card><Empty>Aucun voyage aujourd'hui.</Empty></Card> : d.trips.map((t) =>
          <Card key={t.id} kind={t.late_min > 15 || t.failures ? 'bad' : t.status === 'in_progress' ? 'ok' : 'todo'} className={focus === t.id ? 'active' : ''}
            style={{ cursor: 'pointer' }} onClick={() => setFocus(focus === t.id ? null : t.id)}>
            <div className="row between"><b>V{t.number} · {t.label ?? '—'}</b><span className="big">{t.stops_done} / {t.stops_total}</span></div>
            <div className="small">{t.vehicle_kind} {t.plate} · {t.late_min > 0 ? <span style={{ color: 'var(--bad)', fontWeight: 700 }}>{t.late_min} min de retard</span> : 'à l\'heure'}
              {t.stopped_min > 10 ? ` · arrêt depuis ${t.stopped_min} min` : ''}{t.failures ? ` · ${t.failures} échec(s)` : ''}</div>
            <div className="row between small"><span><StatusBadge s={t.status} /> {formatF(t.cod_expected_fcfa)} à encaisser</span>
              {t.courier_phone && <a href={`tel:${t.courier_phone}`} onClick={(e) => e.stopPropagation()}>📞 {t.courier}</a>}</div>
            {['planned', 'loading'].includes(t.status) && <Gauge label="Rempli" pct={t.gauge.fill_pct} />}
            {t.position && <div className="small muted">position {ago(t.position.at)}</div>}
            {focus === t.id && ['planned', 'loading', 'sealed', 'in_progress'].includes(t.status) &&
              <Btn size="sm" onClick={(e) => { e.stopPropagation(); setMove(t); }}>Déplacer un arrêt…</Btn>}
          </Card>)}</div>}
        {tab === 'alerts' && <div className="stack">{d.alerts.length === 0 ? <Card><Empty icon="check">Aucune alerte.</Empty></Card> : d.alerts.map((a) =>
          <Card key={a.id} kind={a.severity === 'critical' ? 'bad' : a.severity === 'warning' ? 'todo' : ''}>
            <div className="line"><span className="chip-ico" style={{ width: 36, height: 36, '--c': a.severity === 'critical' ? '#dc2626' : a.severity === 'warning' ? '#ea580c' : '#2563eb' }}><Icon name={ALERT_ICO[a.kind] ?? 'bell'} size={18} /></span><div className="grow">{a.message}<div className="small muted">{ago(a.created_at)}</div></div>
              <Btn size="sm" onClick={() => run(async () => { await rpc('lg_ack_alert', { p_id: a.id }); reload(); })}>Traité</Btn></div></Card>)}</div>}
        {tab === 'assign' && <Assign d={d} reload={reload} />}
      </div>
    </div>
    {move && <MoveStop trip={move} trips={d.trips} onClose={() => setMove(null)} onDone={() => { setMove(null); reload(); }} />}
  </>;
}

function Assign({ d, reload }) {
  const [sugg, setSugg] = useState(null);
  const [plan, setPlan] = useState(null);
  const [run, busy] = useAction();
  const { go } = useNav();
  const open = async (o) => setSugg({ o, list: await rpc('lg_suggest_trips', { p_order: o.order_id }) });
  return <div className="stack">
    <div className="row"><Btn kind="primary" disabled={busy || d.to_assign.length === 0} onClick={() => run(async () => setPlan(await rpc('lg_autoplan_run', { p_apply: false })))}>
        <Icon name="route" size={18} />Planifier automatiquement</Btn>
      <Btn kind="ghost" onClick={() => go('/quai')}>Aller au quai</Btn></div>
    {plan && <AutoPlan plan={plan} onClose={() => setPlan(null)} onDone={() => { setPlan(null); reload(); }} />}
    {d.to_assign.length === 0 ? <Card><Empty>Tout est affecté.</Empty></Card> : d.to_assign.map((o) => <Card key={o.order_id} kind="todo">
      <div className="row between"><div><b>{o.order_short}</b> · {o.zone}<div className="small muted">{o.packages} colis · {kg(o.weight_g)} · à quai {ago(o.oldest)}
        {o.cod_fcfa ? ` · ${formatF(o.cod_fcfa)}` : ' · payé'}</div></div><Btn size="sm" kind="primary" onClick={() => open(o)}>Affecter</Btn></div></Card>)}
    {sugg && <Modal title={`Affecter ${sugg.o.order_short} (${sugg.o.zone})`} onClose={() => setSugg(null)}>
      {sugg.list.length === 0 ? <Empty>Aucun voyage ouvert compatible (zone, capacité, glacière, plafond d'espèces). Créez-en un au quai.</Empty>
        : <div className="list">{sugg.list.map((t, i) => <div key={t.trip_id} className="line">
          <span className="grow"><b>V{t.number}</b> {t.label} <span className="small muted">· {t.vehicle_kind} · {t.courier ?? '—'}</span>
            <div className="small muted">note {t.score}/100 · arrêt le plus proche {t.nearest_m != null ? `${(t.nearest_m / 1000).toFixed(1)} km` : '—'} · poids après {t.weight_after_pct} %</div></span>
          {i === 0 && <Badge kind="ok">suggéré</Badge>}
          <Btn size="sm" kind="primary" disabled={busy} onClick={() => run(async () => { const r = await rpc('lg_trip_add_order', { p_trip: t.trip_id, p_order: sugg.o.order_id }); setSugg(null); reload(); return r; }, { ok: 'Commande affectée' })}>Choisir</Btn>
        </div>)}</div>}</Modal>}
  </div>;
}

// Réaffectation en cours de journée (panne, surcharge) : les colis déjà chargés sont repris par double scan
function MoveStop({ trip, trips, onClose, onDone }) {
  const [stop, setStop] = useState(null); const [to, setTo] = useState('');
  const [run, busy] = useAction();
  const open = trip.stops.filter((s) => ['pending', 'en_route', 'arrived'].includes(s.status));
  const dests = trips.filter((x) => x.id !== trip.id && ['planned', 'loading', 'sealed', 'in_progress'].includes(x.status));
  return <Modal title={`Déplacer un arrêt du voyage V${trip.number}`} onClose={onClose}><div className="stack">
    <Field label="Arrêt"><select className="input" value={stop ?? ''} onChange={(e) => setStop(e.target.value)}><option value="">—</option>
      {open.map((s) => <option key={s.seq} value={s.seq}>{s.seq}. {s.name}</option>)}</select></Field>
    <Field label="Vers le voyage"><select className="input" value={to} onChange={(e) => setTo(e.target.value)}><option value="">—</option>
      {dests.map((x) => <option key={x.id} value={x.id}>V{x.number} · {x.courier ?? ''} · {x.status}</option>)}</select></Field>
    <p className="small muted">Si le colis est déjà dans le premier véhicule, le second chauffeur le scanne en le prenant : sans ce scan, il ne peut pas le livrer.</p>
    <Btn kind="primary" size="xl" disabled={!stop || !to || busy} onClick={() => run(async () => {
      const s = trip.stops.find((x) => String(x.seq) === String(stop));
      const r = await rpc('lg_transfer_stop', { p_stop: s.id, p_to_trip: to }); onDone(); return r;
    }, { ok: 'Arrêt déplacé' })}>Déplacer</Btn></div></Modal>;
}

// Simulation avant validation : voyages proposés (balayage autour du hub + capacités + plafond d'espèces)
function AutoPlan({ plan, onClose, onDone }) {
  const [run, busy] = useAction();
  const { go } = useNav();
  return <Modal title="Planification proposée" onClose={onClose}><div className="stack">
    {plan.trips.length === 0 ? <Empty icon="truck">{plan.vehicles_free === 0 ? 'Aucun véhicule libre avec un chauffeur disponible.' : 'Rien à planifier.'}</Empty> :
      <>{plan.trips.map((t) => <Card key={t.vehicle_id} kind={t.fill_pct >= 90 ? 'todo' : 'ok'}>
        <div className="row between"><b>{t.label || 'Voyage'}</b><span className="badge info plain">{t.orders.length} commande(s)</span></div>
        <div className="small muted">{t.kind} {t.plate} · {t.courier} · {t.n} colis · {kg(t.w)}{t.cod ? ` · ${formatF(t.cod)} à encaisser` : ''}</div>
        <Gauge label="Rempli" pct={t.fill_pct} /></Card>)}</>}
    {plan.unassigned.length > 0 && <Card kind="bad"><b>Non planifiées ({plan.unassigned.length})</b>
      <div className="small">{plan.unassigned.map((u) => `${u.zone ?? '?'} (${u.reason})`).join(' · ')}</div></Card>}
    <p className="small muted" style={{ margin: 0 }}>Les commandes voisines sont regroupées en tournant autour du hub ; chaque véhicule se remplit jusqu'à sa première limite (poids, volume, colis, espèces). L'ordre des arrêts est calculé à la création.</p>
    {plan.trips.length > 0 && <Btn kind="primary" size="xl" disabled={busy} onClick={() => run(async () => {
      const r = await rpc('lg_autoplan_run', { p_apply: true }); onDone(); go('/quai'); return r;
    }, { ok: 'Voyages créés : à charger au quai' })}>Créer {plan.trips.length} voyage{plan.trips.length > 1 ? 's' : ''}</Btn>}
  </div></Modal>;
}

// Forte pluie : le répartiteur déclare le supplément pour quelques heures (devis au panier)
function Rain() {
  const { data, reload } = useRpc('lg_surcharges_list', {}, { refresh: 60000 });
  const [open, setOpen] = useState(false);
  const [run, busy] = useAction();
  const rain = (data ?? []).find((s) => s.code === 'rain');
  if (!rain) return null;
  const declare = (h) => run(async () => { const r = await rpc('lg_surcharge_declare', { p_code: 'rain', p_hours: h, p_zones: null }); setOpen(false); reload(); return r; },
    { ok: h ? `Supplément pluie actif ${h} h` : 'Supplément pluie levé' });
  return <>
    <Btn size="sm" kind={rain.in_force ? 'todo' : 'ghost'} onClick={() => setOpen(true)}>{rain.in_force ? `Pluie · jusqu'à ${hhmm(rain.until)}` : 'Forte pluie'}</Btn>
    {open && <Modal title="Supplément forte pluie" onClose={() => setOpen(false)}><div className="stack">
      <p style={{ margin: 0 }}>Ajoute <b>{formatF(rain.amount_fcfa)}</b> au prix de livraison des nouvelles commandes{rain.zones?.length ? ` (${rain.zones.join(', ')})` : ', toutes zones'}. Les livraisons offertes restent offertes.</p>
      <div className="row">{[2, 4, 8].map((h) => <Btn key={h} kind="primary" disabled={busy} onClick={() => declare(h)}>{h} h</Btn>)}
        {rain.in_force && <Btn kind="bad" disabled={busy} onClick={() => declare(0)}>Lever maintenant</Btn>}</div>
      <p className="small muted">Le montant et les zones se règlent dans Administration → Tarifs et zones.</p></div></Modal>}
  </>;
}
