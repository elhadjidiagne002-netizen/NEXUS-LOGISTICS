// Cycle C9 — offre payante : formules (gratuite avec quotas, Pro mensuelle), paiement Wave / Orange Money déclaré par
// l'entreprise puis validé par l'administrateur de la plateforme ; administration de la plateforme (entreprises,
// formules, suspension, statistiques, erreurs remontées). Les fonctions « plateforme » (rôle 'platform') sont réservées
// aux adresses de la variable ADMIN_EMAILS et ne dépendent d'aucune entreprise active.
import { fail, audit, text, int, uuid, parseJson, guard, runBatch } from './core.js';

export const PLAN_DEFAULTS = {
  free: { label: 'Gratuite', price_fcfa: 0, orders_month: 300, couriers: 3, hubs: 2 },   // 2 lieux : un dépôt et un point relais
  pro: { label: 'Pro', price_fcfa: 15000, orders_month: null, couriers: null, hubs: null },
  payment: { wave: null, orange_money: null, name: 'NEXUS Logistics' },
};

/** Réglages de l'offre (défauts + app_settings « plans »), lus une fois par requête. */
export function plansOf(ctx) {
  ctx._plans ??= ctx.db.prepare("SELECT value FROM app_settings WHERE key = 'plans'").first('value').then((v) => {
    const s = parseJson(v, {});
    return { free: { ...PLAN_DEFAULTS.free, ...s.free }, pro: { ...PLAN_DEFAULTS.pro, ...s.pro }, payment: { ...PLAN_DEFAULTS.payment, ...s.payment } };
  });
  return ctx._plans;
}
/** Formule en vigueur : Pro tant que la date de fin n'est pas passée, sinon gratuite. */
export const effectivePlan = (company, now) => (company?.plan === 'pro' && company.plan_until && company.plan_until > now ? 'pro' : 'free');
const monthStart = (now) => `${now.slice(0, 7)}-01T00:00:00.000Z`;

/**
 * Contrôle de quota avant une création (commandes du mois, chauffeurs actifs, lieux). `adding` = nombre ajouté.
 * Refus : quota_orders / quota_couriers / quota_hubs (l'interface propose de passer à la formule Pro).
 */
export async function checkQuota(ctx, kind, adding = 1) {
  const plan = effectivePlan(ctx.company, ctx.now);
  const limit = (await plansOf(ctx))[plan][kind];
  if (limit == null) return;
  const sql = { orders_month: 'SELECT count(*) AS n FROM orders WHERE company_id = ? AND created_at >= ?', couriers: 'SELECT count(*) AS n FROM couriers WHERE company_id = ? AND active = 1 AND ? IS NOT NULL',
    hubs: 'SELECT count(*) AS n FROM hubs WHERE company_id = ? AND active = 1 AND ? IS NOT NULL' }[kind];
  const used = await ctx.db.prepare(sql).bind(ctx.company.id, monthStart(ctx.now)).first('n');
  if (used + adding > limit) fail({ orders_month: 'quota_orders', couriers: 'quota_couriers', hubs: 'quota_hubs' }[kind], 403);
}

export const isPlatformAdmin = (env, user) => Boolean(user?.email)
  && String(env.ADMIN_EMAILS ?? '').split(/[,;\s]+/).filter(Boolean).map((e) => e.toLowerCase()).includes(String(user.email).toLowerCase());

const addMonths = (from, n) => new Date(Date.parse(from) + n * 30 * 86400000).toISOString();

export default {
  // ----------------------------------------------------------------- côté entreprise
  lg_plan_status: {
    roles: 'admin',
    async handler(ctx) {
      const cid = ctx.company.id; const plans = await plansOf(ctx);
      const [u, pays] = await ctx.db.batch([
        ctx.db.prepare(`SELECT (SELECT count(*) FROM orders WHERE company_id = ?1 AND created_at >= ?2) AS orders_month,
            (SELECT count(*) FROM couriers WHERE company_id = ?1 AND active = 1) AS couriers, (SELECT count(*) FROM hubs WHERE company_id = ?1 AND active = 1) AS hubs`)
          .bind(cid, monthStart(ctx.now)),
        ctx.db.prepare('SELECT id, months, amount_fcfa, method, ref, status, declared_at, decided_at, note FROM plan_payments WHERE company_id = ? ORDER BY declared_at DESC LIMIT 24').bind(cid),
      ]);
      const plan = effectivePlan(ctx.company, ctx.now);
      return { plan, label: plans[plan].label, plan_until: ctx.company.plan_until, usage: u.results[0], limits: plans[plan], plans: { free: plans.free, pro: plans.pro },
        payment: plans.payment, payments: pays.results };
    },
  },

  // Paiement déclaré (Wave / Orange Money) : la formule Pro s'active quand l'administrateur de la plateforme le valide.
  lg_plan_declare: {
    roles: 'admin',
    async handler(ctx, a) {
      const months = int(a.p_months);
      if (!(months >= 1 && months <= 12)) fail('invalid_months');
      if (!['wave', 'orange_money'].includes(a.p_method)) fail('invalid_method');
      const ref = text(a.p_ref, 60);
      if (!ref || ref.length < 4) fail('invalid_ref');
      if (await ctx.db.prepare("SELECT 1 AS x FROM plan_payments WHERE company_id = ? AND status = 'pending'").bind(ctx.company.id).first()) fail('payment_pending', 409);
      const id = uuid(); const amount = (await plansOf(ctx)).pro.price_fcfa * months;
      await ctx.db.prepare('INSERT INTO plan_payments (id, company_id, months, amount_fcfa, method, ref, declared_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, ctx.company.id, months, amount, a.p_method, ref, ctx.user.id).run();
      await audit(ctx, 'plan_declare', 'plan_payment', id, { months, amount, method: a.p_method });
      return { ok: true, id, amount_fcfa: amount };
    },
  },

  // ----------------------------------------------------------------- plateforme (ADMIN_EMAILS)
  lg_platform_overview: {
    roles: 'platform',
    async handler(ctx) {
      const d30 = new Date(Date.parse(ctx.now) - 30 * 86400000).toISOString();
      const [cos, pays, errs] = await ctx.db.batch([
        ctx.db.prepare(`SELECT c.id, c.name, c.slug, c.kind, c.city, c.plan, c.plan_until, c.created_at, c.suspended_at,
              (SELECT count(*) FROM members m WHERE m.company_id = c.id) AS members,
              (SELECT count(*) FROM orders o WHERE o.company_id = c.id AND o.created_at >= ?1) AS orders_30d,
              (SELECT count(*) FROM orders o WHERE o.company_id = c.id AND o.status = 'delivered' AND o.delivered_at >= ?1) AS delivered_30d,
              (SELECT max(created_at) FROM audit_log a WHERE a.company_id = c.id) AS last_activity,
              (SELECT u.email FROM members m JOIN users u ON u.id = m.user_id WHERE m.company_id = c.id AND m.role = 'owner' LIMIT 1) AS owner_email
            FROM companies c ORDER BY c.created_at DESC LIMIT 500`).bind(d30),
        ctx.db.prepare(`SELECT p.*, c.name AS company FROM plan_payments p JOIN companies c ON c.id = p.company_id ORDER BY p.status = 'pending' DESC, p.declared_at DESC LIMIT 100`),
        ctx.db.prepare('SELECT count(*) AS n FROM client_errors WHERE created_at >= ?').bind(new Date(Date.parse(ctx.now) - 86400000).toISOString()),
      ]);
      const companies = cos.results.map((c) => ({ ...c, plan_effective: effectivePlan(c, ctx.now), suspended: Boolean(c.suspended_at) }));
      return {
        totals: { companies: companies.length, pro: companies.filter((c) => c.plan_effective === 'pro').length, suspended: companies.filter((c) => c.suspended).length,
          orders_30d: companies.reduce((s, c) => s + c.orders_30d, 0), delivered_30d: companies.reduce((s, c) => s + c.delivered_30d, 0),
          payments_pending: pays.results.filter((p) => p.status === 'pending').length, errors_24h: errs.results[0].n,
          revenue_fcfa: pays.results.filter((p) => p.status === 'approved').reduce((s, p) => s + p.amount_fcfa, 0) },
        companies, payments: pays.results, settings: await plansOf(ctx),
      };
    },
  },

  // Validation d'un paiement déclaré : formule Pro prolongée de N × 30 jours (depuis la fin en cours si elle est future).
  lg_platform_payment_decide: {
    roles: 'platform',
    async handler(ctx, a) {
      const p = await ctx.db.prepare('SELECT p.*, c.plan, c.plan_until FROM plan_payments p JOIN companies c ON c.id = p.company_id WHERE p.id = ?').bind(String(a.p_id ?? '')).first();
      if (!p) fail('unknown_payment', 404);
      if (p.status !== 'pending') return { ok: false, error: 'already_decided', status: p.status };
      const approve = a.p_approve === true;
      const until = approve ? addMonths(p.plan_until && p.plan_until > ctx.now ? p.plan_until : ctx.now, p.months) : null;
      await runBatch(ctx, [
        guard(ctx.db, "(SELECT status FROM plan_payments WHERE id = ?) = 'pending'", [p.id]),
        ctx.db.prepare('UPDATE plan_payments SET status = ?, decided_by = ?, decided_at = ?, note = ? WHERE id = ?')
          .bind(approve ? 'approved' : 'rejected', ctx.user.id, ctx.now, text(a.p_note, 300), p.id),
        ...(approve ? [ctx.db.prepare("UPDATE companies SET plan = 'pro', plan_until = ? WHERE id = ?").bind(until, p.company_id)] : []),
      ], 'already_decided');
      await audit({ ...ctx, company: { id: p.company_id } }, approve ? 'plan_approved' : 'plan_rejected', 'plan_payment', p.id, { months: p.months, until });
      return { ok: true, status: approve ? 'approved' : 'rejected', plan_until: until };
    },
  },

  // Formule, date de fin ou suspension d'une entreprise (une entreprise suspendue n'a plus accès, sa page de suivi non plus).
  lg_platform_company_set: {
    roles: 'platform',
    async handler(ctx, a) {
      const c = await ctx.db.prepare('SELECT id FROM companies WHERE id = ?').bind(String(a.p_company ?? '')).first();
      if (!c) fail('unknown_company', 404);
      const sets = []; const vals = [];
      if (a.p_suspend !== undefined) { sets.push('suspended_at = ?'); vals.push(a.p_suspend === true ? ctx.now : null); }
      if (a.p_plan !== undefined) {
        if (!['free', 'pro'].includes(a.p_plan)) fail('invalid_plan');
        sets.push('plan = ?'); vals.push(a.p_plan);
      }
      if (a.p_plan_until !== undefined) {
        if (a.p_plan_until !== null && Number.isNaN(Date.parse(a.p_plan_until))) fail('invalid_date');
        sets.push('plan_until = ?'); vals.push(a.p_plan_until === null ? null : new Date(Date.parse(a.p_plan_until)).toISOString());
      }
      if (!sets.length) fail('nothing_to_change');
      await ctx.db.prepare(`UPDATE companies SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, c.id).run();
      await audit({ ...ctx, company: { id: c.id } }, 'platform_company_set', 'company', c.id, { suspend: a.p_suspend, plan: a.p_plan, until: a.p_plan_until });
      return { ok: true };
    },
  },

  lg_platform_settings_save: {
    roles: 'platform',
    async handler(ctx, a) {
      const cur = await plansOf(ctx); const p = a.p && typeof a.p === 'object' ? a.p : {};
      const lim = (v, d) => (v === null ? null : v === undefined ? d : Math.max(0, int(v) ?? 0));
      const next = {
        free: { ...cur.free, price_fcfa: 0, orders_month: lim(p.free?.orders_month, cur.free.orders_month), couriers: lim(p.free?.couriers, cur.free.couriers), hubs: lim(p.free?.hubs, cur.free.hubs) },
        pro: { ...cur.pro, price_fcfa: lim(p.pro?.price_fcfa, cur.pro.price_fcfa) ?? 0, orders_month: lim(p.pro?.orders_month, cur.pro.orders_month),
          couriers: lim(p.pro?.couriers, cur.pro.couriers), hubs: lim(p.pro?.hubs, cur.pro.hubs) },
        payment: { ...cur.payment, wave: p.payment?.wave !== undefined ? text(p.payment.wave, 30) : cur.payment.wave,
          orange_money: p.payment?.orange_money !== undefined ? text(p.payment.orange_money, 30) : cur.payment.orange_money,
          name: p.payment?.name !== undefined ? text(p.payment.name, 80) ?? cur.payment.name : cur.payment.name },
      };
      await ctx.db.prepare("INSERT INTO app_settings (key, value) VALUES ('plans', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(next)).run();
      return { ok: true, settings: next };
    },
  },

  lg_platform_errors: {
    roles: 'platform',
    async handler(ctx, a) {
      return (await ctx.db.prepare(`SELECT e.*, c.name AS company FROM client_errors e LEFT JOIN companies c ON c.id = e.company_id ORDER BY e.id DESC LIMIT ?`)
        .bind(Math.min(Math.max(int(a.p_limit) ?? 100, 1), 300)).all()).results;
    },
  },
};
