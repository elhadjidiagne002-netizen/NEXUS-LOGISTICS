import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { rpc } from '../lib/backend.js';
import { errText } from '../lib/errors.js';
import { formatF } from '../lib/algo.js';
import { Icon } from './icons.jsx';
export { Icon };

export { formatF };
export const kg = (g) => g == null ? '—' : `${(g / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} kg`;
export const hhmm = (d) => d ? new Date(d).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Dakar' }) : '—';
export const dmy = (d) => d ? new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Africa/Dakar' }) : '—';
export const ago = (d) => {
  if (!d) return '';
  const m = Math.round((Date.now() - new Date(d)) / 60000);
  return m < 1 ? 'à l\'instant' : m < 60 ? `il y a ${m} min` : m < 1440 ? `il y a ${Math.round(m / 60)} h` : `il y a ${Math.round(m / 1440)} j`;
};

/* ------------------------------------------------------------ navigation */
const NavCtx = createContext(null);
export function NavProvider({ children }) {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => { const f = () => setPath(location.pathname); addEventListener('popstate', f); return () => removeEventListener('popstate', f); }, []);
  const go = useCallback((p) => { if (p !== location.pathname) history.pushState(null, '', p + location.search); setPath(p); scrollTo(0, 0); }, []);
  return <NavCtx.Provider value={{ path, go }}>{children}</NavCtx.Provider>;
}
export const useNav = () => useContext(NavCtx);
export function Link({ to, children, ...p }) {
  const { go } = useNav();
  return <a href={to} onClick={(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); go(to); }} {...p}>{children}</a>;
}

/* ------------------------------------------------------------ messages */
const ToastCtx = createContext(() => {});
export function ToastProvider({ children }) {
  const [t, setT] = useState(null);
  const timer = useRef();
  const toast = useCallback((msg, kind = '') => {
    setT({ msg, kind }); clearTimeout(timer.current); timer.current = setTimeout(() => setT(null), kind === 'bad' ? 5000 : 2800);
  }, []);
  return <ToastCtx.Provider value={toast}>{children}{t && <div className={`toast ${t.kind}`} role="status">{t.msg}</div>}</ToastCtx.Provider>;
}
export const useToast = () => useContext(ToastCtx);

/* ------------------------------------------------------------ données */
export function useRpc(name, args = {}, { refresh = 0, skip = false } = {}) {
  const [state, set] = useState({ data: undefined, error: null, loading: !skip });
  const key = JSON.stringify(args);
  const load = useCallback(async (quiet) => {
    if (skip) return;
    if (!quiet) set((s) => ({ ...s, loading: true }));
    try { const data = await rpc(name, JSON.parse(key)); set({ data, error: null, loading: false }); }
    catch (e) { set((s) => ({ ...s, error: e, loading: false })); }
  }, [name, key, skip]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!refresh) return;
    const i = setInterval(() => { if (document.visibilityState === 'visible') load(true); }, refresh);
    return () => clearInterval(i);
  }, [load, refresh]);
  return { ...state, reload: () => load(true) };
}

/** Exécute une action et affiche succès / refus. Renvoie le résultat ou null. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn, { ok, silent } = {}) => {
    setBusy(true);
    try {
      const r = await fn();
      if (r && r.ok === false) { feedback('bad'); toast(errText(r.error), 'bad'); return r; }
      if (r?.queued) toast('Enregistré sur le téléphone : partira au retour du réseau', '');
      else if (ok) { feedback('ok'); toast(ok, 'ok'); }
      return r ?? { ok: true };
    } catch (e) { feedback('bad'); if (!silent) toast(errText(e), 'bad'); return { ok: false, error: e.code ?? e.message }; }
    finally { setBusy(false); }
  }, [toast]);
  return [run, busy];
}

/* ------------------------------------------------------------ retour sensoriel */
let ac;
export function feedback(kind) {
  try {
    ac ??= new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator(); const g = ac.createGain();
    o.type = kind === 'ok' ? 'sine' : 'square';
    o.frequency.value = kind === 'ok' ? 1320 : 220;
    g.gain.value = 0.08; o.connect(g); g.connect(ac.destination);
    o.start(); o.stop(ac.currentTime + (kind === 'ok' ? 0.09 : 0.35));
  } catch { /* son indisponible */ }
  try { navigator.vibrate?.(kind === 'ok' ? 40 : [80, 60, 80]); } catch { /* pas de vibreur */ }
}

/* ------------------------------------------------------------ petits composants */
export const Btn = ({ kind = '', size = '', block, className = '', ...p }) =>
  <button type="button" className={`btn ${kind} ${size} ${block ? 'block' : ''} ${className}`} {...p} />;
export const Badge = ({ kind = '', children }) => <span className={`badge ${kind}`}>{children}</span>;
export const Card = ({ kind = '', className = '', children, ...p }) => <div className={`card ${kind} ${className}`} {...p}>{children}</div>;
export const Stat = ({ label, value, kind = '', icon, c }) => <div className={`stat ${kind}`}>
  {icon && <span className="chip-ico" style={c ? { '--c': c } : undefined}><Icon name={icon} size={18} /></span>}<b>{value ?? '—'}</b><span>{label}</span></div>;
export const Empty = ({ children, icon = 'inbox' }) => <div className="empty"><span className="chip-ico"><Icon name={icon} size={22} /></span><div>{children}</div></div>;
export const Loading = () => <div className="stack"><div className="skeleton" /><div className="skeleton" /></div>;
export const ErrorBox = ({ error }) => error ? <div className="flash bad"><Icon name="alert" />{errText(error)}</div> : null;
export function Field({ label, children }) { return <label className="field"><span>{label}</span>{children}</label>; }
export function Tabs({ tabs, value, onChange }) {
  return <div className="tabs" role="tablist">{tabs.map(([k, l]) =>
    <button key={k} role="tab" aria-selected={value === k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>{l}</button>)}</div>;
}
export function PageHead({ title, back, sub, children }) {
  const { go } = useNav();
  return <><div className="page-head">{back && <button className="back" aria-label="Retour" onClick={() => go(back)}><Icon name="arrowLeft" size={18} /></button>}
    <h1>{title}</h1>{children}</div>{sub && <p className="page-sub">{sub}</p>}</>;
}
export function Gauge({ label, pct, detail }) {
  const p = Math.max(0, Math.min(100, pct ?? 0));
  return <div className={`gauge ${pct >= 100 ? 'full' : pct >= 90 ? 'warn' : ''}`}>
    <span className="small">{label}</span><div className="bar"><i style={{ width: `${p}%` }} /></div>
    <b className="small">{pct == null ? '—' : `${pct} %`}</b>{detail && <span className="small muted" style={{ gridColumn: '2 / 4' }}>{detail}</span>}</div>;
}
export function Modal({ title, onClose, children }) {
  useEffect(() => { const f = (e) => e.key === 'Escape' && onClose(); addEventListener('keydown', f); return () => removeEventListener('keydown', f); }, [onClose]);
  return <div className="modal-back" onClick={onClose}><div className="modal" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
    <div className="row between" style={{ marginBottom: 10 }}><h2 style={{ margin: 0 }}>{title}</h2><button className="back" aria-label="Fermer" onClick={onClose}><Icon name="x" size={18} /></button></div>
    {children}</div></div>;
}
export function Chips({ options, value, onChange, multi }) {
  const on = (k) => multi ? value.includes(k) : value === k;
  return <div className="chips">{options.map(([k, l]) =>
    <button type="button" key={k} className={`chip ${on(k) ? 'on' : ''}`}
      onClick={() => onChange(multi ? (on(k) ? value.filter((x) => x !== k) : [...value, k]) : k)}>{l}</button>)}</div>;
}

export const STATUS = {
  created: ['Créé', ''], packed: ['Emballé', 'todo'], staged: ['À quai', 'info'], loaded: ['Chargé', 'info'],
  out_for_delivery: ['En livraison', 'info'], delivered: ['Livré', 'ok'], failed: ['Échec', 'bad'],
  returned_hub: ['Retour au hub', 'todo'], returned_vendor: ['Rendu au vendeur', ''], lost: ['Perdu', 'bad'],
  damaged: ['Abîmé', 'bad'], cancelled: ['Annulé', ''],
  draft: ['Brouillon', ''], planned: ['Prévu', ''], loading: ['Chargement', 'todo'], sealed: ['Prêt à partir', 'info'],
  in_progress: ['En tournée', 'info'], completed: ['À clôturer', 'todo'], reconciled: ['Rapproché', 'ok'],
  pending: ['À faire', 'todo'], en_route: ['En route', 'info'], arrived: ['Sur place', 'info'], skipped: ['Retiré', ''],
  todo: ['À préparer', 'todo'], picking: ['En cours', 'info'], open: ['Ouvert', 'bad'], investigating: ['En cours', 'todo'],
  resolved: ['Résolu', 'ok'], closed: ['Clos', 'ok'], available: ['Disponible', 'ok'], on_trip: ['En voyage', 'info'],
  maintenance: ['Atelier', 'bad'], retired: ['Retiré', ''],
};
export const StatusBadge = ({ s }) => { const [l, k] = STATUS[s] ?? [s, '']; return <Badge kind={k}>{l}</Badge>; };
export const HANDLING = [['fragile', 'Fragile'], ['lourd', 'Lourd'], ['liquide', 'Liquide'], ['alimentaire', 'Alimentaire'],
  ['froid', 'Froid'], ['vivant', 'Vivant'], ['chimique', 'Entretien / chimique']];
