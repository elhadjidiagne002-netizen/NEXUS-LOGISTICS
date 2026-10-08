# Journal — NEXUS LOGISTICS

Le plus récent en premier.

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
  (`vars.texte`, modèles modifiables) ; l'envoi WhatsApp par le pipeline NEXUS reste à brancher.
- Planificateur : `lg_watchdog`, `lg_purge`, `lg_evening_report` prêts, non planifiés.
- Hébergement : non déployé.

## Chantiers en attente
- Connexion chauffeur par téléphone + code à 4 chiffres (exige une fonction serveur qui
  émet la session ; colonne `couriers.pin_hash` prévue).
- PDF de facture généré côté serveur et archivé (aujourd'hui : impression navigateur).
- Langues : interface en français seulement ; textes wolof des messages à faire rédiger par
  des locuteurs (champ prévu dans l'écran Messages).
- Paiement mobile à la porte (QR / lien PayTech), rapprochement automatique Wave/OM.
- Phase 3 : points relais, inter-villes, application Android native.
