// Déclencheur des tâches planifiées : appelle POST <API_URL>/api/cron/<tâche> avec le secret partagé.
// Toutes les 5 min : surveillance (retards, arrêts longs, chauffeurs sans position…) et envoi de la file de messages.
// Une fois par heure (premier passage de l'heure) : nettoyage ; à 19 h (Dakar = UTC) : rapport du soir au gérant.
export default {
  async scheduled(event, env, ctx) {
    const at = new Date(event.scheduledTime); const first = at.getUTCMinutes() < 5;
    const tasks = ['watchdog', 'messages', ...(first ? ['purge'] : []), ...(first && at.getUTCHours() === 19 ? ['evening'] : [])];
    for (const task of tasks) {
      ctx.waitUntil(fetch(`${env.API_URL}/api/cron/${task}`, { method: 'POST', headers: { 'x-cron-secret': env.CRON_SECRET } })
        .then(async (r) => { if (!r.ok) console.error('cron', task, r.status, await r.text()); })
        .catch((e) => console.error('cron', task, e?.message)));
    }
  },
};
