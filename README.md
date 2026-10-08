# NEXUS Logistics

De la commande payée à la livraison encaissée, pour **toute entreprise qui livre** (sociétés de livraison,
boutiques et vendeurs qui ont leurs livreurs) : commandes, préparation scannée, chargement contrôlé, tournée,
preuve de livraison, caisse rapprochée, facture automatique, suivi client, pilotage.

En ligne : **https://logistique.nexusmarket.sn** — formule gratuite (300 commandes par mois, 3 chauffeurs,
2 lieux) et formule Pro (15 000 F par mois), paiement Wave ou Orange Money.

## Architecture (entièrement Cloudflare, offres gratuites)

| Partie | Où |
|---|---|
| Interface (React + Vite, installable, hors ligne) | `src/` → `dist/` (Cloudflare Pages) |
| API (Pages Functions, runtime Workers) | `functions/api/[[path]].js` → `server/` |
| Fonctions métier `lg_*` (`POST /api/rpc/<nom>`) | `server/rpc/*.js` |
| Base (D1 `nexus-logistics`, multi-entreprises) | `migrations/*.sql` |
| Tâches planifiées (toutes les 5 min) | Worker `cron/` |
| API des boutiques en ligne, statuts signés | `docs/integration-boutiques.md` |

Chaque entreprise ne voit que ses données (`company_id` sur toutes les tables, test d'isolation pour chaque
fonction). Règles et pièges : `CLAUDE.md`. Plan et état : `ROADMAP.md`. Historique : `JOURNAL.md`.

## Travailler en local

```bash
npm install
```

```bash
npm run api
```

```bash
npm run dev
```

`npm run api` lance l'API sur une base SQLite locale (`.wrangler/dev.sqlite`, même schéma que D1, port 8789) ;
`npm run dev` ouvre l'interface sur http://localhost:5610 (Vite relaie `/api`). Créez une entreprise depuis
l'écran de connexion, puis invitez l'équipe (Administration → Rôles → « Inviter par lien »).

```bash
npm test
```

Tests du serveur (D1 imitée sur `node:sqlite`, isolation entre entreprises, rôles, idempotence) et des
algorithmes de l'interface.

## Mise en ligne

Automatique à chaque push sur `main` (`.github/workflows/deploy.yml`) : tests → construction → migrations D1 →
publication → vérification. À la main, depuis la racine :

```bash
npx wrangler d1 migrations apply nexus-logistics --remote
```

```bash
npm run build && npx wrangler pages deploy dist --project-name nexus-logistics --branch main
```

Secrets du projet Pages (jamais dans le dépôt) : `CRON_SECRET` (même valeur que le Worker `cron/`),
`SECRETS_KEY`, `ADMIN_EMAILS`, et `BREVO_API_KEY` en option (e-mail de secours).
