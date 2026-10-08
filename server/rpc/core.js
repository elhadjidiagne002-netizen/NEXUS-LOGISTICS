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
