# NEXUS LOGISTICS — notes pour Claude / contributeurs

## Ce qu'est le projet (depuis le 08/10/2026)
**Service payant ouvert à toute entreprise qui livre** (formules gratuite et Pro), **sans mode démo**, hébergé
**entièrement sur Cloudflare** (Pages + Pages Functions + D1 + R2), **sans coût financier**. En production sur
**https://logistique.nexusmarket.sn** depuis la bascule du 08/10/2026. Il ne vit plus dans la base Supabase de
NEXUS Market : NEXUS Market est une entreprise cliente comme une autre (API par clé, `docs/integration-boutiques.md`).
Plan et état : **`ROADMAP.md`**. Historique : `JOURNAL.md`.

### Architecture
- **Interface** : app React/Vite (`src/`). Elle n'appelle que `rpc(nom, args)` (`src/lib/backend.js`) →
  `POST /api/rpc/<nom>`. Il n'y a plus de mode démo ni de mode Supabase (supprimés à la bascule).
- **Serveur** : `functions/api/[[path]].js` → `server/app.js` (routes de compte) → `server/rpc/index.js`
  (répartiteur). Fonctions métier dans `server/rpc/<module>.js`, déclarées
  `lg_xxx: { roles, handler(ctx, args) }`, à ajouter au `REGISTRY`. Runtime Workers : pas de module Node.
- **Base** : D1 `nexus-logistics` (id dans `wrangler.toml`), migrations **`migrations/NNNN_*.sql`**
  (SQLite). En ligne : `npx wrangler d1 migrations apply nexus-logistics --remote` AVANT de déployer.
  `deploy.yml` les applique automatiquement avant chaque publication.
- **Tâches planifiées** : appelées par **`nexus-cron`**, le planificateur de NEXUS Market (dépôt `nexus-market`,
  `cron-worker/src/logistique.js`), toutes les 5 min → `POST /api/cron/<tâche>` avec l'en-tête `x-cron-secret`.
  Le Worker dédié `nexus-logistics-cron` n'a **jamais** été déclenché par Cloudflare (08/10/2026 : déclencheur
  enregistré, 0 invocation en 1 h 20) : retiré du dépôt, déclencheur coupé. Le secret partagé vit dans le
  secret GitHub `NXL_CRON_SECRET` de nexus-market (posé dans le Worker par `deploy-cron-worker.yml`) ET dans
  `CRON_SECRET` de ce projet Pages : pour le changer, poser la nouvelle valeur aux DEUX endroits depuis un même
  fichier généré (jamais retapée), redéployer ce projet, relancer `deploy-cron-worker.yml`. Vérifier par les
  effets : `select * from cron_runs` (dernier passage de chaque tâche).
- **Secrets Pages** (jamais dans le dépôt) : `CRON_SECRET`, `SECRETS_KEY` (chiffre les jetons WhatsApp des
  entreprises : **ne jamais la changer**, les jetons enregistrés deviendraient illisibles), `ADMIN_EMAILS`
  (administration de la plateforme), `BREVO_API_KEY` facultatif.
- **Administration de la plateforme : https://logistique.nexusmarket.sn/admin/** (page à part, `admin/index.html` →
  `src/admin/`), comme My shop et CV en ligne : connexion avec le **compte Devizo** (même e-mail et mot de passe ;
  base `devizo` reliée en **lecture seule** par `AUTH_DB`, `server/devizo.js`, jamais d'écriture ni de migration
  dessus) et e-mail obligatoirement dans `ADMIN_EMAILS` (revérifié à chaque appel). Session à part (cookie
  `lg_admin`, `/api/admin`, 12 h) qui ne donne accès qu'aux fonctions `roles: 'platform'` via
  `/api/admin/rpc/<nom>` (`server/routes/admin.js`) ; toute fonction sans `read: true` est écrite dans
  `admin_audit`. Nouvelle fonction d'administration → `server/rpc/plateforme.js` (rôle `platform`, sans filtre
  d'entreprise, voulu). En local : `.dev.vars` (ignoré par git) avec `DEV_ADMIN_EMAIL` / `DEV_ADMIN_PASSWORD`
  → `scripts/api-dev.mjs` simule la base Devizo.
- **Stock** : LE chiffre de stock d'un produit est `products.stock` (NULL = non suivi). Il ne change QUE par
  `stockMoveStatements()` (`server/rpc/stock.js`), dans le même lot que l'écriture qui le cause : préparation
  (chaque unité scannée), rupture, rangement / réception, correction motivée, inventaire, rebut, retours. Chaque
  appel écrit une ligne `stock_moves` (historique). Ne jamais faire `UPDATE products SET stock` à la main.
  Les quantités par emplacement (`product_locations`) restent le détail physique d'entrepôt. Modifier une fiche
  produit ne touche jamais au stock (stock de départ à la création seulement). Écran : `/stock`
  (`src/screens/Stock.jsx`, `server/rpc/produits.js`).
- **Historique** : la version Postgres d'origine (`supabase/`, `test/sql/`, mode démo PGlite) a été supprimée
  après portage complet ; pour relire sa logique : `git show 708861b:supabase/migrations/<fichier>`.

### Règles (à respecter dans toute évolution)
1. **Multi-entreprises** : toute table métier a `company_id` ; **toute** requête d'un handler filtre sur
   `ctx.company.id`, y compris les UPDATE/DELETE par id (`WHERE id = ? AND company_id = ?`), puis vérifie
   `meta.changes`. Chaque cycle ajoute un test d'isolation (une autre entreprise ne voit ni ne modifie rien).
   Ne jamais renvoyer « n'existe pas » différemment de « pas à vous » (même code `unknown_*`).
2. **Rôles** : `roles: 'public' | 'member' | 'admin' | ['dispatcher', …]` (admin = owner/admin de
   l'entreprise, toujours autorisé). Le test « toute fonction non publique refuse un visiteur » parcourt
   le REGISTRY : une fonction `public` doit être voulue (page de suivi par jeton secret).
3. **Pas de transaction interactive dans D1** : écritures multiples = `env.DB.batch([...])` (atomique) ;
   transitions d'état par UPDATE **conditionnel** (`WHERE status = 'x'`) + contrôle de `meta.changes`
   au lieu de `SELECT … FOR UPDATE` ; insertions dépendantes conditionnées dans le même lot
   (`INSERT … SELECT … WHERE EXISTS (…)`, cf. `acceptInvite`).
   Pour annuler tout un lot si l'état a changé depuis la lecture : `guard(db, 'condition SQL', params)` dans le lot
   et `runBatch(ctx, stmts, 'code_erreur')` (`server/rpc/core.js`). Pas d'apostrophe dans un commentaire `--` à
   l'intérieur d'une requête : la D1 imitée des tests compte mal les paramètres.
4. **Idempotence** des actions de terrain : `idempotent(ctx, nom, args.p_event, fn)` (`server/rpc/core.js`).
5. **Un refus métier qui doit laisser une trace ne lève pas d'erreur** : renvoyer `{ ok:false, error }` après
   avoir écrit (ex. essais du code client décomptés). Les autres refus : `fail('code')` → `{ error: code }`.
   Tout nouveau code d'erreur a sa phrase dans `src/lib/errors.js`.
6. **Numéros visibles sans trou** : `nextCounter(ctx, 'facture-2026')` (table `counters`), jamais
   AUTOINCREMENT ni aléatoire pour un numéro montré au client.
7. **Montants en FCFA entiers** (plus de conversion EUR ×655,957 : ce n'est plus la base NEXUS Market).
8. **Budget gratuit Cloudflare** (à garder en tête à chaque fonction) : Workers 100 000 requêtes/jour et
   **10 ms de CPU par requête** ; D1 5 M lectures et **100 000 écritures/jour**, 5 Go ; R2 10 Go.
   → GPS au plus toutes les 30 s, interrogation (polling) 20-30 s au lieu du temps réel, pas de dépendance
   npm lourde dans `server/` (mesurer : `npx wrangler check startup --pages`), requêtes groupées
   (`json_group_array`, `batch`) plutôt qu'en boucle. D1 limite à 100 paramètres liés par requête.
9. **Jamais `502`** comme code d'erreur (Cloudflare remplace le corps) : `500`.
10. Dates en texte ISO UTC (`ctx.now`) ; affichage à l'heure de Dakar côté interface.

### Tests et aperçu
- `npm run test:server` : tests du portage (D1 imitée sur `node:sqlite`, `test/helpers/d1-mock.js`, aussi
  stricte que D1 sur le nombre de paramètres) ; `test/helpers/api-client.js` (`register`, `invite`, `rpc`,
  `rpcError`). `env.DB.calls` compte les allers-retours vers D1 (un `batch` = 1) : l'utiliser pour borner une
  fonction qui traite un lot (import, API : ≤ 50 commandes par appel). `npm test` = serveur + algorithmes.
- Aperçu local : configuration `logistics-full` (port 5611) du launch.json de nexus-market =
  `scripts/api-dev.mjs` (API sur `.wrangler/dev.sqlite`, port 8789) + Vite (proxy `/api`).
- **La base D1 de production contient de vraies entreprises** (première inscription le 08/10/2026) : ne jamais
  y faire d'essai qui écrit ; la prévisualisation `--branch complet` partage cette même base.

---

# Pièges d'interface toujours valables (hérités de la première version)
- **Service worker** : mettre en cache `/`, jamais `/index.html` (308 de Cloudflare Pages → réponse redirigée
  servie à une navigation = site inaccessible ; incident du 01/10/2026).
- **Leaflet dans une fenêtre** : `.map` a son propre contexte d'empilement (`isolation`), sinon la carte passe
  devant les fenêtres modales.
- **Logo SVG** : identifiant de dégradé unique par instance (`useId`) ; un dégradé défini dans un bloc masqué
  n'est pas rendu par Chrome.
- **`Field` + `Chips`** : un `<label>` autour de boutons active le premier quand on touche l'intitulé ; `Field`
  rend un `<div>` si son enfant est un `Chips`. Ne pas envelopper un groupe de boutons dans un `<label>`.
- **Bash Windows** : les heredocs Python avec apostrophes cassent sous Git Bash ; passer par un fichier de script.
