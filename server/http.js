// Aides HTTP communes aux routes.

export class HttpError extends Error {
  constructor(status, message, code = undefined) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export async function readJson(request, maxBytes = 2_000_000) {
  const ct = request.headers.get('content-type') || '';
  if (!ct.includes('application/json')) throw new HttpError(415, 'Format attendu : JSON.');
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'Envoi trop volumineux : réessayez par petits lots.');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'JSON invalide.');
  }
}

export function getCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export const SESSION_COOKIE = 'lg_session';
export const SESSION_DAYS = 60;

export function sessionCookie(token, maxAgeSeconds = SESSION_DAYS * 86400) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export const clientIp = (request) =>
  request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'inconnue';

export const isUuid = (s) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
export const isIso = (s) => typeof s === 'string' && s.length <= 40 && !Number.isNaN(Date.parse(s));

/** Coupe un tableau en paquets (D1 limite le nombre de paramètres liés par requête à 100). */
export function chunks(arr, size = 90) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Texte nettoyé et tronqué, ou null. */
export function str(v, max = 200) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}
export function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
export function intOrNull(v) {
  const n = numOrNull(v);
  return n === null ? null : Math.round(n);
}
