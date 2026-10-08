// Tâches planifiées : POST /api/cron/<tâche>, appelées par le petit Worker cron/ (Pages n'a pas de déclencheur
// horaire). Protégées par le secret CRON_SECRET (en-tête x-cron-secret). Chaque tâche traite TOUTES les entreprises
// en quelques requêtes groupées (INSERT … SELECT), jamais en boucle par entreprise : budget de 10 ms de CPU.
// Portage de lg_watchdog (surveillance, toutes les 5 min) et lg_purge (nettoyage, une fois par heure).
import { HttpError, json } from '../http.js';
import { sendPending, render, DEFAULT_TEMPLATES } from '../rpc/messages.js';
import { sendWebhooks } from '../rpc/webhooks.js';

const cfg = (key, def) => `coalesce(json_extract(co.settings, '$.${key}'), ${def})`;
const minutesSince = (col) => `((julianday(?1) - julianday(${col})) * 1440)`;

/** Surveillance (lg_watchdog) : retards, arrêts longs, chauffeurs sans position, colis oubliés, documents, verrous. */
export function watchdogStatements(db, now) {
  const today = now.slice(0, 10);
  const in15 = new Date(Date.parse(`${today}T00:00:00Z`) + 15 * 86400000).toISOString().slice(0, 10);
  const alert = (select) => db.prepare(`INSERT OR IGNORE INTO alerts (company_id, kind, severity, message, trip_id, stop_id, package_id, dedupe_key) ${select}`);
  return [
    // retards sur l'heure estimée (plus de 20 min)
    alert(`SELECT t.company_id, 'late', 'warning', 'Voyage ' || t.number || ', arrêt ' || s.seq || ' : ' || CAST(round(${minutesSince('s.eta')}) AS INTEGER) || ' min de retard',
        t.id, s.id, NULL, 'late:' || s.id
      FROM trip_stops s JOIN trips t ON t.id = s.trip_id JOIN companies co ON co.id = t.company_id
     WHERE co.suspended_at IS NULL AND t.status = 'in_progress' AND s.status IN ('pending', 'en_route') AND s.eta IS NOT NULL AND ${minutesSince('s.eta')} > 20`).bind(now),
    // arrêt anormalement long
    alert(`SELECT t.company_id, 'long_stop', 'warning', 'Voyage ' || t.number || ' : arrêt ' || s.seq || ' depuis ' || CAST(round(${minutesSince('s.arrived_at')}) AS INTEGER) || ' min',
        t.id, s.id, NULL, 'long:' || s.id
      FROM trip_stops s JOIN trips t ON t.id = s.trip_id JOIN companies co ON co.id = t.company_id
     WHERE co.suspended_at IS NULL AND t.status = 'in_progress' AND s.status = 'arrived' AND ${minutesSince('s.arrived_at')} > ${cfg('stop_max_minutes', 15)}`).bind(now),
    // chauffeur sans position pendant un voyage (une alerte par heure au plus)
    alert(`SELECT t.company_id, 'driver_offline', 'warning', 'Voyage ' || t.number || ' : ' || c.name || ' sans position depuis ' || coalesce(substr(c.last_seen_at, 12, 5), 'le départ'),
        t.id, NULL, NULL, 'offline:' || t.id || ':' || substr(?1, 1, 13)
      FROM trips t JOIN couriers c ON c.id = t.courier_id JOIN companies co ON co.id = t.company_id
     WHERE co.suspended_at IS NULL AND t.status = 'in_progress' AND ${minutesSince('coalesce(c.last_seen_at, t.started_at)')} > ${cfg('offline_max_minutes', 20)}`).bind(now),
    // colis oubliés à quai
    alert(`SELECT p.company_id, 'stale_package', 'info', 'Colis ' || p.code || ' (' || coalesce(p.zone, '?') || ') à quai depuis plus de ' || ${cfg('staged_max_hours', 24)} || ' h',
        NULL, NULL, p.id, 'stale:' || p.id
      FROM packages p JOIN companies co ON co.id = p.company_id
     WHERE co.suspended_at IS NULL AND p.status = 'staged' AND ${minutesSince('p.updated_at')} > ${cfg('staged_max_hours', 24)} * 60
       AND NOT EXISTS (SELECT 1 FROM trip_packages tp WHERE tp.package_id = p.id AND tp.outcome IS NULL)`).bind(now),
    // documents qui expirent sous 15 jours (sans remplaçant plus récent)
    alert(`SELECT d.company_id, 'doc_expiring', 'info', coalesce(v.plate, c.name, '?') || ' : ' || replace(d.kind, '_', ' ') || ' expire le '
          || substr(d.expires_at, 9, 2) || '/' || substr(d.expires_at, 6, 2) || '/' || substr(d.expires_at, 1, 4), NULL, NULL, NULL, 'doc:' || d.id
      FROM vehicle_documents d JOIN companies co ON co.id = d.company_id LEFT JOIN vehicles v ON v.id = d.vehicle_id LEFT JOIN couriers c ON c.id = d.courier_id
     WHERE co.suspended_at IS NULL AND d.expires_at BETWEEN ?2 AND ?3
       AND NOT EXISTS (SELECT 1 FROM vehicle_documents d2 WHERE d2.company_id = d.company_id AND d2.kind = d.kind AND d2.expires_at > d.expires_at
                        AND (d2.vehicle_id = d.vehicle_id OR d2.courier_id = d.courier_id))`).bind(now, today, in15),
    // préparations verrouillées par un préparateur inactif : libérées
    db.prepare(`UPDATE pick_tasks SET picker_id = NULL WHERE status = 'picking' AND picker_id IS NOT NULL AND last_activity_at IS NOT NULL
        AND ${minutesSince('last_activity_at')} > 4 * (SELECT ${cfg('pick_lock_minutes', 15)} FROM companies co WHERE co.id = pick_tasks.company_id)`).bind(now),
  ];
}

/** Nettoyage (lg_purge) : positions et rejeux de plus de 30 jours, alertes traitées, sessions et limites expirées. */
export function purgeStatements(db, now) {
  const d30 = new Date(Date.parse(now) - 30 * 86400000).toISOString();
  const d1 = new Date(Date.parse(now) - 86400000).toISOString();
  return [
    db.prepare('DELETE FROM driver_positions WHERE recorded_at < ?').bind(d30),
    db.prepare('DELETE FROM action_log WHERE created_at < ?').bind(d30),
    db.prepare('DELETE FROM alerts WHERE acked_at IS NOT NULL AND acked_at < ?').bind(d30),
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    db.prepare('DELETE FROM rate_limits WHERE ts < ?').bind(d1),
  ];
}

/**
 * Rapport du soir au gérant (lg_evening_report), pour chaque entreprise qui a renseigné un numéro ou une adresse :
 * chiffres du jour en une requête groupée, message déposé dans la file (envoi par la tâche « messages »).
 */
export async function eveningReport(env, now) {
  const day = now.slice(0, 10); const from = `${day}T00:00:00.000Z`; const d24 = new Date(Date.parse(now) - 86400000).toISOString();
  const rows = (await env.DB.prepare(
    `SELECT co.id, co.name, json_extract(co.settings, '$.manager_phone') AS phone, json_extract(co.settings, '$.manager_email') AS email,
            (SELECT body_fr FROM message_templates m WHERE m.company_id = co.id AND m.event_key = 'lg_evening_report' AND m.active = 1) AS body,
            (SELECT count(*) FROM message_templates m WHERE m.company_id = co.id AND m.event_key = 'lg_evening_report' AND m.active = 0) AS off,
            (SELECT count(*) FROM scan_events e WHERE e.company_id = co.id AND e.event = 'deliver' AND e.server_at >= ?1) AS livres,
            (SELECT count(*) FROM scan_events e WHERE e.company_id = co.id AND e.event = 'fail' AND e.server_at >= ?1) AS echecs,
            (SELECT round(100.0 * sum(p.attempts = 0) / nullif(count(*), 0)) FROM scan_events e JOIN packages p ON p.id = e.package_id
              WHERE e.company_id = co.id AND e.event = 'deliver' AND e.server_at >= ?1) AS premiere,
            (SELECT round(100.0 * sum(s.completed_at <= coalesce(s.window_end, strftime('%Y-%m-%dT%H:%M:%fZ', s.eta, '+30 minutes'))) / nullif(count(*), 0))
               FROM trip_stops s WHERE s.company_id = co.id AND s.status = 'delivered' AND s.completed_at >= ?1) AS ponctualite,
            (SELECT coalesce(sum(abs(gap_fcfa)), 0) FROM cash_remittances r WHERE r.company_id = co.id AND r.validated_at >= ?1) AS especes,
            (SELECT count(*) FROM packages p WHERE p.company_id = co.id AND p.status = 'staged' AND p.updated_at < ?2) AS a_quai
       FROM companies co WHERE co.suspended_at IS NULL
        AND (coalesce(json_extract(co.settings, '$.manager_phone'), '') <> '' OR coalesce(json_extract(co.settings, '$.manager_email'), '') <> '')`,
  ).bind(from, d24).all()).results;
  const def = DEFAULT_TEMPLATES.find((t) => t.event_key === 'lg_evening_report').body_fr;
  const stmts = rows.filter((r) => !r.off).map((r) => {
    const vars = { entreprise: r.name, livres: r.livres, echecs: r.echecs, premiere_presentation: r.premiere ?? '—', ponctualite: r.ponctualite ?? '—', especes: r.especes, a_quai: r.a_quai };
    const phone = String(r.phone ?? '').replace(/\D/g, '').slice(-9) || null;
    return env.DB.prepare('INSERT INTO outbox (id, company_id, event_key, phone, email, vars, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), r.id, 'lg_evening_report', phone, r.email || null, JSON.stringify(vars), render(r.body ?? def, vars), now);
  });
  if (stmts.length) await env.DB.batch(stmts);
  return { reports: stmts.length };
}

const TASKS = { watchdog: watchdogStatements, purge: purgeStatements };
const JOBS = { messages: async (env, now) => ({ ...(await sendPending(env, now)), ...(await sendWebhooks(env, now)) }), evening: eveningReport };

function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length < 16) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** POST /api/cron/<tâche> */
export async function run(request, env, { task }) {
  if (!env.CRON_SECRET) throw new HttpError(503, 'Tâches planifiées non configurées (secret CRON_SECRET).', 'cron_disabled');
  if (!sameSecret(request.headers.get('x-cron-secret'), env.CRON_SECRET)) throw new HttpError(403, 'Accès refusé.', 'forbidden');
  const build = TASKS[task]; const job = JOBS[task];
  if (!build && !job) throw new HttpError(404, 'Tâche inconnue.', 'unknown_task');
  const now = new Date().toISOString();
  let result;
  if (build) {
    const res = await env.DB.batch(build(env.DB, now));
    result = { changes: res.reduce((s, r) => s + (r.meta?.changes ?? 0), 0) };
  } else result = await job(env, now);
  await env.DB.prepare('INSERT INTO cron_runs (task, ran_at, result) VALUES (?, ?, ?) ON CONFLICT (task) DO UPDATE SET ran_at = excluded.ran_at, result = excluded.result')
    .bind(task, now, JSON.stringify(result)).run();
  return json({ ok: true, task, ...result });
}
