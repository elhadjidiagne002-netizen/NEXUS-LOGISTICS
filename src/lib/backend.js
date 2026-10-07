// Accès aux données. Deux modes, une seule interface : rpc(nom, arguments).
// - « supabase » : la vraie base (VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY).
// - « demo »     : Postgres complet DANS le navigateur (PGlite), qui exécute exactement
//                  les mêmes migrations SQL que la prod, avec un jeu de données fictif.
//                  Rien ne sort du téléphone ; utile pour former les équipes.
// Les applications n'écrivent jamais dans une table : tout passe par une fonction.

const SB_URL = import.meta.env.VITE_SUPABASE_URL;
const SB_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const MODE = SB_URL && SB_KEY && !new URLSearchParams(location.search).has('demo') ? 'supabase' : 'demo';

export class RpcError extends Error {
  constructor(code, detail) { super(code); this.code = code; this.detail = detail; }
}
export class NetworkError extends Error {}

let impl;
const listeners = new Set();
export const onAuthChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach((fn) => fn());

// Simulation de coupure réseau (mode démo) pour montrer la file hors ligne
let simulatedOffline = false;
export const setSimulatedOffline = (v) => { simulatedOffline = v; window.dispatchEvent(new Event(v ? 'offline' : 'online')); };
export const isOffline = () => simulatedOffline || !navigator.onLine;

/* ------------------------------------------------------------------ SUPABASE */
async function supabaseImpl() {
  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
  sb.auth.onAuthStateChange(() => emit());
  return {
    async rpc(name, args = {}) {
      if (isOffline()) throw new NetworkError('offline');
      const { data, error } = await sb.rpc(name, args);
      if (error) {
        if (/fetch|network|Failed to fetch|Load failed/i.test(error.message)) throw new NetworkError(error.message);
        throw new RpcError(error.message.replace(/^.*?:\s*/, ''), error.details);
      }
      return data;
    },
    async session() { return (await sb.auth.getSession()).data.session; },
    async signIn(email, password) {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw new RpcError('login_failed', error.message);
    },
    async signOut() { await sb.auth.signOut(); },
    async upload(path, blob) {
      if (isOffline()) throw new NetworkError('offline');
      const { error } = await sb.storage.from('lg-proofs').upload(path, blob, { upsert: false, contentType: blob.type });
      if (error && !/exists/i.test(error.message)) {
        if (/fetch|network|Failed to fetch|Load failed/i.test(error.message)) throw new NetworkError(error.message);
        throw new RpcError('upload_failed', error.message);
      }
      return path;
    },
    async signedUrl(path) {
      const { data } = await sb.storage.from('lg-proofs').createSignedUrl(path, 600);
      return data?.signedUrl ?? null;
    },
    channel(table, cb) {
      const ch = sb.channel('lg-' + table).on('postgres_changes', { event: '*', schema: 'public', table }, cb).subscribe();
      return () => sb.removeChannel(ch);
    },
  };
}

/* ---------------------------------------------------------------------- DÉMO */
export const DEMO_USERS = [
  { id: '00000000-0000-4000-a000-000000000001', name: 'Mo Admin', label: 'Administrateur' },
  { id: '00000000-0000-4000-a000-000000000002', name: 'Fatou', label: 'Préparatrice' },
  { id: '00000000-0000-4000-a000-000000000003', name: 'Ousmane', label: 'Chef de quai' },
  { id: '00000000-0000-4000-a000-000000000004', name: 'Aïssatou', label: 'Répartitrice' },
  { id: '00000000-0000-4000-a000-000000000006', name: 'Moussa', label: 'Chauffeur (fourgonnette)' },
  { id: '00000000-0000-4000-a000-000000000009', name: 'Ibrahima', label: 'Chauffeur (moto)' },
  { id: '00000000-0000-4000-a000-000000000011', name: 'Cheikh', label: 'Chauffeur (tricycle)' },
  { id: '00000000-0000-4000-a000-000000000005', name: 'Babacar', label: 'Caissier' },
  { id: '00000000-0000-4000-a000-000000000008', name: 'Khady', label: 'Comptable' },
  { id: '00000000-0000-4000-a000-000000000010', name: 'Coumba', label: 'Service client' },
  { id: '00000000-0000-4000-a000-000000000007', name: 'Boutique Ndèye', label: 'Vendeur' },
];
const DEMO_DB = 'idb://nexus-logistics-demo-v1';

async function demoImpl() {
  const [{ PGlite }, { pgcrypto }, sql] = await Promise.all([
    import('@electric-sql/pglite'), import('@electric-sql/pglite/contrib/pgcrypto'), import('../demo/sql.js')]);
  // écriture différée sur IndexedDB : sinon chaque requête attend le disque (scénario : des centaines)
  const db = new PGlite(DEMO_DB, { extensions: { pgcrypto }, relaxedDurability: true });
  await db.waitReady;
  const state = await db.query(`select to_regclass('public.lg_trips') is not null as tables,
      to_regclass('public.app_config') is not null
        and exists (select 1 from public.app_config where key = 'lg_demo_ready' and value->>'v' = $1) as ready`, [sql.VERSION])
    .then((r) => r.rows[0]).catch(() => ({ tables: false, ready: false }));
  if (state.tables && !state.ready) {
    // installation interrompue (onglet fermé…) ou schéma modifié depuis : on efface et on recommence
    await db.close();
    await new Promise((r) => { const q = indexedDB.deleteDatabase('/pglite/nexus-logistics-demo-v1'); q.onsuccess = q.onerror = q.onblocked = r; });
    location.reload();
    return new Promise(() => {});
  }
  if (!state.ready) {
    progress('Création des tables et des fonctions…');
    await sql.install(db);
    progress("Simulation d'une journée : commandes, préparation, voyages…");
    const { runScenario } = await import('../demo/scenario.js');
    await runScenario(rpcOn(db), (q, p) => db.query(q, p));
    await db.query("insert into public.app_config (key, value) values ('lg_demo_ready', jsonb_build_object('at', now(), 'v', $1::text))", [sql.VERSION]);
  }
  let uid = localStorage.getItem('lg-demo-uid');
  progress(null);
  const files = new Map(); // photos et signatures de démo : restent dans la mémoire de l'onglet
  return {
    async rpc(name, args = {}) {
      if (isOffline()) throw new NetworkError('offline');
      return rpcOn(db, () => uid)(name, args);
    },
    async session() { return uid ? { user: { id: uid } } : null; },
    async signIn(id) { uid = id; localStorage.setItem('lg-demo-uid', id); emit(); },
    async signOut() { uid = null; localStorage.removeItem('lg-demo-uid'); emit(); },
    async upload(path, blob) {
      if (isOffline()) throw new NetworkError('offline');
      files.set(path, URL.createObjectURL(blob)); return path;
    },
    async signedUrl(path) { return files.get(path) ?? null; },
    channel() { return () => {}; },
    // démo uniquement : dernier code de livraison « envoyé » au client (lu dans la file de messages)
    async peekOtp(orderId) {
      const { rows } = await db.query(`select vars->>'code' c from public.notification_outbox where event_key = 'lg_out_for_delivery'
        and vars->>'commande' = upper(left($1::text, 8)) order by created_at desc limit 1`, [orderId]);
      return rows[0]?.c ?? null;
    },
    async reset() {
      await db.close();
      indexedDB.deleteDatabase('/pglite/nexus-logistics-demo-v1');
      localStorage.removeItem('lg-demo-uid');
      location.reload();
    },
  };
}

function rpcOn(db, getUid = () => null) {
  return async (name, args = {}, asUid) => {
    const keys = Object.keys(args).filter((k) => args[k] !== undefined);
    const vals = keys.map((k) => {
      const v = args[k];
      if (v === null || v instanceof Date) return v;
      if (Array.isArray(v)) return v.some((x) => x && typeof x === 'object') ? JSON.stringify(v) : v;
      return typeof v === 'object' ? JSON.stringify(v) : v;
    });
    const sql = `select public.${name.replace(/[^a-z_]/g, '')}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
    try {
      await db.query("select set_config('test.uid', $1, false)", [asUid ?? getUid() ?? '']);
      const { rows } = await db.query(sql, vals);
      return rows[0].r;
    } catch (e) {
      throw new RpcError(String(e.message), e.detail);
    }
  };
}

/* ------------------------------------------------------------------ PUBLIC */
export function progress(msg) { window.dispatchEvent(new CustomEvent('lg-progress', { detail: msg })); }

export async function backend() {
  if (!impl) impl = MODE === 'supabase' ? supabaseImpl() : demoImpl();
  return impl;
}
export const rpc = async (name, args) => (await backend()).rpc(name, args);
