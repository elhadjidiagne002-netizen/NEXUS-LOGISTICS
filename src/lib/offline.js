// Travail sans réseau (chapitre 06) : chaque action de terrain reçoit un identifiant
// unique (p_event), est tentée tout de suite, sinon gardée sur le téléphone et rejouée
// au retour du réseau. Le serveur reconnaît l'identifiant : jamais de doublon.
// Les photos attendent dans leur propre file et partent EN DERNIER.
import { backend, NetworkError, RpcError, isOffline } from './backend.js';

const DB = 'nexus-logistics-offline';
const listeners = new Set();
let state = { pending: 0, uploads: 0, rejected: [], syncing: false };

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('actions', { keyPath: 'id' });
      r.result.createObjectStore('uploads', { keyPath: 'path' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function store(name, mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode);
    const req = fn(tx.objectStore(name));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}
const all = (name) => store(name, 'readonly', (s) => s.getAll());

async function refresh() {
  const [a, u] = await Promise.all([all('actions'), all('uploads')]).catch(() => [[], []]);
  state = { ...state, pending: a.length, uploads: u.length };
  listeners.forEach((fn) => fn(state));
}
export const subscribeQueue = (fn) => { listeners.add(fn); fn(state); refresh(); return () => listeners.delete(fn); };
export const queueState = () => state;

/**
 * Exécute une action de terrain. Renvoie le résultat du serveur, ou { queued: true }
 * si le réseau manque (l'action partira seule plus tard).
 */
export async function act(fn, args, label = fn) {
  const id = args.p_event ?? crypto.randomUUID();
  const full = { ...args, p_event: id };
  const b = await backend();
  // l'ordre compte : si des actions attendent déjà, la nouvelle passe derrière elles
  if (state.pending === 0 && !isOffline()) {
    try { return await b.rpc(fn, full); }
    catch (e) { if (!(e instanceof NetworkError)) throw e; }
  }
  await store('actions', 'readwrite', (s) => s.put({ id, fn, args: full, label, at: Date.now() }));
  await refresh();
  return { ok: true, queued: true, p_event: id };
}

/** Photo ou signature : chemin décidé tout de suite, envoi du fichier quand le réseau le permet. */
export async function queueUpload(path, blob) {
  const b = await backend();
  if (!isOffline()) {
    try { await b.upload(path, blob); return path; } catch (e) { if (!(e instanceof NetworkError)) throw e; }
  }
  await store('uploads', 'readwrite', (s) => s.put({ path, blob, at: Date.now() }));
  await refresh();
  return path;
}

export async function flush() {
  if (state.syncing || isOffline()) return;
  state = { ...state, syncing: true }; listeners.forEach((fn) => fn(state));
  const b = await backend();
  try {
    const actions = (await all('actions')).sort((x, y) => x.at - y.at);
    for (const a of actions) {
      try {
        const r = await b.rpc(a.fn, a.args);
        if (r && r.ok === false && !r.replayed) state.rejected = [...state.rejected, { label: a.label, error: r.error, at: a.at }];
      } catch (e) {
        if (e instanceof NetworkError) break;
        // le serveur fait foi : refus affiché, action retirée de la file
        state.rejected = [...state.rejected, { label: a.label, error: e instanceof RpcError ? e.code : String(e), at: a.at }];
      }
      await store('actions', 'readwrite', (s) => s.delete(a.id));
    }
    if ((await all('actions')).length === 0) {
      for (const u of await all('uploads')) {
        try { await b.upload(u.path, u.blob); await store('uploads', 'readwrite', (s) => s.delete(u.path)); }
        catch (e) {
          if (e instanceof NetworkError) break;
          // refus définitif (droits, taille) : signalé, retiré de la file pour ne pas bloquer les suivants
          state.rejected = [...state.rejected, { label: `Envoi de ${u.path.split('/').pop()}`, error: e.code ?? String(e), at: u.at }];
          await store('uploads', 'readwrite', (s) => s.delete(u.path));
        }
      }
    }
  } finally {
    state = { ...state, syncing: false };
    await refresh();
  }
}
export const clearRejected = () => { state = { ...state, rejected: [] }; listeners.forEach((fn) => fn(state)); };

window.addEventListener('online', () => flush());
setInterval(() => flush(), 20000);
