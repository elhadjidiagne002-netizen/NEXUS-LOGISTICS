// Accès aux données : une seule interface, rpc(nom, arguments) → POST /api/rpc/<nom> sur le serveur
// Cloudflare (Pages Functions + D1, multi-entreprises). Les écrans n'écrivent jamais dans une table :
// tout passe par une fonction du serveur (server/rpc/*.js), qui contrôle l'entreprise, le rôle et l'appareil.

export class RpcError extends Error {
  // text : phrase en français renvoyée par le serveur (mode api), utilisée si le code n'est pas traduit
  constructor(code, detail, text) { super(code); this.code = code; this.detail = detail; this.text = text; }
}
export class NetworkError extends Error {}

// Identifiant de l'appareil, créé une fois : sert au blocage d'un téléphone perdu (lg_devices)
export const DEVICE_ID = (() => {
  try {
    let id = localStorage.getItem('lg-device');
    if (!id) { id = crypto.randomUUID(); localStorage.setItem('lg-device', id); }
    return id;
  } catch { return null; }
})();
export const deviceLabel = () => {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'Appareil';
  return `${os} · ${/Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'navigateur'}`;
};

let impl;
const listeners = new Set();
export const onAuthChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach((fn) => fn());

export const isOffline = () => !navigator.onLine;

/* ----------------------------------------------------------- API CLOUDFLARE */
async function apiImpl() {
  const headers = { 'content-type': 'application/json', ...(DEVICE_ID ? { 'x-lg-device': DEVICE_ID } : {}) };
  async function call(method, path, body) {
    if (isOffline()) throw new NetworkError('offline');
    let res;
    try {
      res = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) { throw new NetworkError(e.message); }
    let data = null;
    try { data = await res.json(); } catch { /* corps vide ou page d'erreur */ }
    if (!res.ok) {
      if (res.status >= 500 && !data) throw new NetworkError(`http_${res.status}`);
      throw new RpcError(data?.error ?? `http_${res.status}`, data?.detail, data?.message);
    }
    return data;
  }
  let current = (await call('GET', '/api/auth/session')).session;
  const set = (s) => { current = s; emit(); return s; };
  return {
    rpc: (name, args = {}) => call('POST', `/api/rpc/${name}`, args),
    async session() { return current; },
    async signIn(email, password) { return set(await call('POST', '/api/auth/login', { email, password })); },
    async register(form) { return set(await call('POST', '/api/auth/register', form)); },
    async invitation(token) { return call('GET', `/api/invites/${token}`); },
    async acceptInvite(token, form) { return set(await call('POST', `/api/invites/${token}/accept`, form)); },
    async switchCompany(id) { return set(await call('POST', '/api/auth/company', { company_id: id })); },
    async signOut() { await call('POST', '/api/auth/logout').catch(() => {}); set(null); },
    // photos et signatures de preuve : PUT /api/files/<voyage>/… (R2 ou repli D1), lues par la session
    async upload(path, blob) {
      if (isOffline()) throw new NetworkError('offline');
      let res;
      try {
        res = await fetch(`/api/files/${path}`, { method: 'PUT', credentials: 'same-origin', body: blob,
          headers: { 'content-type': blob.type || 'image/jpeg', ...(DEVICE_ID ? { 'x-lg-device': DEVICE_ID } : {}) } });
      } catch (e) { throw new NetworkError(e.message); }
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        if (res.status >= 500 && !data) throw new NetworkError(`http_${res.status}`);
        throw new RpcError(data?.error ?? 'upload_failed', data?.detail, data?.message);
      }
      return path;
    },
    async signedUrl(path) { return path ? `/api/files/${path}` : null; },
    channel() { return () => {}; },
  };
}

export async function backend() {
  if (!impl) impl = apiImpl();
  return impl;
}
export const rpc = async (name, args) => (await backend()).rpc(name, args);
