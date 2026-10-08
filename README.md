# NEXUS LOGISTICS

De la commande payée à la livraison encaissée : préparation, facture, chargement,
tournée, preuve de livraison, caisse. Construit d'après le **dossier de conception v2.0**
(`NEXUS-LOGISTICS-Dossier-de-conception-v2.pdf`, 7 octobre 2026), calé sur la base
Supabase de NEXUS Market.

## Démarrer

```bash
npm install
```

```bash
npm run dev
```

Ouvre http://localhost:5610. **Sans variables d'environnement, l'app démarre en mode
démo** : une base Postgres complète tourne dans le navigateur (PGlite), avec exactement
les mêmes migrations que la prod et une journée fictive déjà jouée (12 commandes, 2
voyages, une livraison, un échec, des alertes). Choisissez un rôle et essayez.
Le bouton réseau (en haut à droite) permet de **simuler une coupure** et de
réinitialiser la démo.

Mode réel : copier `.env.example` en `.env` et renseigner `VITE_SUPABASE_URL` et
`VITE_SUPABASE_ANON_KEY` (clé publique). Les comptes sont ceux de NEXUS Market.

```bash
npm test
```

98 tests : parcours complet en SQL, droits réels sous les rôles `anon` et
`authenticated`, scénario de démo, un fichier par cycle d'amélioration, algorithmes.

## Ce qui est construit

| Module du dossier | Où | État |
|---|---|---|
| 01 Préparation | `/preparation`, migration 03 | P1 : file par heure limite, verrou, scan (caméra, douchette, saisie), produit sans code, rupture, colisage multi-colis, étiquettes A6 QR, mise à quai |
| 02 Facturation | `/factures`, migration 05 | P1 + export : facture auto (paiement en ligne ou encaissement), lignes réellement livrées, remise, livraison, TVA, montant en lettres, avoirs numérotés, numérotation **sans trou**, export CSV (journal, TVA, encaissements) |
| 03 Chargement | `/quai`, migration 04 | P1 + P2 : voyage, affectation, scan avec 3 jauges, refus motivés, incompatibilités (annexe C), plan de chargement, contrôle de départ, signature, bordereau, contrôle véhicule |
| 04 Tour de contrôle | `/tour`, migration 07 | P1 + P2 : indicateurs, carte, voyages par urgence, alertes, suggestion d'affectation notée, regroupement par zone, relecture du trajet |
| 05 Chauffeur | `/chauffeur`, migration 04 | P1 : ma journée, naviguer/appeler/WhatsApp, livraison (colis, montant exact, code ou signature, photo ~120 Ko, position), échec motivé, fin de tournée, **hors ligne**, SOS, dépenses, plafond d'espèces |
| 06 Suivi client | `/suivi/:jeton`, migration 06 | P1 + P2 : page sans compte, étapes, heure estimée, carte, confirmation, épingle + repère, note, demandes, facture, créneaux ; réponses WhatsApp (OUI/NON, 1-5, 1/2/3) |
| 07 Retours | `/quai` → Retours | P1 : réception par une autre personne, nouvelle présentation, retour vendeur avec stock rétabli et avoir |
| 08 Caisse | `/caisse` | P1 : comptage par billets, écart → incident, rapprochement bloqué jusqu'à décision, gains du chauffeur, reçu |
| 09 Vendeurs | `/vendeur` | P1/P2 : colis, délais, ruptures, fiches produit (code, poids, taille) + import CSV |
| 10 Flotte | `/admin` → Flotte | P1/P2 : fiches, documents et échéances (blocage si expiré), entretien, coûts |
| 12 Tarification | `/admin` → Tarifs | P1/P2 : grille zone × véhicule × poids, délai promis, livraison offerte, express, `lg_quote` public pour le panier |
| 13 Incidents | `/sav` | P1/P2 : fiche, responsabilité par chaîne de garde, résolution, indemnité, retenue |
| 14 Analytique | `/analytique` | Les 12 indicateurs du chapitre 12, par zone, chauffeur, vendeur ; rapport du soir |
| 15 Administration | `/admin` | Rôles par personne et par lieu, réglages dans `app_config` (dont jours de pic, primes, double contrôle), journal d'audit |

### Ajouté pendant les 5 cycles d'amélioration (07/10/2026)
| Cycle | Contenu |
|---|---|
| 1 | Versement intermédiaire de caisse · réaffectation d'un arrêt avec transfert par double scan · reprise chez le client (retours demandés) · collecte chez les vendeurs et réception au hub |
| 2 | Refonte complète du design (barre latérale, onglets mobiles, Inter, icônes, mode sombre) · modèles de messages clients modifiables (annexe B) avec aperçu WhatsApp et file d'envoi |
| 3 | Planification automatique des voyages (simulation puis création) · double contrôle des commandes de valeur · consignes lues à voix haute · numéros de voyage sans saut |
| 4 | Entrepôt : emplacements, rangement, « où est ce produit ? », chemin de prélèvement, préparation par vague avec bacs, inventaire tournant à l'aveugle |
| 5 | Prévision de volume et de véhicules (jours de pic) · détection d'anomalies · classement et prime de ponctualité des chauffeurs · contrôle des retours (remise en vente / vendeur / rebut) · livraison à un tiers |

### Fonctions P2 ajoutées le 08/10/2026 (cycles 6 à 20)
| Cycle | Contenu | Où |
|---|---|---|
| 6 | **Lots et péremption** : rangement par lot et date, prélèvement « premier périmé, premier sorti », sortie de stock motivée, **traçabilité pour rappel produit** (qui a reçu le lot X) ; lots du vendeur dans son espace | `/entrepot` → Péremption, `/vendeur` |
| 7 | **Productivité de la préparation** : lignes par heure, mauvais scans, écarts au double contrôle, ruptures par vendeur, emballages consommés | `/entrepot` → Productivité, `/analytique` → Préparation |
| 8 | **Retours : frais et causes** : cause suggérée au contrôle, qui paie et combien (réglable), statistiques par motif / vendeur / quartier | `/quai` → Retours, `/analytique` → Retours |
| 9 | **Engagement de délai des vendeurs** : délai promis qui fixe l'heure limite, relances WhatsApp avant échéance et en retard, ponctualité | `/vendeur` → Mon engagement, `/analytique` → Vendeurs |
| 10 | **Suppléments nuit et forte pluie** au devis (désactivés par défaut) ; la pluie se déclare depuis la tour de contrôle | `/tour`, `/admin` → Tarifs |
| 11 | **Plusieurs quais** : arrivée du véhicule, file d'attente, affectation d'un quai, temps moyens de chargement et d'attente | `/quai` → Quais, app chauffeur |
| 12 | **Tableaux par axe** (zone, vendeur, chauffeur, véhicule, jour, heure) et **export Excel** | `/analytique` → Indicateurs |
| 13 | **Coûts** : par véhicule (au km, par colis), marge par zone, coût des échecs | `/analytique` → Coûts |
| 14 | **Assurance colis** (prime au devis, plafond d'indemnisation), **avoir** de l'indemnité, **accord du client** depuis sa page de suivi | `/sav` → Incidents, `/suivi/:jeton` |
| 15 | **Appareils** : liste des téléphones, déconnexion à distance, blocage d'un appareil perdu (appliqué côté serveur) | `/admin` → Appareils |
| 16 | **Relevé de reversement vendeur** (indicatif) : produits livrés − commission − frais de retour ; espèces reversables après rapprochement | `/vendeur` → Reversements, `/factures` |
| 17 | **Dépôt par le vendeur** : créneaux au hub, réservation, plus de collecte prévue, réception directe | `/vendeur` → Dépôt au hub, `/quai` → Réception |
| 18 | **Canal de secours e-mail (Brevo)** : WhatsApp d'abord, e-mail seulement s'il échoue ; canal visible par message | `/messages`, NEXUS `lg-fallback.js` |
| 19 | **Entretien préventif** : kilométrage estimé, échéance du carnet, alerte dans la tour de contrôle | `/admin` → Flotte, `/tour` |
| 20 | **Retour de tournée** : écart signalé dès la clôture, colis attendus au quai, alerte levée au dernier scan | `/quai` → Retours, `/tour` |

Les montants proposés (frais par cause de retour, plafond sans assurance, prime, suppléments)
sont des valeurs de départ **à valider** ; tous sont réglables dans l'administration.

## Organisation

```
supabase/migrations/   SQL à appliquer dans l'ordre (01 socle = annexe A rendue rejouable)
supabase/stub/         miroir des tables NEXUS utilisées (tests et démo SEULEMENT)
supabase/seed/         données fictives (tests et démo SEULEMENT)
src/lib/algo.js        chapitre 10 : ordre des arrêts, jauge, plan de chargement, affectation…
src/lib/backend.js     Supabase réel ou démo PGlite, même interface rpc()
src/lib/offline.js     file d'actions et de photos hors ligne, sans doublon
src/screens/           un écran par rôle
src/demo/scenario.js   la journée de démo, jouée par les vraies fonctions
test/                  node --test
```

## Mise en production — rien n'a été appliqué à la base réelle

Voir `CLAUDE.md` (« Mise en production »). En résumé : appliquer les migrations sur une
**branche de test Supabase**, rejouer une journée, puis la prod ; déployer l'app sur
Cloudflare Pages ; brancher l'envoi des messages `lg_*` de `notification_outbox` et la
veille `lg_watchdog()` (et `lg_vendor_reminders()`) dans le planificateur existant.
La CI « Vérification » lance les tests et la construction sur toute branche et pull request ;
le déploiement ne part que de `main`.
