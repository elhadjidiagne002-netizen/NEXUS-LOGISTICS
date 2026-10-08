# NEXUS LOGISTICS — notes pour Claude / contributeurs

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
15. **Bash Windows** : les heredocs Python avec apostrophes cassent sous Git Bash ; passer par
    un fichier de script.

## Tests
- `npm test` : 65 tests (PGlite = Postgres 18 en WebAssembly, pgcrypto inclus), dont un
  fichier par cycle (`test/sql/cycle1..8.test.mjs`) qui part de la journée de démo.
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
   (réglage `invoice_issuer`), nombre de présentations (`max_attempts`).
3. Brancher : envoi des événements `lg_*` de `notification_outbox` (modèles WhatsApp de
   l'annexe B à ajouter côté `functions/api/_lib/notify.js` de NEXUS) ; `lg_handle_reply`
   dans le webhook WhatsApp entrant ; `lg_watchdog()` (toutes les 5 min) et `lg_purge()`
   + `lg_evening_report()` dans `nexus_cron_horaire()` (CLAUDE.md NEXUS §18 : une seule
   fenêtre d'écriture par heure).
4. Déployer `dist/` sur Cloudflare Pages (`npm run build`), variables `VITE_SUPABASE_*`.
5. Attribuer les rôles (`/admin` → Rôles) et les fiches véhicules.
