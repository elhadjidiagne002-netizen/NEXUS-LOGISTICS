# Journal — NEXUS LOGISTICS

Le plus récent en premier.

## 08/10/2026 — Cycle C10 (Cloudflare) : intégration des boutiques en ligne
- **Fait** : `migrations/0010_integration.sql` (adresse de rappel, événements à envoyer) ; `server/rpc/webhooks.js`
  (événements signés HMAC-SHA256, envoi avec reprises) ; `GET /api/v1/orders/<référence>` ; événements créés à la
  confirmation, préparation, départ, livraison, échec et annulation ; carte « Statuts renvoyés » dans Administration
  → API boutiques ; notice `docs/integration-boutiques.md` (dont les étapes côté dépôt nexus-market).
- **Choix** : l'événement n'est créé que par un `INSERT … SELECT … WHERE EXISTS` (commande avec référence externe ET
  adresse active) : aucune lecture, aucune écriture pour les entreprises qui n'utilisent pas l'API.
- **Pas fait** : la partie dans le dépôt nexus-market (pas accessible depuis cette session).
- **État** : 77 tests serveur, builds OK.
- **À appliquer en ligne** : migration `0010_integration.sql`.

## 08/10/2026 — Cycle C9 (Cloudflare) : offre payante, plateforme, site public
- **Fait** : `migrations/0009_offre.sql` (paiements d'abonnement déclarés, erreurs de l'interface) ;
  `server/rpc/offre.js` (formules, quotas, abonnement, administration de la plateforme) ; `server/routes/public.js`
  (`GET /api/plans`, `POST /api/errors`) ; rôle `platform` dans le répartiteur (adresses `ADMIN_EMAILS`, sans
  entreprise active) ; écrans Plateforme et Administration → Abonnement ; formules sur la page d'accueil ; pages
  légales statiques, robots, sitemap, balises de partage ; remontée des erreurs JavaScript (`src/lib/report.js`).
- **Choix** : paiement déclaré + validation humaine (aucun prestataire de paiement payant) ; quota de lieux à 2 en
  gratuit (un dépôt et un relais) ; une entreprise suspendue perd l'accès ET ses pages de suivi.
- **État** : 74 tests serveur, 12 unitaires, builds OK ; accueil, abonnement et validation d'un paiement vérifiés.
- **À faire en ligne** : migration `0009_offre.sql` ; `ADMIN_EMAILS` (variable Pages) avec votre adresse.

## 08/10/2026 — Cycle C8 (Cloudflare) : messages aux clients
- **Fait** : `migrations/0008_messages.sql` (modèles modifiés, file d'envoi, instance WhatsApp de l'entreprise) ;
  `server/rpc/messages.js` (modèles, rendu, file, envoi Green API / Brevo, réponses) ; `server/routes/whatsapp.js`
  (webhook des réponses) ; tâches planifiées « messages » (toutes les 5 min) et « evening » (19 h) ; messages créés
  dans commandes, préparation, tournée, retours, incidents et renforts ; note du client rattachée au livreur (moyenne
  recalculée) ; Messages : bouton « Envoyer sur WhatsApp » (wa.me) ; Administration → WhatsApp.
- **Choix** : un message ne bloque jamais l'action (`sendLater` : lot séparé, erreur journalisée) ; le texte final
  est figé à la création ; le jeton WhatsApp est chiffré et n'est jamais renvoyé (table `channels`, pas les réglages
  lisibles par tous les membres) ; modèles lus une seule fois par requête (promesse gardée : import de 50 commandes).
- **État** : 69 tests serveur, 12 unitaires, builds OK ; file d'envoi et réglage WhatsApp vérifiés dans Chromium.
- **À faire en ligne** : migration `0008_messages.sql` ; `npx wrangler pages secret put SECRETS_KEY --project-name
  nexus-logistics` (et `BREVO_API_KEY` pour l'e-mail de secours).

## 08/10/2026 — Cycle C7 (Cloudflare) : pilotage et tâches planifiées
- **Fait** : `migrations/0007_pilotage.sql` (renforts, dernier passage des tâches) ; `server/rpc/pilotage.js`
  (tour de contrôle, acquittement des alertes, indicateurs, axes, coûts et marges, prévision, anomalies, classement,
  retours par cause, renforts) ; `server/routes/cron.js` (surveillance, nettoyage) ; Worker `cron/` (déclencheur).
- **Choix (budget)** : indicateurs calculés à la lecture (aucune écriture) ; la surveillance traite toutes les
  entreprises en 6 requêtes `INSERT OR IGNORE … SELECT` (une alerte par situation grâce à l'index `alerts_dedupe`) ;
  un seul déclencheur cron (offre gratuite : 5 par compte), le nettoyage tourne au premier passage de chaque heure.
- **État** : 63 tests serveur, 12 unitaires, builds OK ; tour de contrôle et pilotage vérifiés dans Chromium.
- **À faire en ligne** : migration `0007_pilotage.sql` ; `cd cron && npx wrangler deploy && npx wrangler secret put
  CRON_SECRET`, puis `npx wrangler pages secret put CRON_SECRET --project-name nexus-logistics` (même valeur).

## 08/10/2026 — Cycle C6 (Cloudflare) : caisse, factures, avoirs, relevés, incidents
- **Fait** : `migrations/0006_caisse.sql` (versements, versements intermédiaires, gains des chauffeurs, factures et
  lignes) ; modules `server/rpc/caisse.js` (caisse, rapprochement, gains, incidents) et `factures.js` (facture à la
  livraison, avoirs, montant en lettres, export comptable, relevés vendeurs) ; page de suivi : facture imprimable et
  réponse du client à une proposition d'indemnité ; réglages NINEA / RC / adresse / commission dans l'administration ;
  en-tête de facture au nom de l'entreprise. `test/helpers/scenario.js` partagé par les tests C5 et C6.
- **Choix** : numéros FAC-/AV- par entreprise et par année incrémentés dans le même lot D1 que la facture (lot annulé
  = aucun numéro perdu) ; « pas plus que facturé » contrôlé par `guard()` dans le lot ; rapprochement par passage
  conditionnel `completed → reconciled`, donc gains crédités une seule fois même en cas de double appel.
- **Pas fait (volontairement)** : la bascule de `deploy.yml` vers `build:api` — elle déploierait la version complète
  en production au prochain push, avant que les migrations 0003 à 0006 soient appliquées en ligne.
- **État** : 56 tests serveur, 12 unitaires, builds OK ; caisse (comptage, reçu, rapprochement), factures et gains
  vérifiés dans Chromium.
- **À appliquer en ligne** : `npx wrangler d1 migrations apply nexus-logistics --remote` → `0006_caisse.sql`.

## 08/10/2026 — Cycle C5 (Cloudflare) : livraison sur le terrain et retours
- **Fait** : `migrations/0005_terrain.sql` (codes de livraison, preuves, encaissements, adresses vérifiées, positions,
  dépenses, demandes de retour, causes et frais de retour, contrôles de retour, fichiers) ; modules
  `server/rpc/terrain.js` (journée du chauffeur, départ, appel, arrivée manuelle ou GPS, livraison avec code client
  ou signature + photo + encaissement exact, échec motivé, fin de tournée, SOS, dépenses, collecte, transferts) et
  `retours.js` (retour au quai, au vendeur, causes et qui paie, contrôle et remise en vente, reprises chez le client) ;
  route `server/routes/files.js` (photos et signatures, R2 ou repli D1) ; page de suivi complétée (livreur, heure,
  position, code à donner, passage manqué) ; fiche colis avec preuves et numéro de voyage ; frais de route dans les
  coûts de la flotte ; l'app chauffeur envoie sa position toutes les 30 s (au lieu de 10).
- **Pourquoi** : sans ce cycle, toute livraison s'arrêtait sur « Cette fonction n'est pas encore disponible ».
- **Choix** : code client gardé en clair (il s'affiche sur la page de suivi privée), nouveau à chaque départ ; un
  code faux décompte un essai et répond `{ ok:false, error:'bad_code' }` (règle 5). Photos dans D1 tant que R2 n'est
  pas branché (gratuit, ~150 Ko par photo compressée) — passer à R2 dès que le volume grossit (`wrangler.toml`).
- **État** : 49 tests serveur, 12 unitaires, builds OK ; tournée complète vérifiée dans Chromium (départ signé,
  code, photo envoyée puis relue, page de suivi « Livrée »).
- **À appliquer en ligne** : `npx wrangler d1 migrations apply nexus-logistics --remote` → `0005_terrain.sql`.

## 08/10/2026 — Cycle C4 (Cloudflare) : flotte, quai et voyages
- **Fait** : `migrations/0004_voyages.sql` ; modules `server/rpc/flotte.js` (véhicules, documents, entretien au km,
  contrôle avant départ, alertes, adresse de collecte) et `voyages.js` (voyages, arrêts, chargement contrôlé,
  bordereau, heures estimées, quais, collectes, réception, dépôts vendeurs, créneaux client, suggestions,
  planification automatique). Espace vendeur : « Adresse de collecte ».
- **Choix (budget D1)** : le plan de chargement (fond / milieu / porte, ordre) n'est plus stocké mais calculé à la
  lecture — la version Postgres réécrivait tous les colis du voyage à chaque scan. Un véhicule et un chauffeur
  n'ont qu'un voyage ouvert : index uniques partiels (sûr même en cas de double clic).
- **État** : 42 tests serveur, 12 unitaires, builds OK ; Quai (création, chargement, jauge) et Flotte vérifiés
  dans Chromium. Retours et transferts déplacés au C5.
- **À appliquer en ligne** : `npx wrangler d1 migrations apply nexus-logistics --remote` → `0004_voyages.sql`.

## 08/10/2026 — Cycle C3 (Cloudflare) : préparation et entrepôt
- **Fait** : `migrations/0003_preparation.sql` ; modules `server/rpc/preparation.js` (file, prise, scans, rupture,
  colisage, mise à quai, étiquettes, double contrôle, vagues, productivité), `entrepot.js` (emplacements, rangement
  par lot, inventaire, péremption, traçabilité, fiche colis) et `stock.js` (FEFO en JavaScript : remplace les
  déclencheurs Postgres de prélèvement et de cohérence des lots). Une commande confirmée ou payée d'avance ouvre sa
  préparation dans le même lot ; l'annulation emporte préparation et colis non partis ; le montant dû retire les
  ruptures. Réglage `prep_at_vendor` (préparation chez le vendeur). Le rejeu d'une action renvoie `replayed: true`.
- **Nouveau procédé** : `guard()` + `runBatch()` (`server/rpc/core.js`) — une assertion SQL dans un lot D1 annule
  tout le lot si l'état a changé entre la lecture et l'écriture (table `batch_guards` avec CHECK). Remplace le verrou.
- **État** : 32 tests serveur, 12 unitaires, builds OK ; Préparation et Entrepôt vérifiés dans Chromium.
- **À appliquer en ligne** : `npx wrangler d1 migrations apply nexus-logistics --remote` → `0003_preparation.sql`.

## 08/10/2026 — Cycle C2 (Cloudflare) : commandes, zones, tarifs, suivi client
- **Fait** : migration `migrations/0002_commandes.sql` (commandes, lignes, clients, catalogue, zones, grille, suppléments,
  numéros bannis, demandes, notes, clés d'API ; `company_id` partout) ; modules `server/rpc/tarifs.js`,
  `commandes.js`, `suivi.js` (35 fonctions, mêmes noms et formes que la version Postgres pour les écrans) ; route
  `POST /api/v1/orders` (`server/routes/api-v1.js`). Interface (mode api) : Service client → Commandes (saisie, détail,
  confirmation, assurance, annulation, lien WhatsApp, import CSV) et Produits ; Administration → Tarifs et zones
  (quartiers de Dakar en un clic, ajout de zone, prix au km) et API boutiques ; page de suivi au nom de l'entreprise.
- **Pourquoi** : la commande ne vient plus du site NEXUS ; elle naît chez chaque entreprise (téléphone, fichier, API).
- **Choix** : un import ou un envoi API = au plus 50 commandes, lectures groupées puis UN `batch` (≤ 10 allers-retours
  D1, mesuré par `D1Mock.calls`) ; numéro sans trou lu dans le compteur incrémenté par le même lot ; suppléments par
  défaut sans ligne en base (écrite seulement à la modification) ; `lg_quote` public par l'adresse publique
  (`p_company`) ; heure de Dakar = UTC (pas d'heure d'été).
- **État** : `test:server` 24/24, `test:unit` 12/12, `build` et `build:api` OK, `test:sql` 93/93 (référence inchangée) ;
  parcours vérifié dans Chromium (inscription → quartiers → tarif → commande → page de suivi). Rien déployé.
- **À appliquer en ligne (en local, avant déploiement)** : `npx wrangler d1 migrations apply nexus-logistics --remote`
  → applique `0002_commandes.sql`.

## 08/10/2026 — Changement de cible : service payant sur Cloudflare, sans démo ; cycle C1 (socle) fait
- **Décision de l'utilisateur** : NEXUS Logistics devient un **service ouvert à toute entreprise qui livre**
  (gratuit puis abonnement, comme Devizo et My shop), **sans mode démo**, **tout sur Cloudflare** (Pages,
  Functions, D1, R2), **sans coût financier**, développé **par cycles en cloud**. Raisons : la base Supabase
  de NEXUS est sur l'instance gratuite Nano, déjà saturée plusieurs fois ; un 2e projet Supabase gratuit se
  met en pause après 7 jours et a la même petite machine ; héberger pour de bon à part dans Supabase aurait
  obligé à synchroniser commandes et comptes entre deux bases.
- **Méthode** : portage de la logique Postgres en JavaScript sur D1 **sous les mêmes noms** (`rpc(nom, args)`),
  pour garder les écrans React ; les tests Postgres servent de cahier des charges. Plan : `ROADMAP.md`
  (C1 à C11, bascule du domaine et suppression de la démo au cycle C6). Règles : `CLAUDE.md` (en tête).
- **C1 fait ici** : D1 `nexus-logistics` (WEUR, `b6751d1e…`) + `migrations/0001_socle.sql` ; comptes
  (inscription d'entreprise, connexion, sessions, changement d'entreprise, mot de passe), invitations par
  lien à usage unique (y compris double clic), répartiteur `/api/rpc/<nom>` (session, entreprise, appareil
  bloqué, rôles), 16 fonctions du socle (`lg_me`, équipe et rôles, chauffeurs, lieux, réglages, appareils).
  Interface : mode `api`, écran connexion / « Créer mon entreprise », page `/invitation/<jeton>`, carte
  « Inviter par lien » (WhatsApp). 12 tests serveur (isolation entre entreprises, refus sans session de
  toute fonction, blocage d'appareil côté serveur, CSRF).
- **Vérifié** : en local (aperçu `logistics-full` : inscription → accueil propriétaire ; invitation →
  préparatrice qui ne voit que Préparation et Entrepôt) et **sur Cloudflare**
  (https://complet.nexus-logistics-6my.pages.dev : inscription, `lg_me`, refus sans session ; données
  d'essai effacées ensuite). La démo de logistique.nexusmarket.sn reste en place jusqu'à la bascule (C6).
- **Prochaine étape** : routine cloud qui réalise C2, C3… (un cycle par passage, `git pull` local après).

## 08/10/2026 — Domaine logistique.nexusmarket.sn en service
- Domaine rattaché au projet Pages `nexus-logistics` (API Pages, jeton wrangler) puis enregistrement DNS
  `CNAME logistique → nexus-logistics-6my.pages.dev` (proxifié) créé avec un jeton « Modifier le DNS de la
  zone » limité à nexusmarket.sn fourni par l'utilisateur (fichier supprimé après usage). 26 → 27
  enregistrements : rien d'autre touché. Domaine « actif », certificat HTTPS valide, `/`, `/suivi/…` et
  `/sw.js` en 200.
- **Lien de suivi des clients** : la valeur par défaut de `tracking_base_url` pointait sur
  `logistics.nexusmarket.sn` (jamais créé) → `https://logistique.nexusmarket.sn/suivi/` (migration du socle
  et exemple des modèles de messages ; rien n'était appliqué en base, donc corrigé à la source).
- `deploy.yml` : la vérification de fin de déploiement contrôle le nouveau domaine.

## 08/10/2026 — Reprise en local du travail de nuit + mise au niveau de la suite NEXUS
- **Rapatrié** : la branche cloud `claude/gallant-johnson-4atibs` (cycles 6 à 22) fusionnée dans `main`
  (avance simple, PR #1) ; côté NEXUS Market, la PR #4 (canal de secours e-mail `lg-fallback.js`) aussi.
- **Vérifié en local** : 103/103 tests ici, build Vite OK ; côté NEXUS 373/373 tests unitaires ; aucune
  contrainte en base sur `notification_outbox.whatsapp_status` (le statut `fallback_email` passe).
- **Mise au niveau** des autres sites (Devizo, My shop, CV) : liens « La suite NEXUS (gratuit) » sur
  l'écran de connexion et l'accueil, suivis par `?src=logistics-connexion` / `?src=logistics-accueil`.
- **Déploiement** : le workflow `deploy.yml` échoue faute du secret `CLOUDFLARE_API_TOKEN` dans ce dépôt ;
  démo republiée à la main (`wrangler pages deploy dist`).
- **Reste à décider par l'utilisateur** : secret GitHub du déploiement, remontée d'erreurs Sentry (projet à créer), et toujours la branche de test
  Supabase + décisions 1-3 du chapitre 14 avant toute application en prod.

## 08/10/2026 — Cycle 22 : appel de livreurs en renfort (module 04, P2 « Gestion des pics »)
- La prévision signalait la sous-capacité (« Appelez des livreurs en renfort ») sans moyen d'agir.
- `lg_reinforcement_call(jour, besoin, zones, note)` : un appel par jour ; chaque chauffeur actif reçoit
  le message `lg_reinforcement` (WhatsApp, e-mail de secours) **une seule fois** ; relancer met à jour
  le besoin sans renvoyer. Le chauffeur répond dans « Ma journée » (`lg_reinforcement_answer`) ; le
  répartiteur voit disponibles / non / sans réponse (`lg_reinforcements`) et clôt l'appel.
- Écrans : Pilotage → Prévision (bouton sur le bandeau de sous-capacité et sur chaque jour, suivi des
  appels) ; app chauffeur (carte « Renfort demandé le … »). Vérifié de bout en bout dans la démo.
- Tests : 103/103.

## 08/10/2026 — Cycle 21 : arrivée détectée automatiquement (module 04, P2)
- `lg_driver_ping` (positions envoyées toutes les 10 s pendant la tournée) passe l'arrêt en cours à
  « arrivé » quand le chauffeur est à moins de `auto_arrive_m` (80 m, 0 = désactivé) avec un GPS précis
  (≤ 100 m) ; colonne `arrived_auto` pour distinguer de l'appui sur « Arrivé » (toujours possible).
  Effet de bord voulu : le chronomètre de l'alerte « arrêt long » démarre même si le chauffeur oublie
  de toucher l'écran.
- App chauffeur : message « Arrivée détectée » et rafraîchissement. Réglage dans l'administration.
- Tests : 101/101.

## 08/10/2026 — Cycle 20 : retour de tournée, écart signalé à la clôture (module 03, P2)
- **Défaut** : l'alerte `not_scanned` était prévue dès le socle mais **jamais levée** ; un chauffeur pouvait
  terminer sa tournée sans que personne ne voie les colis non livrés qu'il devait rapporter.
- À la clôture d'un voyage (déclencheur, non bloquant), s'il reste des colis à rapporter
  (`lg_trip_unreturned` : échecs pas rentrés, colis chargés jamais livrés), alerte dans la tour de contrôle
  avec leurs codes ; elle **se lève toute seule** au scan du dernier colis (`lg_return_hub`, par une autre
  personne que le chauffeur, comme avant).
- Quai → Retours : carte « Attendus au quai » (voyage, chauffeur, codes, retard au-delà d'une heure, appel).
- Tests : 98/98.

## 08/10/2026 — Cycle 19 : entretien préventif au kilométrage + indicateur « colis par heure »
- **Défaut** : le carnet enregistrait « prochain entretien à N km » (`next_due_km`) sans que personne ne soit
  jamais prévenu. Désormais : **kilométrage estimé** (`lg_vehicle_km_estimate` = dernier relevé + km des
  voyages partis depuis), **échéance** (`lg_vehicle_maintenance` : bientôt sous `maintenance_alert_km`,
  500 km par défaut, ou dépassée) et **alerte dans la tour de contrôle** (`maintenance_due`, une par état),
  posée à la clôture d'un voyage et à chaque relevé (déclencheurs non bloquants). Badge dans la Flotte.
- **Défaut** : `lg_kpis` donnait « 934 colis par heure » quand les tournées avaient duré quelques secondes
  (démo) ; plus de cadence sous 30 min de tournée cumulée.
- Démo : vidange de la moto due dans 250 km (alerte visible). Tests : 95/95.

## 08/10/2026 — Cycle 18 : canal de secours e-mail via Brevo (module 06, P2)
- **Envoi fait par NEXUS Market** (dépôt `nexus-market`, même branche) : `functions/api/_lib/lg-fallback.js`,
  appelé par `/cron/notify-retry` pour les événements `lg_*`. **WhatsApp d'abord** avec le texte final
  (`vars.texte`) ; **e-mail Brevo seulement** si WhatsApp échoue (Green API et WAHA) ou si le numéro
  manque — jamais les deux (offre Brevo gratuite : 300 e-mails/jour ; expéditeur `nx@nexusmarket.sn`,
  vérifié actif sur le compte). WhatsApp s'arrête dès que l'e-mail est parti (`fallback_email`).
- **Défaut évité** : sans ce branchement, le cron aurait ignoré le WhatsApp des `lg_*` (pas de modèle
  côté NEXUS) et envoyé un e-mail générique **vide** pour chaque message logistique.
- Côté base : les relances vendeur portent `profiles.email`, le rapport du soir le nouveau réglage
  `manager_email` (les messages clients portaient déjà `buyer_email`). `lg_outbox_recent` donne le statut
  e-mail ; `lg_outbox_channels` les totaux. Écran Messages → file d'envoi : canal utilisé par message
  (WhatsApp / e-mail de secours / aucun contact) et totaux sur 7 jours.
- Tests : 93/93 ici ; 9 tests unitaires côté NEXUS (`tests/unit/lg-fallback.test.js`).
- Prérequis en production : `BREVO_API_KEY` dans les secrets Cloudflare de NEXUS (attention au plafond de
  64 variables, CLAUDE.md NEXUS §12) — à vérifier, le code l'utilisait déjà en secours de Resend.

## 08/10/2026 — Cycle 17 : dépôt par le vendeur au hub (module 09, P2)
- **Créneaux de dépôt** ouverts par le chef de quai (`lg_dropoff_slots_create` : à partir du, n jours,
  plages, vendeurs par créneau ; Quai → Réception → « Créneaux »).
- **Réservation par le vendeur** (`lg_dropoff_available`, `lg_dropoff_book`, `lg_dropoff_cancel` ;
  espace vendeur → « Dépôt au hub ») pour ses colis prêts chez lui ; un seul dépôt prévu à la fois.
- Tant qu'un dépôt est prévu, le vendeur **n'est plus proposé à la collecte** (`lg_pickups_pending`).
- **Au hub** : le scan de « Réception au hub » bascule tout seul sur `lg_dropoff_receive` quand le colis
  est encore « chez le vendeur » (pas de voyage) : colis au hub, pesée, réservation du jour « arrivée »
  avec le nombre reçu. Un colis déjà prévu dans une collecte est refusé (`in_pickup_trip`).
- Liste des dépôts du jour (attendu, en retard, arrivé) à côté de la réception.
- Tests : 91/91.

## 08/10/2026 — Cycle 16 : relevé de reversement des vendeurs (module 08, P2)
- `lg_vendor_statement(du, au, vendeur)` — **indicatif, lecture seule** (le versement réel reste dans
  `payout_requests`, flux NEXUS) : produits réellement livrés (`lg_order_goods_fcfa` : ruptures et
  lignes annulées exclues, remise au prorata, sans frais de livraison) − commission
  (`profiles.commission_rate`) − **frais de retour à la charge du vendeur** (cycle 8).
- **Réglé** (`lg_order_settled`) : paiement en ligne payé ; en espèces, **seulement quand le voyage est
  rapproché**. Défaut trouvé par le test : `payment_status` passe à « paid » dès l'encaissement par
  le chauffeur — trop tôt pour reverser des espèces pas encore comptées.
- Un vendeur ne voit que son relevé ; le comptable voit la synthèse (`lg_vendor_statements`) et le
  détail par vendeur. Export Excel du relevé.
- Écrans : espace vendeur → « Reversements » (7 jours, ce mois, mois dernier) ; Factures →
  « Reversements vendeurs » (comptable). Cellules numériques des tableaux sans retour à la ligne.
- Tests : 89/89.

## 08/10/2026 — Cycle 15 : appareils (module 15, P2)
- L'app crée un **identifiant d'appareil** (une fois, `localStorage`) et l'envoie en en-tête
  `x-lg-device` (option `global.headers` de supabase-js) ; PostgREST le rend lisible en SQL
  (`request.headers`), comme l'identifiant de session du jeton (`request.jwt.claims.session_id`).
- `lg_device_ping` à l'ouverture puis toutes les 5 min (`lg_devices` : personne, appareil, vu le…).
- **Blocage appliqué côté serveur** : `lg_has_role`, `lg_is_admin`, `lg_my_courier_id`,
  `lg_trip_courier_user` échouent pour un appareil **bloqué** (perdu/volé) ou pour une session
  **coupée à distance** ; une reconnexion par mot de passe crée une nouvelle session, qui passe.
  L'app se déconnecte et affiche la raison. Sans en-tête (ancienne version) : inchangé.
- Limite connue : les fonctions qui reconnaissent un **vendeur** par `vendor_id = auth.uid()` (sans
  passer par ces contrôles) ne sont pas concernées par le blocage.
- Écran : Administration → **Appareils** (rechercher, déconnecter, bloquer, débloquer ; impossible
  de bloquer l'appareil qu'on utilise). Démo : une « session » par connexion, pour essayer.
- Messages en français pour tous les nouveaux codes d'erreur des cycles 6 à 15.
- Vérifié de bout en bout dans la démo : Moussa ouvre l'app, l'admin bloque son appareil, Moussa
  est refusé avec le message « Cet appareil a été bloqué… ».
- Tests : 86/86.

## 08/10/2026 — Cycle 14 : assurance colis et résolution des incidents (module 13, P2)
- **Assurance** : `lg_quote` accepte une valeur déclarée (`p_declared_value_fcfa`) et renvoie la
  prime (`insurance_fee_fcfa`, 2 % · 300 F minimum · 1 000 000 F assurables au plus — réglables) et
  `total_fcfa`. Colonnes `orders.insured_value_fcfa` / `insurance_fee_fcfa` (le site les renseigne
  au paiement) ; `lg_order_insure` pour une commande prise par téléphone, tant que rien n'est chargé.
- **Plafond d'indemnisation** (`lg_incident_cap`) : valeur assurée ; sinon valeur des produits
  plafonnée à `uninsured_cap_fcfa` (50 000 F proposé, **à valider**). Au-delà : `over_cap`.
- **Résolution** (`lg_resolve_incident`, nouvelle signature) : **avoir** de l'indemnité sur la facture
  (une seule fois), et **clôture avec l'accord du client** — coché par le service client (téléphone),
  sinon la proposition part par WhatsApp (modèle `lg_incident_proposal`) et le client **accepte ou
  refuse depuis sa page de suivi** (`lg_track_incidents`, `lg_track_incident_answer`, ouvertes à
  anon par le lien secret ; un refus rouvre l'incident).
- Réglages admin : alerte péremption, paramètres d'assurance, plafond sans assurance.
- `test/sql/droits.test.mjs` : 2 fonctions publiques de plus (attendu), et les nouvelles fonctions
  internes vérifiées fermées.
- Tests : 83/83.

## 08/10/2026 — Cycle 13 : coûts (modules 10 et 14, P2)
- `lg_costs(du, au)` (répartiteur, comptable) : coûts = dépenses de voyage non rejetées + entretien
  du carnet + rémunération des chauffeurs ; recettes = frais de livraison des commandes livrées.
  **Totaux** (coût par présentation, par livraison, au km, **coût des échecs**, marge), **par
  véhicule** (km, remplissage, coût au km et par colis), **marge par zone**.
- Répartitions assumées et écrites à l'écran : paie d'un chauffeur au prorata de ses livraisons par
  véhicule ; coût total aux zones au prorata des présentations (à affiner avec le km par arrêt).
- Pilotage → « Coûts ». Démo : le chauffeur saisit un plein de 6 000 F au départ.
- Tests : 78/78.

## 08/10/2026 — Cycle 12 : tableaux par axe et export Excel (module 14, P2)
- `lg_kpis_by_axis(axe, du, au)` : présentations, livrés, échecs, taux d'échec, 1re présentation,
  ponctualité, délai de bout en bout, **par zone, vendeur, chauffeur, véhicule, jour de la semaine
  ou heure**. Mêmes définitions que `lg_kpis` (le test vérifie que chaque axe redonne ses totaux).
- Pilotage → Indicateurs → « Tableau par axe », bouton **Exporter (Excel)** : CSV point-virgule,
  BOM UTF-8 (accents), décimales à virgule.
- Tests : 76/76.

## 08/10/2026 — Cycle 11 : plusieurs quais (module 03, P2)
- **Quais** (`lg_docks`, 3 en démo : Q1 fourgonnettes, Q2 motos, Q3 tricycles) ; création par le
  chef de quai.
- **File d'attente** : le chauffeur touche « Je suis arrivé au hub » (ou le chef de quai le note)
  → `dock_queued_at` ; il voit sa place puis « Présentez-vous au quai Q2 » (`lg_trip_dock`).
- **Affectation** (`lg_dock_assign`) : un quai = un voyage non parti à la fois ; sans quai précisé,
  le premier libre. Le quai se libère tout seul au départ ou à l'annulation du voyage.
- **Tableau** (`lg_dock_board`, Quai → Quais) : occupation et progression du chargement, file,
  voyages à venir, **temps moyen de chargement par quai** (1er colis chargé → scellé) et **attente
  moyenne avant quai** (7 jours).
- Tests : 74/74.

## 08/10/2026 — Cycle 10 : offres — suppléments nuit et forte pluie (module 12, P2)
- Express, programmé et « offerte au-delà de » existaient déjà dans `lg_quote`. Ajout de
  **suppléments** (`lg_surcharges`) **désactivés par défaut** : aucun prix ne change tant qu'on n'en
  active pas un. Une livraison offerte reste offerte (pas de supplément).
- **Nuit** : fenêtre horaire de Dakar (à cheval sur minuit géré), express seulement par défaut,
  1 000 F proposé ; réglable par l'admin (Administration → Tarifs et zones → Suppléments).
- **Forte pluie** : le répartiteur la **déclare** depuis la tour de contrôle pour 2, 4 ou 8 h
  (24 h max), toutes zones ou zones choisies ; elle expire d'elle-même (`lg_surcharge_declare`).
- `lg_quote` renvoie désormais `base_fcfa` et `surcharges` en plus de `price_fcfa` (compatible :
  mêmes champs qu'avant). Le simulateur de l'admin affiche le détail.
- Reste du P2 « Offres » : l'abonnement (livraison illimitée) — demande une identité client fiable
  au panier, non traité.
- Tests : 71/71.

## 08/10/2026 — Cycle 9 : engagement de délai des vendeurs (module 09, P2)
- **Engagement explicite** (`lg_vendor_commitments`) : le vendeur promet un délai de préparation
  (1 à 96 h) dans son espace, ou le chef de quai le fixe pour lui (`lg_vendor_commitment_set`).
  Tant que le lieu de préparation n'est pas tranché, un vendeur **sans** engagement garde les 24 h
  par défaut et ne reçoit aucune relance.
- **Heure limite** : déclencheur sur `lg_pick_tasks` → réception + délai promis (une date promise au
  client reste prioritaire).
- **Relances** (`lg_vendor_reminders`, fonction de planificateur, fermée aux apps) : WhatsApp au
  vendeur 2 h avant l'échéance puis en retard, une fois par étape (`lg_vendor_reminders_sent`),
  seulement si le hub n'a pas pris la commande. 2 modèles ajoutés à « Messages clients ».
- **Mesure** : « Mon engagement » dans l'espace vendeur (ponctualité 30 j, délai moyen, commandes
  ouvertes avec le temps restant) ; Pilotage → « Vendeurs » pour les équipes.
- À brancher en production : `lg_vendor_reminders()` à côté de `lg_watchdog()` (CLAUDE.md, mise en production §3).
- Tests : 68/68.

## 08/10/2026 — Cycle 8 : retours, frais et causes (module 08, P2)
- **Causes de retour** (`lg_return_causes`) : qui supporte les frais (vendeur, client, NEXUS,
  personne) et combien (aucun, frais de livraison de la commande, montant fixe). **Valeurs proposées
  à valider** (chapitre 14) : erreur vendeur et produit défectueux → vendeur ; changement d'avis,
  refus à la porte, client absent → client ; abîmé en transport → NEXUS. Réglables par l'admin
  (`lg_return_cause_save`, Pilotage → Retours → Modifier).
- **Classement** (`lg_return_classify`) au contrôle du retour, au quai : la cause est **suggérée**
  (`lg_return_suggest`) d'après le motif d'échec du chauffeur ou la demande du client ; frais
  **constatés** dans `lg_return_charges` (un par colis, reclassement tracé), **pas encaissés** :
  retenue sur reversement ou facturation au client restent une décision humaine.
- **Statistiques** (`lg_return_stats`) : par motif, par vendeur (taux de retour, part de sa faute,
  frais à sa charge), par quartier ; retours revenus sans cause.
- **Défaut d'interface corrigé partout** : `Field` rendait un `<label>` autour des groupes de choix ;
  toucher l'intitulé (« Décision », « État du produit »…) sélectionnait la 1re option. `Field` rend
  désormais un `<div>` pour un groupe de `Chips` (9 écrans concernés, aucune autre modification).
- Tests : 65/65.

## 08/10/2026 — Cycle 7 : productivité de la préparation (module 01, P2)
- `lg_pick_productivity(p_from, p_to)` (lecture seule ; chef de quai, répartiteur, comptable,
  service client) : par préparateur, commandes, lignes, unités, temps, **lignes par heure**, saisie
  manuelle, **mauvais scans** (produit inattendu, lu dans `lg_action_log`), **écarts au double
  contrôle** (incidents `missing_item`), erreurs pour 100 lignes ; **ruptures par vendeur** et délai
  de préparation ; **emballages consommés** par taille (d'après les dimensions du colisage).
- Temps : une vague compte une seule fois (première prise → dernière fermeture), plafond 3 h par
  commande ou vague (préparation abandonnée). Moins d'une minute cumulée → pas de cadence (défaut
  vu à l'écran sur la démo : « 385 714 lignes/heure »).
- Écrans : onglet « Préparation » du Pilotage, onglet « Productivité » de l'Entrepôt (chef de quai),
  composant partagé `src/components/productivity.jsx`.
- CI GitHub « Vérification » : verte sur la branche. Tests : 62/62.

## 08/10/2026 — Cycle 6 : lots et dates de péremption (module 01, P2)
- **Rangement par lot** : `lg_put_away` prend désormais `p_lot` et `p_expires_on` (facultatifs) ;
  table `lg_stock_lots` (par produit × emplacement × lot × date). Une marchandise **déjà périmée
  est refusée** (`expired_lot`). Invariant : somme des lots ≤ quantité de l'emplacement (le reste
  = stock non loti, rangé avant ou sans date).
- **Premier périmé, premier sorti (FEFO)** : l'emplacement proposé (`lg_pick_location_id`) est
  celui dont le lot valide périme le plus tôt ; un emplacement qui ne contient plus que du périmé
  n'est jamais proposé. Le détail de préparation affiche « prendre lot X · JJ/MM/AAAA », et le
  prélèvement décrémente ce lot (périmé seulement en dernier recours, mouvement marqué).
- **Péremption** (`lg_lots_expiring`, réglage `expiry_alert_days`, 30 j) et **sortie de stock
  motivée** (`lg_lot_discard` : rayon, stock du site, journal). Un vendeur voit les lots de ses produits.
- **Rappel produit** (`lg_lot_trace`) : pour un n° de lot, les commandes servies, le client, son
  téléphone (bouton Appeler) ; reçu / sorti / en rayon. Base : `lg_lot_moves` (mouvements signés).
- **Cohérence** : un emplacement qui baisse (inventaire…) réduit ses lots, périmés puis plus anciens d'abord.
- Écrans : onglet « Péremption » de l'Entrepôt (+ traçage), champs lot/DLC au rangement, lots dans la
  recherche, consigne de lot à la préparation. Démo : 3 lots datés (œufs à J+2, riz à J+21 et J+120).
- **Test de prévision qui échouait chaque jeudi** (le pic « Louma du vendredi » de la démo
  multipliait la prévision du lendemain) : remise à zéro des pics dans le test ; vendredi de la
  démo calculé en jours UTC (= Dakar) quel que soit le fuseau du navigateur.
- **Espace vendeur** : onglet « Péremption » (ses lots à J-30, invitation à une promotion avant la date).
- **CI** : `.github/workflows/verify.yml` lance tests + construction sur toute branche ≠ `main` et
  toute pull request (jusqu'ici, seuls les pushs sur `main` étaient testés… au moment de déployer).
- Tests : 60/60. Vérifié dans la démo (navigateur headless) : onglet Péremption, rangement, espace vendeur (téléphone).
- Branche `claude/gallant-johnson-4atibs` (pas `main` : `main` déploie).

## 08/10/2026 — Dépôt GitHub et mise en ligne (démo)
- Dépôt `elhadjidiagne002-netizen/NEXUS-LOGISTICS` (créé par l'utilisateur, **public**) :
  l'envoi par le navigateur n'avait pris que les fichiers de premier niveau ; les dossiers
  `src/`, `supabase/`, `test/`, `public/` ont été ajoutés (commit `f03da6e`).
- Projet Cloudflare Pages `nexus-logistics` → **https://nexus-logistics-6my.pages.dev**
  (le nom court était pris). Piège : wrangler 4.148 crée désormais les projets sous forme
  « Workers » et échoue sans point d'entrée ; création en Pages classique avec `--force`
  (une seule fois, comme les autres sites), et `wrangler.toml` (`pages_build_output_dir = "dist"`).
- `.github/workflows/deploy.yml` sur le modèle de My shop : tests → construction → déploiement
  → contrôle de la production (titre, script du build, page de suivi, service worker).
  Variables de dépôt `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` à poser pour le mode réel ;
  sans elles, le site publié est la démonstration.
- Premier déploiement fait depuis le poste et vérifié (cache immuable des assets, WebAssembly
  de la démo servi en `application/wasm`).

## 07/10/2026 — Cycle 5 : anticiper, motiver, prévenir (dernier des 5 cycles demandés)
- **Prévision** (`lg_forecast`) : moyenne pondérée du même jour sur 4 semaines, jours de pic
  réglables (`peak_days` : Tabaski, Louma…), besoin en véhicules et alerte de sous-capacité.
- **Anomalies** (`lg_anomalies`) : livraisons validées loin de l'adresse, écarts de caisse
  répétés, taux d'échec anormal par chauffeur, clients qui refusent, vendeurs en rupture,
  zones difficiles — présentés comme signaux à vérifier.
- **Classement des chauffeurs** (`lg_driver_scores`, `lg_leaderboard`) visible dans leur
  app (« 1er sur 3 cette semaine »), et **prime de ponctualité** enfin calculée à la clôture
  (`bonus_on_time`, désactivée par défaut). Les primes entrent maintenant dans `total_earned`.
- **Contrôle des retours** (`lg_return_inspect`) : état, puis remise en vente (stock et
  rayon rétablis) / retour vendeur / rebut (incident) ; avoir si facturé.
- **Livraison à un tiers** (`lg_track_third_party`) depuis la page de suivi : la personne
  désignée reçoit un nouveau code ; l'ancien ne vaut plus.
- Démo : 4 semaines d'historique de commandes et un jour de pic. L'empreinte de version de la
  démo inclut désormais le scénario (sinon une démo déjà installée ne rejoue pas le nouveau).
- Tests : 54/54.

**Bilan des 5 cycles** : 15 migrations, 176 fonctions `lg_*`, 38 tables ; 54 tests ; design
refait. Toujours **rien d'appliqué à la base réelle ni déployé**.

## 07/10/2026 — Cycle 4 : l'entrepôt (module 11) et la préparation par vague
- **Emplacements** (`lg_stock_locations`, `lg_product_locations`) : allée-étagère-niveau,
  tri naturel (A-2 avant A-10, `lg_loc_key`), rangement par scan (`lg_put_away`),
  recherche « où est ce produit ? » (`lg_product_find`). Un prélèvement décrémente le
  rayon le plus garni (déclencheur sur `lg_pick_lines`).
- **Chemin de prélèvement** : `lg_pick_task_detail` donne l'emplacement de chaque ligne et
  trie les lignes dans l'ordre des rayons.
- **Préparation par vague** (`lg_wave_create`, `lg_wave_detail`, `lg_wave_scan`) : 2 à 12
  commandes en un passage ; chaque scan affiche en grand le **bac** de la commande la plus
  urgente qui attend ce produit ; on emballe ensuite commande par commande.
- **Inventaire tournant** (`lg_inventory_today`, `lg_inventory_count`) : emplacements les
  moins récemment comptés d'abord, comptage à l'aveugle, écart motivé, rayon et stock du site
  corrigés, historique des écarts pour le chef de quai.
- Écrans : nouvel espace « Entrepôt » (inventaire, rangement, recherche, emplacements),
  cases à cocher « Préparer en vague » dans la file, écran de vague (bacs + chemin).
- Tests : 49/49.

## 07/10/2026 — Cycle 3 : planification automatique, double contrôle, consignes vocales
- **Planification automatique** (`lg_autoplan_run`) : simulation puis création. Balayage
  angulaire autour du hub, remplissage du plus grand véhicule libre jusqu'à sa première
  limite (poids, volume, colis, plafond d'espèces), glacière et deux-roues respectés,
  chauffeur habituel s'il est libre, ordre des arrêts au plus proche voisin. Écran : tour de
  contrôle → « À affecter » → « Planifier automatiquement ».
- **Double contrôle** (`lg_double_check`, réglage `double_check_fcfa`, 100 000 F par défaut) :
  au-delà du seuil, mise à quai refusée tant qu'une autre personne que le préparateur n'a pas
  contrôlé ; un écart ouvre un incident.
- **Consignes lues à voix haute** pour le chauffeur (synthèse vocale du téléphone).
- 3e chauffeur fictif (Cheikh, tricycle) dans la démo.
- Pièges trouvés en vérifiant dans le navigateur : la carte Leaflet passait devant les
  fenêtres (contexte d'empilement isolé) ; **numéros de voyage qui sautaient (2 → 34)** :
  une séquence Postgres perd jusqu'à 32 valeurs à un redémarrage brutal. Voyages et
  incidents passent sur un compteur transactionnel (`lg_next_counter`). Probable cause du
  saut de factures vu au premier jour (déjà corrigé par `invoice_sequences`).
- Tests : 45/45.

## 07/10/2026 — Cycle 2 : refonte du design + messages clients
- **Design** (demande de l'utilisateur : « plus moderne, attrayant et professionnel ») :
  nouvelle charte (Inter, accent émeraude, ambre pour l'argent, mode sombre soigné et
  bascule clair/sombre mémorisée), barre latérale sombre groupée par métier sur ordinateur,
  barre d'onglets en bas sur téléphone, page de connexion avec panneau de marque, accueil
  avec bandeau et tuiles à icônes, jeu d'icônes vectorielles (`src/components/icons.jsx`)
  à la place des émojis, indicateurs avec icône, onglets « segmentés », tableaux et fenêtres
  retravaillés, page de suivi client avec bandeau et barre d'étapes.
- **Messages clients** (annexe B) : table `lg_message_templates` (11 modèles), rendu
  `lg_render_message` ; chaque message déposé dans `notification_outbox` porte son texte
  final (`vars.texte`) ; modèle désactivable ; écran « Messages clients » avec éditeur,
  variables à insérer, aperçu façon WhatsApp sur le dernier envoi réel, champ wolof (à faire
  rédiger par un locuteur), file d'envoi au numéro masqué.
- Piège corrigé en vérifiant : le logo disparaissait quand son dégradé SVG était défini
  dans un bloc masqué (`display:none`) — identifiant unique par instance (`useId`).
- Tests : 41/41. Vérifié dans le navigateur : connexion, accueil, tour de contrôle (grand
  écran), messages (téléphone).

## 07/10/2026 — Cycle 1 d'améliorations : les fonctions P1 qui manquaient
- **Versement intermédiaire** (`lg_cash_drop`, table `lg_cash_drops`) : au-delà du plafond
  d'espèces, le caissier encaisse une partie sans clôturer le voyage ; l'alerte se lève,
  le versement final est calculé net (`lg_trip_cash_outstanding`, `lg_courier_cash`).
- **Réaffectation d'un arrêt** (`lg_transfer_stop`) + **double scan** (`lg_take_transfer`) :
  impossible de livrer un colis transféré tant que le nouveau chauffeur ne l'a pas scanné.
- **Reprise chez le client** (`lg_returns_pending`, `lg_trip_add_return`) depuis les
  `return_requests` approuvées : colis « retour », arrêt de reprise, photo de l'état,
  réception au hub, retour vendeur avec avoir ; la commande reste « livrée ».
- **Collecte chez les vendeurs** (`lg_pickups_pending`, `lg_trip_add_pickup`, `lg_collect`)
  et **réception au hub** avec repesée (`lg_receive`). Un colis préparé par le vendeur
  reste « chez lui » jusqu'à la collecte ; la mise à quai prend le hub du préparateur.
- Rapprochement : bloqué tant qu'un colis collecté n'est pas reçu au hub.
- Écrans : caisse « Sur la route », tour de contrôle « Déplacer un arrêt », quai
  « Collectes et reprises » + « Réception », chauffeur « Collecter / Reprendre / Colis à récupérer ».
- Piège corrigé : la migration des droits s'appelle désormais
  `29991231000000_droits_toujours_en_dernier.sql` (sinon les fonctions des migrations
  suivantes restaient ouvertes à `anon` par les droits par défaut de Supabase).
- Tests : 40/40 (5 nouveaux, partant de la journée de démo).

## 07/10/2026 — Lancement du projet : base, application, démo

**Point de départ** : le dossier de conception v2.0 (15 modules, 48 pages) et le script
MVP de l'annexe A, sans code.

**Fait**
- Lecture de la base réelle **en lecture seule** pour caler le schéma (colonnes de
  `orders`, `invoices`, `couriers`, contraintes, 42 zones). Aucune écriture en prod.
- 10 migrations SQL (`supabase/migrations/`) : l'annexe A rendue rejouable, puis 134
  fonctions `lg_*` et 31 tables couvrant les 15 modules au niveau P1 et une bonne part du P2
  (préparation, colisage, quai, voyages, jauge, plan de chargement, livraison prouvée,
  échecs, retours, caisse et rapprochement, gains des chauffeurs, facture et avoirs,
  suivi public, réponses WhatsApp, tour de contrôle, veille automatique, 12 indicateurs,
  tarifs au panier, créneaux, flotte et documents, incidents, administration, droits).
- Application React/Vite installable : un écran par rôle (préparateur, chef de quai,
  répartiteur, chauffeur, caissier, comptable, service client, vendeur, administrateur)
  + page de suivi client publique. Scan caméra / douchette / saisie, signature, photo
  compressée, carte, impression (étiquettes A6 QR, bordereau, facture, reçu), file hors
  ligne sans doublon.
- Mode démo : Postgres dans le navigateur (PGlite) avec les mêmes migrations et une journée
  jouée par les vraies fonctions.
- 35 tests au vert. Vérifié dans le navigateur : tour de contrôle, livraison complète au
  téléphone (scan, code client, photo 642 → 129 Ko, encaissement), chargement, factures,
  service client, suivi public avec confirmation.

**Défauts trouvés et corrigés en route** : montant à encaisser qui ignorait les ruptures ;
facture jamais émise pour une commande payée dès sa création ; écart de caisse qui
n'empêchait pas le rapprochement ; contrôle d'accès contourné quand l'acheteur est vide ;
numérotation des factures avec trous (séquence Postgres) ; une facture en échec annulait
l'ouverture de la préparation.

**État** : rien n'est appliqué à la base réelle ni déployé. Prochaine étape proposée :
branche de test Supabase, puis décisions 1 à 3 du chapitre 14 (voir `CLAUDE.md`).
Dépôt git initialisé, aucun commit.

## État actuel des intégrations
- Base : migrations prêtes, **non appliquées** (ni test ni prod).
- Messages : déposés dans `notification_outbox` (événements `lg_*`) **avec leur texte final**
  (`vars.texte`, modèles modifiables) ; envoi codé côté NEXUS (WhatsApp, e-mail Brevo en secours,
  `lg-fallback.js`) — actif dès que les migrations seront appliquées.
- Planificateur : `lg_watchdog`, `lg_vendor_reminders`, `lg_purge`, `lg_evening_report` prêts, non planifiés.
- Hébergement : Cloudflare Pages `nexus-logistics`, **https://logistique.nexusmarket.sn** = démo (PGlite)
  jusqu'à la bascule du cycle C6 ; version complète en prévisualisation sur
  https://complet.nexus-logistics-6my.pages.dev (Functions + D1 `nexus-logistics`). Déploiement automatique
  bloqué faute de `CLOUDFLARE_API_TOKEN` (déploiement à la main).
- Base de la version complète : D1 `nexus-logistics` (migration 0001 appliquée). La base Supabase de NEXUS
  n'est plus la cible : les migrations `supabase/` ne seront PAS appliquées (archive de référence).

## Chantiers en attente
- **Portage Cloudflare : cycles C2 à C11 de `ROADMAP.md`** (le reste de cette liste vient après).
- Connexion chauffeur par téléphone + code à 4 chiffres (exige une fonction serveur qui
  émet la session ; colonne `couriers.pin_hash` prévue).
- PDF de facture généré côté serveur et archivé (aujourd'hui : impression navigateur).
- Langues : interface en français seulement ; textes wolof des messages à faire rédiger par
  des locuteurs (champ prévu dans l'écran Messages).
- Paiement mobile à la porte (QR / lien PayTech), rapprochement automatique Wave/OM.
- Phase 3 : points relais, inter-villes, application Android native.
