// Module 05 — Application chauffeur. Un écran, une action. Gros boutons, une main.
import React, { useEffect, useMemo, useState } from 'react';
import { rpc } from '../lib/backend.js';
import { act, queueUpload } from '../lib/offline.js';
import { errText } from '../lib/errors.js';
import { normalizeCode } from '../lib/algo.js';
import { MODE, backend } from '../lib/backend.js';
import { useRpc, useAction, useNav, useToast, feedback, Icon, Stat, Btn, Card, Badge, Empty, Loading, ErrorBox, PageHead, Modal, Field, Chips,
  StatusBadge, formatF, hhmm, kg } from '../components/ui.jsx';
import { Scanner, SignaturePad, PhotoInput } from '../components/field.jsx';
import { Checklist } from './Dock.jsx';

// Annexe C — mêmes codes que lg_failure_reasons
export const REASONS = [
  ['absent', 'Client absent', true], ['unreachable', 'Client injoignable', true], ['address', 'Adresse introuvable', true],
  ['refused', 'Refus du colis', false], ['no_money', 'Pas d\'argent disponible', false], ['postponed', 'Report demandé', false],
  ['damaged', 'Colis abîmé', false], ['wrong_product', 'Mauvais produit', false], ['no_access', 'Accès impossible (inondation…)', false],
  ['breakdown', 'Panne ou accident', false]];

export function getPos(timeout = 6000) {
  return new Promise((res) => {
    if (!navigator.geolocation) return res({ lat: null, lng: null });
    navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      () => res({ lat: null, lng: null }), { enableHighAccuracy: true, timeout, maximumAge: 30000 });
  });
}

export default function Driver({ stopId }) {
  const day = useRpc('lg_my_day', {}, { refresh: 30000 });
  const inProgress = day.data?.trips?.some((t) => t.status === 'in_progress');
  const toast = useToast();
  usePositionBroadcast(inProgress, () => { toast('Arrivée détectée : vous êtes sur place', 'ok'); feedback('ok'); day.reload(); });
  if (day.loading && !day.data) return <Loading />;
  if (day.error) return <><PageHead title="Ma journée" back="/" /><ErrorBox error={day.error} /></>;
  const stop = stopId && day.data.trips.flatMap((t) => t.stops.map((s) => ({ ...s, trip: t }))).find((s) => s.id === stopId);
  return <>
    {stop ? <Stop stop={stop} reload={day.reload} /> : <Day d={day.data} reload={day.reload} />}
  </>;
}

/** Position envoyée toutes les 10 s tant que l'app est visible et qu'un voyage roule (le serveur n'écrit qu'une fois par minute). */
function usePositionBroadcast(active, onArrive) {
  useEffect(() => {
    if (!active || !navigator.geolocation) return;
    let last = 0;
    const id = navigator.geolocation.watchPosition((p) => {
      if (Date.now() - last < 10000 || document.visibilityState !== 'visible') return;
      last = Date.now();
      rpc('lg_driver_ping', { p_lat: p.coords.latitude, p_lng: p.coords.longitude, p_accuracy_m: Math.round(p.coords.accuracy),
        p_speed_kmh: p.coords.speed != null ? Math.round(p.coords.speed * 3.6) : null })
        .then((r) => { if (r?.arrived_stop) onArrive?.(r); }).catch(() => {});   // arrivée détectée par le serveur (rayon auto_arrive_m)
    }, () => {}, { enableHighAccuracy: true, maximumAge: 10000 });
    return () => navigator.geolocation.clearWatch(id);
  }, [active]);
}

function Day({ d, reload }) {
  const [modal, setModal] = useState(null);
  const trips = d.trips;
  const allStops = trips.flatMap((t) => t.stops.filter((s) => s.kind === 'delivery'));
  const done = allStops.filter((s) => ['delivered', 'failed'].includes(s.status)).length;
  const toCollect = allStops.filter((s) => !['delivered', 'failed'].includes(s.status)).reduce((a, s) => a + s.cod_due_fcfa, 0);
  const limit = d.courier.cash_limit_fcfa;
  return <>
    <PageHead title={`${allStops.length} livraison${allStops.length > 1 ? 's' : ''} aujourd'hui`} back="/"><Sos /></PageHead>
    <div className="stats">
      <Stat icon="cash" c="#d97706" kind="todo" value={formatF(toCollect)} label={`À encaisser · ${done} faite(s)`} />
      <Stat icon="shield" c={d.cash_in_hand_fcfa > limit ? '#dc2626' : '#475569'} kind={d.cash_in_hand_fcfa > limit ? 'bad' : ''} value={formatF(d.cash_in_hand_fcfa)} label={`Espèces sur moi · plafond ${formatF(limit)}`} />
      <Stat icon="star" c="#059669" kind="ok" value={formatF(d.earnings_pending_fcfa)} label="Gains en attente" />
    </div>
    <Reinforcements />
    {d.week && <div className="flash info" style={{ marginTop: 10 }}><Icon name="star" /><div style={{ flex: 1 }}>
      <b>{d.week.rank === 1 ? '1er' : `${d.week.rank}e`} sur {d.week.of}</b> cette semaine · {d.week.delivered} livrée(s){d.week.on_time_pct != null ? ` · ${d.week.on_time_pct} % à l'heure` : ''}
      <div className="small">Score {d.week.score} · gains de la semaine {formatF(d.week.earnings)}</div></div></div>}
    {d.cash_in_hand_fcfa > limit && <div className="flash bad" style={{ marginTop: 10 }}>Plafond d'espèces dépassé : passez verser au caissier avant de continuer.</div>}
    {trips.length === 0 && <Card style={{ marginTop: 12 }}><Empty icon="bike">Aucun voyage prévu pour vous. Reposez-vous !</Empty></Card>}
    <div className="stack" style={{ marginTop: 12 }}>{trips.map((t) => <Trip key={t.id} t={t} reload={reload} />)}</div>
    <div className="row" style={{ marginTop: 16 }}>
      <Btn onClick={() => setModal('expense')}><Icon name="fuel" />Dépense</Btn>
      {trips[0] && <Btn onClick={() => setModal('check')}><Icon name="wrench" />Contrôle véhicule</Btn>}
    </div>
    {modal === 'expense' && <Expense tripId={trips[0]?.id} onClose={() => setModal(null)} />}
    {modal === 'check' && <Checklist trip={trips[0].id} vehicle={trips[0].vehicle} onClose={() => setModal(null)} />}
  </>;
}

function Trip({ t, reload }) {
  const { go } = useNav();
  const [run, busy] = useAction();
  const [sig, setSig] = useState(null);
  const [summary, setSummary] = useState(null);
  const active = t.stops.find((s) => ['en_route', 'arrived'].includes(s.status));
  const next = t.stops.filter((s) => s.status === 'pending');
  const finished = t.stops.filter((s) => ['delivered', 'failed'].includes(s.status));
  const allDone = t.stops.length > 0 && next.length === 0 && !active;

  if (['planned', 'loading'].includes(t.status)) return <Card kind="todo"><div className="row between"><h3 style={{ margin: 0 }}>Voyage n° {t.number}</h3><StatusBadge s={t.status} /></div>
    <p className="small">Chargement en cours au quai · départ prévu {hhmm(t.planned_departure)} · {t.stops.length} arrêt(s)</p><DockInfo trip={t.id} /></Card>;

  if (t.status === 'sealed') return <Card kind="todo"><h2>Prise en charge · voyage n° {t.number}</h2><DockInfo trip={t.id} />
    <p>{t.stops.length} arrêts · {t.stops.reduce((a, s) => a + s.packages.length, 0)} colis · à encaisser <b>{formatF(t.cod_expected_fcfa)}</b></p>
    <div className="list small">{t.stops.map((s) => <div key={s.id}>{s.seq}. {s.contact_name} — {s.packages.map((p) => p.code.slice(-6)).join(', ')}</div>)}</div>
    {!t.signed && <><p>Vérifiez le chargement puis signez : sans signature, pas de départ.</p><SignaturePad onChange={setSig} /></>}
    <Btn kind="primary" size="xl" block disabled={(!t.signed && !sig) || busy} onClick={() => run(async () => {
      const path = !t.signed ? await queueUpload(`${t.id}/signature-prise-en-charge-${Date.now()}.png`, sig) : null;
      const pos = await getPos(4000);
      const r = await act('lg_trip_start', { p_trip: t.id, p_signature_path: path, p_lat: pos.lat, p_lng: pos.lng }, 'Départ en tournée');
      reload(); return r;
    }, { ok: 'Bonne route ! Les clients sont prévenus.' })}>Démarrer la tournée</Btn></Card>;

  if (t.status === 'completed') return <Card kind="todo"><h2>Voyage n° {t.number} terminé</h2>
    <p>Passez à la caisse verser vos espèces. Les colis en échec sont à rendre au quai.</p>
    <p className="small muted">Les gains sont crédités quand le caissier a clôturé le voyage.</p></Card>;

  return <Card kind="ok"><div className="row between"><h3 style={{ margin: 0 }}>Voyage n° {t.number}</h3><span className="small muted">{finished.length} / {t.stops.length}</span></div>
    {active && <StopCard s={active} trip={t} onOpen={() => go(`/chauffeur/arret/${active.id}`)} reload={reload} />}
    {next.length > 0 && <><div className="small muted" style={{ marginTop: 10 }}>ENSUITE</div>
      <div className="list">{next.slice(0, 4).map((s) => <div key={s.id} className="line"><b>{s.seq}</b><span className="grow">{s.contact_name}
        <span className="small muted"> · {s.address}</span></span>{s.cod_due_fcfa ? <span className="small">{formatF(s.cod_due_fcfa)}</span> : <Badge kind="ok">payé</Badge>}</div>)}</div></>}
    {finished.length > 0 && <details style={{ marginTop: 8 }}><summary className="small muted">Arrêts faits ({finished.length})</summary>
      <div className="list">{finished.map((s) => <div key={s.id} className="line"><b>{s.seq}</b><span className="grow">{s.contact_name}</span><StatusBadge s={s.status} /></div>)}</div></details>}
    {allDone && <Btn kind="primary" size="xl" block disabled={busy} onClick={() => run(async () => {
      const r = await act('lg_trip_finish', { p_trip: t.id }, 'Fin de tournée'); if (r.ok && !r.queued) setSummary(r); reload(); return r;
    })}>Fin de tournée</Btn>}
    {summary && <Modal title="Récapitulatif de la tournée" onClose={() => setSummary(null)}><div className="stack">
      <div className="stats"><div className="stat ok"><b>{summary.delivered}</b><span>livrés</span></div><div className="stat bad"><b>{summary.failed}</b><span>échecs</span></div></div>
      <div className="card flat"><div className="muted small">Espèces à verser au caissier</div><div className="money">{formatF(summary.cash_to_remit_fcfa)}</div>
        <div className="small muted">Paiements mobiles : {formatF(summary.mobile_collected_fcfa)} (ne passent pas par la caisse)</div></div>
      {summary.packages_to_return.length > 0 && <div className="card todo flat"><b>Colis à rendre au quai</b><div className="mono small">{summary.packages_to_return.join(' · ')}</div></div>}
      {summary.to_hub?.length > 0 && <div className="card info flat"><b>Colis collectés à déposer au hub</b><div className="mono small">{summary.to_hub.join(' · ')}</div></div>}
      {summary.cash_dropped_fcfa > 0 && <p className="small muted">Déjà versé en cours de tournée : {formatF(summary.cash_dropped_fcfa)}</p>}
      <Btn kind="primary" onClick={() => setSummary(null)}>Compris</Btn></div></Modal>}
  </Card>;
}

function StopCard({ s, trip, onOpen, reload }) {
  const [run] = useAction();
  const dest = s.lat != null ? `${s.lat},${s.lng}` : encodeURIComponent(`${s.address ?? ''} ${s.landmark ?? ''} Sénégal`);
  const phone = (s.contact_phone ?? '').replace(/[^\d+]/g, '');
  const wa = `https://wa.me/${phone.replace('+', '')}?text=${encodeURIComponent(`Bonjour ${s.contact_name?.split(' ')[0] ?? ''}, je suis le livreur NEXUS Market. J'arrive pour votre commande ${s.order_short}${s.cod_due_fcfa ? ` (${formatF(s.cod_due_fcfa)} à préparer)` : ''}.`)}`;
  return <div className="card flat active" style={{ marginTop: 10 }}>
    <div className="row between"><div><div className="small muted">Arrêt {s.seq} · arrivée vers {hhmm(s.eta)}
      {s.kind !== 'delivery' && <Badge kind="info">{s.kind === 'pickup' ? 'collecte vendeur' : 'reprise client'}</Badge>}</div>
      <h2 style={{ margin: '2px 0' }}>{s.contact_name}</h2><div>{s.address}</div>{s.landmark && <div className="small row" style={{ gap: 4 }}><Icon name="pin" size={14} /> {s.landmark}</div>}</div>
      <div className="right"><div className="big">{s.cod_due_fcfa ? formatF(s.cod_due_fcfa) : 'Payé'}</div><div className="small muted">{s.packages.length} colis</div></div></div>
    <Btn kind="ghost" size="sm" style={{ marginTop: 6 }} onClick={() => speak(s)}><Icon name="headset" size={16} />Écouter les consignes</Btn>
    <div className="btn3" style={{ marginTop: 6 }}>
      <a className="btn" href={`https://www.google.com/maps/dir/?api=1&destination=${dest}`} target="_blank" rel="noreferrer"><Icon name="nav" />Naviguer</a>
      <a className="btn" href={`tel:${phone}`} onClick={() => rpc('lg_stop_call', { p_stop: s.id }).then(reload).catch(() => {})}><Icon name="phone" />Appeler</a>
      <a className="btn" href={wa} target="_blank" rel="noreferrer" onClick={() => rpc('lg_stop_call', { p_stop: s.id }).catch(() => {})}><Icon name="chat" />WhatsApp</a>
    </div>
    <div className="row" style={{ marginTop: 10 }}>
      {s.status === 'en_route' && <Btn size="xl" style={{ flex: 1 }} onClick={() => run(async () => {
        const pos = await getPos(3000); const r = await act('lg_stop_arrive', { p_stop: s.id, p_lat: pos.lat, p_lng: pos.lng }, 'Arrivée'); reload(); return r;
      })}>Je suis arrivé</Btn>}
      <Btn kind="primary" size="xl" style={{ flex: 1 }} onClick={onOpen}>{s.kind === 'pickup' ? 'Collecter →' : s.kind === 'return' ? 'Reprendre →' : 'Livrer / Échec →'}</Btn>
    </div></div>;
}

/* ------------------------------------------------------------ LIVRAISON */
function Stop({ stop: s, reload }) {
  const { go } = useNav();
  const toast = useToast();
  const [scanned, setScanned] = useState([]);
  const [split, setSplit] = useState({ cash: s.cod_due_fcfa, wave: 0, orange_money: 0 });
  const [refs, setRefs] = useState({ wave: '', orange_money: '' });
  const [mode, setMode] = useState('cash');
  const [otp, setOtp] = useState(['', '', '', '']);
  const [useSig, setUseSig] = useState(false);
  const [sig, setSig] = useState(null);
  const [name, setName] = useState('');
  const [photo, setPhoto] = useState(null);
  const [fail, setFail] = useState(false);
  const [run, busy] = useAction();
  const [msg, setMsg] = useState(null);
  const expected = s.packages.map((p) => p.code);
  const total = split.cash + split.wave + split.orange_money;
  const allScanned = expected.every((c) => scanned.includes(c));
  const proofOk = useSig ? sig && name.trim() : otp.join('').length === 4;
  const closed = ['delivered', 'failed'].includes(s.status);

  const scan = (code) => {
    const c = normalizeCode(code);
    if (!expected.includes(c)) { feedback('bad'); setMsg({ kind: 'bad', text: `${c} n'est pas pour cet arrêt` }); return; }
    feedback('ok'); setMsg(null); setScanned((x) => (x.includes(c) ? x : [...x, c]));
  };
  const deliver = () => run(async () => {
    const pos = await getPos(5000);
    const base = `${s.trip.id}/${s.id}`;
    const photoPath = photo ? await queueUpload(`${base}/photo-${crypto.randomUUID()}.jpg`, photo) : null;
    const sigPath = useSig && sig ? await queueUpload(`${base}/signature-${crypto.randomUUID()}.png`, sig) : null;
    const payments = ['cash', 'wave', 'orange_money'].filter((m) => split[m] > 0).map((m) => ({ method: m, amount: split[m], ref: refs[m] || null }));
    const r = await act('lg_deliver', { p_stop: s.id, p_codes: scanned, p_payments: payments, p_otp: useSig ? null : otp.join(''),
      p_recipient_name: useSig ? name : null, p_signature_path: sigPath, p_photo_path: photoPath, p_lat: pos.lat, p_lng: pos.lng,
      p_device_at: new Date().toISOString() }, `Livraison ${s.contact_name}`);
    if (r.ok === false) {
      if (r.error === 'bad_code') { setOtp(['', '', '', '']); return { ok: false, error: r.attempts_left > 0 ? `bad_code` : 'code_locked' }; }
      if (r.error === 'code_locked' || r.error === 'code_expired') setUseSig(true);
      return r;
    }
    toast(r.queued ? 'Livraison enregistrée sur le téléphone' : `Livré !${r.invoice ? ` Facture ${r.invoice} envoyée au client.` : ''}${r.far ? ' (position éloignée signalée)' : ''}`, 'ok');
    feedback('ok'); reload(); go('/chauffeur');
    return { ok: true };
  });

  if (closed) return <><PageHead title={`Arrêt ${s.seq}`} back="/chauffeur" /><Card><StatusBadge s={s.status} /> {s.contact_name}</Card></>;
  if (s.kind !== 'delivery') return <Collect s={s} reload={reload} />;
  const toTake = s.packages.filter((p) => p.to_take);
  if (toTake.length) return <TakeTransfer s={s} codes={toTake.map((p) => p.code)} reload={reload} />;
  return <>
    <PageHead title={`Arrêt ${s.seq} · ${s.contact_name}`} back="/chauffeur"><Sos /></PageHead>
    <div className="stack" style={{ maxWidth: 720 }}>
      <Card><h3>1. Colis ({scanned.length}/{expected.length})</h3>
        <div className="chips" style={{ marginBottom: 8 }}>{expected.map((c) => <span key={c} className={`badge ${scanned.includes(c) ? 'ok' : 'todo'}`}>{scanned.includes(c) ? '✔' : '○'} {c}</span>)}</div>
        {!allScanned && <Scanner onCode={scan} placeholder="Scanner le colis remis" autoFocusInput={false} />}
        {msg && <div className={`flash ${msg.kind}`}>{msg.text}</div>}</Card>

      <Card><h3>2. À encaisser</h3>
        {s.cod_due_fcfa === 0 ? <div className="flash ok">Déjà payé en ligne : rien à encaisser.</div> : <>
          <div className="money center">{formatF(s.cod_due_fcfa)}</div>
          <Chips value={mode} onChange={(m) => { setMode(m); if (m !== 'mix') setSplit({ cash: 0, wave: 0, orange_money: 0, [m]: s.cod_due_fcfa }); }}
            options={[['cash', 'Espèces'], ['wave', 'Wave'], ['orange_money', 'Orange Money'], ['mix', 'Mixte']]} />
          {mode === 'mix' ? <div className="grid cols-3" style={{ marginTop: 8 }}>{[['cash', 'Espèces'], ['wave', 'Wave'], ['orange_money', 'Orange Money']].map(([m, l]) =>
            <Field key={m} label={l}><input className="input" inputMode="numeric" value={split[m] || ''} onChange={(e) => setSplit({ ...split, [m]: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
              {m !== 'cash' && split[m] > 0 && <input className="input" style={{ marginTop: 4 }} placeholder="Référence" value={refs[m]} onChange={(e) => setRefs({ ...refs, [m]: e.target.value })} />}</Field>)}</div>
            : mode !== 'cash' && <Field label="Référence de la transaction"><input className="input" value={refs[mode]} onChange={(e) => setRefs({ ...refs, [mode]: e.target.value })} /></Field>}
          {total !== s.cod_due_fcfa && <div className="flash todo">Total saisi {formatF(total)} ≠ montant dû</div>}</>}</Card>

      <Card><h3>3. Preuve</h3>
        {!useSig ? <><p className="small muted center">Code de livraison du client (4 chiffres, reçu par WhatsApp)</p>
          <DemoOtp orderId={s.order_id} />
          <div className="otp">{otp.map((d, i) => <input key={i} id={`otp${i}`} inputMode="numeric" maxLength={1} value={d} aria-label={`Chiffre ${i + 1}`}
            onChange={(e) => { const v = e.target.value.replace(/\D/g, '').slice(-1); const n = [...otp]; n[i] = v; setOtp(n); if (v && i < 3) document.getElementById(`otp${i + 1}`)?.focus(); }} />)}</div>
          <Btn kind="ghost" block onClick={() => setUseSig(true)}>Pas de code : signature</Btn></>
          : <><Field label="Nom de la personne qui reçoit"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <SignaturePad onChange={setSig} /><Btn kind="ghost" size="sm" onClick={() => setUseSig(false)}>Revenir au code</Btn></>}
        <div style={{ marginTop: 10 }}><PhotoInput onChange={setPhoto} value={photo} /></div></Card>
    </div>
    <div className="actionbar"><div className="actionbar-inner">
      <Btn kind="bad" size="xl" onClick={() => setFail(true)}>Échec</Btn>
      <Btn kind="ok" size="xl" style={{ flex: 2 }} disabled={busy || !allScanned || !proofOk || !photo || total !== s.cod_due_fcfa} onClick={deliver}>Livré ✔</Btn>
    </div></div>
    {fail && <FailModal s={s} onClose={() => setFail(false)} onDone={() => { reload(); go('/chauffeur'); }} />}
  </>;
}

function FailModal({ s, onClose, onDone }) {
  const [reason, setReason] = useState(null);
  const [photo, setPhoto] = useState(null);
  const [note, setNote] = useState('');
  const [called, setCalled] = useState(s.called);
  const [run, busy] = useAction();
  const r = REASONS.find((x) => x[0] === reason);
  const needCall = r?.[2] && !called;
  return <Modal title="Déclarer un échec" onClose={onClose}><div className="stack">
    <Chips options={REASONS.map(([k, l]) => [k, l])} value={reason} onChange={setReason} />
    {needCall && <div className="flash todo">Appelez d'abord le client.
      <a className="btn sm" href={`tel:${s.contact_phone}`} onClick={() => rpc('lg_stop_call', { p_stop: s.id }).then(() => setCalled(true))}>📞 Appeler</a></div>}
    <PhotoInput label="Photo du lieu" onChange={setPhoto} value={photo} />
    <Field label="Précision (facultatif)"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    <Btn kind="bad" size="xl" disabled={!reason || needCall || !photo || busy} onClick={() => run(async () => {
      const pos = await getPos(4000);
      const path = await queueUpload(`${s.trip.id}/${s.id}/echec-${crypto.randomUUID()}.jpg`, photo);
      const res = await act('lg_fail', { p_stop: s.id, p_reason: reason, p_photo_path: path, p_note: note || null, p_lat: pos.lat, p_lng: pos.lng,
        p_device_at: new Date().toISOString() }, `Échec ${s.contact_name}`);
      if (res.ok) onDone();
      return res;
    }, { ok: 'Échec enregistré, client prévenu' })}>Valider l'échec</Btn></div></Modal>;
}

/* ------------------------------------------------------------ ALERTE ET DÉPENSES */
function Sos() {
  const [open, setOpen] = useState(false);
  const [run, busy] = useAction();
  const send = (kind) => run(async () => {
    const pos = await getPos(5000);
    const r = await rpc('lg_sos', { p_kind: kind, p_lat: pos.lat, p_lng: pos.lng }); setOpen(false); return r;
  }, { ok: 'Alerte envoyée au répartiteur avec votre position' });
  return <>
    <button className="sos" onClick={() => setOpen(true)} aria-label="Alerte"><Icon name="sos" size={18} />SOS</button>
    {open && <Modal title="Alerte" onClose={() => setOpen(false)}><div className="grid cols-2">
      {[['panne', 'Panne'], ['accident', 'Accident'], ['agression', 'Agression'], ['autre', 'Autre']].map(([k, l]) =>
        <Btn key={k} kind="bad" size="xl" disabled={busy} onClick={() => send(k)}>{l}</Btn>)}</div>
      <p className="small muted">Votre position est envoyée au répartiteur. En cas de danger : 17 (police), 18 (pompiers).</p></Modal>}
  </>;
}

function Expense({ tripId, onClose }) {
  const [kind, setKind] = useState('carburant'); const [amount, setAmount] = useState(''); const [photo, setPhoto] = useState(null);
  const [run, busy] = useAction();
  return <Modal title="Dépense" onClose={onClose}><div className="stack">
    <Chips options={[['carburant', 'Carburant'], ['peage', 'Péage'], ['reparation', 'Réparation'], ['stationnement', 'Stationnement'], ['amende', 'Amende'], ['autre', 'Autre']]} value={kind} onChange={setKind} />
    <Field label="Montant (F)"><input className="input big" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} /></Field>
    <PhotoInput label="Photo du reçu" onChange={setPhoto} value={photo} />
    <Btn kind="primary" size="xl" disabled={!amount || busy} onClick={() => run(async () => {
      // le chemin commence par le voyage : c'est ce que vérifie la règle de l'espace privé
      const path = photo && tripId ? await queueUpload(`${tripId}/depense-${crypto.randomUUID()}.jpg`, photo) : null;
      const r = await rpc('lg_add_expense', { p_kind: kind, p_amount_fcfa: Number(amount), p_receipt_path: path }); onClose(); return r;
    }, { ok: 'Dépense enregistrée' })}>Enregistrer</Btn></div></Modal>;
}

// Mode démo seulement : le message WhatsApp n'existe pas, on montre le code « envoyé » pour pouvoir s'entraîner.
function DemoOtp({ orderId }) {
  const [code, setCode] = useState(null);
  useEffect(() => { if (MODE === 'demo') backend().then((b) => b.peekOtp?.(orderId)).then(setCode).catch(() => {}); }, [orderId]);
  return code ? <p className="small center"><Badge kind="info">Démo · code envoyé au client : <b className="mono">{code}</b></Badge></p> : null;
}

/* ------------------------------------------------------------ COLLECTE ET REPRISE */
function Collect({ s, reload }) {
  const { go } = useNav();
  const [scanned, setScanned] = useState([]); const [photo, setPhoto] = useState(null); const [msg, setMsg] = useState(null);
  const [run, busy] = useAction();
  const expected = s.packages.map((p) => p.code);
  const isReturn = s.kind === 'return';
  const scan = (code) => {
    const c = normalizeCode(code);
    if (!expected.includes(c)) { feedback('bad'); setMsg(`${c} n'est pas attendu ici`); return; }
    feedback('ok'); setMsg(null); setScanned((x) => (x.includes(c) ? x : [...x, c]));
  };
  return <>
    <PageHead title={`${isReturn ? 'Reprise' : 'Collecte'} · ${s.contact_name}`} back="/chauffeur"><Sos /></PageHead>
    <div className="stack" style={{ maxWidth: 720 }}>
      {isReturn && <Card kind="todo"><h3>Étiquetez le colis rendu</h3><p>Écrivez ce code sur le colis (ou collez une étiquette), puis scannez-le ou tapez-le :</p>
        <div className="zone-label mono center">{expected[0]}</div></Card>}
      <Card><h3>Colis ({scanned.length}/{expected.length})</h3>
        <div className="chips" style={{ marginBottom: 8 }}>{expected.map((c) => <span key={c} className={`badge ${scanned.includes(c) ? 'ok' : 'todo'}`}>{scanned.includes(c) ? '✔' : '○'} {c}</span>)}</div>
        {scanned.length < expected.length && <Scanner onCode={scan} placeholder="Scanner le colis remis" autoFocusInput={false} />}
        {msg && <div className="flash bad">{msg}</div>}</Card>
      <Card><PhotoInput label={isReturn ? 'Photo de l\'état du produit repris' : 'Photo des colis collectés (facultatif)'} onChange={setPhoto} value={photo} /></Card>
    </div>
    <div className="actionbar"><div className="actionbar-inner">
      <Btn kind="ok" size="xl" disabled={busy || scanned.length < expected.length || (isReturn && !photo)} onClick={() => run(async () => {
        const pos = await getPos(4000);
        const path = photo ? await queueUpload(`${s.trip.id}/${s.id}/collecte-${crypto.randomUUID()}.jpg`, photo) : null;
        const r = await act('lg_collect', { p_stop: s.id, p_codes: scanned, p_photo_path: path, p_lat: pos.lat, p_lng: pos.lng }, `Collecte ${s.contact_name}`);
        if (r.ok) { reload(); go('/chauffeur'); }
        return r;
      }, { ok: 'Colis pris en charge : à remettre au hub' })}>{isReturn ? 'Repris ✔' : 'Collecté ✔'}</Btn></div></div>
  </>;
}

// Arrêt réaffecté depuis un autre voyage : le chauffeur scanne les colis en les récupérant
function TakeTransfer({ s, codes, reload }) {
  const [run, busy] = useAction();
  return <>
    <PageHead title={`Arrêt ${s.seq} · ${s.contact_name}`} back="/chauffeur" />
    <Card kind="todo"><h2>Colis à récupérer</h2>
      <p>Cet arrêt vient d'un autre voyage. Récupérez {codes.length > 1 ? 'les colis' : 'le colis'} auprès de l'autre chauffeur et scannez-{codes.length > 1 ? 'les' : 'le'} :</p>
      <div className="chips" style={{ marginBottom: 8 }}>{codes.map((c) => <span key={c} className="badge todo mono">{c}</span>)}</div>
      <Scanner busy={busy} placeholder="Scanner le colis récupéré" onCode={(code) => run(async () => {
        const r = await act('lg_take_transfer', { p_trip: s.trip.id, p_code: code }, `Reprise ${code}`); reload(); return r;
      }, { ok: 'Colis récupéré' })} /></Card>
  </>;
}

// Consignes lues à voix haute (P2) : adresse, repère, montant — pour ne pas lire en roulant
export function speak(s) {
  try {
    const parts = [`Arrêt ${s.seq}. ${s.contact_name ?? ''}.`, s.address ? `Adresse : ${s.address}.` : '', s.landmark ? `Repère : ${s.landmark}.` : '',
      s.kind === 'pickup' ? 'Collecte chez le vendeur.' : s.kind === 'return' ? 'Reprise d\'un article chez le client.' : '',
      s.cod_due_fcfa ? `Montant à encaisser : ${s.cod_due_fcfa} francs.` : s.kind === 'delivery' ? 'Déjà payé.' : '',
      `${s.packages?.length ?? 0} colis.`];
    const u = new SpeechSynthesisUtterance(parts.filter(Boolean).join(' '));
    u.lang = 'fr-FR'; u.rate = 0.95;
    const voice = speechSynthesis.getVoices().find((v) => v.lang?.startsWith('fr'));
    if (voice) u.voice = voice;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  } catch { /* synthèse vocale indisponible */ }
}

// Quai : « je suis arrivé au hub », puis le quai affecté par le chef de quai
function DockInfo({ trip }) {
  const { data: d, reload } = useRpc('lg_trip_dock', { p_trip: trip }, { refresh: 20000 });
  const [run, busy] = useAction();
  if (!d) return null;
  if (d.dock) return <div className="flash ok" style={{ margin: '8px 0' }}><Icon name="truck" /><div>Présentez-vous au <b className="big">quai {d.dock}</b></div></div>;
  if (d.queued_at) return <div className="flash todo" style={{ margin: '8px 0' }}><Icon name="clock" /><div>En attente d'un quai{d.position ? ` · ${d.position === 1 ? 'prochain' : `${d.position}e dans la file`}` : ''}</div></div>;
  return <Btn kind="primary" block disabled={busy} onClick={() => run(async () => { const r = await act('lg_dock_checkin', { p_trip: trip }, 'Arrivée au hub'); reload(); return r; },
    { ok: 'Arrivée signalée' })}><Icon name="pin" size={18} />Je suis arrivé au hub</Btn>;
}

// Appel de renfort (jours de pic) : le chauffeur répond depuis sa journée
function Reinforcements() {
  const { data, reload } = useRpc('lg_my_reinforcements', {});
  const [run, busy] = useAction();
  if (!data?.length) return null;
  return <div className="stack" style={{ marginTop: 10 }}>{data.map((c) => <Card key={c.id} kind={c.available == null ? 'todo' : ''}>
    <b>Renfort demandé le {new Date(c.day + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}</b>
    <div className="small muted">{c.zones?.length ? c.zones.join(', ') : 'toutes zones'}{c.note ? ` · ${c.note}` : ''}</div>
    <div className="row" style={{ marginTop: 8 }}>
      <Btn kind={c.available === true ? 'ok' : ''} disabled={busy} onClick={() => run(async () => { const r = await act('lg_reinforcement_answer', { p_call: c.id, p_available: true }, 'Renfort : disponible'); reload(); return r; }, { ok: 'Merci, le répartiteur est prévenu' })}>Je suis disponible</Btn>
      <Btn kind={c.available === false ? 'bad' : 'ghost'} disabled={busy} onClick={() => run(async () => { const r = await act('lg_reinforcement_answer', { p_call: c.id, p_available: false }, 'Renfort : pas disponible'); reload(); return r; }, { ok: 'Réponse enregistrée' })}>Pas disponible</Btn></div>
  </Card>)}</div>;
}
