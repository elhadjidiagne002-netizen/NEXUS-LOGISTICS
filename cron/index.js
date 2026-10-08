// Déclencheur des tâches planifiées : appelle POST <API_URL>/api/cron/<tâche> avec le secret partagé.
// Toutes les 5 min : surveillance (retards, arrêts longs, chauffeurs sans position…).
// Une fois par heure (premier passage de l'heure) : nettoyage. 0 requête de plus que nécessaire (budget gratuit).
export default {
  async scheduled(event, env, ctx) {
    const minute = new Date(event.scheduledTime).getUTCMinutes();
    const tasks = ['watchdog', ...(minute < 5 ? ['purge'] : [])];
    for (const task of tasks) {
      ctx.waitUntil(fetch(`${env.API_URL}/api/cron/${task}`, { method: 'POST', headers: { 'x-cron-secret': env.CRON_SECRET } })
        .then(async (r) => { if (!r.ok) console.error('cron', task, r.status, await r.text()); })
        .catch((e) => console.error('cron', task, e?.message)));
    }
  },
};
