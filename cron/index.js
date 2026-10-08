// Déclencheur des tâches planifiées : appelle POST <API_URL>/api/cron/<tâche> avec le secret partagé.
// Toutes les 5 min : surveillance (retards, arrêts longs, chauffeurs sans position…) et envoi de la file de messages.
// Une fois par heure (premier passage de l'heure) : nettoyage ; à 19 h (Dakar = UTC) : rapport du soir au gérant.
// Un échec DOIT faire échouer l'exécution (piège vu sur nexus-cron : un Worker qui attrape ses erreurs est compté
// « en succès » par Cloudflare, et 606 passages en 401 sont passés inaperçus) → on attend toutes les tâches et on lève.
export default {
  async scheduled(event, env) {
    const at = new Date(event.scheduledTime); const first = at.getUTCMinutes() < 5;
    const tasks = ['watchdog', 'reminders', 'messages', ...(first ? ['purge'] : []), ...(first && at.getUTCHours() === 19 ? ['evening'] : [])];
    const results = await Promise.all(tasks.map((task) =>
      fetch(`${env.API_URL}/api/cron/${task}`, { method: 'POST', headers: { 'x-cron-secret': env.CRON_SECRET }, signal: AbortSignal.timeout(25000) })
        .then(async (r) => (r.ok ? null : `${task} : HTTP ${r.status} ${(await r.text()).slice(0, 200)}`))
        .catch((e) => `${task} : ${e?.message ?? e}`)));
    const failed = results.filter(Boolean);
    if (failed.length) throw new Error(`Tâches en échec (${failed.length}/${tasks.length}) — ${failed.join(' | ')}`);
  },
};
