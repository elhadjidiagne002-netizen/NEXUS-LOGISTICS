// Outils communs aux fonctions métier (erreurs, rôles, audit, idempotence, numérotation).
import { HttpError } from '../http.js';

/** Erreur métier : renvoyée au client sous la forme { error: code } (codes traduits par src/lib/errors.js). */
export class RpcFail extends HttpError {
  constructor(code, status = 400, detail = undefined) {
    super(status, code, code);
    this.detail = detail;
  }
}
export const fail = (code, status = 400) => { throw new RpcFail(code, status); };

/** Administrateur ou un des rôles demandés (équivalent de lg_has_role). */
export const hasRole = (ctx, roles) => ctx.isAdmin || ctx.roles.some((r) => roles.includes(r.role));

/** Audit (qui a fait quoi) — jamais bloquant. */
export async function audit(ctx, action, entity, entityId, detail = null) {
  try {
    await ctx.db.prepare('INSERT INTO audit_log (company_id, user_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(ctx.company?.id ?? null, ctx.user?.id ?? null, action, entity, entityId == null ? null : String(entityId),
        detail == null ? null : JSON.stringify(detail)).run();
  } catch { /* l'audit ne doit jamais faire échouer l'action */ }
}

/**
 * Idempotence des actions de terrain (p_event) : si l'événement a déjà été traité, renvoie le même
 * résultat. Sinon exécute `fn` puis mémorise son résultat. Équivalent de lg_idem_get / lg_idem_put.
 */
export async function idempotent(ctx, fnName, eventId, fn) {
  if (!eventId) return fn();
  const prev = await ctx.db.prepare('SELECT result FROM action_log WHERE company_id = ? AND event_id = ?').bind(ctx.company.id, String(eventId)).first();
  if (prev) return JSON.parse(prev.result);
  const result = await fn();
  await ctx.db.prepare('INSERT OR IGNORE INTO action_log (company_id, event_id, fn, result) VALUES (?, ?, ?, ?)')
    .bind(ctx.company.id, String(eventId), fnName, JSON.stringify(result ?? null)).run();
  return result;
}

/** Numéro suivant sans trou (factures, voyages…) : compteur par entreprise, incrément atomique. */
export async function nextCounter(ctx, key) {
  const r = await ctx.db.prepare(
    `INSERT INTO counters (company_id, key, n) VALUES (?, ?, 1)
     ON CONFLICT (company_id, key) DO UPDATE SET n = n + 1 RETURNING n`,
  ).bind(ctx.company.id, key).first();
  return r.n;
}

// ----------------------------------------------------------------- petites aides partagées par les modules
/** Texte nettoyé et tronqué, ou null. */
export const text = (v, max = 200) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));
/** Nombre fini, ou null. */
export const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
/** Entier (arrondi), ou null. */
export const int = (v) => (num(v) == null ? null : Math.round(Number(v)));
export const uuid = () => crypto.randomUUID();
/** Clé de téléphone : 9 derniers chiffres (+221 77… et 77… sont le même client). */
export const phoneKey = (p) => { const d = String(p ?? '').replace(/\D/g, ''); return d.length >= 9 ? d.slice(-9) : null; };
/** JSON stocké en texte → valeur (ou valeur par défaut si vide ou invalide). */
export function parseJson(s, dflt = null) {
  if (s == null || s === '') return dflt;
  try { return JSON.parse(s); } catch { return dflt; }
}
/** Distance à vol d'oiseau en mètres (équivalent de lg_distance_m). */
export function distanceM(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => v == null)) return null;
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return Math.round(12742000 * Math.asin(Math.sqrt(a)));
}
