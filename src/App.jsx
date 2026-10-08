import React, { Suspense, lazy, useEffect, useState } from 'react';
import { backend, MODE, DEMO_USERS, onAuthChange, rpc, setSimulatedOffline, isOffline, DEVICE_ID, deviceLabel, RpcError } from './lib/backend.js';
import { subscribeQueue, flush, clearRejected } from './lib/offline.js';
import { errText } from './lib/errors.js';
import { NavProvider, ToastProvider, useNav, Btn, Card, Field, Loading, Link, Modal, ago } from './components/ui.jsx';
import { Icon } from './components/icons.jsx';

const Picking = lazy(() => import('./screens/Picking.jsx'));
const Dock = lazy(() => import('./screens/Dock.jsx'));
const Driver = lazy(() => import('./screens/Driver.jsx'));
const Control = lazy(() => import('./screens/Control.jsx'));
const Cash = lazy(() => import('./screens/Cash.jsx'));
const Billing = lazy(() => import('./screens/Billing.jsx'));
const Support = lazy(() => import('./screens/Support.jsx'));
const Vendor = lazy(() => import('./screens/Vendor.jsx'));
const Admin = lazy(() => import('./screens/Admin.jsx'));
const Analytics = lazy(() => import('./screens/Analytics.jsx'));
const Messages = lazy(() => import('./screens/Messages.jsx'));
const Warehouse = lazy(() => import('./screens/Warehouse.jsx'));
const Track = lazy(() => import('./screens/Track.jsx'));
const Platform = lazy(() => import('./screens/Platform.jsx'));

export const MeCtx = React.createContext(null);
export const useMe = () => React.useContext(MeCtx);
export const has = (m, ...roles) => m?.is_admin || (m?.roles ?? []).some((r) => roles.includes(r.role));
export const ROLE_FR = { picker: 'préparateur', dock_chief: 'chef de quai', dispatcher: 'répartiteur', cashier: 'caissier', accountant: 'comptable', support: 'service client' };

// Écrans par rôle (chapitre 03, acteurs et surfaces). « c » = couleur de l'icône.
const TILES = [
  { to: '/chauffeur', icon: 'bike', c: '#059669', title: 'Ma journée', short: 'Journée', sub: 'Arrêts, livraison, encaissement', group: 'Terrain', show: (m) => !!m.courier_id },
  { to: '/preparation', icon: 'box', c: '#0284c7', title: 'Préparation', short: 'Préparer', sub: 'Prélever, scanner, emballer, mettre à quai', group: 'Terrain', show: (m) => has(m, 'picker', 'dock_chief') || m.is_vendor },
  { to: '/entrepot', icon: 'layers', c: '#0891b2', title: 'Entrepôt', short: 'Entrepôt', sub: 'Emplacements, rangement, inventaire', group: 'Terrain', show: (m) => has(m, 'picker', 'dock_chief') },
  { to: '/quai', icon: 'truck', c: '#7c3aed', title: 'Quai', short: 'Quai', sub: 'Voyages, chargement, collectes, retours', group: 'Terrain', show: (m) => has(m, 'dock_chief', 'dispatcher') },
  { to: '/tour', icon: 'map', c: '#0d9488', title: 'Tour de contrôle', short: 'Contrôle', sub: 'Carte en direct, voyages, alertes', group: 'Pilotage', show: (m) => has(m, 'dispatcher', 'dock_chief', 'support') },
  { to: '/caisse', icon: 'cash', c: '#d97706', title: 'Caisse', short: 'Caisse', sub: 'Versements, écarts, clôtures', group: 'Argent', show: (m) => has(m, 'cashier') },
  { to: '/factures', icon: 'receipt', c: '#4f46e5', title: 'Factures', short: 'Factures', sub: 'Factures, avoirs, exports comptables', group: 'Argent', show: (m) => has(m, 'accountant', 'support') },
  { to: '/sav', icon: 'headset', c: '#db2777', title: 'Service client', short: 'Clients', sub: 'Confirmations, demandes, incidents, colis', group: 'Clients', show: (m) => has(m, 'support', 'dispatcher') },
  { to: '/messages', icon: 'message', c: '#16a34a', title: 'Messages clients', short: 'Messages', sub: 'Modèles WhatsApp, aperçu, file d\'envoi', group: 'Clients', show: (m) => has(m, 'support') },
  { to: '/vendeur', icon: 'store', c: '#ea580c', title: 'Espace vendeur', short: 'Vendeur', sub: 'Colis, fiches produit, délais', group: 'Vendeurs', show: (m) => m.is_vendor || m.is_admin },
  { to: '/analytique', icon: 'chart', c: '#2563eb', title: 'Pilotage', short: 'Pilotage', sub: 'Indicateurs, prévision, anomalies, classement', group: 'Pilotage', show: (m) => has(m, 'dispatcher', 'accountant', 'support') },
  { to: '/admin', icon: 'settings', c: '#475569', title: 'Administration', short: 'Admin', sub: 'Rôles, flotte, tarifs, réglages', group: 'Pilotage', show: (m) => m.is_admin || has(m, 'dock_chief') },
  { to: '/plateforme', icon: 'shield', c: '#0f172a', title: 'Plateforme', short: 'Plateforme', sub: 'Entreprises, abonnements, erreurs', group: 'Pilotage', show: (m) => !!m.is_platform_admin },
];

export default function App() {
  return <ToastProvider><NavProvider><Root /></NavProvider></ToastProvider>;
}

function Root() {
  const { path } = useNav();
  useTheme();
  if (path.startsWith('/suivi/')) return <Suspense fallback={<div className="app"><Loading /></div>}><Track token={path.split('/')[2]} /></Suspense>;
  if (MODE === 'api' && path.startsWith('/invitation/')) return <Invitation token={path.split('/')[2]} />;
  return <Authed />;
}

// Thème clair / sombre / système, mémorisé sur l'appareil
function useTheme() {
  useEffect(() => {
    try { const t = localStorage.getItem('lg-theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* stockage indisponible */ }
  }, []);
}
export function toggleTheme() {
  const cur = document.documentElement.dataset.theme
    ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('lg-theme', next); } catch { /* stockage indisponible */ }
}

function Authed() {
  const [phase, setPhase] = useState('boot');
  const [me, setMe] = useState(null);
  const [bootErr, setBootErr] = useState(null);
  const load = async () => {
    try {
      const b = await backend();
      const s = await b.session();
      if (!s) { setMe(null); setPhase('login'); return; }
      if (!(await devicePing(b))) return;
      setMe(await rpc('lg_me', {})); setPhase('ready');
    } catch (e) { setBootErr(e); setPhase('login'); }
  };
  // appareil bloqué (perdu, volé) ou session coupée à distance : déconnexion immédiate
  const devicePing = async (b) => {
    if (!DEVICE_ID) return true;
    const r = await rpc('lg_device_ping', { p_device: DEVICE_ID, p_label: deviceLabel() }).catch(() => ({ ok: true }));
    if (r.ok !== false) return true;
    setBootErr(new RpcError(r.error)); await b.signOut(); setMe(null); setPhase('login');
    return false;
  };
  useEffect(() => { load(); return onAuthChange(load); }, []);
  useEffect(() => {
    if (phase !== 'ready') return;
    const i = setInterval(async () => { if (!isOffline() && document.visibilityState === 'visible') devicePing(await backend()); }, 5 * 60000);
    return () => clearInterval(i);
  }, [phase]);
  if (phase === 'boot') return <Boot />;
  if (phase === 'login' || !me) return <Login error={bootErr} />;
  return <MeCtx.Provider value={me}><Shell me={me} /></MeCtx.Provider>;
}

function Boot() {
  const [step, setStep] = useState(null);
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const f = (e) => setStep(e.detail); addEventListener('lg-progress', f);
    const i = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => { removeEventListener('lg-progress', f); clearInterval(i); };
  }, []);
  return <div className="login-wrap" style={{ gridTemplateColumns: '1fr', placeItems: 'center' }}>
    <div className="center stack" style={{ alignItems: 'center', padding: 24 }}>
      <Logo size={64} /><h1 style={{ marginTop: 6 }}>NEXUS Logistics</h1>
      <p className="muted">{MODE === 'demo' ? (step ?? 'Ouverture de la base de démonstration…') : 'Connexion…'}</p>
      {MODE === 'demo' && step && <><div className="gauge" style={{ width: 280, gridTemplateColumns: '1fr' }}><div className="bar"><i style={{ width: `${Math.min(95, secs * 2.5)}%` }} /></div></div>
        <p className="small muted">Première ouverture seulement · {secs} s</p></>}
    </div>
  </div>;
}

export function Logo({ size = 32 }) {
  const id = React.useId().replace(/:/g, "");
  return <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
    <defs><linearGradient id={`g${id}`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#10b981" /><stop offset="1" stopColor="#047857" /></linearGradient></defs>
    <rect width="64" height="64" rx="16" fill={`url(#g${id})`} />
    <path d="M15 43V21l13 15V21M35 21l15 22M50 21 35 43" stroke="#fff" strokeWidth="5.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="51" cy="50" r="4.5" fill="#fbbf24" /></svg>;
}

const ROLE_ICON = { Administrateur: 'shield', Préparatrice: 'box', 'Chef de quai': 'truck', Répartitrice: 'map', Caissier: 'cash', Comptable: 'receipt',
  'Service client': 'headset', Vendeur: 'store' };
function Login({ error }) {
  const [email, setEmail] = useState(''); const [pw, setPw] = useState(''); const [err, setErr] = useState(error);
  useEffect(() => { if (error) setErr(error); }, [error]);
  const signIn = async (e) => {
    e?.preventDefault();
    try { await (await backend()).signIn(email, pw); } catch (x) { setErr(x); }
  };
  return <div className="login-wrap">
    <aside className="login-art">
      <div className="brand" style={{ color: '#fff' }}><Logo size={40} /><span>NEXUS Logistics<small style={{ color: '#a7f3d0' }}>{MODE === 'api' ? 'Pour toute entreprise qui livre' : 'NEXUS Market · Dakar'}</small></span></div>
      <div className="stack" style={{ gap: 22 }}>
        <h1>De la commande payée à la livraison encaissée.</h1>
        <p style={{ maxWidth: 480, color: '#a7f3d0', margin: 0 }}>Préparation scannée, chargement contrôlé, livraison prouvée, caisse rapprochée et facture automatique — sur le terrain, même sans réseau.</p>
        <div className="steps">
          <div><b>Préparé</b>scan de chaque article</div><div><b>Chargé</b>jauge poids, volume, colis</div>
          <div><b>Livré</b>code client, photo, position</div><div><b>Encaissé</b>caisse et facture le jour même</div>
        </div>
      </div>
      {MODE === 'api' && <Prices />}
      <small style={{ color: '#6ee7b7' }}>Conçu pour Dakar : adresses par repère, paiement à la livraison, Wave et Orange Money.</small>
    </aside>
    <main className="login-form">
      <div className="brand" style={{ marginBottom: 26 }}><Logo size={42} /><span>NEXUS Logistics<small>De la commande à l'encaissement</small></span></div>
      {MODE === 'demo' ? <>
        <h1>Démonstration</h1>
        <p className="muted" style={{ marginTop: 0 }}>Une base complète tourne sur cet appareil, avec une journée fictive déjà commencée. Choisissez qui vous êtes :</p>
        {err && <div className="flash bad" style={{ marginBottom: 12 }}>{errText(err)}</div>}
        <div className="grid cols-2" style={{ gap: 10 }}>{DEMO_USERS.map((u) =>
          <button key={u.id} className="role-card" onClick={async () => (await backend()).signIn(u.id)}>
            <span className="chip-ico" style={{ width: 40, height: 40 }}><Icon name={ROLE_ICON[u.label] ?? (u.label.startsWith('Chauffeur') ? 'bike' : 'user')} /></span>
            <span><b>{u.name}</b><span>{u.label}</span></span></button>)}</div>
      </> : MODE === 'api' ? <ApiAuth initialError={err} /> : <form className="stack" onSubmit={signIn}>
        <h1>Connexion</h1><p className="muted" style={{ marginTop: -6 }}>Votre compte NEXUS Market. Les rôles logistiques sont attribués par l'administrateur.</p>
        <Field label="E-mail"><input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
        <Field label="Mot de passe"><input className="input" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} required /></Field>
        {err && <div className="flash bad">{errText(err)}</div>}
        <Btn kind="primary" type="submit" size="xl">Se connecter</Btn></form>}
      {MODE === 'api' ? <PublicFooter /> : <SuiteNexus where="connexion" />}
    </main>
  </div>;
}

// Formules (page d'accueil publique) : quotas et prix réglés par la plateforme (GET /api/plans)
function Prices() {
  const [p, setP] = useState(null);
  useEffect(() => { fetch('/api/plans').then((r) => r.json()).then(setP).catch(() => {}); }, []);
  if (!p?.free) return null;
  const lim = (v, what) => (v == null ? `${what} sans limite` : `${v} ${what}`);
  return <div className="grid cols-2" style={{ gap: 12 }}>{[p.free, p.pro].map((x) => <div key={x.label} style={{ border: '1px solid rgb(255 255 255 / 25%)', borderRadius: 14, padding: 14 }}>
    <b style={{ fontSize: '1.1rem' }}>{x.label}</b><div style={{ fontSize: '1.5rem', fontWeight: 800 }}>{x.price_fcfa ? `${x.price_fcfa.toLocaleString('fr-FR')} F / mois` : 'Gratuit'}</div>
    <div className="small" style={{ color: '#a7f3d0' }}>{lim(x.orders_month, 'commandes par mois')} · {lim(x.couriers, 'chauffeurs')} · {lim(x.hubs, 'lieux')}</div></div>)}</div>;
}
function PublicFooter() {
  return <p className="small muted" style={{ marginTop: 28 }}><a href="/mentions-legales.html">Mentions légales</a> · <a href="/cgu.html">Conditions d'utilisation</a> ·{' '}
    <a href="/confidentialite.html">Confidentialité</a> · Paiement Wave ou Orange Money</p>;
}

// Version complète (Cloudflare) : connexion ou création d'une entreprise de livraison
const COMPANY_KINDS = [['livraison', 'Société de livraison'], ['boutique', 'Boutique qui livre ses clients'], ['vendeur', 'Vendeur en ligne'], ['autre', 'Autre']];
function ApiAuth({ initialError }) {
  const [mode, setMode] = useState('login');
  const [f, setF] = useState({ email: '', password: '', name: '', phone: '', company: '', kind: 'livraison', city: 'Dakar' });
  const [err, setErr] = useState(initialError); const [busy, setBusy] = useState(false);
  const s = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const b = await backend();
      if (mode === 'login') await b.signIn(f.email, f.password);
      else await b.register({ email: f.email, password: f.password, name: f.name, phone: f.phone, company: { name: f.company, kind: f.kind, city: f.city, phone: f.phone } });
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return <form className="stack" onSubmit={submit}>
    <h1>{mode === 'login' ? 'Connexion' : 'Créer mon entreprise'}</h1>
    <p className="muted" style={{ marginTop: -6 }}>{mode === 'login' ? 'Votre compte NEXUS Logistics. Une invitation reçue ? Ouvrez son lien.'
      : 'Gratuit pour démarrer. Vous invitez ensuite votre équipe et vos chauffeurs par un lien WhatsApp.'}</p>
    {mode === 'register' && <>
      <Field label="Nom de l'entreprise"><input className="input" value={f.company} onChange={s('company')} required maxLength={120} /></Field>
      <Field label="Activité"><select className="input" value={f.kind} onChange={s('kind')}>{COMPANY_KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
      <div className="grid cols-2" style={{ gap: 10 }}>
        <Field label="Ville"><input className="input" value={f.city} onChange={s('city')} maxLength={60} /></Field>
        <Field label="Téléphone"><input className="input" type="tel" value={f.phone} onChange={s('phone')} placeholder="77 000 00 00" /></Field></div>
      <Field label="Votre nom"><input className="input" autoComplete="name" value={f.name} onChange={s('name')} required maxLength={80} /></Field></>}
    <Field label="E-mail"><input className="input" type="email" autoComplete="username" value={f.email} onChange={s('email')} required /></Field>
    <Field label="Mot de passe"><input className="input" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={f.password} onChange={s('password')} required minLength={mode === 'login' ? undefined : 8} /></Field>
    {err && <div className="flash bad">{errText(err)}</div>}
    <Btn kind="primary" type="submit" size="xl" disabled={busy}>{mode === 'login' ? 'Se connecter' : "Créer l'entreprise"}</Btn>
    <Btn kind="ghost" type="button" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setErr(null); }}>
      {mode === 'login' ? 'Pas encore de compte ? Créer mon entreprise' : "J'ai déjà un compte : me connecter"}</Btn>
  </form>;
}

// Lien d'invitation (/invitation/<jeton>) : rejoindre une entreprise, avec un compte neuf ou existant
const INVITE_ROLE = { admin: 'administrateur', staff: "membre de l'équipe", vendor: 'vendeur', courier: 'chauffeur-livreur' };
function Invitation({ token }) {
  const { go } = useNav();
  const [inv, setInv] = useState(null); const [err, setErr] = useState(null); const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ email: '', password: '', name: '', phone: '' });
  useEffect(() => {
    backend().then((b) => b.invitation(token)).then((r) => { setInv(r); setF((x) => ({ ...x, name: r.name ?? '' })); }).catch(setErr);
  }, [token]);
  const s = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return <div className="login-wrap" style={{ gridTemplateColumns: '1fr', placeItems: 'center' }}>
    <main className="login-form" style={{ maxWidth: 460 }}>
      <div className="brand" style={{ marginBottom: 20 }}><Logo size={42} /><span>NEXUS Logistics<small>Invitation</small></span></div>
      {!inv ? (err ? <div className="flash bad">{errText(err)}</div> : <Loading />) : <form className="stack" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr(null);
        try { await (await backend()).acceptInvite(token, f); go('/'); } catch (x) { setErr(x); } finally { setBusy(false); }
      }}>
        <h1>Rejoindre {inv.company}</h1>
        <p className="muted" style={{ marginTop: -6 }}>Vous êtes invité comme <b>{INVITE_ROLE[inv.role]}</b>{inv.staff_roles?.length ? ` (${inv.staff_roles.map((r) => ROLE_FR[r]).join(', ')})` : ''}.
          Déjà un compte NEXUS Logistics ? Saisissez son e-mail et son mot de passe.</p>
        <Field label="Votre nom"><input className="input" value={f.name} onChange={s('name')} maxLength={80} /></Field>
        <Field label="Téléphone"><input className="input" type="tel" value={f.phone} onChange={s('phone')} /></Field>
        <Field label="E-mail"><input className="input" type="email" autoComplete="username" value={f.email} onChange={s('email')} required /></Field>
        <Field label="Mot de passe"><input className="input" type="password" autoComplete="new-password" value={f.password} onChange={s('password')} required /></Field>
        {err && <div className="flash bad">{errText(err)}</div>}
        <Btn kind="primary" type="submit" size="xl" disabled={busy}>Rejoindre</Btn></form>}
    </main></div>;
}

function Shell({ me }) {
  const { path } = useNav();
  const seg = path.split('/').filter(Boolean);
  const screens = {
    preparation: <Picking taskId={seg[1]} sub={seg[2]} />, entrepot: <Warehouse />, quai: <Dock sub={seg[1]} id={seg[2]} />, chauffeur: <Driver stopId={seg[2]} />,
    tour: <Control />, caisse: <Cash />, factures: <Billing invoiceId={seg[1]} />, sav: <Support />, colis: <Support code={seg[1]} />,
    vendeur: <Vendor />, admin: <Admin />, analytique: <Analytics />, messages: <Messages />, plateforme: <Platform />,
  };
  const tiles = TILES.filter((t) => t.show(me));
  const content = seg[0] ? screens[seg[0]] ?? <Home me={me} tiles={tiles} /> : tiles.length === 1 ? screens[tiles[0].to.slice(1)] : <Home me={me} tiles={tiles} />;
  const tabs = tiles.length > 1 ? [{ to: '/', icon: 'home', short: 'Accueil' }, ...tiles.slice(0, 4)] : [];
  return <div className={`shell ${tabs.length ? 'has-tabbar' : ''}`}>
    <Sidebar me={me} tiles={tiles} path={path} />
    <div style={{ minWidth: 0 }}>
      <TopBar me={me} />
      <main className="app"><Suspense fallback={<div style={{ paddingTop: 20 }}><Loading /></div>}>{content}</Suspense></main>
    </div>
    {tabs.length > 0 && <nav className="tabbar" aria-label="Navigation">{tabs.map((t) =>
      <Link key={t.to} to={t.to} className={(t.to === '/' ? path === '/' : path.startsWith(t.to)) ? 'on' : ''}><Icon name={t.icon} size={22} /><span>{t.short}</span></Link>)}</nav>}
  </div>;
}

const initials = (n) => (n ?? '?').split(/\s+/).map((x) => x[0]).slice(0, 2).join('').toUpperCase();
function Sidebar({ me, tiles, path }) {
  const groups = [...new Set(tiles.map((t) => t.group))];
  return <aside className="sidebar" aria-label="Menu">
    <Link to="/" className="brand"><Logo size={34} /><span>NEXUS Logistics<small style={{ color: '#64748b' }}>{MODE === 'demo' ? 'Démonstration' : me.company?.name ?? 'NEXUS Market'}</small></span></Link>
    <Link to="/" className={`side-link ${path === '/' ? 'on' : ''}`}><Icon name="home" />Accueil</Link>
    {groups.map((g) => <React.Fragment key={g}><div className="side-label">{g}</div>
      {tiles.filter((t) => t.group === g).map((t) => <Link key={t.to} to={t.to} className={`side-link ${path.startsWith(t.to) ? 'on' : ''}`}>
        <Icon name={t.icon} />{t.title}</Link>)}</React.Fragment>)}
    <div className="side-foot"><span className="avatar">{initials(me.name)}</span>
      <div className="who"><b>{me.name}</b><span>{me.is_admin ? 'Administrateur' : (me.roles ?? []).map((r) => ROLE_FR[r.role]).join(', ') || (me.courier_id ? 'Chauffeur-livreur' : me.is_vendor ? 'Vendeur' : '')}</span></div>
      <button className="icon-btn" title="Thème clair / sombre" aria-label="Changer de thème" onClick={toggleTheme}><Icon name="moon" size={18} /></button>
    </div>
  </aside>;
}

function Home({ me, tiles }) {
  const hour = Number(new Date().toLocaleString('fr-FR', { hour: 'numeric', hour12: false, timeZone: 'Africa/Dakar' }));
  return <>
    <div className="hero" style={{ marginTop: 22 }}>
      <div className="small" style={{ color: '#6ee7b7', fontWeight: 600 }}>{new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Africa/Dakar' })}</div>
      <h1 style={{ margin: '4px 0 6px', fontSize: '1.9rem' }}>{hour < 13 ? 'Bonjour' : hour < 18 ? 'Bon après-midi' : 'Bonsoir'} {me.name?.split(' ')[0]}</h1>
      <p className="muted" style={{ margin: 0, maxWidth: 560 }}>{tiles.length ? 'Que voulez-vous faire ?' : 'Aucun rôle logistique sur ce compte pour l\'instant.'}</p>
    </div>
    {tiles.length === 0 ? <Card style={{ marginTop: 16 }}><h2>Aucun rôle logistique</h2>
      <p className="muted">Ce compte n'a pas encore de rôle (préparateur, chef de quai, répartiteur, caissier…). Demandez à l'administrateur.</p></Card>
      : <div className="grid tiles" style={{ marginTop: 18 }}>{tiles.map((t) =>
        <Link key={t.to} to={t.to} className="tile">
          <span className="chip-ico" style={{ '--c': t.c }}><Icon name={t.icon} size={22} /></span>
          <b>{t.title}</b><span className="muted small">{t.sub}</span>
          <span className="go">Ouvrir <Icon name="arrowRight" size={16} /></span></Link>)}</div>}
    <SuiteNexus where="accueil" />
  </>;
}

// Pont vers les autres outils gratuits de la suite (même convention ?src=<site>-<endroit> que
// Devizo, My shop et CV en ligne, pour mesurer d'où viennent les visites).
const SUITE = [
  ['https://nexusmarket.sn/', 'NEXUS Market', 'vendre et être trouvé'],
  ['https://myshop.nexusmarket.sn/', 'My shop', 'caisse et stock'],
  ['https://devis.nexusmarket.sn/', 'Devizo', 'devis et factures'],
  ['https://cv.nexusmarket.sn/', 'CV en ligne', 'recruter, se présenter'],
];
export function SuiteNexus({ where }) {
  return <p className="small muted suite-nexus" style={{ marginTop: 28 }}>La suite NEXUS (gratuit) :{' '}
    {SUITE.map(([url, name, what], i) => <React.Fragment key={url}>{i > 0 && ' · '}
      <a href={`${url}?src=logistics-${where}`} target="_blank" rel="noopener">{name}</a> ({what})</React.Fragment>)}</p>;
}

function TopBar({ me }) {
  const [q, setQ] = useState({ pending: 0, uploads: 0, rejected: [] });
  const [off, setOff] = useState(isOffline());
  const [open, setOpen] = useState(false);
  useEffect(() => subscribeQueue(setQ), []);
  useEffect(() => {
    const f = () => setOff(isOffline());
    addEventListener('online', f); addEventListener('offline', f);
    return () => { removeEventListener('online', f); removeEventListener('offline', f); };
  }, []);
  const waiting = q.pending + q.uploads;
  return <header className="topbar">
    <Link to="/" className="brand"><Logo size={30} /><span className="hide-sm">NEXUS Logistics</span></Link>
    {MODE === 'demo' && <span className="badge info">Démo</span>}
    <span className="spacer" />
    <button className={`netpill ${off ? 'off' : waiting ? 'queue' : ''}`} onClick={() => setOpen(true)} aria-label="État du réseau">
      <Icon name={off ? 'wifioff' : waiting ? 'refresh' : 'wifi'} size={15} />
      {off ? 'Hors ligne' : waiting ? `${waiting} en attente` : 'En ligne'}{q.rejected.length ? ` · ${q.rejected.length} refus` : ''}
    </button>
    <button className="icon-btn" aria-label="Changer de thème" title="Thème clair / sombre" onClick={toggleTheme}><Icon name="sun" size={18} /></button>
    <button className="icon-btn" aria-label="Compte et synchronisation" onClick={() => setOpen(true)}><span className="avatar" style={{ width: 32, height: 32, fontSize: '.75rem' }}>{initials(me.name)}</span></button>
    {open && <Modal title="Réseau et synchronisation" onClose={() => setOpen(false)}>
      <div className="stack">
        <div className={`flash ${off ? 'bad' : 'ok'}`}><Icon name={off ? 'wifioff' : 'wifi'} />{off ? 'Pas de réseau : vos actions sont gardées sur ce téléphone.' : 'Connecté.'}</div>
        <p style={{ margin: 0 }}><b>{q.pending}</b> action(s) et <b>{q.uploads}</b> photo(s) en attente d'envoi. Les photos partent en dernier.</p>
        {q.rejected.length > 0 && <div className="card bad flat"><b>Refusé par le serveur au retour du réseau</b>
          <ul>{q.rejected.map((r, i) => <li key={i}>{r.label} — {errText(r.error)} <span className="muted small">({ago(r.at)})</span></li>)}</ul>
          <Btn size="sm" onClick={clearRejected}>J'ai compris</Btn></div>}
        <div className="row"><Btn kind="primary" onClick={() => flush()} disabled={off}><Icon name="refresh" size={18} />Synchroniser maintenant</Btn></div>
        {MODE === 'demo' && <Card kind="flat"><b>Outils de démonstration</b>
          <label className="check"><input type="checkbox" checked={off} onChange={(e) => { setSimulatedOffline(e.target.checked); setOff(e.target.checked); if (!e.target.checked) flush(); }} /> Simuler une coupure réseau</label>
          <div className="row"><Btn onClick={async () => (await backend()).signOut()}><Icon name="users" size={18} />Changer de rôle</Btn>
            <Btn kind="bad" onClick={async () => { if (confirm('Effacer la base de démonstration et recommencer la journée ?')) (await backend()).reset(); }}>Réinitialiser la démo</Btn></div></Card>}
        {MODE !== 'demo' && <Btn onClick={async () => (await backend()).signOut()}><Icon name="logout" size={18} />Se déconnecter</Btn>}
      </div></Modal>}
  </header>;
}
