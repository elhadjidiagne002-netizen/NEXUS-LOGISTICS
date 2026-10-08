// Tableau de bord d'administration de la plateforme NEXUS Logistics (/admin/).
// Connexion avec le COMPTE DEVIZO de l'administrateur (même e-mail et mot de passe que Devizo, My shop et CV en ligne),
// adresse obligatoirement dans ADMIN_EMAILS (server/routes/admin.js). Session d'administration à part : elle ne donne
// accès à aucune entreprise en tant que membre, seulement aux fonctions de plateforme (/api/admin/rpc/<nom>).
import React, { useEffect, useState } from 'react';
import { rpc } from '../lib/backend.js';
import { errText } from '../lib/errors.js';
import { Logo, toggleTheme } from '../App.jsx';
import { Payments, Settings, Errors } from '../screens/Platform.jsx';
import { useRpc, useAction, Btn, Card, Badge, Empty, Loading, ErrorBox, Tabs, Stat, Field, Modal, formatF, dmy, ago, Icon } from '../components/ui.jsx';

const SECTIONS = [
  ['overview', 'home', 'Vue d’ensemble'], ['companies', 'store', 'Entreprises'], ['users', 'users', 'Comptes'],
  ['orders', 'box', 'Commandes'], ['payments', 'cash', 'Abonnements'], ['plans', 'receipt', 'Formules'],
  ['messages', 'message', 'Messages'], ['system', 'settings', 'Système'], ['errors', 'alert', 'Erreurs'], ['audit', 'shield', 'Journal'],
];
const ROLE = { owner: 'propriétaire', admin: 'administrateur', staff: 'équipe', vendor: 'vendeur', courier: 'chauffeur' };
const STATUS = { pending: 'à traiter', processing: 'en préparation', in_transit: 'en route', delivered: 'livrée', cancelled: 'annulée' };

async function api(method, path, body) {
  const r = await fetch(path, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error ?? `http_${r.status}`), { code: data.error, text: data.message });
  return data;
}

export default function AdminApp() {
  const [admin, setAdmin] = useState(undefined);
  useEffect(() => { api('GET', '/api/admin/me').then((r) => setAdmin(r.email)).catch(() => setAdmin(null)); }, []);
  // session expirée (12 h) ou adresse retirée de ADMIN_EMAILS : retour à la connexion
  useEffect(() => {
    if (!admin) return;
    const i = setInterval(() => api('GET', '/api/admin/me').then((r) => { if (!r.email) setAdmin(null); }).catch(() => {}), 120000);
    return () => clearInterval(i);
  }, [admin]);
  if (admin === undefined) return <div className="app"><Loading /></div>;
  if (!admin) return <Login onDone={setAdmin} />;
  return <Shell admin={admin} onLogout={async () => { await api('POST', '/api/admin/logout').catch(() => {}); setAdmin(null); }} />;
}

function Login({ onDone }) {
  const [f, setF] = useState({ email: '', password: '' }); const [err, setErr] = useState(null); const [busy, setBusy] = useState(false);
  return <div className="login-wrap" style={{ gridTemplateColumns: '1fr', placeItems: 'center' }}>
    <main className="login-form" style={{ maxWidth: 440 }}>
      <div className="brand" style={{ marginBottom: 22 }}><Logo size={42} /><span>NEXUS Logistics<small>Administration de la plateforme</small></span></div>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr(null);
        try { onDone((await api('POST', '/api/admin/login', f)).email); } catch (x) { setErr(x); } finally { setBusy(false); }
      }}>
        <h1>Connexion administrateur</h1>
        <p className="muted" style={{ marginTop: -6 }}>Avec votre <b>compte Devizo</b> : le même e-mail et le même mot de passe que pour l’administration
          de Devizo, My shop et CV en ligne.</p>
        <Field label="E-mail"><input className="input" type="email" autoComplete="username" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></Field>
        <Field label="Mot de passe"><input className="input" type="password" autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required /></Field>
        {err && <div className="flash bad">{err.text ?? errText(err)}</div>}
        <Btn kind="primary" type="submit" size="xl" disabled={busy}>Se connecter</Btn>
        <a className="small" href="/">← Retour à NEXUS Logistics</a>
      </form>
    </main></div>;
}

function Shell({ admin, onLogout }) {
  const [sec, setSec] = useState(() => { try { return localStorage.getItem('lg-admin-sec') || 'overview'; } catch { return 'overview'; } });
  const [company, setCompany] = useState(null);
  const go = (s) => { setSec(s); setCompany(null); scrollTo(0, 0); try { localStorage.setItem('lg-admin-sec', s); } catch { /* stockage indisponible */ } };
  const openCompany = (id) => { setSec('companies'); setCompany(id); scrollTo(0, 0); };
  const title = SECTIONS.find(([k]) => k === sec)?.[2];
  return <div className="shell">
    <aside className="sidebar" aria-label="Menu">
      <div className="brand"><Logo size={34} /><span>NEXUS Logistics<small style={{ color: '#64748b' }}>Administration</small></span></div>
      {SECTIONS.map(([k, icon, l]) => <button key={k} className={`side-link ${sec === k ? 'on' : ''}`} onClick={() => go(k)}><Icon name={icon} />{l}</button>)}
      <div className="side-foot"><span className="avatar"><Icon name="shield" size={16} /></span>
        <div className="who"><b>Administrateur</b><span>{admin}</span></div>
        <button className="icon-btn" title="Se déconnecter" aria-label="Se déconnecter" onClick={onLogout}><Icon name="logout" size={18} /></button></div>
    </aside>
    <div style={{ minWidth: 0 }}>
      <header className="topbar"><span className="brand"><Logo size={30} /><span className="hide-sm">Administration</span></span>
        <select className="input" style={{ maxWidth: 220 }} aria-label="Rubrique" value={sec} onChange={(e) => go(e.target.value)}>
          {SECTIONS.map(([k, , l]) => <option key={k} value={k}>{l}</option>)}</select>
        <span className="spacer" />
        <button className="icon-btn" aria-label="Changer de thème" onClick={toggleTheme}><Icon name="sun" size={18} /></button>
        <button className="icon-btn" aria-label="Se déconnecter" onClick={onLogout}><Icon name="logout" size={18} /></button></header>
      <main className="app">
        <div className="page-head" style={{ marginTop: 18 }}>{company && <button className="back" aria-label="Retour" onClick={() => setCompany(null)}><Icon name="arrowLeft" size={18} /></button>}
          <h1>{company ? 'Entreprise' : title}</h1></div>
        {sec === 'overview' && <Overview go={go} openCompany={openCompany} />}
        {sec === 'companies' && (company ? <CompanyDetail id={company} /> : <Companies openCompany={openCompany} />)}
        {sec === 'users' && <Users openCompany={openCompany} />}
        {sec === 'orders' && <Orders openCompany={openCompany} />}
        {sec === 'payments' && <PaymentsSection />}
        {sec === 'plans' && <PlansSection />}
        {sec === 'messages' && <Messages />}
        {sec === 'system' && <System />}
        {sec === 'errors' && <Errors />}
        {sec === 'audit' && <Audit />}
      </main>
    </div>
  </div>;
}

// ----------------------------------------------------------------- vue d'ensemble
function Overview({ go, openCompany }) {
  const { data, error, loading } = useRpc('lg_platform_overview', {}, { refresh: 60000 });
  const sys = useRpc('lg_platform_system', {}, { refresh: 60000 });
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const t = data.totals;
  const late = (sys.data?.cron ?? []).filter((c) => ['watchdog', 'messages'].includes(c.task) && c.late_minutes > 15);
  return <div className="stack">
    <div className="stats">
      <Stat icon="store" label="entreprises" value={t.companies} /><Stat icon="star" c="#059669" label="en formule Pro" value={t.pro} />
      <Stat icon="users" label="comptes" value={sys.data?.volumes.users ?? '…'} /><Stat icon="truck" label="livrées sur 30 jours" value={t.delivered_30d} />
      <Stat icon="box" label="commandes sur 30 jours" value={t.orders_30d} /><Stat icon="cash" c="#d97706" label="abonnements à valider" value={t.payments_pending} kind={t.payments_pending ? 'todo' : ''} />
      <Stat icon="receipt" label="encaissé (abonnements)" value={formatF(t.revenue_fcfa)} /><Stat icon="alert" c="#dc2626" label="erreurs (24 h)" value={t.errors_24h} kind={t.errors_24h ? 'bad' : ''} />
    </div>
    {(t.payments_pending > 0 || late.length > 0 || t.suspended > 0) && <Card kind="todo"><h3>À regarder</h3><div className="list">
      {t.payments_pending > 0 && <div className="line"><span className="grow">{t.payments_pending} paiement(s) d’abonnement déclaré(s) à vérifier</span><Btn size="sm" onClick={() => go('payments')}>Ouvrir</Btn></div>}
      {late.length > 0 && <div className="line"><span className="grow">Tâches planifiées en retard : {late.map((c) => `${c.task} (${c.late_minutes} min)`).join(', ')}</span><Btn size="sm" onClick={() => go('system')}>Système</Btn></div>}
      {t.suspended > 0 && <div className="line"><span className="grow">{t.suspended} entreprise(s) suspendue(s)</span><Btn size="sm" onClick={() => go('companies')}>Voir</Btn></div>}
    </div></Card>}
    <Card><h3>Dernières entreprises inscrites</h3>{!data.companies.length ? <Empty>Aucune entreprise pour l’instant.</Empty> :
      <div className="list">{data.companies.slice(0, 8).map((c) => <button key={c.id} className="line" style={{ textAlign: 'left', width: '100%', background: 'none', border: 0, cursor: 'pointer' }} onClick={() => openCompany(c.id)}>
        <span className="grow"><b>{c.name}</b><div className="small muted">{c.owner_email} · {c.city} · {ago(c.created_at)}</div></span>
        <Badge kind={c.plan_effective === 'pro' ? 'ok' : ''}>{c.plan_effective === 'pro' ? 'Pro' : 'Gratuite'}</Badge>{c.suspended && <Badge kind="bad">suspendue</Badge>}</button>)}</div>}</Card>
  </div>;
}

// ----------------------------------------------------------------- entreprises
function Companies({ openCompany }) {
  const { data, error, loading, reload } = useRpc('lg_platform_overview', {});
  const [q, setQ] = useState(''); const [run, busy] = useAction();
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const list = data.companies.filter((c) => !q || `${c.name} ${c.owner_email ?? ''} ${c.city}`.toLowerCase().includes(q.toLowerCase()));
  return <Card>
    <input className="input" style={{ maxWidth: 340, marginBottom: 10 }} placeholder="Nom, propriétaire, ville…" value={q} onChange={(e) => setQ(e.target.value)} />
    {!list.length ? <Empty>Aucune entreprise.</Empty> : <div className="scroll-x"><table className="tbl"><thead><tr><th>Entreprise</th><th>Propriétaire</th><th>Formule</th>
      <th className="num">Membres</th><th className="num">Commandes 30 j</th><th>Activité</th><th></th></tr></thead><tbody>{list.map((c) => <tr key={c.id} style={{ opacity: c.suspended ? 0.55 : 1 }}>
        <td><button className="linkish" style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left' }} onClick={() => openCompany(c.id)}><b>{c.name}</b></button>
          <div className="small muted">{c.city} · créée le {dmy(c.created_at)}</div></td><td className="small">{c.owner_email}</td>
        <td><Badge kind={c.plan_effective === 'pro' ? 'ok' : ''}>{c.plan_effective === 'pro' ? `Pro → ${dmy(c.plan_until)}` : 'Gratuite'}</Badge></td>
        <td className="num">{c.members}</td><td className="num">{c.orders_30d}</td><td className="small">{c.last_activity ? ago(c.last_activity) : '—'}</td>
        <td><div className="row" style={{ justifyContent: 'flex-end' }}><Btn size="sm" onClick={() => openCompany(c.id)}>Gérer</Btn>
          <Btn size="sm" kind={c.suspended ? 'primary' : 'bad'} disabled={busy} onClick={() => confirm(c.suspended ? `Rétablir ${c.name} ?` : `Suspendre ${c.name} ? Plus personne n’y aura accès.`)
            && run(async () => { const r = await rpc('lg_platform_company_set', { p_company: c.id, p_suspend: !c.suspended }); reload(); return r; })}>{c.suspended ? 'Rétablir' : 'Suspendre'}</Btn></div></td></tr>)}</tbody></table></div>}
  </Card>;
}

function CompanyDetail({ id }) {
  const { data, error, loading, reload } = useRpc('lg_platform_company_detail', { p_company: id });
  const [tab, setTab] = useState('members'); const [edit, setEdit] = useState(null); const [plan, setPlan] = useState(null);
  const [run, busy] = useAction();
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const c = data.company; const n = data.counts;
  const act = (fn, args, ok) => run(async () => { const r = await rpc(fn, args); reload(); return r; }, { ok });
  return <div className="stack">
    <Card kind={c.suspended ? 'bad' : ''}>
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div><h2 style={{ margin: 0 }}>{c.name}</h2><div className="small muted">{c.kind} · {c.city}{c.phone ? ` · ${c.phone}` : ''} · adresse publique « {c.slug} » · créée le {dmy(c.created_at)}</div>
          <div className="chips" style={{ marginTop: 6 }}><Badge kind={c.plan_effective === 'pro' ? 'ok' : ''}>{c.plan_effective === 'pro' ? `Pro jusqu’au ${dmy(c.plan_until)}` : 'Formule gratuite'}</Badge>
            {c.suspended && <Badge kind="bad">suspendue depuis le {dmy(c.suspended_at)}</Badge>}</div></div>
        <div className="row"><Btn size="sm" onClick={() => setEdit({ name: c.name, city: c.city ?? '', phone: c.phone ?? '' })}>Modifier</Btn>
          <Btn size="sm" onClick={() => setPlan({ plan: c.plan, until: c.plan_until ? c.plan_until.slice(0, 10) : '' })}>Formule</Btn>
          <Btn size="sm" kind={c.suspended ? 'primary' : 'bad'} disabled={busy} onClick={() => confirm(c.suspended ? `Rétablir ${c.name} ?` : `Suspendre ${c.name} ? Plus personne n’y aura accès, ses pages de suivi non plus.`)
            && act('lg_platform_company_set', { p_company: c.id, p_suspend: !c.suspended }, c.suspended ? 'Entreprise rétablie' : 'Entreprise suspendue')}>{c.suspended ? 'Rétablir' : 'Suspendre'}</Btn></div>
      </div>
      <div className="stats" style={{ marginTop: 12 }}>
        <Stat icon="box" label="commandes (30 j)" value={n.orders_30d} /><Stat icon="truck" label="livrées (30 j)" value={n.delivered_30d} />
        <Stat icon="bike" label="chauffeurs actifs" value={n.couriers} /><Stat icon="route" label="voyages (30 j)" value={n.trips_30d} />
        <Stat icon="receipt" label="factures" value={n.invoices} /><Stat icon="message" c="#dc2626" label="messages en échec (7 j)" value={n.messages_failed_7d} kind={n.messages_failed_7d ? 'bad' : ''} />
      </div>
    </Card>
    <Tabs value={tab} onChange={setTab} tabs={[['members', `Membres (${data.members.length})`], ['orders', 'Commandes'], ['api', 'API et rappels'], ['payments', 'Abonnement'], ['activity', 'Activité'], ['settings', 'Réglages']]} />
    {tab === 'members' && <Card><div className="scroll-x"><table className="tbl"><thead><tr><th>Personne</th><th>Rôle</th><th>Rôles logistiques</th><th>Dernière connexion</th><th></th></tr></thead><tbody>
      {data.members.map((m) => <tr key={m.user_id} style={{ opacity: m.suspended ? 0.55 : 1 }}><td><b>{m.name}</b><div className="small muted">{m.email}{m.phone ? ` · ${m.phone}` : ''}</div></td>
        <td><select className="input" value={m.role} disabled={busy || m.role === 'owner'} onChange={(e) => {
          const role = e.target.value;
          if (role === 'owner' && !confirm(`Faire de ${m.name} le propriétaire de ${c.name} ? Le propriétaire actuel deviendra administrateur.`)) return;
          act('lg_platform_member_set', { p_company: c.id, p_user: m.user_id, p_role: role }, 'Rôle modifié');
        }}>{Object.entries(ROLE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></td>
        <td className="small">{m.staff.join(', ') || '—'}</td><td className="small">{m.last_login ? ago(m.last_login) : 'jamais'}</td>
        <td>{m.role !== 'owner' && <Btn size="sm" kind="ghost" disabled={busy} onClick={() => confirm(`Retirer ${m.name} de ${c.name} ?`)
          && act('lg_platform_member_set', { p_company: c.id, p_user: m.user_id, p_remove: true }, 'Membre retiré')}>Retirer</Btn>}</td></tr>)}
    </tbody></table></div><p className="small muted">Pour changer de propriétaire : choisissez « propriétaire » sur la nouvelle personne.</p></Card>}
    {tab === 'orders' && <OrdersTable list={data.orders} />}
    {tab === 'api' && <div className="split">
      <Card><h3>Clés d’API</h3>{!data.api_keys.length ? <Empty>Aucune clé.</Empty> : <div className="list">{data.api_keys.map((k) => <div key={k.id} className="line">
        <span className="grow"><b>{k.name}</b> <span className="mono small">{k.prefix}…</span><div className="small muted">créée {ago(k.created_at)} · {k.last_used_at ? `utilisée ${ago(k.last_used_at)}` : 'jamais utilisée'}</div></span>
        {k.revoked_at ? <Badge>révoquée</Badge> : <Btn size="sm" kind="bad" disabled={busy} onClick={() => confirm('Révoquer cette clé ? La boutique ne pourra plus envoyer de commandes avec.')
          && act('lg_platform_api_key_revoke', { p_id: k.id }, 'Clé révoquée')}>Révoquer</Btn>}</div>)}</div>}</Card>
      <Card><h3>Statuts renvoyés à la boutique</h3>{!data.webhook ? <Empty>Pas d’adresse de rappel.</Empty> : <div className="stack">
        <div className="mono small" style={{ wordBreak: 'break-all' }}>{data.webhook.url}</div>
        <div><Badge kind={data.webhook.active ? 'ok' : ''}>{data.webhook.active ? 'active' : 'inactive'}</Badge></div>
        {data.webhook.last_error && <div className="flash bad">{data.webhook.last_error}</div>}</div>}</Card></div>}
    {tab === 'payments' && <Card>{!data.payments.length ? <Empty>Aucun paiement déclaré.</Empty> : <div className="list">{data.payments.map((p) => <div key={p.id} className="line">
      <span className="grow"><b>{formatF(p.amount_fcfa)}</b> · {p.months} mois · {p.method} · réf. <span className="mono">{p.ref}</span><div className="small muted">déclaré {ago(p.declared_at)}{p.note ? ` · ${p.note}` : ''}</div></span>
      <Badge kind={{ approved: 'ok', rejected: 'bad' }[p.status] ?? 'todo'}>{{ approved: 'validé', rejected: 'refusé', pending: 'à vérifier' }[p.status]}</Badge></div>)}</div>}</Card>}
    {tab === 'activity' && <Card>{!data.activity.length ? <Empty>Aucune activité.</Empty> : <div className="list">{data.activity.map((x, i) => <div key={i} className="line">
      <span className="grow">{x.action}<span className="small muted"> · {x.entity ?? ''} · {x.user ?? '—'}</span></span><span className="small muted">{ago(x.created_at)}</span></div>)}</div>}</Card>}
    {tab === 'settings' && <Card><h3>Réglages enregistrés par l’entreprise</h3>{!Object.keys(c.settings).length ? <Empty>Valeurs par défaut.</Empty> :
      <div className="scroll-x"><table className="tbl"><tbody>{Object.entries(c.settings).map(([k, v]) => <tr key={k}><td className="mono small">{k}</td><td>{JSON.stringify(v)}</td></tr>)}</tbody></table></div>}
      <h3 style={{ marginTop: 14 }}>Lieux</h3><div className="list">{data.hubs.map((h) => <div key={h.id} className="line"><span className="grow">{h.name} <span className="small muted">· {h.kind}{h.address ? ` · ${h.address}` : ''}</span></span>{!h.active && <Badge>inactif</Badge>}</div>)}</div></Card>}
    {edit && <Modal title="Coordonnées de l’entreprise" onClose={() => setEdit(null)}><div className="stack">
      <Field label="Nom"><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
      <Field label="Ville"><input className="input" value={edit.city} onChange={(e) => setEdit({ ...edit, city: e.target.value })} /></Field>
      <Field label="Téléphone"><input className="input" value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></Field>
      <Btn kind="primary" disabled={busy} onClick={async () => { const r = await act('lg_platform_company_update', { p_company: c.id, p_name: edit.name, p_city: edit.city, p_phone: edit.phone }, 'Enregistré'); if (r?.ok !== false) setEdit(null); }}>Enregistrer</Btn></div></Modal>}
    {plan && <Modal title="Formule de l’entreprise" onClose={() => setPlan(null)}><div className="stack">
      <Field label="Formule"><select className="input" value={plan.plan} onChange={(e) => setPlan({ ...plan, plan: e.target.value })}><option value="free">Gratuite</option><option value="pro">Pro</option></select></Field>
      {plan.plan === 'pro' && <Field label="Pro jusqu’au"><input className="input" type="date" value={plan.until} onChange={(e) => setPlan({ ...plan, until: e.target.value })} /></Field>}
      <p className="small muted">Pour offrir ou prolonger la formule Pro sans paiement déclaré (geste commercial, essai).</p>
      <Btn kind="primary" disabled={busy || (plan.plan === 'pro' && !plan.until)} onClick={async () => {
        const r = await act('lg_platform_company_set', { p_company: c.id, p_plan: plan.plan, p_plan_until: plan.plan === 'pro' ? `${plan.until}T23:59:59.000Z` : null }, 'Formule enregistrée');
        if (r?.ok !== false) setPlan(null);
      }}>Enregistrer</Btn></div></Modal>}
  </div>;
}

// ----------------------------------------------------------------- comptes
function Users({ openCompany }) {
  const [q, setQ] = useState(''); const [query, setQuery] = useState('');
  const { data, error, loading, reload } = useRpc('lg_platform_users', { p_q: query });
  const [run, busy] = useAction();
  const act = (args, ok) => run(async () => { const r = await rpc('lg_platform_user_set', args); reload(); return r; }, { ok });
  return <Card>
    <form className="row" style={{ marginBottom: 10 }} onSubmit={(e) => { e.preventDefault(); setQuery(q); }}>
      <input className="input" style={{ maxWidth: 340 }} placeholder="Nom, e-mail ou téléphone" value={q} onChange={(e) => setQ(e.target.value)} /><Btn type="submit"><Icon name="search" size={16} />Chercher</Btn></form>
    <ErrorBox error={error} />{loading && !data ? <Loading /> : !data?.length ? <Empty>Aucun compte.</Empty> :
      <div className="scroll-x"><table className="tbl"><thead><tr><th>Compte</th><th>Entreprises</th><th>Dernière connexion</th><th></th></tr></thead><tbody>{data.map((u) => <tr key={u.id} style={{ opacity: u.suspended ? 0.55 : 1 }}>
        <td><b>{u.name}</b>{u.suspended && <Badge kind="bad">suspendu</Badge>}<div className="small muted">{u.email}{u.phone ? ` · ${u.phone}` : ''} · inscrit le {dmy(u.created_at)}</div></td>
        <td className="small">{u.companies.length ? u.companies.map((c) => <div key={c.id}><button className="linkish" style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer' }} onClick={() => openCompany(c.id)}>{c.name}</button> · {ROLE[c.role]}</div>) : '—'}</td>
        <td className="small">{u.last_login ? ago(u.last_login) : 'jamais'}{u.sessions ? ` · ${u.sessions} session(s)` : ''}</td>
        <td><div className="row" style={{ justifyContent: 'flex-end' }}>
          {u.sessions > 0 && <Btn size="sm" disabled={busy} onClick={() => act({ p_user: u.id, p_logout: true }, 'Sessions fermées')}>Déconnecter</Btn>}
          <Btn size="sm" kind={u.suspended ? 'primary' : 'bad'} disabled={busy} onClick={() => confirm(u.suspended ? `Rétablir ${u.email} ?` : `Suspendre ${u.email} ? Il ne pourra plus se connecter.`)
            && act({ p_user: u.id, p_suspend: !u.suspended }, u.suspended ? 'Compte rétabli' : 'Compte suspendu')}>{u.suspended ? 'Rétablir' : 'Suspendre'}</Btn></div></td></tr>)}</tbody></table></div>}
  </Card>;
}

// ----------------------------------------------------------------- commandes
function OrdersTable({ list, openCompany }) {
  if (!list.length) return <Card><Empty>Aucune commande.</Empty></Card>;
  return <Card><div className="scroll-x"><table className="tbl"><thead><tr><th>N°</th>{openCompany && <th>Entreprise</th>}<th>Client</th><th>Zone</th><th>Statut</th><th>Paiement</th><th className="num">Total</th><th>Créée</th></tr></thead>
    <tbody>{list.map((o) => <tr key={o.id}><td className="mono">{o.number}{o.external_ref && <div className="small muted">{o.external_ref}</div>}</td>
      {openCompany && <td><button className="linkish" style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer' }} onClick={() => openCompany(o.company_id)}>{o.company}</button></td>}
      <td>{o.buyer_name}<div className="small muted">{o.buyer_phone}</div></td><td>{o.delivery_zone}</td>
      <td><Badge kind={o.status === 'delivered' ? 'ok' : o.status === 'cancelled' ? 'bad' : ''}>{STATUS[o.status] ?? o.status}</Badge></td>
      <td className="small">{o.payment_method === 'cod' ? 'à la livraison' : 'payée en ligne'} · {o.payment_status === 'paid' ? 'payée' : 'à encaisser'}</td>
      <td className="num">{formatF(o.total_fcfa)}</td><td className="small">{dmy(o.created_at)}</td></tr>)}</tbody></table></div></Card>;
}

function Orders({ openCompany }) {
  const [q, setQ] = useState(''); const [f, setF] = useState({ p_q: '', p_status: '' });
  const { data, error, loading } = useRpc('lg_platform_orders', { p_q: f.p_q, p_status: f.p_status || null });
  return <div className="stack">
    <form className="row" onSubmit={(e) => { e.preventDefault(); setF({ ...f, p_q: q }); }}>
      <input className="input" style={{ maxWidth: 300 }} placeholder="N°, référence, client, téléphone" value={q} onChange={(e) => setQ(e.target.value)} />
      <select className="input" style={{ maxWidth: 200 }} value={f.p_status} onChange={(e) => setF({ ...f, p_status: e.target.value })}><option value="">Tous les statuts</option>
        {Object.entries(STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select><Btn type="submit"><Icon name="search" size={16} />Chercher</Btn></form>
    <ErrorBox error={error} />{loading && !data ? <Loading /> : <OrdersTable list={data ?? []} openCompany={openCompany} />}
  </div>;
}

// ----------------------------------------------------------------- abonnements, formules
function PaymentsSection() {
  const { data, error, loading, reload } = useRpc('lg_platform_overview', {});
  if (loading && !data) return <Loading />;
  return error ? <ErrorBox error={error} /> : <Payments list={data.payments} reload={reload} />;
}
function PlansSection() {
  const { data, error, loading, reload } = useRpc('lg_platform_overview', {});
  if (loading && !data) return <Loading />;
  return error ? <ErrorBox error={error} /> : <Settings s={data.settings} reload={reload} />;
}

// ----------------------------------------------------------------- messages, système, journal
function Messages() {
  const [st, setSt] = useState('failed');
  const { data, error, loading } = useRpc('lg_platform_outbox', { p_status: st });
  return <div className="stack"><Tabs value={st} onChange={setSt} tabs={[['failed', 'En échec'], ['pending', 'En attente'], ['sent', 'Envoyés'], ['cancelled', 'Annulés']]} />
    <ErrorBox error={error} />{loading && !data ? <Loading /> : !data?.length ? <Card><Empty icon="check">Aucun message.</Empty></Card> :
      <Card><div className="scroll-x"><table className="tbl"><thead><tr><th>Entreprise</th><th>Message</th><th>Destinataire</th><th>Canaux</th><th>Créé</th></tr></thead><tbody>
        {data.map((m) => <tr key={m.id}><td>{m.company}</td><td className="mono small">{m.event_key}{m.last_error && <div className="small" style={{ color: 'var(--bad, #dc2626)' }}>{m.last_error}</div>}</td>
          <td className="small">{m.phone ?? ''}{m.email ? ` · ${m.email}` : ''}</td><td className="small">WhatsApp {m.whatsapp_status ?? '—'} · e-mail {m.email_status ?? '—'} · {m.attempts} essai(s)</td>
          <td className="small">{ago(m.created_at)}</td></tr>)}</tbody></table></div></Card>}</div>;
}

const TASK = { watchdog: 'Surveillance (retards, alertes)', reminders: 'Relances des vendeurs', messages: 'Envoi des messages', purge: 'Nettoyage horaire', evening: 'Rapport du soir' };
function System() {
  const { data, error, loading } = useRpc('lg_platform_system', {}, { refresh: 60000 });
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const v = data.volumes; const cfg = data.config;
  return <div className="stack">
    <Card><h3>Tâches planifiées</h3><p className="small muted" style={{ marginTop: -6 }}>Lancées toutes les 5 minutes par le planificateur de NEXUS Market (nexus-cron).</p>
      {!data.cron.length ? <div className="flash bad">Aucun passage enregistré : le planificateur ne joint pas le site.</div> :
        <div className="list">{data.cron.map((t) => { const lateLimit = ['purge'].includes(t.task) ? 75 : t.task === 'evening' ? 1500 : 15;
          return <div key={t.task} className="line"><span className="grow"><b>{TASK[t.task] ?? t.task}</b><div className="small muted mono">{JSON.stringify(t.result)}</div></span>
            <Badge kind={t.late_minutes > lateLimit ? 'bad' : 'ok'}>{t.late_minutes > lateLimit ? `en retard (${t.late_minutes} min)` : `il y a ${t.late_minutes} min`}</Badge></div>; })}</div>}</Card>
    <div className="split">
      <Card><h3>Volumes</h3><div className="stats">
        <Stat icon="store" label="entreprises" value={v.companies} /><Stat icon="users" label="comptes" value={v.users} /><Stat icon="box" label="commandes" value={v.orders} />
        <Stat icon="route" label="voyages" value={v.trips} /><Stat icon="receipt" label="factures" value={v.invoices} /><Stat icon="message" label="messages" value={v.messages} />
        <Stat icon="camera" label="photos de preuve" value={v.files} /></div></Card>
      <Card><h3>Sept derniers jours</h3>
        <p><b>Messages</b> : {Object.entries(data.outbox_7d).map(([k, n]) => `${n} ${k}`).join(' · ') || 'aucun'}</p>
        <p><b>Statuts renvoyés aux boutiques</b> : {Object.entries(data.webhooks_7d).map(([k, n]) => `${n} ${k}`).join(' · ') || 'aucun'}</p>
        <h3>Configuration</h3><div className="list">
          {[['cron', 'Tâches planifiées (CRON_SECRET)'], ['whatsapp_key', 'Chiffrement des jetons WhatsApp (SECRETS_KEY)'], ['email', 'E-mail de secours (BREVO_API_KEY)'], ['devizo_accounts', 'Comptes administrateur Devizo (AUTH_DB)']]
            .map(([k, l]) => <div key={k} className="line"><span className="grow">{l}</span><Badge kind={cfg[k] ? 'ok' : 'todo'}>{cfg[k] ? 'configuré' : 'absent'}</Badge></div>)}</div></Card>
    </div></div>;
}

function Audit() {
  const { data, error, loading } = useRpc('lg_platform_audit', { p_limit: 300 });
  if (loading && !data) return <Loading />;
  return <Card><ErrorBox error={error} />{!data?.length ? <Empty>Aucune action.</Empty> : <div className="list">{data.map((a) => <div key={a.id} className="line" style={{ alignItems: 'flex-start' }}>
    <span className="grow"><b>{a.action.replace(/^lg_platform_/, '')}</b><span className="small muted"> · {a.admin}{a.target ? ` · ${a.target}` : ''}</span>
      {a.detail && <div className="mono small muted" style={{ wordBreak: 'break-all' }}>{JSON.stringify(a.detail)}</div>}</span><span className="small muted">{dmy(a.created_at)} {ago(a.created_at)}</span></div>)}</div>}</Card>;
}
