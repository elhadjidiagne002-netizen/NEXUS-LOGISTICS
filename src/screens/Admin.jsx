// Modules 10, 12, 15 — Flotte, tarifs et zones, rôles et réglages.
import React, { useState } from 'react';
import { rpc, MODE } from '../lib/backend.js';
import { useMe, ROLE_FR } from '../App.jsx';
import { errText } from '../lib/errors.js';
import { Icon, useRpc, useAction, Btn, Card, Badge, Empty, Loading, ErrorBox, PageHead, Modal, Field, Tabs, Chips, StatusBadge, formatF, dmy } from '../components/ui.jsx';

export default function Admin() {
  const me = useMe();
  const [tab, setTab] = useState(me.is_admin ? 'staff' : 'fleet');
  const tabs = me.is_admin ? [['staff', 'Rôles'], ['fleet', 'Flotte'], ['pricing', 'Tarifs et zones'], ['devices', 'Appareils'], ['config', 'Réglages'],
    ...(MODE === 'api' ? [['api', 'API boutiques'], ['whatsapp', 'WhatsApp']] : [])] : [['fleet', 'Flotte']];
  return <>
    <PageHead title="Administration" back="/" />
    <Tabs tabs={tabs} value={tab} onChange={setTab} />
    {tab === 'staff' && <Staff />}{tab === 'fleet' && <Fleet />}{tab === 'pricing' && <Pricing />}{tab === 'config' && <Config />}{tab === 'devices' && <Devices />}{tab === 'api' && <ApiKeys />}{tab === 'whatsapp' && <WhatsApp />}
  </>;
}

function Staff() {
  const { data, error, reload } = useRpc('lg_staff_list', {});
  const hubs = useMe().hubs;
  const [q, setQ] = useState(''); const [found, setFound] = useState([]); const [pick, setPick] = useState(null);
  const [run] = useAction();
  return <div className="split">
    <Card><h3>Équipe logistique</h3><ErrorBox error={error} />
      <div className="scroll-x"><table className="tbl"><thead><tr><th>Personne</th><th>Rôle</th><th>Lieu</th><th></th></tr></thead><tbody>
        {(data ?? []).map((r) => <tr key={r.user_id + r.role} style={{ opacity: r.active ? 1 : .5 }}><td>{r.name}<div className="small muted">{r.email}</div></td>
          <td>{ROLE_FR[r.role]}</td><td>{r.hub ?? 'tous'}</td><td>{r.active && <Btn size="sm" kind="ghost" onClick={() => run(async () => { await rpc('lg_revoke_role', { p_user: r.user_id, p_role: r.role }); reload(); }, { ok: 'Rôle retiré' })}>Retirer</Btn>}</td></tr>)}
      </tbody></table></div></Card>
    <Card><h3>Attribuer un rôle</h3>
      <form className="row" onSubmit={async (e) => { e.preventDefault(); setFound(await rpc('lg_find_users', { p_q: q })); }}>
        <input className="input" style={{ flex: 1 }} placeholder="Nom, e-mail ou téléphone" value={q} onChange={(e) => setQ(e.target.value)} /><Btn type="submit">Chercher</Btn></form>
      <div className="list">{found.map((u) => <div key={u.id} className="line"><span className="grow">{u.name}<div className="small muted">{u.email} · {u.role}</div></span><Btn size="sm" onClick={() => setPick({ u, role: 'picker', hub: hubs[0]?.id ?? '' })}>Choisir</Btn></div>)}</div>
      {pick && <div className="stack" style={{ marginTop: 10 }}><b>{pick.u.name}</b>
        <Chips options={Object.entries(ROLE_FR)} value={pick.role} onChange={(role) => setPick({ ...pick, role })} />
        <Field label="Lieu"><select className="input" value={pick.hub} onChange={(e) => setPick({ ...pick, hub: e.target.value })}><option value="">Tous les lieux</option>{hubs.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select></Field>
        <Btn kind="primary" onClick={() => run(async () => { const r = await rpc('lg_grant_role', { p_user: pick.u.id, p_role: pick.role, p_hub: pick.hub || null }); setPick(null); reload(); return r; }, { ok: 'Rôle attribué' })}>Attribuer</Btn>
        <p className="small muted">Un même compte peut cumuler deux rôles. Les chauffeurs sont les livreurs déjà inscrits (table couriers).</p></div>}</Card>
    {MODE === 'api' && <Invite />}
  </div>;
}

// Version complète : inviter une personne par un lien (à envoyer par WhatsApp), valable 7 jours, à usage unique
const INVITE_KINDS = [['staff', 'Équipe'], ['courier', 'Chauffeur-livreur'], ['vendor', 'Vendeur'], ['admin', 'Administrateur']];
function Invite() {
  const me = useMe();
  const [f, setF] = useState({ role: 'staff', staff: ['picker'], name: '', phone: '' });
  const [link, setLink] = useState(null);
  const [run, busy] = useAction();
  const toggle = (r) => setF({ ...f, staff: f.staff.includes(r) ? f.staff.filter((x) => x !== r) : [...f.staff, r] });
  const msg = link && `Bonjour${f.name ? ` ${f.name}` : ''}, ${me.company?.name ?? 'notre entreprise'} vous invite sur NEXUS Logistics : ${link}`;
  const wa = link && `https://wa.me/${f.phone.replace(/\D/g, '').replace(/^(7\d{8})$/, '221$1')}?text=${encodeURIComponent(msg)}`;
  return <Card><h3>Inviter par lien</h3>
    <div className="stack">
      <Chips options={INVITE_KINDS.filter(([k]) => k !== 'admin' || me.is_owner)} value={f.role} onChange={(role) => { setF({ ...f, role }); setLink(null); }} />
      {f.role === 'staff' && <div className="chips">{Object.entries(ROLE_FR).map(([k, l]) =>
        <label key={k} className="check"><input type="checkbox" checked={f.staff.includes(k)} onChange={() => toggle(k)} /> {l}</label>)}</div>}
      <div className="grid cols-2" style={{ gap: 10 }}>
        <Field label="Nom (facultatif)"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="WhatsApp (facultatif)"><input className="input" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="77 000 00 00" /></Field></div>
      <Btn kind="primary" disabled={busy} onClick={() => run(async () => {
        const r = await rpc('lg_invite_create', { p_role: f.role, p_staff_roles: f.role === 'staff' ? f.staff : [], p_name: f.name || null });
        setLink(location.origin + r.path); return r;
      }, { ok: 'Lien créé' })}>Créer le lien d'invitation</Btn>
      {link && <div className="card flat ok"><div className="mono small" style={{ wordBreak: 'break-all' }}>{link}</div>
        <div className="row" style={{ marginTop: 8 }}>
          <Btn size="sm" onClick={() => navigator.clipboard?.writeText(link)}>Copier</Btn>
          <a className="btn sm primary" href={wa} target="_blank" rel="noopener">Envoyer par WhatsApp</a></div>
        <p className="small muted" style={{ margin: '6px 0 0' }}>Valable 7 jours, une seule fois. La personne choisit son mot de passe.</p></div>}
    </div></Card>;
}

const KINDS = ['vélo', 'moto', 'tricycle', 'voiture', 'fourgonnette', 'camion'];
function Fleet() {
  const { data, error, loading, reload } = useRpc('lg_fleet', {});
  const [edit, setEdit] = useState(null); const [doc, setDoc] = useState(null); const [maint, setMaint] = useState(null);
  const [run] = useAction();
  if (loading && !data) return <Loading />;
  return <div className="stack"><ErrorBox error={error} />
    <div className="row"><Btn kind="primary" onClick={() => setEdit({ kind: 'moto', capacity_kg: 40, equipment: [], ownership: 'interne' })}>＋ Véhicule</Btn></div>
    <div className="grid cols-2">{(data ?? []).map((v) => {
      const expired = v.documents.some((d) => d.expired); const soon = v.documents.some((d) => d.soon);
      const m = v.maintenance;
      return <Card key={v.id} kind={expired || v.status === 'maintenance' || m?.state === 'overdue' ? 'bad' : soon || m?.state === 'soon' ? 'todo' : 'ok'}>
        <div className="row between"><h3 style={{ margin: 0 }}>{v.kind} · <span className="mono">{v.plate}</span></h3><StatusBadge s={v.on_trip ? 'on_trip' : v.status} /></div>
        <div className="small">{v.label} · {v.capacity_kg} kg{v.capacity_l ? ` · ${v.capacity_l} L` : ''}{v.max_packages ? ` · ${v.max_packages} colis` : ''} · {v.ownership}
          {v.equipment.length ? ` · ${v.equipment.join(', ')}` : ''}</div>
        <div className="small muted">Chauffeur habituel : {v.default_courier?.name ?? '—'} · {v.odometer_km ? `${v.odometer_km.toLocaleString('fr-FR')} km` : ''}
          · coûts 30 j {formatF(v.costs_30d_fcfa)}{v.km_30d ? ` · ${v.km_30d} km` : ''}{v.costs_30d_fcfa && v.km_30d ? ` · ${formatF(v.costs_30d_fcfa / v.km_30d)}/km` : ''}</div>
        <div className="chips" style={{ margin: '6px 0' }}>{v.documents.map((d) => <Badge key={d.id} kind={d.expired ? 'bad' : d.soon ? 'todo' : 'ok'}>{d.kind.replace('_', ' ')} · {dmy(d.expires_at)}</Badge>)}
          {v.documents.length === 0 && <Badge kind="todo">aucun document</Badge>}</div>
        {m && <div style={{ margin: '4px 0' }}><Badge kind={m.state === 'overdue' ? 'bad' : m.state === 'soon' ? 'todo' : 'ok'}>
          <Icon name="wrench" size={12} /> {m.kind} {m.state === 'overdue' ? `dépassé de ${(-m.remaining_km).toLocaleString('fr-FR')} km`
            : m.state === 'unknown' ? `à ${m.due_km.toLocaleString('fr-FR')} km (compteur inconnu)` : `dans ${m.remaining_km.toLocaleString('fr-FR')} km`}</Badge>
          {m.km != null && <span className="small muted"> · ≈ {m.km.toLocaleString('fr-FR')} km estimés</span>}</div>}
        {v.last_check && <div className="small muted">Dernier contrôle : {dmy(v.last_check.at)} {v.last_check.ok ? '✔' : '✖ non conforme'}</div>}
        <div className="row"><Btn size="sm" onClick={() => setEdit(v)}>Modifier</Btn><Btn size="sm" onClick={() => setDoc(v)}>＋ Document</Btn><Btn size="sm" onClick={() => setMaint(v)}>Entretien</Btn>
          {!v.on_trip && <Btn size="sm" kind="ghost" onClick={() => run(async () => { await rpc('lg_set_vehicle_status', { p_vehicle: v.id, p_status: v.status === 'maintenance' ? 'available' : 'maintenance' }); reload(); })}>
            {v.status === 'maintenance' ? 'Remettre en service' : 'Mettre à l\'atelier'}</Btn>}</div>
      </Card>;
    })}</div>
    {edit && <VehicleForm v={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(); }} />}
    {doc && <Modal title={`Document · ${doc.plate}`} onClose={() => setDoc(null)}><DocForm v={doc} onDone={() => { setDoc(null); reload(); }} /></Modal>}
    {maint && <Modal title={`Entretien · ${maint.plate}`} onClose={() => setMaint(null)}><MaintForm v={maint} onDone={() => { setMaint(null); reload(); }} /></Modal>}
  </div>;
}

function VehicleForm({ v, onClose, onDone }) {
  const [f, setF] = useState({ ...v, default_courier_id: v.default_courier?.id ?? '' });
  const couriers = useRpc('lg_couriers_list', {});
  const [run, busy] = useAction();
  const s = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return <Modal title={v.id ? `Véhicule ${v.plate}` : 'Nouveau véhicule'} onClose={onClose}><div className="stack">
    <div className="grid cols-2">
      <Field label="Immatriculation"><input className="input mono" value={f.plate ?? ''} onChange={s('plate')} /></Field>
      <Field label="Type"><select className="input" value={f.kind} onChange={s('kind')}>{KINDS.map((k) => <option key={k}>{k}</option>)}</select></Field>
      <Field label="Libellé"><input className="input" value={f.label ?? ''} onChange={s('label')} /></Field>
      <Field label="Propriété"><select className="input" value={f.ownership} onChange={s('ownership')}><option value="interne">interne</option><option value="partenaire">partenaire</option><option value="independant">indépendant</option></select></Field>
      <Field label="Capacité (kg)"><input className="input" inputMode="numeric" value={f.capacity_kg ?? ''} onChange={s('capacity_kg')} /></Field>
      <Field label="Capacité (litres)"><input className="input" inputMode="numeric" value={f.capacity_l ?? ''} onChange={s('capacity_l')} /></Field>
      <Field label="Colis maximum"><input className="input" inputMode="numeric" value={f.max_packages ?? ''} onChange={s('max_packages')} /></Field>
      <Field label="Chauffeur habituel"><select className="input" value={f.default_courier_id} onChange={s('default_courier_id')}><option value="">—</option>{(couriers.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
    </div>
    <Field label="Équipements"><Chips multi options={[['caisson', 'Caisson'], ['bâche', 'Bâche'], ['glacière', 'Glacière'], ['sangles', 'Sangles']]} value={f.equipment ?? []} onChange={(equipment) => setF({ ...f, equipment })} /></Field>
    <Btn kind="primary" size="xl" disabled={!f.plate || !f.capacity_kg || busy} onClick={() => run(async () => {
      const r = await rpc('lg_upsert_vehicle', { p: { id: v.id, plate: f.plate, kind: f.kind, label: f.label, capacity_kg: Number(f.capacity_kg), capacity_l: f.capacity_l ? Number(f.capacity_l) : null,
        max_packages: f.max_packages ? Number(f.max_packages) : null, equipment: f.equipment ?? [], ownership: f.ownership, hub_id: v.hub_id ?? null,
        default_courier_id: f.default_courier_id || null, status: v.status ?? 'available' } });
      onDone(); return r;
    }, { ok: 'Véhicule enregistré' })}>Enregistrer</Btn></div></Modal>;
}

function DocForm({ v, onDone }) {
  const [f, setF] = useState({ kind: 'assurance', number: '', expires: '' });
  const [run, busy] = useAction();
  return <div className="stack">
    <Chips options={[['assurance', 'Assurance'], ['visite_technique', 'Visite technique'], ['carte_grise', 'Carte grise'], ['autre', 'Autre']]} value={f.kind} onChange={(kind) => setF({ ...f, kind })} />
    <Field label="Numéro"><input className="input" value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} /></Field>
    <Field label="Échéance"><input className="input" type="date" value={f.expires} onChange={(e) => setF({ ...f, expires: e.target.value })} /></Field>
    <p className="small muted">Alerte 15 jours avant ; véhicule bloqué au départ une fois expiré.</p>
    <Btn kind="primary" disabled={!f.expires || busy} onClick={() => run(async () => { const r = await rpc('lg_add_document', { p_vehicle: v.id, p_courier: null, p_kind: f.kind, p_number: f.number, p_expires_at: f.expires }); onDone(); return r; }, { ok: 'Document ajouté' })}>Ajouter</Btn></div>;
}

function MaintForm({ v, onDone }) {
  const [f, setF] = useState({ kind: 'entretien', km: v.odometer_km ?? '', cost: '', note: '', next: '' });
  const [run, busy] = useAction();
  return <div className="stack">
    <Chips options={[['entretien', 'Entretien'], ['vidange', 'Vidange'], ['pneus', 'Pneus'], ['panne', 'Panne']]} value={f.kind} onChange={(kind) => setF({ ...f, kind })} />
    <div className="grid cols-3"><Field label="Kilométrage"><input className="input" inputMode="numeric" value={f.km} onChange={(e) => setF({ ...f, km: e.target.value })} /></Field>
      <Field label="Coût (F)"><input className="input" inputMode="numeric" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} /></Field>
      <Field label="Prochain à (km)"><input className="input" inputMode="numeric" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} /></Field></div>
    <Field label="Note"><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
    <Btn kind="primary" disabled={busy} onClick={() => run(async () => { const r = await rpc('lg_log_maintenance', { p_vehicle: v.id, p_kind: f.kind, p_odometer_km: f.km ? Number(f.km) : null, p_cost_fcfa: f.cost ? Number(f.cost) : null, p_note: f.note, p_next_due_km: f.next ? Number(f.next) : null }); onDone(); return r; }, { ok: 'Enregistré' })}>Enregistrer</Btn></div>;
}

function Pricing() {
  const { data, error, loading, reload } = useRpc('lg_pricing', {});
  const [run] = useAction();
  const [rc, setRc] = useState({ zone: '', vehicle_kind: '', max_weight_g: 20, price_fcfa: '', per_km_fcfa: '', lead_hours: 24, service: 'standard' });
  const [quote, setQuote] = useState({ zone: '', kg: 3, sub: 20000 }); const [qr, setQr] = useState(null);
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const qZone = quote.zone || data.zones[0]?.name || '';
  return <div className="stack"><ErrorBox error={error} />
    {MODE === 'api' && <NewZone empty={!data.zones.length} reload={reload} />}
    <div className="split">
      <Card><h3>Grille de prix</h3><div className="scroll-x"><table className="tbl"><thead><tr><th>Service</th><th>Zone</th><th>Véhicule</th><th className="num">Jusqu'à</th><th className="num">Prix</th><th className="num">Délai</th><th></th></tr></thead>
        <tbody>{data.rate_cards.map((r) => <tr key={r.id}><td>{r.service}</td><td>{r.zone ?? 'toutes'}</td><td>{r.vehicle_kind ?? 'tous'}</td><td className="num">{r.max_weight_g / 1000} kg</td>
          <td className="num">{formatF(r.price_fcfa)}{r.per_km_fcfa ? ` + ${formatF(r.per_km_fcfa)}/km` : ''}</td><td className="num">{r.lead_hours} h</td>
          <td><Btn size="sm" kind="ghost" onClick={() => run(async () => { await rpc('lg_upsert_rate_card', { p: { id: r.id, active: false } }); reload(); })}>✕</Btn></td></tr>)}</tbody></table></div>
        <div className="grid cols-3" style={{ marginTop: 10 }}>
          <select className="input" value={rc.service} onChange={(e) => setRc({ ...rc, service: e.target.value })}><option>standard</option><option>express</option><option>programme</option></select>
          <select className="input" value={rc.zone} onChange={(e) => setRc({ ...rc, zone: e.target.value })}><option value="">toutes zones</option>{data.zones.map((z) => <option key={z.name}>{z.name}</option>)}</select>
          <select className="input" value={rc.vehicle_kind} onChange={(e) => setRc({ ...rc, vehicle_kind: e.target.value })}><option value="">tous véhicules</option>{KINDS.map((k) => <option key={k}>{k}</option>)}</select>
          <input className="input" inputMode="numeric" placeholder="jusqu'à (kg)" value={rc.max_weight_g} onChange={(e) => setRc({ ...rc, max_weight_g: e.target.value })} />
          <input className="input" inputMode="numeric" placeholder="prix (F)" value={rc.price_fcfa} onChange={(e) => setRc({ ...rc, price_fcfa: e.target.value })} />
          <input className="input" inputMode="numeric" placeholder="délai (h)" value={rc.lead_hours} onChange={(e) => setRc({ ...rc, lead_hours: e.target.value })} />
          {MODE === 'api' && <input className="input" inputMode="numeric" placeholder="+ prix au km (F, facultatif)" value={rc.per_km_fcfa} onChange={(e) => setRc({ ...rc, per_km_fcfa: e.target.value.replace(/\D/g, '') })} />}</div>
        <Btn kind="primary" style={{ marginTop: 8 }} disabled={!rc.price_fcfa} onClick={() => run(async () => {
          await rpc('lg_upsert_rate_card', { p: { ...rc, max_weight_g: Number(rc.max_weight_g) * 1000, price_fcfa: Number(rc.price_fcfa), lead_hours: Number(rc.lead_hours), per_km_fcfa: Number(rc.per_km_fcfa) || 0 } }); reload();
        }, { ok: 'Tarif ajouté' })}>Ajouter le tarif</Btn></Card>
      <Card><h3>Simulateur (prix au panier)</h3><div className="grid cols-3">
        <select className="input" value={qZone} onChange={(e) => setQuote({ ...quote, zone: e.target.value })}>{data.zones.map((z) => <option key={z.name}>{z.name}</option>)}</select>
        <input className="input" inputMode="decimal" value={quote.kg} onChange={(e) => setQuote({ ...quote, kg: e.target.value })} aria-label="Poids kg" />
        <input className="input" inputMode="numeric" value={quote.sub} onChange={(e) => setQuote({ ...quote, sub: e.target.value })} aria-label="Montant panier" /></div>
        <Btn style={{ marginTop: 8 }} onClick={async () => setQr(await rpc('lg_quote', { p_zone: qZone, p_weight_g: Math.round(Number(quote.kg) * 1000), p_subtotal_fcfa: Number(quote.sub) }))}>Calculer</Btn>
        {qr && (qr.ok ? <div className="flash ok" style={{ marginTop: 8 }}><div><b className="big">{formatF(qr.price_fcfa)}</b>{qr.distance_km != null ? ` · ${qr.distance_km} km` : ''} {qr.free && '(offerte)'} · {qr.vehicle_kind}{qr.surcharges?.length ? ` · dont ${qr.surcharges.map((s) => `${s.label.toLowerCase()} ${formatF(s.amount_fcfa)}`).join(', ')}` : ''}<div className="small">promis le {dmy(qr.promised_at)}</div></div></div>
          : <div className="flash bad" style={{ marginTop: 8 }}>{errText(qr.error)}</div>)}
        <p className="small muted">Fonction publique <span className="mono">lg_quote</span> : le site peut l'appeler au panier, avant paiement.</p></Card>
    </div>
    <Surcharges zones={data.zones} />
    <Card><h3>Zones ({data.zones.length})</h3><div className="scroll-x"><table className="tbl"><thead><tr><th>Zone</th><th>Ville</th><th>Desservie</th><th>Heure limite</th><th>Offerte dès</th><th></th></tr></thead>
      <tbody>{data.zones.map((z) => <ZoneRow key={z.name} z={z} reload={reload} />)}</tbody></table></div></Card>
  </div>;
}

// Suppléments (nuit, forte pluie…) : désactivés par défaut ; la pluie se déclare depuis la tour de contrôle
function Surcharges({ zones }) {
  const { data, reload } = useRpc('lg_surcharges_list', {});
  const [f, setF] = useState(null);
  const [run, busy] = useAction();
  return <Card><h3>Suppléments</h3><div className="list">{(data ?? []).map((s) => <div key={s.code} className="line">
    <span className="grow">{s.label} <Badge kind={s.in_force ? 'ok' : ''}>{s.in_force ? 'actif' : 'inactif'}</Badge>
      <div className="small muted">{formatF(s.amount_fcfa)}{s.start_time ? ` · de ${s.start_time.slice(0, 5)} à ${s.end_time?.slice(0, 5)}` : ''}
        {s.services?.length ? ` · ${s.services.join(', ')}` : ' · tous services'}{s.zones?.length ? ` · ${s.zones.join(', ')}` : ' · toutes zones'}
        {s.until ? ` · jusqu'à ${dmy(s.until)} ${new Date(s.until).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Dakar' })}` : ''}</div></span>
    <Btn size="sm" onClick={() => setF({ ...s, start_time: s.start_time?.slice(0, 5) ?? '', end_time: s.end_time?.slice(0, 5) ?? '', zones: s.zones ?? [], services: s.services ?? [] })}>Modifier</Btn></div>)}</div>
    <p className="small muted">Ajoutés au devis au panier (<span className="mono">lg_quote</span>), jamais sur une livraison offerte.</p>
    {f && <Modal title={f.label} onClose={() => setF(null)}><div className="stack">
      <Field label="Montant (F CFA)"><input className="input" inputMode="numeric" value={f.amount_fcfa} onChange={(e) => setF({ ...f, amount_fcfa: e.target.value.replace(/\D/g, '') })} /></Field>
      <div className="grid cols-2"><Field label="De (heure)"><input className="input" type="time" value={f.start_time} onChange={(e) => setF({ ...f, start_time: e.target.value })} /></Field>
        <Field label="À (heure)"><input className="input" type="time" value={f.end_time} onChange={(e) => setF({ ...f, end_time: e.target.value })} /></Field></div>
      <Field label="Services (aucun = tous)"><Chips multi options={[['standard', 'Standard'], ['express', 'Express'], ['programme', 'Programmé']]} value={f.services} onChange={(services) => setF({ ...f, services })} /></Field>
      <Field label="Zones (aucune = toutes)"><select className="input" multiple size={5} value={f.zones} onChange={(e) => setF({ ...f, zones: [...e.target.selectedOptions].map((o) => o.value) })}>
        {zones.map((z) => <option key={z.name}>{z.name}</option>)}</select></Field>
      <Field label="État"><Chips options={[['on', 'Actif'], ['off', 'Inactif']]} value={f.active ? 'on' : 'off'} onChange={(v) => setF({ ...f, active: v === 'on' })} /></Field>
      <Btn kind="primary" disabled={busy} onClick={() => run(async () => {
        const r = await rpc('lg_surcharge_save', { p: { code: f.code, label: f.label, amount_fcfa: Number(f.amount_fcfa) || 0, active: f.active,
          start_time: f.start_time || null, end_time: f.end_time || null, services: f.services.length ? f.services : null, zones: f.zones.length ? f.zones : null } });
        setF(null); reload(); return r;
      }, { ok: 'Supplément enregistré' })}>Enregistrer</Btn></div></Modal>}
  </Card>;
}

function ZoneRow({ z, reload }) {
  const [f, setF] = useState(z); const [dirty, setDirty] = useState(false); const [run] = useAction();
  const s = (k, v) => { setF({ ...f, [k]: v }); setDirty(true); };
  return <tr><td>{z.name}</td><td>{z.city}</td><td><input type="checkbox" checked={f.served} onChange={(e) => s('served', e.target.checked)} /></td>
    <td><input className="input" style={{ minHeight: 36, width: 110 }} type="time" value={String(f.cutoff_time).slice(0, 5)} onChange={(e) => s('cutoff_time', e.target.value)} /></td>
    <td><input className="input" style={{ minHeight: 36, width: 110 }} inputMode="numeric" value={f.free_above_fcfa ?? ''} onChange={(e) => s('free_above_fcfa', e.target.value)} /></td>
    <td>{dirty && <Btn size="sm" kind="primary" onClick={() => run(async () => { await rpc('lg_set_zone', { p_zone: z.name, p: { served: f.served, cutoff_time: f.cutoff_time, free_above_fcfa: f.free_above_fcfa ? Number(f.free_above_fcfa) : null, delivery_days: f.delivery_days } }); setDirty(false); reload(); }, { ok: 'Zone mise à jour' })}>OK</Btn>}
      {MODE === 'api' && !dirty && <Btn size="sm" kind="ghost" title="Supprimer la zone" onClick={() => { if (confirm(`Supprimer la zone ${z.name} ?`)) run(async () => { const r = await rpc('lg_zone_delete', { p_zone: z.name }); reload(); return r; }, { ok: 'Zone supprimée' }); }}>✕</Btn>}</td></tr>;
}

const CFG = [['max_attempts', 'Présentations avant retour vendeur'], ['proof_radius_m', 'Rayon de validation (m)'], ['cash_limit_fcfa', 'Plafond d\'espèces par chauffeur (F)'],
  ['pick_lock_minutes', 'Libération d\'une préparation inactive (min)'], ['tva_rate', 'Taux de TVA (%)'], ['heavy_kg', 'Seuil « lourd » (kg)'],
  ['otp_attempts', 'Essais du code client'], ['staged_max_hours', 'Alerte colis à quai (h)'], ['stop_max_minutes', 'Alerte arrêt long (min)'],
  ['pay_per_package', 'Prime par colis livré (F)'], ['bonus_zero_failure', 'Bonus zéro échec (F)'], ['manager_phone', 'WhatsApp du gérant (rapport du soir)'], ['manager_email', 'E-mail du gérant (secours du rapport du soir)'], ['maintenance_alert_km', 'Alerte entretien (km avant l\'échéance)'], ['auto_arrive_m', 'Arrivée détectée à moins de (m, 0 = désactivée)'],
  ['bonus_on_time', 'Prime par livraison à l\'heure (F)'], ['double_check_fcfa', 'Double contrôle au-delà de (F)'],
  ['tracking_base_url', 'Adresse de la page de suivi'], ['expiry_alert_days', 'Alerte péremption (jours avant la date)'],
  ['insurance_rate_pct', 'Assurance : prime (% de la valeur déclarée)'], ['insurance_min_fcfa', 'Assurance : prime minimale (F)'],
  ['insurance_max_value_fcfa', 'Assurance : valeur maximale assurable (F)'], ['uninsured_cap_fcfa', 'Plafond d\'indemnisation sans assurance (F)'],
  ['pay_fixed_trip', 'Fixe par voyage pour le chauffeur (F)'], ['commission_pct', 'Commission sur les produits des vendeurs (%)'],
  ['company_ninea', 'NINEA (factures)'], ['company_rc', 'Registre du commerce (factures)'], ['company_address', 'Adresse (factures)']];
function Config() {
  const { data } = useRpc('lg_pricing', {});
  const [f, setF] = useState(null);
  const [run, busy] = useAction();
  const cur = f ?? data?.config ?? {};
  return <Card><div className="grid cols-2">{CFG.map(([k, l]) => <Field key={k} label={l}><input className="input" value={cur[k] ?? ''} placeholder="valeur par défaut"
    onChange={(e) => setF({ ...cur, [k]: e.target.value })} /></Field>)}
    {MODE === 'api' ? <Field label="Émetteur de la facture client"><select className="input" value={cur.invoice_issuer ?? 'company'} onChange={(e) => setF({ ...cur, invoice_issuer: e.target.value })}>
      <option value="company">L'entreprise, en son nom</option><option value="vendor">Le vendeur (facture émise pour son compte)</option></select></Field>
    : <Field label="Émetteur de la facture client"><select className="input" value={cur.invoice_issuer ?? 'vendor_via_nexus'} onChange={(e) => setF({ ...cur, invoice_issuer: e.target.value })}>
      <option value="vendor_via_nexus">Le vendeur, par l'intermédiaire de NEXUS</option><option value="nexus">NEXUS Market en son nom</option></select></Field>}
    <label className="check"><input type="checkbox" checked={cur.require_photo !== false && cur.require_photo !== 'false'} onChange={(e) => setF({ ...cur, require_photo: e.target.checked })} /> Photo obligatoire à la livraison et à l'échec</label>
    {MODE === 'api' && <label className="check"><input type="checkbox" checked={cur.prep_at_vendor === true || cur.prep_at_vendor === 'true'} onChange={(e) => setF({ ...cur, prep_at_vendor: e.target.checked })} /> Les commandes d'un vendeur se préparent chez lui (sinon au dépôt)</label>}</div>
    <PeakDays value={Array.isArray(cur.peak_days) ? cur.peak_days : []} onChange={(peak_days) => setF({ ...cur, peak_days })} />
    <Btn kind="primary" size="xl" style={{ marginTop: 12 }} disabled={!f || busy} onClick={() => run(async () => {
      const clean = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v]));
      const r = await rpc('lg_set_config', { p: clean }); setF(null); return r;
    }, { ok: 'Réglages enregistrés' })}>Enregistrer</Btn>
    <p className="small muted">Rangés dans app_config (clé nexus_logistics_cfg), sans toucher au code. Chaque modification est journalisée.</p></Card>;
}

// Jours de pic (Tabaski, Korité, Magal, Gamou, Louma, soldes) : multiplient la prévision
function PeakDays({ value, onChange }) {
  const [d, setD] = useState(''); const [label, setLabel] = useState(''); const [factor, setFactor] = useState('2');
  return <div className="card flat" style={{ marginTop: 14 }}><b>Jours de pic</b>
    <p className="small muted" style={{ marginTop: 4 }}>Utilisés par la prévision de volume et l'alerte de sous-capacité.</p>
    <div className="chips" style={{ marginBottom: 8 }}>{value.map((p, i) => <span key={i} className="badge todo">{p.label} · {dmy(p.date)} · ×{p.factor}
      <button className="icon-btn" style={{ width: 22, height: 22 }} aria-label="Retirer" onClick={() => onChange(value.filter((_, j) => j !== i))}><Icon name="x" size={12} /></button></span>)}</div>
    <div className="row"><input className="input" style={{ width: 170 }} type="date" value={d} onChange={(e) => setD(e.target.value)} />
      <input className="input" style={{ width: 160 }} placeholder="Tabaski" value={label} onChange={(e) => setLabel(e.target.value)} />
      <input className="input" style={{ width: 90 }} inputMode="decimal" value={factor} onChange={(e) => setFactor(e.target.value)} aria-label="Coefficient" />
      <Btn disabled={!d || !label} onClick={() => { onChange([...value, { date: d, label, factor: Number(factor.replace(',', '.')) || 1 }]); setD(''); setLabel(''); }}><Icon name="plus" size={16} />Ajouter</Btn></div>
  </div>;
}

// Appareils (P2) : téléphones utilisés par l'équipe ; déconnexion à distance, blocage d'un appareil perdu
function Devices() {
  const { data, error, loading, reload } = useRpc('lg_devices_list', {});
  const [q, setQ] = useState('');
  const [run, busy] = useAction();
  if (loading && !data) return <Loading />;
  const rows = (data ?? []).filter((d) => !q || `${d.user} ${d.label ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  const act2 = (fn, args, ok) => run(async () => { const r = await rpc(fn, args); reload(); return r; }, { ok });
  return <div className="stack"><ErrorBox error={error} />
    <div className="row between"><input className="input" style={{ maxWidth: 320 }} placeholder="Personne ou appareil…" value={q} onChange={(e) => setQ(e.target.value)} />
      <span className="small muted">{(data ?? []).filter((d) => d.blocked).length} bloqué(s) · {(data ?? []).length} appareil(s)</span></div>
    <Card>{!rows.length ? <Empty icon="phone">Aucun appareil. Ils apparaissent à la première ouverture de l'app.</Empty> :
      <div className="scroll-x"><table className="tbl"><thead><tr><th>Personne</th><th>Appareil</th><th>Vu</th><th>État</th><th></th></tr></thead>
        <tbody>{rows.map((d) => <tr key={d.id}><td><b>{d.user}</b></td>
          <td>{d.label ?? '—'}{d.this_device && <Badge kind="info">celui-ci</Badge>}<div className="small muted" title={d.user_agent ?? ''}>depuis le {dmy(d.first_seen_at)}</div></td>
          <td className="small">{dmy(d.last_seen_at)} {new Date(d.last_seen_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Dakar' })}</td>
          <td>{d.blocked ? <Badge kind="bad">bloqué</Badge> : d.active_session ? <Badge kind="ok">connecté</Badge> : <Badge>déconnecté</Badge>}</td>
          <td><div className="row" style={{ justifyContent: 'flex-end' }}>
            {!d.blocked && d.active_session && <Btn size="sm" disabled={busy} onClick={() => act2('lg_device_revoke', { p_id: d.id }, 'Session coupée : reconnexion obligatoire')}>Déconnecter</Btn>}
            {d.blocked ? <Btn size="sm" disabled={busy} onClick={() => act2('lg_device_block', { p_id: d.id, p_blocked: false }, 'Appareil débloqué')}>Débloquer</Btn>
              : !d.this_device && <Btn size="sm" kind="bad" disabled={busy} onClick={() => confirm(`Bloquer « ${d.label ?? 'cet appareil'} » de ${d.user} ? Plus rien ne passera depuis ce téléphone.`)
                && act2('lg_device_block', { p_id: d.id, p_blocked: true }, 'Appareil bloqué')}>Bloquer</Btn>}</div></td></tr>)}</tbody></table></div>}</Card>
    <p className="small muted">Téléphone perdu ou volé : <b>Bloquer</b> — plus aucune action n'est acceptée depuis lui, même connecté. <b>Déconnecter</b> coupe la session en cours ; la personne se reconnecte avec son mot de passe.</p>
  </div>;
}

// Version complète : chaque entreprise a ses propres zones (quartiers). Démarrage rapide : quartiers de Dakar.
function NewZone({ empty, reload }) {
  const [f, setF] = useState({ name: '', city: '', lat: '', lng: '' }); const [run, busy] = useAction();
  return <Card kind={empty ? 'todo' : ''}><h3>{empty ? 'Aucune zone de livraison' : 'Ajouter une zone'}</h3>
    {empty && <div className="row" style={{ marginBottom: 10 }}><Btn kind="primary" disabled={busy} onClick={() => run(async () => { const r = await rpc('lg_zones_seed', {}); reload(); return r; }, { ok: 'Quartiers de Dakar ajoutés' })}>Ajouter les quartiers de Dakar et environs</Btn>
      <span className="small muted">42 zones, modifiables ensuite.</span></div>}
    <div className="grid cols-3"><input className="input" placeholder="Nom (quartier, ville…)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      <input className="input" placeholder="Ville" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} />
      <input className="input" inputMode="decimal" placeholder="Latitude du centre" value={f.lat} onChange={(e) => setF({ ...f, lat: e.target.value })} />
      <input className="input" inputMode="decimal" placeholder="Longitude du centre" value={f.lng} onChange={(e) => setF({ ...f, lng: e.target.value })} /></div>
    <p className="small muted">Le centre sert à reconnaître la zone d'une position GPS (page de suivi) et au prix au km.</p>
    <Btn disabled={busy || !f.name.trim()} onClick={() => run(async () => {
      const r = await rpc('lg_set_zone', { p_zone: f.name, p: { city: f.city || null, lat: f.lat ? Number(f.lat.replace(',', '.')) : null, lng: f.lng ? Number(f.lng.replace(',', '.')) : null } });
      setF({ name: '', city: '', lat: '', lng: '' }); reload(); return r;
    }, { ok: 'Zone ajoutée' })}>Ajouter la zone</Btn></Card>;
}

// Clés d'API : les boutiques en ligne envoient leurs commandes payées (POST /api/v1/orders)
// Envoi automatique des messages par l'instance WhatsApp de l'entreprise (Green API) ; sans elle, envoi manuel gratuit (wa.me).
function WhatsApp() {
  const { data, error, reload } = useRpc('lg_channel_get', {});
  const [inst, setInst] = useState(''); const [token, setToken] = useState(''); const [run, busy] = useAction();
  return <div className="split">
    <Card><h3>Envoi automatique</h3><ErrorBox error={error} />
      {data?.connected ? <><div className="flash ok">Instance {data.instance_id} branchée : les messages partent seuls (toutes les 5 minutes).</div>
        <Field label="Adresse à donner à Green API pour recevoir les réponses (OUI / NON, notes)"><input className="input mono" readOnly value={data.webhook_url} onFocus={(e) => e.target.select()} /></Field>
        {data.last_error && <div className="flash bad">{data.last_error}</div>}
        <Btn kind="bad" disabled={busy} onClick={() => confirm('Débrancher WhatsApp ? Les messages repasseront en envoi manuel.') && run(async () => { const r = await rpc('lg_channel_save', { p_disconnect: true }); reload(); return r; }, { ok: 'WhatsApp débranché' })}>Débrancher</Btn></>
        : <><p className="small">Sans instance, chaque message attend dans <b>Messages → File d'envoi</b> : un appui ouvre WhatsApp avec le texte prêt (gratuit).</p>
          <Field label="Numéro d'instance (idInstance)"><input className="input" inputMode="numeric" value={inst} onChange={(e) => setInst(e.target.value.trim())} /></Field>
          <Field label="Jeton (apiTokenInstance)"><input className="input mono" value={token} onChange={(e) => setToken(e.target.value.trim())} /></Field>
          <Btn kind="primary" disabled={busy || !inst || !token} onClick={() => run(async () => { const r = await rpc('lg_channel_save', { p_instance_id: inst, p_token: token }); setToken(''); reload(); return r; }, { ok: 'WhatsApp branché' })}>Brancher</Btn></>}</Card>
    <Card><h3>Comment faire</h3><ol className="small">
      <li>Créez un compte sur green-api.com et une instance (offre gratuite pour commencer).</li>
      <li>Scannez le QR code avec le WhatsApp de l'entreprise.</li>
      <li>Collez ici le numéro d'instance et le jeton : il est chiffré, jamais réaffiché.</li>
      <li>Dans Green API, collez l'adresse des réponses ci-contre (webhook « incomingMessageReceived »).</li></ol>
      <p className="small muted">Si WhatsApp échoue et que le client a une adresse e-mail, un e-mail de secours part (une seule fois).</p></Card>
  </div>;
}

function ApiKeys() {
  const { data, error, reload } = useRpc('lg_api_keys_list', {});
  const [name, setName] = useState(''); const [created, setCreated] = useState(null); const [run, busy] = useAction();
  return <div className="split">
    <Card><h3>Clés d'API</h3><ErrorBox error={error} />
      {!data?.length ? <Empty>Aucune clé.</Empty> : <div className="list">{data.map((k) => <div key={k.id} className="line" style={{ opacity: k.revoked_at ? .5 : 1 }}>
        <span className="grow"><b>{k.name}</b> <span className="mono small">{k.prefix}…</span><div className="small muted">créée le {dmy(k.created_at)}{k.last_used_at ? ` · utilisée le ${dmy(k.last_used_at)}` : ' · jamais utilisée'}{k.revoked_at ? ' · révoquée' : ''}</div></span>
        {!k.revoked_at && <Btn size="sm" kind="bad" onClick={() => { if (confirm(`Révoquer la clé « ${k.name} » ? Le site qui l'utilise ne pourra plus envoyer de commande.`)) run(async () => { const r = await rpc('lg_api_key_revoke', { p_id: k.id }); reload(); return r; }, { ok: 'Clé révoquée' }); }}>Révoquer</Btn>}</div>)}</div>}
      <div className="row" style={{ marginTop: 10 }}><input className="input" style={{ flex: 1 }} placeholder="Nom (ex. site WooCommerce)" value={name} onChange={(e) => setName(e.target.value)} />
        <Btn kind="primary" disabled={busy} onClick={() => run(async () => { const r = await rpc('lg_api_key_create', { p_name: name || null }); setCreated(r); setName(''); reload(); return r; })}>Créer une clé</Btn></div>
      {created && <div className="flash todo" style={{ marginTop: 10 }}><div><b>Copiez cette clé maintenant</b> : elle ne sera plus jamais affichée.
        <div className="mono small" style={{ wordBreak: 'break-all', margin: '6px 0' }}>{created.key}</div>
        <Btn size="sm" onClick={() => navigator.clipboard?.writeText(created.key)}>Copier</Btn></div></div>}</Card>
    <Card><h3>Brancher une boutique en ligne</h3>
      <p className="small">Depuis le serveur de la boutique (jamais depuis le navigateur du client) :</p>
      <pre className="mono small" style={{ whiteSpace: 'pre-wrap' }}>{`POST ${location.origin}/api/v1/orders
Authorization: Bearer nxl_…
Content-Type: application/json

{ "external_ref": "WC-1001",
  "customer": { "name": "Aminata Diop", "phone": "771234567",
                "address": "Villa 12, Mermoz", "landmark": "face pharmacie" },
  "zone": "Mermoz",
  "items": [{ "name": "Huile 5 L", "quantity": 2, "unit_price_fcfa": 6000, "weight_g": 5000 }],
  "payment_method": "prepaid" }`}</pre>
      <p className="small muted">Réponse : numéro de commande, frais de livraison, lien de suivi à transmettre au client. Renvoyer la même external_ref ne crée pas de doublon.
        Jusqu'à 50 commandes par envoi avec {'{ "orders": [ … ] }'}. Devis au panier : fonction publique lg_quote avec p_company = adresse publique de l'entreprise.</p></Card>
  </div>;
}
