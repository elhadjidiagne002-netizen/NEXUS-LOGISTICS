// Comptes : inscription d'une entreprise, connexion, déconnexion, invitations, changement d'entreprise.
import { HttpError, json, readJson, sessionCookie, clientIp, str } from '../http.js';
import { hashPassword, verifyPassword, sha256Hex } from '../crypto.js';
import { createSession, requireSession, currentSession, companiesOf, rateLimit, clearRateLimit, now } from '../auth.js';

const KINDS = ['livraison', 'boutique', 'vendeur', 'autre'];
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'Mot de passe : 8 caractères au moins.', 'weak_password');
  if (pw.length > 200) throw new HttpError(400, 'Mot de passe trop long.', 'weak_password');
}
function checkEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(e)) throw new HttpError(400, 'Adresse e-mail invalide.', 'invalid_email');
  return e;
}

/** Adresse publique unique, dérivée du nom (« Express Dakar » → express-dakar, express-dakar-2…). */
async function uniqueSlug(env, name) {
  const base = String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'entreprise';
  for (let i = 1; i < 50; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    if (!(await env.DB.prepare('SELECT 1 AS x FROM companies WHERE slug = ?').bind(slug).first())) return slug;
  }
  return `${base}-${crypto.randomUUID().slice(0, 6)}`;
}

async function authPayload(env, userId, companyId) {
  const user = await env.DB.prepare('SELECT id, email, name, phone FROM users WHERE id = ?').bind(userId).first();
  return { user, company_id: companyId, companies: await companiesOf(env, userId) };
}

/** POST /api/auth/register { email, password, name, phone?, company: { name, kind, phone, city } } */
export async function register(request, env) {
  const ip = clientIp(request);
  await rateLimit(env, `register:${ip}`, 5, 3600);
  const b = await readJson(request);
  const email = checkEmail(b.email);
  checkPassword(b.password);
  const name = str(b.name, 80);
  if (!name) throw new HttpError(400, 'Indiquez votre nom.', 'invalid_name');
  const cName = str(b.company?.name, 120);
  if (!cName) throw new HttpError(400, "Indiquez le nom de l'entreprise.", 'invalid_company');
  const kind = KINDS.includes(b.company?.kind) ? b.company.kind : 'livraison';
  if (await env.DB.prepare('SELECT 1 AS x FROM users WHERE email = ?').bind(email).first()) {
    throw new HttpError(409, 'Un compte existe déjà avec cette adresse : connectez-vous.', 'email_taken');
  }
  const userId = crypto.randomUUID();
  const companyId = crypto.randomUUID();
  const hash = await hashPassword(b.password);
  const slug = await uniqueSlug(env, cName);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, email, name, phone, password_hash) VALUES (?, ?, ?, ?, ?)').bind(userId, email, name, str(b.phone, 30), hash),
    env.DB.prepare('INSERT INTO companies (id, name, slug, kind, phone, city) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(companyId, cName, slug, kind, str(b.company?.phone, 30), str(b.company?.city, 60) || 'Dakar'),
    env.DB.prepare("INSERT INTO members (company_id, user_id, role) VALUES (?, ?, 'owner')").bind(companyId, userId),
    // un premier lieu pour démarrer (modifiable dans l'administration)
    env.DB.prepare("INSERT INTO hubs (id, company_id, name, kind) VALUES (?, ?, 'Dépôt principal', 'hub')").bind(crypto.randomUUID(), companyId),
    env.DB.prepare("INSERT INTO audit_log (company_id, user_id, action, entity, entity_id) VALUES (?, ?, 'company_create', 'company', ?)").bind(companyId, userId, companyId),
  ]);
  const token = await createSession(env, userId, companyId, request.headers.get('user-agent'));
  return json(await authPayload(env, userId, companyId), 201, { 'set-cookie': sessionCookie(token) });
}

/** POST /api/auth/login { email, password } */
export async function login(request, env) {
  const ip = clientIp(request);
  const b = await readJson(request);
  const email = String(b.email || '').trim().toLowerCase();
  await rateLimit(env, `login:${ip}`, 20, 900);
  await rateLimit(env, `login:${email}`, 8, 900);
  const u = await env.DB.prepare('SELECT id, password_hash, suspended_at FROM users WHERE email = ?').bind(email).first();
  // même réponse que le compte existe ou non
  if (!u || !(await verifyPassword(String(b.password || ''), u.password_hash))) {
    throw new HttpError(401, 'E-mail ou mot de passe incorrect.', 'login_failed');
  }
  if (u.suspended_at) throw new HttpError(403, 'Ce compte est suspendu. Contactez le support NEXUS Logistics.', 'suspended');
  await clearRateLimit(env, `login:${email}`);
  const companies = await companiesOf(env, u.id);
  const token = await createSession(env, u.id, companies[0]?.id ?? null, request.headers.get('user-agent'));
  return json(await authPayload(env, u.id, companies[0]?.id ?? null), 200, { 'set-cookie': sessionCookie(token) });
}

/** POST /api/auth/logout */
export async function logout(request, env) {
  const s = await currentSession(request, env);
  if (s) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(s.sessionId).run();
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
}

/** GET /api/auth/session — null si pas connecté (jamais d'erreur : sert au démarrage de l'app). */
export async function session(request, env) {
  const s = await currentSession(request, env);
  if (!s || s.user.suspended) return json({ session: null });
  return json({ session: await authPayload(env, s.user.id, s.companyId) });
}

/** POST /api/auth/company { company_id } — changer d'entreprise active. */
export async function switchCompany(request, env) {
  const s = await requireSession(request, env);
  const b = await readJson(request);
  const ok = await env.DB.prepare('SELECT 1 AS x FROM members m JOIN companies c ON c.id = m.company_id WHERE m.company_id = ? AND m.user_id = ? AND c.suspended_at IS NULL')
    .bind(String(b.company_id || ''), s.user.id).first();
  if (!ok) throw new HttpError(403, 'Accès refusé à cette entreprise.', 'forbidden');
  await env.DB.prepare('UPDATE sessions SET company_id = ? WHERE id = ?').bind(b.company_id, s.sessionId).run();
  return json(await authPayload(env, s.user.id, b.company_id));
}

/** POST /api/auth/password { current, password } */
export async function changePassword(request, env) {
  const s = await requireSession(request, env);
  const b = await readJson(request);
  checkPassword(b.password);
  const u = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(s.user.id).first();
  if (!(await verifyPassword(String(b.current || ''), u.password_hash))) throw new HttpError(401, 'Mot de passe actuel incorrect.', 'login_failed');
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(b.password), s.user.id),
    // les autres sessions sont fermées
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').bind(s.user.id, s.sessionId),
  ]);
  return json({ ok: true });
}

async function findInvite(env, token) {
  if (typeof token !== 'string' || token.length < 16 || token.length > 80) return null;
  const inv = await env.DB.prepare(
    `SELECT i.*, c.name AS company_name FROM invites i JOIN companies c ON c.id = i.company_id
      WHERE i.token_hash = ? AND c.suspended_at IS NULL`,
  ).bind(await sha256Hex(token)).first();
  if (!inv || inv.used_at || inv.expires_at < now()) return null;
  return inv;
}

/** GET /api/invites/:token — aperçu de l'invitation (nom de l'entreprise, rôle). */
export async function getInvite(request, env, { token }) {
  const inv = await findInvite(env, token);
  if (!inv) throw new HttpError(404, "Ce lien d'invitation n'est plus valable : demandez-en un nouveau.", 'invite_invalid');
  return json({ company: inv.company_name, role: inv.role, name: inv.name, staff_roles: JSON.parse(inv.staff_roles) });
}

/**
 * POST /api/invites/:token/accept { email, password, name?, phone? }
 * Nouveau compte (nom obligatoire) ou compte existant (mot de passe vérifié). Chauffeur → fiche chauffeur.
 */
export async function acceptInvite(request, env, { token }) {
  await rateLimit(env, `invite:${clientIp(request)}`, 10, 900);
  const inv = await findInvite(env, token);
  if (!inv) throw new HttpError(404, "Ce lien d'invitation n'est plus valable : demandez-en un nouveau.", 'invite_invalid');
  const b = await readJson(request);
  const email = checkEmail(b.email);
  const existing = await env.DB.prepare('SELECT id, name, password_hash FROM users WHERE email = ?').bind(email).first();
  let userId; let userName;
  const stmts = [];
  if (existing) {
    if (!(await verifyPassword(String(b.password || ''), existing.password_hash))) {
      throw new HttpError(401, 'Un compte existe avec cette adresse : saisissez son mot de passe.', 'login_failed');
    }
    userId = existing.id; userName = existing.name;
  } else {
    checkPassword(b.password);
    userName = str(b.name, 80) || str(inv.name, 80);
    if (!userName) throw new HttpError(400, 'Indiquez votre nom.', 'invalid_name');
    userId = crypto.randomUUID();
    stmts.push(env.DB.prepare('INSERT INTO users (id, email, name, phone, password_hash) VALUES (?, ?, ?, ?, ?)')
      .bind(userId, email, userName, str(b.phone, 30), await hashPassword(b.password)));
  }
  const already = existing && (await env.DB.prepare('SELECT 1 AS x FROM members WHERE company_id = ? AND user_id = ?').bind(inv.company_id, userId).first());
  // Un même lien ne sert qu'une fois, même en cas de double clic : le marquage est conditionnel, et chaque
  // insertion qui suit n'a lieu QUE si c'est cette requête qui a marqué le lien (used_by = userId).
  const mine = 'EXISTS (SELECT 1 FROM invites WHERE token_hash = ? AND used_by = ?)';
  stmts.push(env.DB.prepare('UPDATE invites SET used_at = ?, used_by = ? WHERE token_hash = ? AND used_at IS NULL').bind(now(), userId, inv.token_hash));
  if (!already) {
    stmts.push(env.DB.prepare(`INSERT INTO members (company_id, user_id, role) SELECT ?, ?, ? WHERE ${mine}`)
      .bind(inv.company_id, userId, inv.role, inv.token_hash, userId));
  }
  for (const role of JSON.parse(inv.staff_roles)) {
    stmts.push(env.DB.prepare(
      `INSERT INTO staff_roles (company_id, user_id, role, active, granted_by) SELECT ?, ?, ?, 1, ? WHERE ${mine}
       ON CONFLICT (company_id, user_id, role) DO UPDATE SET active = 1`,
    ).bind(inv.company_id, userId, role, inv.created_by, inv.token_hash, userId));
  }
  if (inv.role === 'courier' && !(await env.DB.prepare('SELECT 1 AS x FROM couriers WHERE company_id = ? AND user_id = ?').bind(inv.company_id, userId).first())) {
    stmts.push(env.DB.prepare(`INSERT INTO couriers (id, company_id, user_id, name, phone) SELECT ?, ?, ?, ?, ? WHERE ${mine}`)
      .bind(crypto.randomUUID(), inv.company_id, userId, userName, str(b.phone, 30), inv.token_hash, userId));
  }
  const res = await env.DB.batch(stmts);
  if (!res[existing ? 0 : 1].meta.changes) throw new HttpError(409, "Cette invitation vient déjà d'être utilisée.", 'invite_invalid');
  const sessionToken = await createSession(env, userId, inv.company_id, request.headers.get('user-agent'));
  return json(await authPayload(env, userId, inv.company_id), 200, { 'set-cookie': sessionCookie(sessionToken) });
}
