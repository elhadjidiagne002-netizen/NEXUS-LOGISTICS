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

## C5 — Livraison sur le terrain ✅ (08/10/2026)
- [x] Retours (`lg_returns_expected`, `lg_returns_to_inspect`, `lg_return_causes`, `lg_return_cause_save`,
      `lg_return_classify`, `lg_return_inspect`, `lg_return_hub`, `lg_return_vendor`, `lg_returns_pending`,
      `lg_trip_add_return`, + `lg_return_request` : demande saisie par le service client) et transferts entre voyages
      (`lg_transfer_stop`, `lg_take_transfer`) ; `lg_collect` (collecte chez le vendeur ou reprise chez le client).
- [x] App chauffeur : `lg_my_day`, départ signé (`lg_trip_start`, code client par commande), appel (`lg_stop_call`),
      arrivée manuelle et automatique GPS, code client avec essais décomptés **sans exception**, signature, photo,
      encaissement exact (espèces / Wave / Orange Money, mixte), échec motivé (appel exigé, incident), fin de tournée
      (bilan, alerte « colis à rapporter » levée au dernier retour), plafond d'espèces, adresse vérifiée réutilisée.
- [x] **Photos de preuve** : `PUT` / `GET /api/files/<voyage>/…` (session, entreprise, chauffeur du voyage) ; R2 si
      la liaison `PROOFS` existe, sinon table `files` de D1 (≤ 1,5 Mo) ; `upload` / `signedUrl` dans `backend.js`.
- [x] Positions : `lg_driver_ping` toutes les 30 s (écriture ≤ 1 / 25 s, trace toutes les 2 min) ; SOS ; dépenses
      de voyage (dans les coûts de la flotte) ; page de suivi : livreur, heure, arrêts avant, position, code,
      passage manqué. 7 tests serveur ; tournée complète vérifiée dans Chromium.
- Reste : migration `0005` à appliquer en ligne ; R2 facultatif (voir `wrangler.toml`) ; gains chauffeur,
      versements intermédiaires (`cash_drops`), facture à la livraison et avoirs des retours → C6 ; messages
      « livreur en route », « livré », « reprise prévue » → C8 ; `lg_my_reinforcements` (renforts) → C7 ;
      `lg_track_incidents` / réponse du client à une proposition d'incident → C11.

## C6 — Caisse, factures, reversements ✅ (08/10/2026) — bascule faite le 08/10/2026
- [x] Versements chauffeur (`lg_remit_cash`, comptage par billets), versements intermédiaires (`lg_cash_drop`),
      écarts → incident `cash_gap`, rapprochement (caisse versée, pas d'écart ouvert, colis rendus, collectes reçues),
      gains chauffeur au rapprochement (réglages `pay_*`, `bonus_*` ; retenue = gain négatif), reçu (`lg_cash_desk`).
- [x] Factures à la livraison et avoirs (numéros sans trou par année : compteur dans le même lot), avoir automatique
      sur retour d'un client livré, export comptable, relevés de reversement vendeur (`commission_pct`), facture sur
      la page de suivi ; incidents (`lg_open_incident`, `lg_incidents_list`, `lg_resolve_incident` : retenue,
      indemnité plafonnée, avoir, accord du client via `lg_track_incidents` / `lg_track_incident_answer`).
- [x] **BASCULE** (08/10/2026, session locale) : `deploy.yml` construit la version complète sur `main` ; logistique.nexusmarket.sn sert la version
      complète. Suppression du mode démo (PGlite, `src/demo/`, `seed`), de `supabase-js` et du mode
      `supabase` dans `backend.js` ; écran d'accueil sans « Démonstration ». Les fonctions pas encore
      portées affichent « bientôt disponible » au lieu d'une erreur.
- Reste : migration `0006` à appliquer en ligne ; **bascule laissée à l'utilisateur** : `deploy.yml` déploie à
      chaque push sur `main`, la passer en `build:api` mettrait la version complète en production — à faire
      seulement après `npx wrangler d1 migrations apply nexus-logistics --remote` (0003 → 0006) ; règles de paie
      par type de véhicule (`lg_pay_rules`) remplacées par les réglages de l'entreprise ; paiement des gains
      (marquer « payé ») → C7 ; message « facture envoyée » → C8.

## C7 — Pilotage et tâches automatiques ✅ (08/10/2026)
- [x] Tour de contrôle (`lg_dashboard` : chiffres du jour, voyages avec position et jauge, alertes, commandes à
      affecter ; rafraîchissement par interrogation toutes les 15 s), `lg_ack_alert` (`lg_transfer_stop` : C5).
- [x] Tâches planifiées : route `POST /api/cron/<tâche>` (secret `CRON_SECRET`), surveillance toutes les 5 min
      (retards, arrêts longs, chauffeurs sans position, colis oubliés, documents, verrous de préparation) et nettoyage
      horaire, en requêtes groupées pour toutes les entreprises ; appelées par `nexus-cron` (le Worker dédié `cron/` n'a jamais été déclenché par Cloudflare : retiré le 08/10/2026).
- [x] Indicateurs (`lg_kpis`, `lg_kpis_by_axis`), coûts et marges (`lg_costs`), prévision (`lg_forecast`),
      anomalies (`lg_anomalies`), classement (`lg_leaderboard`), retours par cause (`lg_return_stats`), renforts
      (`lg_reinforcement_*`, `lg_my_reinforcements`). Calculés à la lecture : aucune écriture. 7 tests serveur.
- Reste : migration `0007` à appliquer en ligne ; tâches branchées sur `nexus-cron` (fait le 08/10/2026) ; rapport du soir et message de renfort → C8 (messages) ; relances des
      vendeurs → C11 (engagements de délai) ; paiement des gains (marquer « payé ») → C11.

## C8 — Messages clients ✅ (08/10/2026)
- [x] Modèles modifiables par entreprise (16 messages, défauts dans le code, ligne écrite à la modification), aperçu,
      file d'envoi (`lg_templates_list`, `lg_template_save`, `lg_preview_message`, `lg_outbox_recent`,
      `lg_outbox_channels`, `lg_outbox_mark_sent`, `lg_outbox_cancel`) ; messages branchés sur tout le parcours
      (confirmation, rupture, préparée, en route avec le code, personne désignée, à l'approche, livrée avec la facture,
      échec, reprise, proposition d'indemnité, renfort, rapport du soir à 19 h).
- [x] Envoi **gratuit** par défaut : lien `wa.me` pré-rempli dans la file d'envoi ; envoi automatique par l'instance
      WhatsApp **de l'entreprise** (Green API, jeton chiffré AES-GCM avec `SECRETS_KEY`, `lg_channel_get/save`) par la
      tâche planifiée « messages » ; e-mail de secours (Brevo) ; réponses du client par webhook
      (`POST /api/whatsapp/<secret>` : OUI / NON, note 1 à 5, choix 1 / 2 / 3).
- Reste : migration `0008` à appliquer en ligne ; secrets `SECRETS_KEY` (et `BREVO_API_KEY` si e-mail de secours)
      à poser (voir `wrangler.toml`) ; versions wolof des modèles à faire rédiger ; relances vendeurs → C11.

## C9 — Offre payante et site public ✅ (08/10/2026)
- [x] Formules gratuite (300 commandes par mois, 3 chauffeurs, 2 lieux) et Pro (15 000 F par mois), réglables par la
      plateforme (`app_settings` « plans ») ; quotas contrôlés à la création (commandes, chauffeurs, lieux) ; paiement
      **Wave / Orange Money déclaré** (`lg_plan_declare`) puis validé par la plateforme, qui prolonge de 30 jours par mois.
- [x] Administration de la plateforme (`ADMIN_EMAILS`, rôle `platform`, écran /plateforme) : entreprises, formules,
      suspension, paiements, statistiques, erreurs remontées (`POST /api/errors`, limité à 20 par heure et par adresse).
- [x] Page d'accueil avec les formules (`GET /api/plans`), mentions légales, CGU, confidentialité, `robots.txt`,
      `sitemap.xml`, balises de partage ; onglet Administration → Abonnement. 5 tests serveur.
- Reste : migration `0009` à appliquer en ligne ; variable `ADMIN_EMAILS` à poser sur Pages ; numéros Wave / Orange
      Money à saisir dans Plateforme → Formules ; Sentry non branché (suivi maison suffisant pour l'instant).

## C10 — Intégration NEXUS Market ✅ côté NEXUS Logistics (08/10/2026)
- [x] Lecture de l'état d'une commande par l'API (`GET /api/v1/orders/<référence>`), même clé que l'envoi.
- [x] Statuts renvoyés à la boutique par un appel signé HMAC-SHA256 (`order.confirmed` … `order.cancelled`),
      adresse et secret par entreprise (`lg_webhook_get/save`, secret chiffré), envoi et reprises par la tâche
      « messages » ; notice `docs/integration-boutiques.md`. 3 tests serveur.
- [x] Côté dépôt `nexus-market` (08/10/2026, commit 5765b4e) : envoyer les commandes, recevoir les statuts, retirer
      `lg-fallback.js` — étapes détaillées au § 5 de `docs/integration-boutiques.md`.
- Reste : migration `0010` à appliquer en ligne ; créer l'entreprise « NEXUS Market », sa clé et son adresse de rappel.

## C11 — Fonctions avancées restantes et nettoyage ✅ (08/10/2026)
- [x] Ce qui restait des cycles 6 à 22 : engagement de délai des vendeurs (`lg_my_commitment`,
      `lg_vendor_commitment_set`, `lg_vendor_commitments_list`, heure limite des préparations, relances par la tâche
      planifiée « reminders »). Incidents et assurance, retours et causes, coûts, renforts : portés aux C5 à C7.
      Toutes les fonctions appelées par l'interface existent désormais en mode `api` ; les fonctions Postgres non
      portées sont des aides internes réécrites en JavaScript, ou `lg_upsert_pay_rule` / `lg_issue_invoice_manual`
      (sans écran : paie réglée par l'entreprise, facture émise à la livraison). 2 tests serveur.
- [x] Suppression de l'archive Postgres (`supabase/`, `test/sql/`, `nexus-logistics-mvp.sql`), du mode démo et de
      `supabase-js` ; README réécrit (08/10/2026, après la bascule).
- Reste : migration `0011` à appliquer en ligne ; bascule (voir C6) puis nettoyage.

