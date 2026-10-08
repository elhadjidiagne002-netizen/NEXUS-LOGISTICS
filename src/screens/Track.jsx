// Module 06 — Page de suivi publique : lien unique, sans compte. Fonctionne pour les invités
// (49 commandes sur 53 sont passées sans compte). Le client ne doit jamais avoir à demander « où est ma commande ? ».
import React, { useEffect, useState } from 'react';
import { backend } from '../lib/backend.js';
import { errText } from '../lib/errors.js';
import { printInvoice } from '../lib/print.js';
import { Logo } from '../App.jsx';
import { Icon, Btn, Card, Badge, Loading, Modal, Field, Chips, formatF, hhmm, dmy, useToast } from '../components/ui.jsx';
import { MapView } from '../components/field.jsx';

const call = async (name, args) => (await backend()).rpc(name, args);

export default function Track({ token }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [modal, setModal] = useState(null);
  const toast = useToast();
  const [proposals, setProposals] = useState([]);
  const load = async () => {
    try { setD(await call('lg_track', { p_token: token })); setProposals(await call('lg_track_incidents', { p_token: token }).catch(() => [])); } catch (e) { setErr(e); }
  };
  useEffect(() => { load(); const i = setInterval(() => document.visibilityState === 'visible' && load(), 20000); return () => clearInterval(i); }, [token]);
  const doit = async (name, args, ok) => {
    try { const r = await call(name, { p_token: token, ...args }); if (r.ok === false) toast(errText(r.error), 'bad'); else { toast(ok, 'ok'); setModal(null); load(); } }
    catch (e) { toast(errText(e), 'bad'); }
  };
  if (err) return <div className="app" style={{ maxWidth: 640, paddingTop: 30 }}><Card><h2>Lien introuvable</h2><p className="muted">{errText(err)}</p></Card></div>;
  if (!d) return <div className="app" style={{ maxWidth: 640 }}><Loading /></div>;
  if (!d.ok) return <div className="app" style={{ maxWidth: 640, paddingTop: 30 }}><Card><h2>Lien introuvable</h2><p className="muted">Vérifiez le lien reçu par WhatsApp.</p></Card></div>;
  const o = d.order; const del = d.delivery;
  const current = [...d.steps].reverse().find((s) => s.at)?.key;
  return <div className="app" style={{ maxWidth: 640, paddingTop: 16 }}>
    <div className="row" style={{ marginBottom: 14 }}><Logo size={36} /><div><b>{d.company?.name ?? 'NEXUS Market'}</b><div className="small muted">Suivi de commande {o.number ? `n° ${o.number}` : o.short}</div></div></div>
    <div className="hero">
      <div className="small" style={{ color: '#6ee7b7', fontWeight: 600 }}>{o.first_name ? `Bonjour ${o.first_name}` : 'Votre commande'} · {o.vendor}</div>
      <h1 style={{ margin: '6px 0', fontSize: '1.9rem' }}>{o.status === 'delivered' ? 'Livrée' : o.status === 'cancelled' ? 'Commande annulée' : o.status === 'in_transit' ? 'En route'
        : d.can_confirm ? 'À confirmer' : 'En préparation'}</h1>
      {del?.eta && o.status === 'in_transit' && <div className="big" style={{ color: '#fff' }}>Arrivée vers {hhmm(del.eta)}
        <span className="small muted" style={{ fontWeight: 500 }}>{del.stops_before ? ` · ${del.stops_before} arrêt(s) avant vous` : ''}</span></div>}
      {del?.courier && o.status === 'in_transit' && <div className="small muted" style={{ marginTop: 4 }}>Votre livreur : <b style={{ color: '#fff' }}>{del.courier}</b>
        {del.courier_rating ? ` · ★ ${Number(del.courier_rating).toFixed(1)}` : ''}</div>}
      <div className="stepper">{d.steps.map((st) => <div key={st.key} className={`s ${st.at ? 'done' : ''} ${st.key === current && o.status !== 'delivered' ? 'now' : ''}`}
        style={{ color: st.at ? '#ecfdf5' : '#6b8f80' }}><i style={{ background: st.at ? '#34d399' : 'rgb(255 255 255 / 15%)' }} />{st.label}</div>)}</div>
    </div>
    <div className="stack" style={{ marginTop: 14 }}>
      {d.amount_due_fcfa > 0 && o.status !== 'cancelled' && <div className="flash todo"><Icon name="cash" /><div>Montant à préparer : <b className="big">{formatF(d.amount_due_fcfa)}</b><div className="small">Espèces, Wave ou Orange Money</div></div></div>}
      {d.delivery_code && <div className="flash ok"><Icon name="shield" /><div>Code à donner au livreur : <b className="big" style={{ letterSpacing: 4 }}>{d.delivery_code}</b>
        <div className="small">Ne le donnez qu'à la remise du colis.</div></div></div>}
      {d.failure && <div className="flash bad"><Icon name="alert" />Passage le {dmy(d.failure.at)} à {hhmm(d.failure.at)} sans pouvoir vous remettre le colis ({d.failure.reason.toLowerCase()}).</div>}
      <Card><ul className="timeline">{d.steps.map((st) => <li key={st.key}><span className={`dot ${st.at ? 'ok' : ''}`} />
        <b style={{ opacity: st.at ? 1 : .5 }}>{st.label}</b>{st.at && <div className="small muted">{dmy(st.at)} à {hhmm(st.at)}</div>}</li>)}</ul></Card>
    </div>
    {del?.position && <div style={{ marginTop: 12 }}><MapView height={300} markers={[{ kind: 'truck', lat: del.position.lat, lng: del.position.lng, icon: '🛵' },
      ...(del.dest ? [{ lat: del.dest.lat, lng: del.dest.lng, label: '🏠', color: '#0b6e4f' }] : [])]} /></div>}
    <div className="stack" style={{ marginTop: 12 }}>
      {proposals.map((p) => <Card key={p.id} kind="todo"><h3>Notre proposition</h3>
        <p style={{ margin: '0 0 6px' }}>{p.resolution}</p>{p.compensation_fcfa > 0 && <p style={{ margin: '0 0 10px' }}>Indemnité : <b className="big">{formatF(p.compensation_fcfa)}</b></p>}
        <div className="row"><Btn kind="ok" size="xl" style={{ flex: 1 }} onClick={() => doit('lg_track_incident_answer', { p_incident: p.id, p_accept: true }, 'Merci, c\'est accepté.')}>J'accepte</Btn>
          <Btn kind="bad" onClick={() => doit('lg_track_incident_answer', { p_incident: p.id, p_accept: false }, 'Noté : le service client vous recontacte.')}>Je refuse</Btn></div></Card>)}
      {d.can_confirm && <Card kind="todo"><h3>Confirmez-vous votre commande ?</h3><p className="small">{formatF(d.amount_due_fcfa)} à payer à la livraison.</p>
        <div className="row"><Btn kind="ok" size="xl" style={{ flex: 1 }} onClick={() => doit('lg_track_confirm', { p_yes: true }, 'Merci ! Commande confirmée.')}>Oui, je confirme</Btn>
          <Btn kind="bad" onClick={() => confirm('Annuler la commande ?') && doit('lg_track_confirm', { p_yes: false }, 'Commande annulée')}>Annuler</Btn></div></Card>}
      {d.can_edit_address && <Btn block onClick={() => setModal('loc')}><Icon name="pin" size={18} />{o.has_position ? 'Modifier ma position' : 'Indiquer ma position et un repère'}</Btn>}
      {d.can_rate && <Card><h3>Comment s'est passée la livraison ?</h3><Rate onRate={(r, c) => doit('lg_track_rate', { p_rating: r, p_comment: c }, 'Merci pour votre note !')} /></Card>}
      {d.invoice && <Btn block onClick={async () => { const inv = await call('lg_track_invoice', { p_token: token }); if (inv.ok) printInvoice(inv); }}><Icon name="receipt" size={18} />Ma facture {d.invoice.number}</Btn>}
      {o.status !== 'delivered' && o.status !== 'cancelled' && <Btn block onClick={() => setModal('help')}>Changer de jour · être rappelé · aide</Btn>}
    </div>
    <p className="small muted center" style={{ marginTop: 18 }}>{o.vendor && o.vendor !== d.company?.name ? `Vendu par ${o.vendor} · ` : ''}livré par {d.company?.name ?? 'NEXUS LOGISTICS'}</p>
    {modal === 'loc' && <Location onClose={() => setModal(null)} onSave={(lat, lng, landmark) => doit('lg_track_set_location', { p_lat: lat, p_lng: lng, p_landmark: landmark }, 'Position enregistrée, merci !')} />}
    {modal === 'help' && <Help onClose={() => setModal(null)} onSend={(kind, payload) => doit('lg_track_request', { p_kind: kind, p_payload: payload }, 'Demande envoyée : nous vous recontactons.')}
      onThirdParty={(name, phone) => doit('lg_track_third_party', { p_name: name, p_phone: phone }, 'C\'est noté : la personne recevra le code de livraison.')} />}
  </div>;
}

function Rate({ onRate }) {
  const [r, setR] = useState(0); const [c, setC] = useState('');
  return <div className="stack"><div className="row" style={{ fontSize: '2rem' }}>{[1, 2, 3, 4, 5].map((i) =>
    <button key={i} className="btn ghost" style={{ fontSize: '1.8rem', padding: 4 }} aria-label={`${i} étoile(s)`} onClick={() => setR(i)}>{i <= r ? '★' : '☆'}</button>)}</div>
    {r > 0 && <><input className="input" placeholder="Un mot (facultatif)" value={c} onChange={(e) => setC(e.target.value)} /><Btn kind="primary" onClick={() => onRate(r, c)}>Envoyer</Btn></>}</div>;
}

function Location({ onClose, onSave }) {
  const [pos, setPos] = useState(null); const [landmark, setLandmark] = useState(''); const [err, setErr] = useState(null);
  const locate = () => navigator.geolocation?.getCurrentPosition((p) => setPos({ lat: p.coords.latitude, lng: p.coords.longitude }),
    () => setErr('Position refusée : posez l\'épingle sur la carte.'), { enableHighAccuracy: true, timeout: 8000 });
  return <Modal title="Où vous livrer ?" onClose={onClose}><div className="stack">
    <Btn kind="primary" onClick={locate}><Icon name="pin" size={18} />Utiliser ma position actuelle</Btn>
    {err && <div className="flash todo">{err}</div>}
    <MapView height={260} markers={pos ? [{ ...pos, label: '🏠', color: '#0b6e4f' }] : []} onReady={(map) => map.on('click', (e) => setPos({ lat: e.latlng.lat, lng: e.latlng.lng }))} fitKey={pos ? 1 : 0} />
    <p className="small muted">Ou touchez la carte pour poser l'épingle.</p>
    <Field label="Repère (ex. « en face de la pharmacie »)"><input className="input" value={landmark} onChange={(e) => setLandmark(e.target.value)} /></Field>
    <Btn kind="ok" size="xl" disabled={!pos} onClick={() => onSave(pos.lat, pos.lng, landmark)}>Enregistrer</Btn></div></Modal>;
}

function Help({ onClose, onSend, onThirdParty }) {
  const [tpName, setTpName] = useState(''); const [tpPhone, setTpPhone] = useState('');
  const [kind, setKind] = useState('reschedule'); const [msg, setMsg] = useState(''); const [day, setDay] = useState('');
  return <Modal title="Que souhaitez-vous ?" onClose={onClose}><div className="stack">
    <Chips options={[['reschedule', 'Changer de jour'], ['callback', 'Être rappelé'], ['third_party', 'Faire livrer à un voisin'], ['help', 'Autre question']]} value={kind} onChange={setKind} />
    {kind === 'third_party' && <><Field label="Nom de la personne qui recevra le colis"><input className="input" value={tpName} onChange={(e) => setTpName(e.target.value)} /></Field>
      <Field label="Son téléphone (elle recevra le code de livraison)"><input className="input" inputMode="tel" value={tpPhone} onChange={(e) => setTpPhone(e.target.value)} /></Field></>}
    {kind === 'reschedule' && <Field label="Jour souhaité"><input className="input" type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field>}
    {kind !== 'third_party' && <Field label="Message"><textarea className="input" value={msg} onChange={(e) => setMsg(e.target.value)} /></Field>}
    <Btn kind="primary" size="xl" disabled={kind === 'third_party' && (!tpName.trim() || tpPhone.replace(/\D/g, '').length < 9)}
      onClick={() => kind === 'third_party' ? onThirdParty(tpName, tpPhone) : onSend(kind, { message: msg, day: day || undefined })}>Envoyer</Btn></div></Modal>;
}
