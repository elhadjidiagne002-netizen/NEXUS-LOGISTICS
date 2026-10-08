// Connexion de l'administrateur avec son compte Devizo (le même que pour Devizo, My shop et CV en ligne).
// On LIT la base D1 de Devizo (liaison AUTH_DB) : aucune écriture. Algorithme identique à Devizo
// (PBKDF2-SHA256, format « pbkdf2$<itérations>$<sel base64url>$<empreinte base64url> »).

function b64url(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return b64url(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

/** Empreinte au format Devizo (sert aux tests). */
export async function devizoHash(password, iterations = 100_000) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${iterations}$${b64url(salt)}$${await pbkdf2(password, salt, iterations)}`;
}

export async function verifyDevizoPassword(password, stored) {
  const [scheme, iter, salt, hash] = String(stored || '').split('$');
  const n = Number(iter);
  if (scheme !== 'pbkdf2' || !salt || !hash || !n || n > 100_000) return false; // plafond du runtime Workers
  return timingSafeEqual(await pbkdf2(String(password), fromB64url(salt), n), hash);
}

/** Super-administrateurs : e-mails listés dans ADMIN_EMAILS (même valeur que Devizo et CV en ligne). */
export function isSuperAdmin(email, env) {
  const list = String(env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return Boolean(email) && list.includes(String(email).trim().toLowerCase());
}

/** Compte Devizo : { email } si e-mail + mot de passe corrects, { suspended: true } si suspendu, sinon null. */
export async function findDevizoAccount(env, email, password) {
  const row = await env.AUTH_DB.prepare('SELECT id, email, password_hash, company FROM tenants WHERE email = ?')
    .bind(String(email).trim().toLowerCase()).first();
  if (!row || !(await verifyDevizoPassword(password, row.password_hash))) return null;
  let company = {};
  try { company = JSON.parse(row.company || '{}'); } catch { company = {}; }
  if (company.suspended_at) return { suspended: true };
  return { id: row.id, email: row.email };
}
