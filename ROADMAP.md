# Feuille de route — NEXUS Logistics, version complète sur Cloudflare

Décision du 08/10/2026 (utilisateur) : NEXUS Logistics devient un **service payant ouvert à toute entreprise
qui livre** (sociétés de livraison, boutiques et vendeurs qui ont leurs livreurs), **sans mode démo**, hébergé
**entièrement sur Cloudflare** (Pages + Pages Functions + D1 + R2), **sans coût financier** (offres gratuites).
NEXUS Market devient un client parmi d'autres.

Méthode : on **porte** la logique Postgres existante (`supabase/migrations/*.sql`, 176 fonctions `lg_*`) en
JavaScript (`server/rpc/*.js`) sur D1, **sous les mêmes noms et avec les mêmes arguments**, pour que les écrans
React (`src/screens/*`) marchent sans être réécrits. Les tests Postgres (`test/sql/*.test.mjs`) sont le cahier
des charges : chaque cycle porte les tests correspondants dans `test/server/*.test.js`. Toutes les règles de
`CLAUDE.md` (multi-entreprises, idempotence, numéros sans trou, budget gratuit) s'appliquent.

Un cycle n'est terminé que si : tests serveur au vert, `npm run build:api` OK, écrans du cycle vérifiés dans
l'aperçu (`logistics-full`), migrations D1 appliquées en ligne, déploiement de prévisualisation vérifié
(`https://complet.nexus-logistics-6my.pages.dev`), `JOURNAL.md` et cette feuille mis à jour, commit poussé.

## C1 — Socle multi-entreprises ✅ (08/10/2026, session locale)
- [x] D1 `nexus-logistics` (WEUR), migration `0001_socle.sql` : entreprises, comptes, membres, rôles logistiques,
      lieux, chauffeurs, sessions, appareils, invitations, idempotence, compteurs, audit, limitation de débit.
- [x] Comptes : inscription d'une entreprise (propriétaire + premier lieu), connexion, session, déconnexion,
      changement d'entreprise active, changement de mot de passe ; PBKDF2 100 000 ; cookie HttpOnly ; CSRF.
- [x] Invitations par lien (WhatsApp), usage unique y compris en double clic, compte neuf ou existant,
      fiche chauffeur créée pour un chauffeur.
- [x] Répartiteur `POST /api/rpc/<nom>` : session, entreprise, appareil bloqué, rôles ; fonctions du socle
      (`lg_me`, équipe et rôles, chauffeurs, lieux, réglages, appareils).
- [x] Interface : mode `api` (`npm run build:api`), écran connexion / création d'entreprise, page d'invitation,
      carte « Inviter par lien » dans Administration → Rôles.
- [x] 12 tests serveur dont isolation entre entreprises et refus sans session de TOUTE fonction.

## C2 — Commandes, zones, tarifs, suivi client ✅ (08/10/2026, routine cloud)
- [x] Migration `0002_commandes.sql` : `orders`, `order_items`, `products` (catalogue logistique : poids, dimensions,
      manutention froid/fragile…), `customers` (un par numéro, repère, position), `zones` (centre + polygone facultatif,
      heure limite, jours, gratuité), `rate_cards` (+ prix au km), `surcharges`, `banned_numbers`, `customer_requests`,
      `ratings`, `api_keys`. Numéro de commande sans trou (compteur lu dans le même lot que l'insertion).
- [x] Saisie d'une commande (Service client → Commandes, rejouable `p_event`), import CSV (gabarit, paquets de 50,
      erreurs par ligne, référence jamais en double), **API par clé** `POST /api/v1/orders` (empreinte SHA-256,
      révocable, Administration → API boutiques), catalogue (Service client → Produits).
- [x] Portage : `lg_quote` (public via `p_company` = adresse publique ; par zone ou par position, prix au km,
      suppléments, assurance), `lg_set_zone` (+ `lg_zone_delete`, `lg_zones_seed` : 42 quartiers de Dakar),
      `lg_upsert_rate_card`, `lg_surcharges_list`, `lg_surcharge_save/declare`, `lg_pricing`, `lg_confirm_cod`,
      `lg_cancel_unconfirmed`, `lg_cod_pending`, `lg_order_insure`, `lg_product_logistics`, `lg_products_to_complete`,
      `lg_product_find`, `lg_vendor_overview` (version C2), `lg_requests_list`, `lg_request_done`, `lg_ban_number`.
- [x] Page de suivi publique `/suivi/<jeton>` : `lg_track`, `lg_track_confirm`, `lg_track_set_location`,
      `lg_track_rate`, `lg_track_request`, `lg_track_third_party` (jeton aléatoire 18 octets, nom de l'entreprise).
- [x] Montants en FCFA entiers partout. 12 tests serveur (dont isolation et rôles) + test unitaire du CSV.
- Reste : migration `0002` à appliquer en ligne et prévisualisation à vérifier (en local) ; envoi du message de
  confirmation au client (C8, en attendant : bouton « Envoyer le lien (WhatsApp) ») ; ouverture de la préparation à la
  confirmation (C3) ; livreur/position/échec/facture sur la page de suivi (C4-C6) ; dessin des polygones de zone sur
  la carte (aujourd'hui : centre seulement à l'écran, polygone par `lg_set_zone`) ; `lg_track_incidents` (C11).

## C3 — Préparation et entrepôt ✅ (08/10/2026)
- [x] Migration `0003_preparation.sql` : tâches et lignes de préparation, vagues, colis, contenu des colis, journal de
      scans en ajout seul (déclencheur), emplacements, stock par emplacement, lots datés et leurs mouvements, comptages
      d'inventaire, incidents (créés par le double contrôle ; gérés au C11).
- [x] Tâches de préparation ouvertes par la confirmation du paiement à la livraison ou par une commande payée d'avance,
      verrou de prise (`pick_lock_minutes`), scan article par article (code-barres, référence, code interne NXI-), rupture
      (montant dû réduit, stock à zéro), emballage multi-colis, pesée, mentions héritées, étiquettes, mise à quai,
      double contrôle au-delà de `double_check_fcfa`, vagues (`lg_pick_*`, `lg_pack`, `lg_stage`, `lg_labels`,
      `lg_resolve_short`, `lg_wave_*`, `lg_double_check`).
- [x] Préparation chez le vendeur OU au hub : réglage `prep_at_vendor` (Administration → Réglages).
- [x] Entrepôt : emplacements, rangement par lot, FEFO, rebut, traçabilité, inventaire tournant, productivité
      (`lg_location_upsert`, `lg_put_away`, `lg_lot_*`, `lg_inventory_*`, `lg_pick_productivity`), fiche colis.
      8 tests serveur (portage de `parcours` 01-07, `cycle3`, `cycle4`, `cycle6`, `cycle7`, isolation, rôles).
- Reste : migration `0003` à appliquer en ligne ; messages au client (rupture, commande préparée) au C8 ; avoir sur
  rupture remboursée au C6.

## C4 — Flotte, quai et voyages ✅ (08/10/2026)
- [x] Migration `0004_voyages.sql` : véhicules, documents, carnet d'entretien et contrôles, voyages, arrêts, colis par
      voyage, quais, créneaux de dépôt vendeur, créneaux de livraison client, alertes ; colonnes chauffeur (permis,
      plafond d'espèces, note), adresse de collecte d'un membre, créneau d'une commande.
- [x] Véhicules, documents, entretien au km (alerte bientôt / dépassé), contrôle avant départ (`lg_fleet`,
      `lg_upsert_vehicle`, `lg_add_document`, `lg_log_maintenance`, `lg_vehicle_check`, `lg_set_vehicle_status`).
- [x] Voyages : création (documents, permis, véhicule et chauffeur libres — index uniques), ajout/retrait/ordre des
      arrêts, chargement contrôlé (poids, volume, colis, froid, vivant, alimentaire/chimique), plan de chargement
      calculé à la lecture, bordereau signé, heures estimées, quais et file d'attente, collectes vendeurs, réception
      au hub, dépôts vendeurs, créneaux client (`lg_trip_*`, `lg_dock_*`, `lg_dropoff_*`, `lg_receive`,
      `lg_create_slots`, `lg_slots_available`, `lg_track_book_slot`). Numéros de voyage sans trou.
- [x] Planification automatique et suggestions (`lg_autoplan_run`, `lg_suggest_trips`). 10 tests serveur.
- Reste : migration `0004` à appliquer en ligne ; retours (`lg_return_*`) et transferts entre voyages
      (`lg_transfer_stop`, `lg_take_transfer`) déplacés au C5 (ils suivent les échecs de livraison) ; frais de route
      dans les coûts de la flotte au C5.

## C5 — Livraison sur le terrain
- [ ] Retours (`lg_returns_expected`, `lg_returns_to_inspect`, `lg_return_causes`, `lg_return_classify`,
      `lg_return_inspect`, `lg_return_hub`, `lg_return_vendor`, `lg_returns_pending`, `lg_trip_add_return`) et
      transferts entre voyages (`lg_transfer_stop`, `lg_take_transfer`), venus du C4 ; `lg_collect` (collecte).
- [ ] App chauffeur : arrêts, appel client, arrivée (manuelle et automatique GPS), code client (OTP) avec
      essais décomptés **sans exception** (le refus laisse une trace), signature, échec et présentations.
- [ ] **Photos de preuve sur R2** (bucket `nexus-logistics-preuves`, privé, chemin préfixé par l'entreprise),
      `upload` / `signedUrl` dans `backend.js` (lecture via route authentifiée, pas d'URL publique).
- [ ] Positions : `lg_driver_ping` **toutes les 30 s au plus** (budget d'écritures D1), dernière position sur
      `couriers`, trace échantillonnée ; SOS ; dépenses de voyage ; file hors ligne (idempotence `p_event`).

## C6 — Caisse, factures, reversements → BASCULE
- [ ] Versements chauffeur, comptage par billets, écarts → incident, rapprochement, gains chauffeur, reçu.
- [ ] Factures et avoirs (numéros sans trou par année), export comptable, relevé de reversement vendeur.
- [ ] **BASCULE** : `deploy.yml` construit `build:api` sur `main` ; logistique.nexusmarket.sn sert la version
      complète. Suppression du mode démo (PGlite, `src/demo/`, `seed`), de `supabase-js` et du mode
      `supabase` dans `backend.js` ; écran d'accueil sans « Démonstration ». Les fonctions pas encore
      portées affichent « bientôt disponible » au lieu d'une erreur.

## C7 — Pilotage et tâches automatiques
- [ ] Tour de contrôle : carte des chauffeurs, voyages, alertes (rafraîchissement par interrogation toutes
      les 20-30 s, pas de temps réel : budget de requêtes), `lg_ack_alert`, `lg_transfer_stop`.
- [ ] Tâches planifiées (surveillance, relances vendeurs, rapport du soir, purge) : route `POST /api/cron/<tâche>`
      protégée par secret, appelée par un **Cron Trigger d'un petit Worker** (Pages n'a pas de cron ; offre
      gratuite = 5 déclencheurs par compte, déjà utilisés en partie par nexus-cron → regrouper).
- [ ] Indicateurs, tableaux par axe + export Excel, coûts et marges, prévision, renforts, anomalies, classement.

## C8 — Messages clients
- [ ] Modèles modifiables, aperçu, file d'envoi (`lg_template_save`, `lg_preview_message`), réponses.
- [ ] Envoi **gratuit** : lien `wa.me` pré-rempli (un geste du répartiteur ou du chauffeur) par défaut ;
      envoi automatique si l'entreprise branche **sa propre** instance WhatsApp (Green API / WAHA : identifiants
      chiffrés par entreprise) ; e-mail de secours (Brevo, quota gratuit partagé à surveiller).

## C9 — Offre payante et site public
- [ ] Formules : gratuite (quotas : livraisons par mois, chauffeurs, lieux) et Pro (abonnement mensuel),
      comme Devizo et My shop ; paiement **Wave / Orange Money déclaré** puis activé par l'admin plateforme.
- [ ] Administration de la plateforme (`ADMIN_EMAILS`) : entreprises, formules, suspension, statistiques.
- [ ] Page d'accueil commerciale (avantages, tarifs, inscription), mentions légales, CGU, confidentialité,
      `robots.txt`, `sitemap.xml`, partage social ; suivi des erreurs (remontée maison, Sentry si projet créé).

## C10 — Intégration NEXUS Market
- [ ] Lecture de l'état d'une commande par l'API (`GET /api/v1/orders/<référence>`), pour les boutiques.
- [ ] NEXUS Market devient une entreprise cliente : ses commandes payées arrivent par l'API par clé (C2),
      les statuts de livraison repartent vers NEXUS par un appel signé (HMAC).
- [ ] Côté dépôt `nexus-market` : brancher l'envoi des commandes, et retirer ou adapter `lg-fallback.js`
      (conçu pour l'ancienne cible : messages `lg_*` dans `notification_outbox`).

## C11 — Fonctions avancées restantes et nettoyage
- [ ] Ce qui reste des cycles 6 à 22 de la version Postgres (incidents et assurance, engagement de délai des
      vendeurs, retours et causes, coûts…), s'il n'a pas été porté avant.
- [ ] Suppression de l'archive Postgres (`supabase/`, `test/sql/`, `nexus-logistics-mvp.sql`) une fois tout
      porté ; mise à jour du README.
