// Installe la base de démo : miroir des tables NEXUS Market, migrations (sauf celles
// propres à Supabase), jeu de données fictif. Mêmes fichiers que le banc de test.
import stub from '../../supabase/stub/prod_subset.sql?raw';
import seed from '../../supabase/seed/demo.sql?raw';
import scenarioSrc from './scenario.js?raw';

const migrations = import.meta.glob('../../supabase/migrations/*.sql', { query: '?raw', import: 'default', eager: true });

// Empreinte du schéma : si une migration change, la base de démo se réinstalle d'elle-même.
// le scénario compte aussi : une journée de démo modifiée doit être rejouée
const all = stub + seed + scenarioSrc + Object.keys(migrations).sort().map((k) => migrations[k]).join('');
let h = 0;
for (let i = 0; i < all.length; i++) h = (Math.imul(31, h) + all.charCodeAt(i)) | 0;
export const VERSION = (h >>> 0).toString(36);

export async function install(db) {
  await db.exec(stub);
  for (const [path, sql] of Object.entries(migrations).sort(([a], [b]) => a.localeCompare(b))) {
    if (path.includes('supabase_only')) continue;
    await db.exec(sql);
  }
  await db.exec(seed);
}
