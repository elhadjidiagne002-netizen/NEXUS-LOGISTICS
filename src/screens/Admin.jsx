// Modules 10, 12, 15 — Flotte, tarifs et zones, rôles et réglages.
import React, { useState } from 'react';
import { rpc } from '../lib/backend.js';
import { useMe, ROLE_FR } from '../App.jsx';
import { Icon, useRpc, useAction, Btn, Card, Badge, Empty, Loading, ErrorBox, PageHead, Modal, Field, Tabs, Chips, StatusBadge, formatF, dmy } from '../components/ui.jsx';

export default function Admin() {
  const me = useMe();
  const [tab, setTab] = useState(me.is_admin ? 'staff' : 'fleet');
  const tabs = me.is_admin ? [['staff', 'Rôles'], ['fleet', 'Flotte'], ['pricing', 'Tarifs et zones'], ['devices', 'Appareils'], ['config', 'Réglages']] : [['fleet', 'Flotte']];
  return <>
    <PageHead title="Administration" back="/" />
    <Tabs tabs={tabs} value={tab} onChange={setTab} />
    {tab === 'staff' && <Staff />}{tab === 'fleet' && <Fleet />}{tab === 'pricing' && <Pricing />}{tab === 'config' && <Config />}{tab === 'devices' && <Devices />}
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
  </div>;
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
      return <Card key={v.id} kind={expired || v.status === 'maintenance' ? 'bad' : soon ? 'todo' : 'ok'}>
        <div className="row between"><h3 style={{ margin: 0 }}>{v.kind} · <span className="mono">{v.plate}</span></h3><StatusBadge s={v.on_trip ? 'on_trip' : v.status} /></div>
        <div className="small">{v.label} · {v.capacity_kg} kg{v.capacity_l ? ` · ${v.capacity_l} L` : ''}{v.max_packages ? ` · ${v.max_packages} colis` : ''} · {v.ownership}
          {v.equipment.length ? ` · ${v.equipment.join(', ')}` : ''}</div>
        <div className="small muted">Chauffeur habituel : {v.default_courier?.name ?? '—'} · {v.odometer_km ? `${v.odometer_km.toLocaleString('fr-FR')} km` : ''}
          · coûts 30 j {formatF(v.costs_30d_fcfa)}{v.km_30d ? ` · ${v.km_30d} km` : ''}{v.costs_30d_fcfa && v.km_30d ? ` · ${formatF(v.costs_30d_fcfa / v.km_30d)}/km` : ''}</div>
        <div className="chips" style={{ margin: '6px 0' }}>{v.documents.map((d) => <Badge key={d.id} kind={d.expired ? 'bad' : d.soon ? 'todo' : 'ok'}>{d.kind.replace('_', ' ')} · {dmy(d.expires_at)}</Badge>)}
          {v.documents.length === 0 && <Badge kind="todo">aucun document</Badge>}</div>
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
  const [rc, setRc] = useState({ zone: '', vehicle_kind: '', max_weight_g: 20, price_fcfa: '', lead_hours: 24, service: 'standard' });
  const [quote, setQuote] = useState({ zone: 'Rufisque', kg: 3, sub: 20000 }); const [qr, setQr] = useState(null);
  if (loading && !data) return <Loading />;
  return <div className="stack"><ErrorBox error={error} />
    <div className="split">
      <Card><h3>Grille de prix</h3><div className="scroll-x"><table className="tbl"><thead><tr><th>Service</th><th>Zone</th><th>Véhicule</th><th className="num">Jusqu'à</th><th className="num">Prix</th><th className="num">Délai</th><th></th></tr></thead>
        <tbody>{data.rate_cards.map((r) => <tr key={r.id}><td>{r.service}</td><td>{r.zone ?? 'toutes'}</td><td>{r.vehicle_kind ?? 'tous'}</td><td className="num">{r.max_weight_g / 1000} kg</td>
          <td className="num">{formatF(r.price_fcfa)}</td><td className="num">{r.lead_hours} h</td>
          <td><Btn size="sm" kind="ghost" onClick={() => run(async () => { await rpc('lg_upsert_rate_card', { p: { id: r.id, active: false } }); reload(); })}>✕</Btn></td></tr>)}</tbody></table></div>
        <div className="grid cols-3" style={{ marginTop: 10 }}>
          <select className="input" value={rc.service} onChange={(e) => setRc({ ...rc, service: e.target.value })}><option>standard</option><option>express</option><option>programme</option></select>
          <select className="input" value={rc.zone} onChange={(e) => setRc({ ...rc, zone: e.target.value })}><option value="">toutes zones</option>{data.zones.map((z) => <option key={z.name}>{z.name}</option>)}</select>
          <select className="input" value={rc.vehicle_kind} onChange={(e) => setRc({ ...rc, vehicle_kind: e.target.value })}><option value="">tous véhicules</option>{KINDS.map((k) => <option key={k}>{k}</option>)}</select>
          <input className="input" inputMode="numeric" placeholder="jusqu'à (kg)" value={rc.max_weight_g} onChange={(e) => setRc({ ...rc, max_weight_g: e.target.value })} />
          <input className="input" inputMode="numeric" placeholder="prix (F)" value={rc.price_fcfa} onChange={(e) => setRc({ ...rc, price_fcfa: e.target.value })} />
          <input className="input" inputMode="numeric" placeholder="délai (h)" value={rc.lead_hours} onChange={(e) => setRc({ ...rc, lead_hours: e.target.value })} /></div>
        <Btn kind="primary" style={{ marginTop: 8 }} disabled={!rc.price_fcfa} onClick={() => run(async () => {
          await rpc('lg_upsert_rate_card', { p: { ...rc, max_weight_g: Number(rc.max_weight_g) * 1000, price_fcfa: Number(rc.price_fcfa), lead_hours: Number(rc.lead_hours) } }); reload();
        }, { ok: 'Tarif ajouté' })}>Ajouter le tarif</Btn></Card>
      <Card><h3>Simulateur (prix au panier)</h3><div className="grid cols-3">
        <select className="input" value={quote.zone} onChange={(e) => setQuote({ ...quote, zone: e.target.value })}>{data.zones.map((z) => <option key={z.name}>{z.name}</option>)}</select>
        <input className="input" inputMode="decimal" value={quote.kg} onChange={(e) => setQuote({ ...quote, kg: e.target.value })} aria-label="Poids kg" />
        <input className="input" inputMode="numeric" value={quote.sub} onChange={(e) => setQuote({ ...quote, sub: e.target.value })} aria-label="Montant panier" /></div>
        <Btn style={{ marginTop: 8 }} onClick={async () => setQr(await rpc('lg_quote', { p_zone: quote.zone, p_weight_g: Math.round(Number(quote.kg) * 1000), p_subtotal_fcfa: Number(quote.sub) }))}>Calculer</Btn>
        {qr && (qr.ok ? <div className="flash ok" style={{ marginTop: 8 }}><div><b className="big">{formatF(qr.price_fcfa)}</b> {qr.free && '(offerte)'} · {qr.vehicle_kind}{qr.surcharges?.length ? ` · dont ${qr.surcharges.map((s) => `${s.label.toLowerCase()} ${formatF(s.amount_fcfa)}`).join(', ')}` : ''}<div className="small">promis le {dmy(qr.promised_at)}</div></div></div>
          : <div className="flash bad" style={{ marginTop: 8 }}>{qr.error}</div>)}
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
    <td>{dirty && <Btn size="sm" kind="primary" onClick={() => run(async () => { await rpc('lg_set_zone', { p_zone: z.name, p: { served: f.served, cutoff_time: f.cutoff_time, free_above_fcfa: f.free_above_fcfa ? Number(f.free_above_fcfa) : null, delivery_days: f.delivery_days } }); setDirty(false); reload(); }, { ok: 'Zone mise à jour' })}>OK</Btn>}</td></tr>;
}

const CFG = [['max_attempts', 'Présentations avant retour vendeur'], ['proof_radius_m', 'Rayon de validation (m)'], ['cash_limit_fcfa', 'Plafond d\'espèces par chauffeur (F)'],
  ['pick_lock_minutes', 'Libération d\'une préparation inactive (min)'], ['tva_rate', 'Taux de TVA (%)'], ['heavy_kg', 'Seuil « lourd » (kg)'],
  ['otp_attempts', 'Essais du code client'], ['staged_max_hours', 'Alerte colis à quai (h)'], ['stop_max_minutes', 'Alerte arrêt long (min)'],
  ['pay_per_package', 'Prime par colis livré (F)'], ['bonus_zero_failure', 'Bonus zéro échec (F)'], ['manager_phone', 'WhatsApp du gérant (rapport du soir)'], ['manager_email', 'E-mail du gérant (secours du rapport du soir)'],
  ['bonus_on_time', 'Prime par livraison à l\'heure (F)'], ['double_check_fcfa', 'Double contrôle au-delà de (F)'],
  ['tracking_base_url', 'Adresse de la page de suivi'], ['expiry_alert_days', 'Alerte péremption (jours avant la date)'],
  ['insurance_rate_pct', 'Assurance : prime (% de la valeur déclarée)'], ['insurance_min_fcfa', 'Assurance : prime minimale (F)'],
  ['insurance_max_value_fcfa', 'Assurance : valeur maximale assurable (F)'], ['uninsured_cap_fcfa', 'Plafond d\'indemnisation sans assurance (F)']];
function Config() {
  const { data } = useRpc('lg_pricing', {});
  const [f, setF] = useState(null);
  const [run, busy] = useAction();
  const cur = f ?? data?.config ?? {};
  return <Card><div className="grid cols-2">{CFG.map(([k, l]) => <Field key={k} label={l}><input className="input" value={cur[k] ?? ''} placeholder="valeur par défaut"
    onChange={(e) => setF({ ...cur, [k]: e.target.value })} /></Field>)}
    <Field label="Émetteur de la facture client"><select className="input" value={cur.invoice_issuer ?? 'vendor_via_nexus'} onChange={(e) => setF({ ...cur, invoice_issuer: e.target.value })}>
      <option value="vendor_via_nexus">Le vendeur, par l'intermédiaire de NEXUS</option><option value="nexus">NEXUS Market en son nom</option></select></Field>
    <label className="check"><input type="checkbox" checked={cur.require_photo !== false && cur.require_photo !== 'false'} onChange={(e) => setF({ ...cur, require_photo: e.target.checked })} /> Photo obligatoire à la livraison et à l'échec</label></div>
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
