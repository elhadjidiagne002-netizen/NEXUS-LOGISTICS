# NEXUS LOGISTICS — notes pour Claude / contributeurs

## ⚠️ Changement de cible (08/10/2026) — LIRE D'ABORD
Décision de l'utilisateur : NEXUS Logistics devient un **service payant ouvert à toute entreprise qui livre**,
**sans mode démo**, hébergé **entièrement sur Cloudflare** (Pages + Pages Functions + D1 + R2), **sans coût
financier**. Il ne vit plus dans la base Supabase de NEXUS Market. Plan par cycles : **`ROADMAP.md`**
(faire le premier cycle non terminé). Historique : `JOURNAL.md`.

### Architecture cible
- **Interface** : la même app React/Vite (`src/`). Elle n'appelle que `rpc(nom, args)` (`src/lib/backend.js`).
  Mode **`api`** = `npm run build:api` / `npm run dev:api` : `POST /api/rpc/<nom>`. Les modes `demo`
  (PGlite) et `supabase` sont **à supprimer à la bascule** (cycle C6), pas avant.
- **Serveur** : `functions/api/[[path]].js` → `server/app.js` (routes de compte) → `server/rpc/index.js`
  (répartiteur). Fonctions métier dans `server/rpc/<module>.js`, déclarées
  `lg_xxx: { roles, handler(ctx, args) }`, à ajouter au `REGISTRY`. Runtime Workers : pas de module Node.
- **Base** : D1 `nexus-logistics` (id dans `wrangler.toml`), migrations **`migrations/NNNN_*.sql`**
  (SQLite). En ligne : `npx wrangler d1 migrations apply nexus-logistics --remote` AVANT de déployer.
- **Référence** : `supabase/migrations/*.sql` (version Postgres, 176 fonctions) et `test/sql/*.test.mjs`
  sont le **cahier des charges** du portage : mêmes noms de fonction, mêmes arguments `p_*`, même forme
  de résultat (l'interface en dépend). Ne plus les modifier, sauf pour les supprimer au cycle C11.

### Règles du portage (à respecter dans chaque cycle)
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
  fonction qui traite un lot (import, API : ≤ 50 commandes par appel). `npm test` lance aussi les 103 tests Postgres (~15 min, PGlite) : en arrière-plan.
- Aperçu local de la version complète : configuration `logistics-full` (port 5611) du launch.json de
  nexus-market = `scripts/api-dev.mjs` (API sur `.wrangler/dev.sqlite`, port 8789) + `vite --mode api`.
- Prévisualisation en ligne : `npm run build:api && npx wrangler pages deploy dist --project-name
  nexus-logistics --branch complet` → https://complet.nexus-logistics-6my.pages.dev (même base D1 que la
  production : effacer les données d'essai après vérification). Production = https://logistique.nexusmarket.sn.

---

# Archive — version Postgres (cible abandonnée le 08/10/2026), utile comme référence du portage

App web installable (React + Vite) distincte du site NEXUS Market, qui parle à la **même
base Supabase** (projet `pqcqbstbdujzaclsiosv`). Toute la logique métier est en SQL
(fonctions `lg_*`), les écrans ne font qu'appeler `rpc()`. Dossier de référence :
`NEXUS-LOGISTICS-Dossier-de-conception-v2.pdf`. Historique : `JOURNAL.md`.

**Règle** : à la fin de chaque session non triviale, ajouter une entrée en haut de
`JOURNAL.md` (fait, pourquoi, état).

## Règles de conception (chapitre 08) — à respecter partout
- **Aucune écriture directe** dans une table `lg_*` depuis une app : toute transition passe
  par une fonction (rôle → rejeu → verrou → conditions → écriture → journal).
- **`lg_scan_events` est en ajout seul** (déclencheur). Corriger = nouvel événement.
- **Idempotence** : toute action de terrain prend `p_event uuid` ; `lg_idem_get/put`
  (table `lg_action_log`) renvoie le résultat déjà calculé si l'action est rejouée.
- **Une erreur qui doit laisser une trace ne lève pas d'exception** : `lg_deliver` renvoie
  `{ok:false, error:'bad_code'}` après avoir décrémenté les essais (une exception
  annulerait la décrémentation). Les autres refus métier font de même.
- **Montants** : base en EUR (comme NEXUS), affichage et factures en FCFA entiers via
  `lg_fcfa()` (× 655,957). Montant dû = `lg_order_due_fcfa()` (ruptures exclues, remise
  au prorata, + livraison) : **le même chiffre pour le chauffeur et la facture**.
- Déclencheurs posés sur `orders` (`lg_order_items_sync`, `lg_order_ready`) : **jamais
  bloquants** pour le site (exception attrapée → `audit_logs` `lg.*_failed`), et la
  facture est dans un bloc séparé de l'ouverture de la préparation.

## Pièges rencontrés (ne pas les réintroduire)
1. **Droits des fonctions** : Supabase donne EXECUTE à `anon` ET `authenticated` sur toute
   nouvelle fonction (cf. NEXUS CLAUDE.md §13). La migration `29991231000000_droits_toujours_en_dernier.sql` (nom choisi pour passer APRÈS toutes les autres) ferme tout
   puis ouvre **par liste**. Toute nouvelle fonction appelable doit y être ajoutée, sinon
   elle est inaccessible (et c'est voulu). Le test `test/sql/droits.test.mjs` vérifie la
   liste exacte des fonctions ouvertes à `anon` — il casse si on en ajoute une par erreur.
2. **`if not (rôle or x = auth.uid())`** laisse passer quand `x` est NULL (NULL ≠ faux).
   Toujours `coalesce(x = auth.uid(), false)`. Trouvé par le test 12 (facture lisible par
   un chauffeur quelconque quand `buyer_id` était vide — 49 commandes sur 53 sont sans compte).
3. **`tableau || 'texte'`** : Postgres lit le littéral comme un tableau → « malformed
   array literal ». Utiliser `array_append()`.
4. **Numéros sans trou** : une **séquence** Postgres perd des valeurs (transaction annulée,
   et jusqu'à 32 d'un coup après un redémarrage brutal — vu en démo : factures 000004 puis
   000034, voyages 2 puis 34). `generate_invoice_number` (prod) est donc écarté : factures et
   avoirs via `lg_next_seq()` (par année), voyages, incidents et vagues via
   `lg_next_counter()` (perpétuel), tous deux sur `invoice_sequences` sous verrou. Ne pas
   créer de nouvelle séquence pour un numéro visible.
5. **Code interne produit** `NXI-` + 8 premiers caractères de l'UUID : ne pas fabriquer
   d'identifiants de démo qui partagent leur préfixe (collision constatée).
6. **Mode démo PGlite** : `relaxedDurability: true` obligatoire (sinon chaque requête
   attend IndexedDB et l'installation ne finit pas). Empreinte (`src/demo/sql.js` `VERSION`)
   = migrations + miroir + données + **scénario** : toute modification réinstalle la démo.
   Ne pas ouvrir deux onglets de la démo en même temps (même base IndexedDB).
7. **Service worker** : mettre en cache `/`, jamais `/index.html` (308 de Cloudflare Pages →
   réponse redirigée servie à une navigation = site inaccessible ; incident du 01/10/2026).
8. **Chemins de l'espace privé `lg-proofs`** : la règle de stockage exige que le premier
   segment soit l'id du voyage pour un chauffeur (`<voyage>/<arrêt>/<uuid>.jpg`).

9. **Ordre des migrations** : les droits sont dans `29991231000000_droits_toujours_en_dernier.sql`.
   Toute nouvelle fonction appelable par une app doit être ajoutée à sa liste (sinon elle
   reste fermée), toute fonction publique à `public_fns` ET à la liste attendue de
   `test/sql/droits.test.mjs`.
10. **Leaflet dans une fenêtre** : `.map` a son propre contexte d'empilement (`isolation`),
    sinon la carte passe devant les fenêtres modales.
11. **Logo SVG** : identifiant de dégradé unique par instance (`useId`) ; un dégradé défini
    dans un bloc masqué n'est pas rendu par Chrome.
12. **Lots (`lg_stock_lots`)** : somme des lots ≤ `lg_product_locations.qty`. Ne jamais baisser un
    emplacement en contournant le déclencheur `lg_product_locations_lots_clamp`, et toujours passer par
    `lg_pick_location_id` (FEFO) pour choisir où prélever. Changer la signature d'une fonction
    (`lg_put_away`) : `drop function` de l'ancienne d'abord, sinon deux surcharges coexistent.
13. **Test dépendant du jour** : la démo déclare un pic le vendredi ; un test de prévision doit
    remettre `peak_days` à vide (il échouait chaque jeudi).
14. **`Field` + `Chips`** : un `<label>` autour de boutons active le premier quand on touche
    l'intitulé ; `Field` rend un `<div>` si son enfant est un `Chips`. Ne pas envelopper un groupe de
    boutons dans un `<label>` à la main.
15. **Appareils** : les contrôles d'identité (`lg_has_role`, `lg_is_admin`, `lg_my_courier_id`,
    `lg_trip_courier_user`) intègrent `lg_device_blocked()`. Toute nouvelle fonction doit passer par
    eux (pas de `auth.uid()` comparé à la main pour un rôle), sinon un appareil bloqué y aurait accès.
16. **Bash Windows** : les heredocs Python avec apostrophes cassent sous Git Bash ; passer par
    un fichier de script.

## Tests
- `npm test` : 103 tests (PGlite = Postgres 18 en WebAssembly, pgcrypto inclus), dont un
  fichier par cycle (`test/sql/cycle1..22.test.mjs`) qui part de la journée de démo.
- `test/helpers/db.mjs` : `createDb()` charge le miroir + migrations + données ;
  `rpc(uid, nom, args)` appelle comme `supabase.rpc` sous l'identité `uid`.
- Le miroir `supabase/stub/prod_subset.sql` a été relevé **en lecture seule** sur la prod
  le 07/10/2026. Si une fonction échoue en prod et pas en test, vérifier d'abord qu'une
  colonne prod manque au miroir (déjà vu : `profiles.commission_rate`).

## Mise en production (non faite — décision de l'utilisateur)
1. Appliquer `supabase/migrations/*.sql` dans l'ordre sur une **branche de test Supabase**
   (le fichier `…0950_stockage_supabase_only.sql` y compris), lancer
   `select public.lg_backfill_order_items();` (reprise des 53 commandes), rejouer une journée.
2. Décisions à trancher avant (chapitre 14) : lieu de préparation (le code gère vendeur ET
   hub), sort des 22 commandes « en préparation » depuis l'été, émetteur de la facture
   (réglage `invoice_issuer`), nombre de présentations (`max_attempts`). Valeurs proposées à
   valider (cycles 6 à 14) : qui paie chaque cause de retour (`lg_return_causes`), plafond
   d'indemnisation sans assurance (`uninsured_cap_fcfa`), prime d'assurance, montants des
   suppléments nuit/pluie (désactivés par défaut).
3. Brancher : l'envoi des événements `lg_*` est codé côté NEXUS (`functions/api/_lib/lg-fallback.js`,
   via `/cron/notify-retry` : WhatsApp avec `vars.texte`, e-mail Brevo en secours) — vérifier `BREVO_API_KEY` ; `lg_handle_reply`
   dans le webhook WhatsApp entrant ; `lg_watchdog()` et `lg_vendor_reminders()` (toutes les 5 min) et `lg_purge()`
   + `lg_evening_report()` dans `nexus_cron_horaire()` (CLAUDE.md NEXUS §18 : une seule
   fenêtre d'écriture par heure).
4. Déployer `dist/` sur Cloudflare Pages (`npm run build`), variables `VITE_SUPABASE_*`.
5. Attribuer les rôles (`/admin` → Rôles) et les fiches véhicules.
