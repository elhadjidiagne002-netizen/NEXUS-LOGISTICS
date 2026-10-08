// Module 03 — Chargement du véhicule (chef de quai) + réception des retours (module 07).
import React, { useState } from 'react';
import { rpc } from '../lib/backend.js';
import { act, queueUpload } from '../lib/offline.js';
import { errText } from '../lib/errors.js';
import { printManifest } from '../lib/print.js';
import { optimizeRoute } from '../lib/algo.js';
import { useMe } from '../App.jsx';
import { Icon, useRpc, useAction, useNav, feedback, Btn, Card, Badge, Empty, Loading, ErrorBox, PageHead, Modal, Field, Chips, Tabs,
  StatusBadge, Gauge, formatF, hhmm, kg, ago } from '../components/ui.jsx';
import { Scanner, SignaturePad } from '../components/field.jsx';

const WARN = { volume_full: 'Volume presque plein', fill_90: 'Véhicule rempli à 90 %', liquid_upright_bottom: 'Liquide : debout et en bas',
  separate_food_chemical: 'Séparer alimentaire et produits d\'entretien' };
const ZONE_FR = { fond: 'FOND', milieu: 'MILIEU', porte: 'PORTE', caisson: 'CAISSON' };

export default function Dock({ sub, id }) {
  if (sub === 'voyage' && id) return <Loading_ id={id} />;
  return <DockHome />;
}

function DockHome() {
  const [tab, setTab] = useState('trips');
  return <>
    <PageHead title="Quai" back="/" />
    <Tabs value={tab} onChange={setTab} tabs={[['trips', 'Voyages'], ['docks', 'Quais'], ['staged', 'Colis à quai'], ['inbound', 'Collectes et reprises'], ['receive', 'Réception'], ['returns', 'Retours']]} />
    {tab === 'trips' && <Trips />}{tab === 'docks' && <Docks />}{tab === 'staged' && <Staged />}{tab === 'returns' && <Returns />}
    {tab === 'inbound' && <Inbound />}{tab === 'receive' && <div className="split"><Receive /><Dropoffs /></div>}
  </>;
}

function Trips() {
  const { data, error, loading, reload } = useRpc('lg_trips_list', { p_scope: 'open' }, { refresh: 20000 });
  const { go } = useNav();
  const [creating, setCreating] = useState(false);
  return <div className="stack">
    <div className="row"><Btn kind="primary" onClick={() => setCreating(true)}>＋ Nouveau voyage</Btn></div>
    <ErrorBox error={error} />
    {loading && !data ? <Loading /> : !data?.length ? <Card><Empty>Aucun voyage ouvert.</Empty></Card> :
      <div className="grid cols-2">{data.map((t) => <Card key={t.id} kind={t.status === 'loading' ? 'todo' : t.status === 'in_progress' ? 'ok' : ''}
        style={{ cursor: 'pointer' }} onClick={() => go(`/quai/voyage/${t.id}`)}>
        <div className="row between"><h3 style={{ margin: 0 }}>Voyage n° {t.number}</h3><StatusBadge s={t.status} /></div>
        <div className="small muted">{t.label ?? '—'} · {t.vehicle.kind} {t.vehicle.plate} · {t.courier ?? 'sans chauffeur'}</div>
        <div className="small">Départ {hhmm(t.planned_departure)} · {t.stops} arrêt(s) · {t.gauge.loaded}/{t.gauge.planned} colis chargés</div>
        <Gauge label="Rempli" pct={t.gauge.fill_pct} />
      </Card>)}</div>}
    {creating && <NewTrip onClose={() => setCreating(false)} onDone={(tid) => { setCreating(false); reload(); go(`/quai/voyage/${tid}`); }} />}
  </div>;
}

function NewTrip({ onClose, onDone }) {
  const fleet = useRpc('lg_fleet', {});
  const couriers = useRpc('lg_couriers_list', {});
  const zones = useRpc('lg_staged_packages', {});
  const [f, setF] = useState({ vehicle: '', courier: '', label: '', zones: [], time: '' });
  const [run, busy] = useAction();
  const vehicles = (fleet.data ?? []).filter((v) => v.status === 'available' && !v.on_trip);
  const v = vehicles.find((x) => x.id === f.vehicle);
  return <Modal title="Nouveau voyage" onClose={onClose}><div className="stack">
    <Field label="Véhicule (disponibles et en règle)"><select className="input" value={f.vehicle} onChange={(e) => {
      const veh = vehicles.find((x) => x.id === e.target.value); setF({ ...f, vehicle: e.target.value, courier: veh?.default_courier?.id ?? f.courier });
    }}><option value="">—</option>{vehicles.map((x) => <option key={x.id} value={x.id} disabled={x.documents.some((d) => d.expired)}>
      {x.kind} {x.plate} · {x.capacity_kg} kg{x.documents.some((d) => d.expired) ? ' · DOCUMENTS EXPIRÉS' : ''}</option>)}</select></Field>
    {v?.documents.some((d) => d.soon) && <div className="flash todo">Un document de ce véhicule expire bientôt.</div>}
    <Field label="Chauffeur"><select className="input" value={f.courier} onChange={(e) => setF({ ...f, courier: e.target.value })}>
      <option value="">—</option>{(couriers.data ?? []).map((c) => <option key={c.id} value={c.id} disabled={c.busy}>{c.name} · {c.vehicle_type}{c.busy ? ' · voyage non clôturé' : ''}</option>)}</select></Field>
    <Field label="Libellé"><input className="input" value={f.label} placeholder="Dakar → Rufisque" onChange={(e) => setF({ ...f, label: e.target.value })} /></Field>
    <Field label="Zones desservies (vide = toutes)"><Chips multi options={(zones.data ?? []).map((z) => [z.zone, `${z.zone} (${z.count})`])} value={f.zones} onChange={(z) => setF({ ...f, zones: z })} /></Field>
    <Field label="Départ prévu"><input className="input" type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} /></Field>
    <Btn kind="primary" size="xl" disabled={!f.vehicle || !f.courier || busy} onClick={() => run(async () => {
      let dep = null;
      if (f.time) { const d = new Date(); const [h, m] = f.time.split(':'); d.setHours(Number(h), Number(m), 0, 0); dep = d.toISOString(); }
      const r = await rpc('lg_trip_create', { p_vehicle: f.vehicle, p_courier: f.courier, p_label: f.label || null, p_departure: dep, p_zones: f.zones });
      onDone(r.trip_id); return r;
    }, { ok: 'Voyage créé' })}>Créer le voyage</Btn>
  </div></Modal>;
}

function Staged() {
  const { data, error, loading } = useRpc('lg_staged_packages', {}, { refresh: 20000 });
  if (loading && !data) return <Loading />;
  return <div className="stack"><ErrorBox error={error} />
    {!data?.length ? <Card><Empty>Le quai est vide.</Empty></Card> : data.map((z) => <Card key={z.zone}>
      <div className="row between"><h3 style={{ margin: 0 }}>{z.zone}</h3><span className="small muted">{z.count} colis · le plus ancien {ago(z.oldest)}</span></div>
      <div className="list">{z.packages.map((p) => <div key={p.code} className="line">
        <span className="mono grow">{p.code}</span><span className="small muted">Cde {p.order_short} · {kg(p.weight_g)}</span>
        {p.in_trip && <Badge kind="info">affecté</Badge>}{p.attempts > 0 && <Badge kind="todo">{p.attempts + 1}e présentation</Badge>}
        <StatusBadge s={p.status} /></div>)}</div></Card>)}</div>;
}

function Returns() {
  return <div className="split"><div className="stack"><Expected /><ReturnScan /></div><Inspect /></div>;
}

// Retour de tournée (P2) : colis non livrés que chaque chauffeur doit rapporter ; l'alerte se lève au dernier scan
function Expected() {
  const { data } = useRpc('lg_returns_expected', {}, { refresh: 20000 });
  if (!data?.length) return null;
  return <Card kind="todo"><h3>Attendus au quai</h3><div className="list">{data.map((x) => <div key={x.trip_id} className="line">
    <span className="grow"><b>Voyage n° {x.number}</b> · {x.courier ?? '—'}
      <div className="small muted">terminé il y a {x.minutes} min · {x.codes.length} colis : <span className="mono">{x.codes.join(', ')}</span></div></span>
    {x.minutes > 60 && <Badge kind="bad">en retard</Badge>}
    {x.phone && <a className="btn sm" href={`tel:${x.phone}`}><Icon name="phone" size={14} /></a>}</div>)}</div>
    <p className="small muted" style={{ margin: '8px 0 0' }}>Scannez-les ci-dessous (une autre personne que le chauffeur). Un colis manquant reste signalé dans la tour de contrôle.</p></Card>;
}

// Contrôle du retour (P2) : état du produit, puis décision — remise en vente, retour vendeur ou rebut
function Inspect() {
  const { data, reload } = useRpc('lg_returns_to_inspect', {}, { refresh: 30000 });
  const causes = useRpc('lg_return_causes', {});
  const [cur, setCur] = useState(null);
  const cause = (causes.data ?? []).find((c) => c.code === cur?.cause);
  const [run, busy] = useAction();
  return <Card><h2>Contrôle des retours</h2>
    {!data?.length ? <Empty icon="check">Aucun colis à contrôler.</Empty> : <div className="list">{data.map((p) =>
      <div key={p.code} className="line"><span className="grow"><b className="mono">{p.code}</b> <Badge kind={p.direction === 'return' ? 'info' : 'todo'}>{p.direction === 'return' ? 'retour client' : `${p.attempts} échecs`}</Badge>
        <div className="small muted">{p.items} · {p.vendor} · {ago(p.since)}</div></span>
        <Btn size="sm" kind="primary" onClick={() => setCur({ ...p, condition: 'bon', decision: p.direction === 'return' ? 'restock' : 'vendor', cause: p.cause ?? p.suggested_cause ?? null })}>Contrôler</Btn></div>)}</div>}
    {cur && <Modal title={`Contrôle · ${cur.code}`} onClose={() => setCur(null)}><div className="stack">
      <p style={{ margin: 0 }}>{cur.items}</p>
      <Field label="État du produit"><Chips options={[['neuf', 'Neuf'], ['bon', 'Bon état'], ['abime', 'Abîmé'], ['inutilisable', 'Inutilisable']]} value={cur.condition} onChange={(condition) => setCur({ ...cur, condition })} /></Field>
      <Field label="Décision"><Chips options={[['restock', 'Remettre en vente'], ['vendor', 'Rendre au vendeur'], ['scrap', 'Rebut']]} value={cur.decision} onChange={(decision) => setCur({ ...cur, decision })} /></Field>
      {cur.decision === 'restock' && !['neuf', 'bon'].includes(cur.condition) && <div className="flash todo">Seul un produit neuf ou en bon état se remet en vente.</div>}
      <Field label="Cause du retour"><Chips options={(causes.data ?? []).filter((c) => c.active).map((c) => [c.code, c.label])} value={cur.cause} onChange={(c) => setCur({ ...cur, cause: c, cause_touched: true })} /></Field>
      {cause && <div className="small muted">{cur.suggested_cause === cause.code && !cur.cause_touched ? 'Cause suggérée d\'après le motif. ' : ''}Frais : {{ vendor: 'à la charge du vendeur', customer: 'à la charge du client', nexus: 'à la charge de NEXUS', none: 'aucun' }[cause.payer]}
        {cause.payer !== 'none' && cause.fee_mode !== 'none' ? ` (${cause.fee_mode === 'delivery' ? 'frais de livraison de la commande' : formatF(cause.fee_fcfa)})` : ''}.</div>}
      <Field label="Remarque"><input className="input" value={cur.note ?? ''} onChange={(e) => setCur({ ...cur, note: e.target.value })} /></Field>
      <p className="small muted">Le client est remboursé par avoir s'il avait été facturé. Le rebut ouvre un incident.</p>
      <Btn kind="primary" size="xl" disabled={busy || !cur.cause} onClick={() => run(async () => {
        const k = await act('lg_return_classify', { p_code: cur.code, p_cause: cur.cause, p_note: cur.note || null }, `Cause ${cur.code}`);
        if (!k.ok && !k.queued) return k;
        const r = await act('lg_return_inspect', { p_code: cur.code, p_condition: cur.condition, p_decision: cur.decision, p_note: cur.note || null }, `Contrôle ${cur.code}`);
        if (r.ok) { setCur(null); reload(); } return r;
      }, { ok: 'Décision enregistrée' })}>Valider</Btn></div></Modal>}
  </Card>;
}

function ReturnScan() {
  const [last, setLast] = useState(null);
  const [run, busy] = useAction();
  return <Card><h2>Réception des retours</h2>
    <p className="small muted">Scan par une autre personne que le chauffeur. Le colis revient au quai ; il repart en nouvelle présentation ou retourne au vendeur.</p>
    <Scanner busy={busy} placeholder="Code du colis rendu" onCode={(code) => run(async () => {
      const r = await act('lg_return_hub', { p_code: code, p_device_at: new Date().toISOString() }, `Retour ${code}`);
      setLast({ code, ...r }); return r;
    }, { ok: 'Colis réceptionné' })} />
    {last?.ok && !last.queued && <div className="card flat stack" style={{ marginTop: 10 }}>
      <b className="mono">{last.code}</b>
      <div className="small">{last.attempts} présentation(s) comptée(s). {last.to_vendor ? 'Motif : refus → retour vendeur.' : last.can_retry ? 'Nouvelle présentation possible.' : 'Maximum atteint.'}</div>
      <div className="row">
        {last.can_retry && !last.to_vendor && <Btn kind="primary" onClick={() => run(async () => { const r = await act('lg_stage', { p_code: last.code }, 'Remise à quai'); setLast(null); return r; }, { ok: 'Remis à quai' })}>Remettre à quai</Btn>}
        <Btn kind="todo" onClick={() => run(async () => { const r = await act('lg_return_vendor', { p_code: last.code, p_reason: last.to_vendor ? 'Refus du client' : 'Présentations épuisées' }, 'Retour vendeur'); setLast(null); return r; }, { ok: 'Rendu au vendeur, stock rétabli, avoir émis si facturé' })}>Rendre au vendeur</Btn>
      </div></div>}
  </Card>;
}

/* ---------------------------------------------------------------- CHARGEMENT */
function Loading_({ id }) {
  const me = useMe();
  const { data: v, error, loading, reload } = useRpc('lg_trip_loading_view', { p_trip: id }, { refresh: 15000 });
  const [last, setLast] = useState(null);
  const [modal, setModal] = useState(null);
  const [run, busy] = useAction();
  if (loading && !v) return <Loading />;
  if (error) return <><PageHead title="Voyage" back="/quai" /><ErrorBox error={error} /></>;
  const g = v.gauge;
  const open = ['planned', 'loading'].includes(v.trip.status);
  const missing = v.stops.flatMap((s) => s.packages.filter((p) => !p.loaded && !p.outcome).map((p) => ({ ...p, seq: s.seq })));

  const load = (code) => run(async () => {
    const r = await act('lg_load_package', { p_trip: id, p_code: code, p_device_at: new Date().toISOString() }, `Chargement ${code}`);
    if (r.ok && !r.queued) { feedback('ok'); setLast({ ok: true, ...r }); reload(); }
    else if (!r.ok) setLast({ ok: false, code, error: r.error, zone: r.zone, status: r.status });
    return r.ok ? r : { ...r, ok: true };
  });
  const optimize = () => run(async () => {
    const hub = me.hubs?.[0];
    const { order, km } = optimizeRoute(hub, v.stops.map((s) => ({ id: s.id, lat: s.lat, lng: s.lng })));
    await rpc('lg_trip_reorder', { p_trip: id, p_stop_ids: order }); reload();
    return { ok: true, km };
  }, { ok: 'Arrêts réordonnés, plan de chargement recalculé' });

  return <>
    <PageHead title={`Voyage n° ${v.trip.number}`} back="/quai"><StatusBadge s={v.trip.status} /></PageHead>
    <div className="split">
      <div className="stack">
        <Card><div className="small muted">{v.trip.label} · {v.vehicle.kind} {v.vehicle.plate} · {v.courier?.name ?? 'sans chauffeur'}</div>
          <div className="stack" style={{ marginTop: 8 }}>
            <Gauge label="Poids" pct={g.weight_pct} detail={`${kg(g.weight_g)} / ${g.capacity_kg} kg`} />
            <Gauge label="Volume" pct={g.volume_pct} detail={g.capacity_l ? `${Math.round(g.volume_l)} / ${g.capacity_l} L` : 'capacité non renseignée'} />
            <Gauge label="Colis" pct={g.count_pct} detail={`${g.count}${g.max_packages ? ' / ' + g.max_packages : ''}`} />
            <div className="row between"><b>Rempli à {g.fill_pct} %</b><span className="small muted">la mesure la plus haute décide</span></div>
          </div></Card>
        {last && (last.ok ? <div className="flash ok"><span className="ico">✔</span><div style={{ flex: 1 }}>
          <div className="row between"><span className="mono">{last.code}</span><span className="zone-label" style={{ fontSize: '1.6rem' }}>{ZONE_FR[last.load_zone] ?? ''}</span></div>
          <div className="small">Arrêt {last.stop_seq} · {kg(last.weight_g)}{last.handling?.includes('fragile') ? (last.load_zone === 'caisson' ? ' · Fragile : poser au-dessus' : ' · Fragile : poser au-dessus, côté porte') : ''}</div>
          {last.warnings?.map((w) => <div key={w} className="small"><Icon name="alert" size={14} /> {WARN[w] ?? w}</div>)}</div></div>
          : <div className="flash bad"><span className="ico">✖</span><div>{errText(last.error)}{last.zone ? ` (${last.zone})` : ''}<div className="small mono">{last.code}</div></div></div>)}
        {open && <Scanner onCode={load} busy={busy} placeholder="Scanner un colis à charger" />}
        {missing.length > 0 && <Card kind="todo"><b>Reste à charger : {missing.length} colis</b>
          <div className="small">{missing.map((p) => <span key={p.code} className="mono" style={{ marginRight: 10 }}>{p.code} (arrêt {p.seq})</span>)}</div></Card>}
      </div>
      <div className="stack">
        <Card><div className="row between"><h3 style={{ margin: 0 }}>Arrêts</h3>
          {open && <div className="row"><Btn size="sm" onClick={() => setModal('add')}>＋ Commande</Btn><Btn size="sm" onClick={optimize}>Optimiser l'ordre</Btn></div>}</div>
          <div className="list">{v.stops.map((s) => <div key={s.id} className="stack" style={{ gap: 4 }}>
            <div className="line"><b>{s.seq}.</b><span className="grow">{s.contact_name} <span className="muted small">· {s.zone} · {s.landmark}</span></span>
              {s.cod_due_fcfa > 0 && <Badge kind="todo">{formatF(s.cod_due_fcfa)}</Badge>}
              {open && <Btn size="sm" kind="ghost" aria-label="Retirer l'arrêt" onClick={() => { if (confirm('Retirer cet arrêt du voyage ?')) run(async () => { await rpc('lg_trip_remove_stop', { p_trip: id, p_stop: s.id }); reload(); }); }}>✕</Btn>}</div>
            <div className="chips">{s.packages.map((p) => <span key={p.code} className={`badge ${p.loaded ? 'ok' : 'todo'}`} title={p.load_zone}>
              {p.loaded ? '✔' : '○'} {p.code.slice(-6)} · {ZONE_FR[p.load_zone] ?? '—'}</span>)}</div></div>)}</div></Card>
        {open && <Btn block onClick={() => setModal('check')}>Contrôle du véhicule</Btn>}
        {!open && <Btn block onClick={() => printManifest(v)}><Icon name="print" size={18} />Bordereau de chargement</Btn>}
      </div>
    </div>
    {open && <div className="actionbar"><div className="actionbar-inner">
      <Btn kind="primary" size="xl" disabled={busy || g.count === 0} onClick={() => setModal('seal')}>
        {missing.length ? `Valider le départ (${missing.length} non chargé)` : 'Valider le départ'}</Btn></div></div>}
    {modal === 'add' && <AddOrder trip={id} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
    {modal === 'check' && <Checklist vehicleId={null} trip={id} plate={v.vehicle.plate} vehicle={v.vehicle} onClose={() => setModal(null)} />}
    {modal === 'seal' && <Seal v={v} missing={missing} onClose={() => setModal(null)} onUnload={(code) => run(async () => {
      const r = await act('lg_unload_package', { p_trip: id, p_code: code, p_reason: 'Retiré au contrôle de départ' }, 'Retrait du voyage'); reload(); return r; })}
      onDone={(res) => { setModal(null); reload(); printManifest(res); }} />}
  </>;
}

function AddOrder({ trip, onClose, onDone }) {
  const { data } = useRpc('lg_staged_packages', {});
  const [run, busy] = useAction();
  const orders = new Map();
  for (const z of data ?? []) for (const p of z.packages) if (!p.in_trip && p.status === 'staged') {
    const o = orders.get(p.order_id) ?? { id: p.order_id, short: p.order_short, zone: z.zone, n: 0, w: 0 };
    o.n++; o.w += p.weight_g ?? 0; orders.set(p.order_id, o);
  }
  return <Modal title="Ajouter une commande au voyage" onClose={onClose}>
    {orders.size === 0 ? <Empty>Aucune commande à quai disponible.</Empty> : <div className="list">{[...orders.values()].map((o) =>
      <div key={o.id} className="line"><span className="grow"><b>{o.short}</b> <span className="muted small">· {o.zone} · {o.n} colis · {kg(o.w)}</span></span>
        <Btn size="sm" kind="primary" disabled={busy} onClick={() => run(async () => { const r = await rpc('lg_trip_add_order', { p_trip: trip, p_order: o.id }); onDone(); return r; }, { ok: 'Commande ajoutée' })}>Ajouter</Btn></div>)}</div>}
  </Modal>;
}

const CHECK = [['pneus', 'Pneus'], ['freins', 'Freins'], ['feux', 'Feux'], ['carburant', 'Carburant'], ['documents', 'Documents à bord'], ['caisson', 'Caisson / bâche propre']];
export function Checklist({ trip, vehicle, onClose }) {
  const fleet = useRpc('lg_fleet', {});
  const [c, setC] = useState(Object.fromEntries(CHECK.map(([k]) => [k, true])));
  const [km, setKm] = useState('');
  const [run, busy] = useAction();
  const vid = (fleet.data ?? []).find((x) => x.plate === vehicle.plate)?.id;
  return <Modal title={`Contrôle avant départ · ${vehicle.plate}`} onClose={onClose}><div className="stack">
    {CHECK.map(([k, l]) => <label key={k} className="check"><input type="checkbox" checked={c[k]} onChange={(e) => setC({ ...c, [k]: e.target.checked })} />{l}</label>)}
    <Field label="Kilométrage"><input className="input" inputMode="numeric" value={km} onChange={(e) => setKm(e.target.value)} /></Field>
    <Btn kind="primary" size="xl" disabled={!vid || busy} onClick={() => run(async () => {
      const r = await rpc('lg_vehicle_check', { p_vehicle: vid, p_checklist: c, p_odometer_km: km ? Number(km) : null, p_trip: trip }); onClose();
      return r;
    }, { ok: 'Contrôle enregistré' })}>Enregistrer</Btn></div></Modal>;
}

function Seal({ v, missing, onClose, onUnload, onDone }) {
  const [sig, setSig] = useState(null);
  const [run, busy] = useAction();
  return <Modal title="Validation du départ" onClose={onClose}><div className="stack">
    {missing.length > 0 && <Card kind="bad"><b>Colis prévus non chargés</b><p className="small">Chargez-les, ou retirez-les explicitement du voyage :</p>
      {missing.map((p) => <div key={p.code} className="line"><span className="mono grow">{p.code}</span><Btn size="sm" onClick={() => onUnload(p.code)}>Retirer</Btn></div>)}</Card>}
    <Card kind="flat"><div className="row between"><span>{v.gauge.count} colis · {kg(v.gauge.weight_g)}</span><b>À encaisser : {formatF(v.trip.cod_expected_fcfa)}</b></div></Card>
    <p><b>{v.courier?.name}</b> signe : il devient responsable des colis chargés.</p>
    <SignaturePad onChange={setSig} />
    <Btn kind="primary" size="xl" disabled={!sig || missing.length > 0 || busy} onClick={() => run(async () => {
      const path = await queueUpload(`${v.trip.id}/signature-depart-${Date.now()}.png`, sig);
      const r = await rpc('lg_trip_seal', { p_trip: v.trip.id, p_signature_path: path });
      if (r.ok) onDone(r);
      return r;
    }, { ok: 'Départ validé — bordereau prêt' })}>Valider et imprimer le bordereau</Btn>
  </div></Modal>;
}

/* ---------------------------------------------------------------- PREMIER KILOMÈTRE */
function Inbound() {
  const pickups = useRpc('lg_pickups_pending', {}, { refresh: 30000 });
  const returns = useRpc('lg_returns_pending', {}, { refresh: 30000 });
  const trips = useRpc('lg_trips_list', { p_scope: 'open' });
  const [pick, setPick] = useState(null);
  const [run, busy] = useAction();
  const open = (trips.data ?? []).filter((t) => ['planned', 'loading', 'sealed', 'in_progress'].includes(t.status));
  const add = () => run(async () => {
    const r = pick.kind === 'pickup' ? await rpc('lg_trip_add_pickup', { p_trip: pick.trip, p_vendor: pick.id })
      : await rpc('lg_trip_add_return', { p_trip: pick.trip, p_return: pick.id });
    setPick(null); pickups.reload(); returns.reload(); return r;
  }, { ok: 'Arrêt ajouté au voyage' });
  return <div className="grid cols-2">
    <Card><h3>Collectes chez les vendeurs</h3><p className="small muted">Colis fermés et déclarés prêts par le vendeur (modèle A).</p>
      {!pickups.data?.length ? <Empty>Aucune collecte en attente.</Empty> : <div className="list">{pickups.data.map((v) =>
        <div key={v.vendor_id} className="line"><span className="grow"><b>{v.vendor}</b><div className="small muted">{v.packages} colis · {kg(v.weight_g)} · prêt {ago(v.oldest)}{v.address ? ` · ${v.address}` : ''}</div></span>
          <Btn size="sm" kind="primary" onClick={() => setPick({ kind: 'pickup', id: v.vendor_id, label: v.vendor, trip: '' })}>Planifier</Btn></div>)}</div>}</Card>
    <Card><h3>Reprises chez les clients</h3><p className="small muted">Demandes de retour approuvées sur le site.</p>
      {!returns.data?.length ? <Empty>Aucune reprise à planifier.</Empty> : <div className="list">{returns.data.map((r) =>
        <div key={r.id} className="line"><span className="grow"><b>{r.customer}</b> <span className="small muted">· {r.zone} · Cde {r.order_short}</span><div className="small">{r.reason}</div></span>
          <Btn size="sm" kind="primary" onClick={() => setPick({ kind: 'return', id: r.id, label: r.customer, trip: '' })}>Planifier</Btn></div>)}</div>}</Card>
    {pick && <Modal title={`${pick.kind === 'pickup' ? 'Collecte' : 'Reprise'} · ${pick.label}`} onClose={() => setPick(null)}><div className="stack">
      <Field label="Dans le voyage"><select className="input" value={pick.trip} onChange={(e) => setPick({ ...pick, trip: e.target.value })}><option value="">—</option>
        {open.map((t) => <option key={t.id} value={t.id}>V{t.number} · {t.label ?? ''} · {t.courier ?? ''} · {t.status}</option>)}</select></Field>
      <Btn kind="primary" size="xl" disabled={!pick.trip || busy} onClick={add}>Ajouter l'arrêt</Btn></div></Modal>}
  </div>;
}

function Receive() {
  const [last, setLast] = useState(null); const [w, setW] = useState('');
  const [run, busy] = useAction();
  return <Card><h2>Réception au hub</h2>
    <p className="small muted">Scan d'entrée des colis collectés chez les vendeurs, apportés par eux (dépôt) ou repris chez les clients : contrôle de l'emballage, pesée, mise à quai.</p>
    <Field label="Poids constaté (kg, facultatif)"><input className="input" inputMode="decimal" value={w} onChange={(e) => setW(e.target.value)} /></Field>
    <div style={{ marginTop: 8 }}><Scanner busy={busy} placeholder="Code du colis reçu" onCode={(code) => run(async () => {
      const weight = w ? Math.round(Number(w.replace(',', '.')) * 1000) : null;
      let r = await act('lg_receive', { p_code: code, p_weight_g: weight }, `Réception ${code}`);
      // colis apporté par le vendeur (dépôt) : il est encore « chez lui », sans voyage
      if (r.ok === false && r.error === 'not_in_transit_to_hub' && r.status === 'staged') r = await act('lg_dropoff_receive', { p_code: code, p_weight_g: weight }, `Dépôt ${code}`);
      setLast({ code, ...r }); setW(''); if (r.ok) feedback('ok'); return r;
    })} /></div>
    {last?.ok && !last.queued && <div className="flash ok" style={{ marginTop: 10 }}><span className="ico">✔</span><div>
      {last.next === 'staged' ? <><div className="zone-label">{last.zone ?? '—'}</div><div className="small">{last.code} · à poser dans la zone, prêt à livrer</div></>
        : <><b>{last.code}</b> · retour client reçu<div className="row" style={{ marginTop: 6 }}>
          <Btn size="sm" kind="todo" onClick={() => run(async () => { const x = await act('lg_return_vendor', { p_code: last.code, p_reason: 'Retour client' }, 'Retour vendeur'); setLast(null); return x; }, { ok: 'Rendu au vendeur, stock rétabli, avoir émis' })}>Rendre au vendeur</Btn></div></>}
    </div></div>}
  </Card>;
}

// Plusieurs quais (P2) : qui charge où, véhicules en attente, temps moyens
function Docks() {
  const { data: b, error, loading, reload } = useRpc('lg_dock_board', {}, { refresh: 20000 });
  const [pick, setPick] = useState(null);
  const [form, setForm] = useState(null);
  const [run, busy] = useAction();
  const me = useMe();
  if (loading && !b) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const free = b.docks.filter((k) => k.active && !k.trip);
  const assign = (trip, dock) => run(async () => { const r = await rpc('lg_dock_assign', { p_trip: trip, p_dock: dock }); setPick(null); reload(); return r; },
    { ok: 'Quai affecté' });
  const checkin = (trip) => run(async () => { const r = await rpc('lg_dock_checkin', { p_trip: trip }); reload(); return r; }, { ok: 'Arrivée enregistrée' });
  return <div className="stack">
    <div className="row between"><span className="small muted">{free.length} quai(s) libre(s) · attente moyenne avant quai (7 j) : {b.avg_wait_min != null ? `${b.avg_wait_min} min` : '—'}</span>
      {me?.roles?.some((r) => r.role === 'dock_chief') || me?.is_admin ? <Btn size="sm" onClick={() => setForm({ code: '', label: '' })}><Icon name="plus" size={16} />Quai</Btn> : null}</div>
    {!b.docks.length ? <Card><Empty icon="truck">Aucun quai déclaré. Ajoutez-en un (Q1, Q2…).</Empty></Card> :
      <div className="grid cols-3">{b.docks.map((k) => <Card key={k.id} kind={k.trip ? 'todo' : 'ok'}>
        <div className="row between"><h3 style={{ margin: 0 }}>{k.code}</h3><Badge kind={k.trip ? 'todo' : 'ok'}>{k.trip ? 'occupé' : 'libre'}</Badge></div>
        <div className="small muted">{k.label ?? ''}</div>
        {k.trip ? <div style={{ marginTop: 8 }}><b>Voyage n° {k.trip.number}</b> · {k.trip.vehicle}<div className="small muted">{k.trip.courier ?? '—'} · <StatusBadge s={k.trip.status} />{k.trip.planned_departure ? ` · départ ${hhmm(k.trip.planned_departure)}` : ''}</div>
          {k.trip.packages > 0 && <Gauge label="chargés" pct={Math.round(100 * k.trip.loaded / k.trip.packages)} detail={`${k.trip.loaded}/${k.trip.packages}`} />}
          {!k.trip.arrived && <div className="small" style={{ color: 'var(--todo)', marginTop: 6 }}>véhicule pas encore signalé au hub</div>}</div>
          : <div className="small muted" style={{ marginTop: 8 }}>{k.trips_7d} voyage(s) en 7 j</div>}
        <div className="small muted" style={{ marginTop: 6 }}>chargement moyen : {k.avg_loading_min != null ? `${k.avg_loading_min} min` : '—'}</div></Card>)}</div>}
    <div className="grid cols-2">
      <Card><h3>File d'attente ({b.queue.length})</h3>{!b.queue.length ? <Empty icon="check">Aucun véhicule en attente.</Empty> :
        <div className="list">{b.queue.map((q, i) => <div key={q.trip_id} className="line"><b>{i + 1}</b>
          <span className="grow">Voyage n° {q.number} · {q.vehicle}<div className="small muted">{q.courier ?? '—'} · attend depuis {q.waiting_min} min</div></span>
          <Btn size="sm" kind="primary" disabled={busy || !free.length} onClick={() => setPick(q)}>Affecter</Btn></div>)}</div>}</Card>
      <Card><h3>À venir ({b.upcoming.length})</h3>{!b.upcoming.length ? <Empty icon="truck">Rien d'autre aujourd'hui.</Empty> :
        <div className="list">{b.upcoming.map((u) => <div key={u.trip_id} className="line">
          <span className="grow">Voyage n° {u.number} · {u.vehicle}<div className="small muted">{u.courier ?? '—'}{u.planned_departure ? ` · départ ${hhmm(u.planned_departure)}` : ''}</div></span>
          <Btn size="sm" disabled={busy} onClick={() => checkin(u.trip_id)}>Arrivé</Btn>
          <Btn size="sm" disabled={busy || !free.length} onClick={() => setPick(u)}>Affecter</Btn></div>)}</div>}</Card>
    </div>
    {pick && <Modal title={`Quai pour le voyage n° ${pick.number}`} onClose={() => setPick(null)}><div className="stack">
      <div className="row">{free.map((k) => <Btn key={k.id} kind="primary" size="xl" disabled={busy} onClick={() => assign(pick.trip_id, k.id)}>{k.code}</Btn>)}</div>
      <p className="small muted">Le chauffeur voit le quai dans son application. Le quai se libère au départ du voyage.</p></div></Modal>}
    {form && <Modal title="Nouveau quai" onClose={() => setForm(null)}><div className="stack">
      <Field label="Code"><input className="input mono" value={form.code} placeholder="Q4" onChange={(e) => setForm({ ...form, code: e.target.value })} /></Field>
      <Field label="Libellé"><input className="input" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></Field>
      <Btn kind="primary" disabled={!form.code || busy} onClick={() => run(async () => { const r = await rpc('lg_dock_upsert', { p: form }); setForm(null); reload(); return r; }, { ok: 'Quai créé' })}>Créer</Btn>
    </div></Modal>}
  </div>;
}

// Dépôts des vendeurs (P2) : créneaux réservés du jour, ouverture de créneaux
function Dropoffs() {
  const { data, reload } = useRpc('lg_dropoffs_today', {}, { refresh: 30000 });
  const me = useMe();
  const [form, setForm] = useState(null);
  const [run, busy] = useAction();
  const day = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Africa/Dakar' });
  return <Card><div className="row between"><h3 style={{ margin: 0 }}>Dépôts des vendeurs aujourd'hui</h3>
      {(me?.is_admin || me?.roles?.some((r) => r.role === 'dock_chief')) && <Btn size="sm" onClick={() => setForm({ from: day(1), days: '5', times: '09:00-11:00, 15:00-17:00', capacity: '6' })}><Icon name="plus" size={16} />Créneaux</Btn>}</div>
    {!data?.length ? <Empty icon="store">Aucun dépôt réservé aujourd'hui.</Empty> : <div className="list" style={{ marginTop: 8 }}>{data.map((b) => <div key={b.id} className="line">
      <span className="grow"><b>{b.vendor}</b><div className="small muted">{b.start.slice(0, 5)}–{b.end.slice(0, 5)} · {b.packages} colis annoncé(s)</div></span>
      {b.status === 'arrived' ? <Badge kind="ok">arrivé · {b.received} reçu(s)</Badge> : b.late ? <Badge kind="bad">en retard</Badge> : <Badge kind="info">attendu</Badge>}
      {b.phone && <a className="btn sm" href={`tel:${b.phone}`}><Icon name="phone" size={14} /></a>}</div>)}</div>}
    <p className="small muted">Scannez les colis apportés dans « Réception au hub » : la réservation passe « arrivé ». Un vendeur qui a réservé un dépôt n'est plus proposé à la collecte.</p>
    {form && <Modal title="Ouvrir des créneaux de dépôt" onClose={() => setForm(null)}><div className="stack">
      <div className="grid cols-2"><Field label="À partir du"><input className="input" type="date" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} /></Field>
        <Field label="Nombre de jours"><input className="input" inputMode="numeric" value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value.replace(/\D/g, '') })} /></Field></div>
      <Field label="Plages (séparées par des virgules)"><input className="input mono" value={form.times} onChange={(e) => setForm({ ...form, times: e.target.value })} /></Field>
      <Field label="Vendeurs par créneau"><input className="input" inputMode="numeric" value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value.replace(/\D/g, '') })} /></Field>
      <Btn kind="primary" disabled={busy || !form.days || !form.capacity} onClick={() => run(async () => {
        const r = await rpc('lg_dropoff_slots_create', { p_from: form.from, p_days: Number(form.days), p_times: form.times.split(',').map((x) => x.trim()).filter(Boolean), p_capacity: Number(form.capacity) });
        setForm(null); reload(); return r;
      }, { ok: 'Créneaux ouverts' })}>Ouvrir</Btn></div></Modal>}
  </Card>;
}
