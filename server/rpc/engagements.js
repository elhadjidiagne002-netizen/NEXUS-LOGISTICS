// Cycle C11 — engagement de délai de préparation des vendeurs (portage du cycle 9 Postgres) : réglage par le vendeur
// (ou le chef de quai), suivi (à l'heure, en retard, relances), relances automatiques par la file de messages.
import { fail, audit, hasRole, int } from './core.js';
import { render, DEFAULT_TEMPLATES } from './messages.js';

/** Statistiques d'engagement de plusieurs vendeurs en une requête (lg_vendor_commitment_stats). */
async function stats(ctx, days, vendorId = null) {
  const since = new Date(Date.parse(ctx.now) - days * 86400000).toISOString();
  const r = await ctx.db.prepare(
    `SELECT u.id AS vendor_id, u.name, vc.prep_hours,
            (SELECT count(*) FROM pick_tasks t WHERE t.company_id = ?1 AND t.vendor_id = u.id AND t.status <> 'cancelled' AND t.created_at > ?2 AND t.done_at IS NOT NULL) AS done,
            (SELECT count(*) FROM pick_tasks t WHERE t.company_id = ?1 AND t.vendor_id = u.id AND t.status <> 'cancelled' AND t.created_at > ?2 AND t.done_at <= t.cutoff_at) AS on_time,
            (SELECT round(avg((julianday(t.done_at) - julianday(t.created_at)) * 24), 1) FROM pick_tasks t
              WHERE t.company_id = ?1 AND t.vendor_id = u.id AND t.status <> 'cancelled' AND t.created_at > ?2 AND t.done_at IS NOT NULL) AS avg_hours,
            (SELECT count(*) FROM pick_tasks t WHERE t.company_id = ?1 AND t.vendor_id = u.id AND t.status IN ('todo', 'picking')) AS open,
            (SELECT count(*) FROM pick_tasks t WHERE t.company_id = ?1 AND t.vendor_id = u.id AND t.status IN ('todo', 'picking') AND t.cutoff_at < ?3) AS open_late,
            (SELECT count(*) FROM vendor_reminders_sent r JOIN pick_tasks t ON t.id = r.task_id WHERE t.company_id = ?1 AND t.vendor_id = u.id AND r.sent_at > ?2) AS reminders,
            EXISTS (SELECT 1 FROM pick_tasks t WHERE t.company_id = ?1 AND t.vendor_id = u.id AND t.created_at > ?2) AS active
       FROM members m JOIN users u ON u.id = m.user_id LEFT JOIN vendor_commitments vc ON vc.company_id = m.company_id AND vc.vendor_id = u.id
      WHERE m.company_id = ?1 AND m.role = 'vendor' AND (?4 IS NULL OR u.id = ?4)`,
  ).bind(ctx.company.id, since, ctx.now, vendorId).all();
  return r.results.map((x) => ({ ...x, active: Boolean(x.active), on_time_pct: x.done ? Math.round((1000 * x.on_time) / x.done) / 10 : null }));
}

/**
 * Relances des vendeurs (lg_vendor_reminders), pour toutes les entreprises : préparation à finir dans moins de 2 h
 * (« soon »), puis en retard (« late »), une seule fois par étape ; message déposé dans la file d'envoi.
 */
export async function vendorReminders(env, now) {
  const soon = new Date(Date.parse(now) + 2 * 3600000).toISOString();
  const rows = (await env.DB.prepare(
    `SELECT t.id, t.company_id, t.cutoff_at, o.number, u.name, u.phone, u.email, vc.prep_hours,
            (SELECT body_fr FROM message_templates m WHERE m.company_id = t.company_id AND m.event_key = CASE WHEN t.cutoff_at <= ?1 THEN 'lg_vendor_prep_late' ELSE 'lg_vendor_prep_soon' END) AS body,
            (SELECT active FROM message_templates m WHERE m.company_id = t.company_id AND m.event_key = CASE WHEN t.cutoff_at <= ?1 THEN 'lg_vendor_prep_late' ELSE 'lg_vendor_prep_soon' END) AS active
       FROM pick_tasks t JOIN vendor_commitments vc ON vc.company_id = t.company_id AND vc.vendor_id = t.vendor_id
       JOIN users u ON u.id = t.vendor_id JOIN orders o ON o.id = t.order_id JOIN companies c ON c.id = t.company_id
      WHERE c.suspended_at IS NULL AND t.status IN ('todo', 'picking') AND t.cutoff_at IS NOT NULL AND t.cutoff_at < ?2
        AND (t.picker_id IS NULL OR t.picker_id = t.vendor_id)
        AND NOT EXISTS (SELECT 1 FROM vendor_reminders_sent r WHERE r.task_id = t.id AND r.stage = CASE WHEN t.cutoff_at <= ?1 THEN 'late' ELSE 'soon' END)
      LIMIT 50`,
  ).bind(now, soon).all()).results;
  const stmts = [];
  for (const r of rows) {
    const stage = r.cutoff_at <= now ? 'late' : 'soon'; const event = `lg_vendor_prep_${stage}`;
    stmts.push(env.DB.prepare('INSERT OR IGNORE INTO vendor_reminders_sent (task_id, stage, company_id, sent_at) VALUES (?, ?, ?, ?)').bind(r.id, stage, r.company_id, now));
    if (r.active === 0 || (!r.phone && !r.email)) continue;
    const vars = { vendeur: String(r.name ?? '').split(' ')[0], commande: String(r.number), heure: `${r.cutoff_at.slice(11, 13)}h${r.cutoff_at.slice(14, 16)}`, delai: r.prep_hours };
    const body = r.body ?? DEFAULT_TEMPLATES.find((t) => t.event_key === event).body_fr;
    stmts.push(env.DB.prepare('INSERT INTO outbox (id, company_id, event_key, phone, email, vars, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), r.company_id, event, String(r.phone ?? '').replace(/\D/g, '').slice(-9) || null, r.email ?? null, JSON.stringify(vars), render(body, vars), now));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { reminders: rows.length };
}

export default {
  lg_my_commitment: {
    roles: 'member',
    async handler(ctx) {
      if (ctx.member !== 'vendor' && !ctx.isAdmin) fail('forbidden', 403);
      const s = (await stats(ctx, 30, ctx.user.id))[0] ?? { vendor_id: ctx.user.id, prep_hours: null, done: 0, on_time: 0, on_time_pct: null, avg_hours: null, open: 0, open_late: 0, reminders: 0 };
      const tasks = (await ctx.db.prepare(`SELECT t.id AS task_id, o.number, t.status, t.cutoff_at FROM pick_tasks t JOIN orders o ON o.id = t.order_id
          WHERE t.company_id = ? AND t.vendor_id = ? AND t.status IN ('todo', 'picking') ORDER BY t.cutoff_at IS NULL, t.cutoff_at`).bind(ctx.company.id, ctx.user.id).all()).results;
      const { name, active, ...rest } = s;
      return { ...rest, tasks: tasks.map((t) => ({ task_id: t.task_id, order_short: String(t.number), status: t.status, cutoff_at: t.cutoff_at,
        minutes_left: t.cutoff_at ? Math.round((Date.parse(t.cutoff_at) - Date.parse(ctx.now)) / 60000) : null })) };
    },
  },

  // Le vendeur s'engage pour lui-même ; le chef de quai (ou l'administrateur) pour n'importe quel vendeur.
  lg_vendor_commitment_set: {
    roles: 'member',
    async handler(ctx, a) {
      const vid = a.p_vendor ? String(a.p_vendor) : ctx.user.id;
      if (!(vid === ctx.user.id && ctx.member === 'vendor') && !hasRole(ctx, ['dock_chief'])) fail('forbidden', 403);
      if (!(await ctx.db.prepare("SELECT 1 AS x FROM members WHERE company_id = ? AND user_id = ? AND role = 'vendor'").bind(ctx.company.id, vid).first())) fail('unknown_vendor', 404);
      const h = a.p_hours == null ? null : int(a.p_hours);
      if (h == null) {
        await ctx.db.prepare('DELETE FROM vendor_commitments WHERE company_id = ? AND vendor_id = ?').bind(ctx.company.id, vid).run();
      } else {
        if (!(h >= 1 && h <= 96)) fail('invalid_hours');
        await ctx.db.prepare(`INSERT INTO vendor_commitments (company_id, vendor_id, prep_hours, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (company_id, vendor_id) DO UPDATE SET prep_hours = excluded.prep_hours, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
          .bind(ctx.company.id, vid, h, ctx.user.id, ctx.now).run();
      }
      await audit(ctx, 'vendor_commitment', 'member', vid, { prep_hours: h });
      return { ok: true, vendor_id: vid, prep_hours: h };
    },
  },

  lg_vendor_commitments_list: {
    roles: ['dock_chief', 'dispatcher', 'support', 'accountant'],
    async handler(ctx, a) {
      return (await stats(ctx, Math.min(Math.max(int(a.p_days) ?? 30, 1), 365))).filter((x) => x.prep_hours != null || x.active)
        .map(({ active, ...x }) => x).sort((x, y) => (x.prep_hours ?? 1e9) - (y.prep_hours ?? 1e9) || String(x.name).localeCompare(String(y.name)));
    },
  },
};
