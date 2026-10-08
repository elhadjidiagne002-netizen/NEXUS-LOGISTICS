# Journal — NEXUS LOGISTICS

Le plus récent en premier.

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
  (`vars.texte`, modèles modifiables) ; l'envoi WhatsApp par le pipeline NEXUS reste à brancher.
- Planificateur : `lg_watchdog`, `lg_vendor_reminders`, `lg_purge`, `lg_evening_report` prêts, non planifiés.
- Hébergement : non déployé.

## Chantiers en attente
- Connexion chauffeur par téléphone + code à 4 chiffres (exige une fonction serveur qui
  émet la session ; colonne `couriers.pin_hash` prévue).
- PDF de facture généré côté serveur et archivé (aujourd'hui : impression navigateur).
- Langues : interface en français seulement ; textes wolof des messages à faire rédiger par
  des locuteurs (champ prévu dans l'écran Messages).
- Paiement mobile à la porte (QR / lien PayTech), rapprochement automatique Wave/OM.
- Phase 3 : points relais, inter-villes, application Android native.
