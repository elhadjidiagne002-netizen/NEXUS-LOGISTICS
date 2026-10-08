// Client HTTP de test : appelle directement le routeur avec une D1 imitée (node:sqlite), garde le cookie de session.
import { handle } from '../../server/app.js';
import { D1Mock } from './d1-mock.js';

export function makeEnv() {
  return { DB: new D1Mock() };
}

let n = 0;
export class Client {
  constructor(env, { ip, device } = {}) {
    this.env = env;
    this.cookie = null;
    this.ip = ip ?? `10.0.${Math.floor(++n / 250)}.${n % 250}`;
    this.device = device ?? null;
  }
  async req(method, path, body, headers = {}) {
    const h = { 'cf-connecting-ip': this.ip, 'user-agent': 'test', ...headers };
    if (body !== undefined && !h['content-type']) h['content-type'] = 'application/json';
    if (this.cookie) h.cookie = this.cookie;
    if (this.device) h['x-lg-device'] = this.device;
    const res = await handle(new Request('https://logistique.test' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), this.env);
    const set = res.headers.get('set-cookie');
    if (set) {
      const v = set.split(';')[0];
      this.cookie = v.endsWith('=') ? null : v;
    }
    return { status: res.status, data: await res.json() };
  }
  get(p) { return this.req('GET', p); }
  post(p, b = {}) { return this.req('POST', p, b); }

  /** Appel d'une fonction métier : renvoie le résultat, ou lève une erreur portant le code. */
  async rpc(name, args = {}) {
    const r = await this.post(`/api/rpc/${name}`, args);
    if (r.status !== 200) {
      const e = new Error(`${name} → ${r.status} ${r.data.error}`);
      e.status = r.status; e.code = r.data.error;
      throw e;
    }
    return r.data;
  }
  /** Code d'erreur d'un appel censé échouer (null s'il a réussi). */
  async rpcError(name, args = {}) {
    try { await this.rpc(name, args); return null; } catch (e) { return e.code; }
  }

  async register(email, { name = 'Awa', company = 'Express Dakar', kind = 'livraison' } = {}) {
    const r = await this.post('/api/auth/register', { email, password: 'motdepasse-solide', name, company: { name: company, kind } });
    if (r.status !== 201) throw new Error('inscription : ' + JSON.stringify(r.data));
    this.user = r.data.user;
    this.companyId = r.data.company_id;
    return r.data;
  }
  async login(email, password = 'motdepasse-solide') {
    const r = await this.post('/api/auth/login', { email, password });
    if (r.status === 200) { this.user = r.data.user; this.companyId = r.data.company_id; }
    return r;
  }
}

/** Invite une personne dans l'entreprise de `admin` et la fait accepter ; renvoie son client connecté. */
export async function invite(env, admin, email, { role = 'staff', staff = [], name = 'Fatou', device } = {}) {
  const inv = await admin.rpc('lg_invite_create', { p_role: role, p_staff_roles: staff, p_name: name });
  const c = new Client(env, { device });
  const r = await c.post(`/api/invites/${inv.token}/accept`, { email, password: 'motdepasse-solide', name });
  if (r.status !== 200) throw new Error('invitation : ' + JSON.stringify(r.data));
  c.user = r.data.user; c.companyId = r.data.company_id;
  return c;
}
