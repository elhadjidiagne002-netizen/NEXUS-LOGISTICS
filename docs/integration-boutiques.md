# Brancher une boutique en ligne (dont NEXUS Market) sur NEXUS Logistics

## 1. Clé d'API
Administration → API boutiques → « Créer une clé » (`nxl_…`, affichée une seule fois). À garder **côté serveur**
de la boutique (jamais dans le navigateur du client).

## 2. Envoyer une commande payée ou à payer à la livraison
```
POST https://logistique.nexusmarket.sn/api/v1/orders
Authorization: Bearer nxl_…
Content-Type: application/json

{ "external_ref": "NXM-2026-0042",
  "customer": { "name": "Aminata Fall", "phone": "771234567", "address": "Liberté 6", "landmark": "près de la mosquée" },
  "zone": "Yoff",
  "payment_method": "prepaid",            // ou "cod" (paiement à la livraison)
  "items": [{ "name": "Riz 5 kg", "quantity": 1, "unit_price_fcfa": 5000, "weight_g": 5000 }] }
```
- Prix unitaire en FCFA entiers (`unit_price_fcfa` ; `price_fcfa` est aussi accepté). `zone` = nom d'une zone créée
  dans Administration → Tarifs et zones (sans tenir compte des accents ni des majuscules), ou bien `customer.lat` /
  `customer.lng` : sans zone reconnue, la commande est refusée (`unknown_zone`).
- Une même `external_ref` n'est jamais créée deux fois : un renvoi rend la commande existante (`duplicate: true`).
- Jusqu'à 50 commandes d'un coup : `{ "orders": [ … ] }`. 300 appels par heure et par clé.

## 3. Lire l'état d'une commande
```
GET https://logistique.nexusmarket.sn/api/v1/orders/NXM-2026-0042
Authorization: Bearer nxl_…
```
Réponse : `status` (pending, processing, in_transit, delivered, cancelled), `payment_status`, `steps`, `delivery`
(livreur, heure prévue, motif d'échec), `invoice`, `tracking_url`.

## 4. Recevoir les statuts (appel signé)
Administration → API boutiques → « Statuts renvoyés à la boutique » : adresse `https://…` ; le **secret**
(`whsec_…`) n'est montré qu'une fois. À chaque étape d'une commande reçue par l'API, NEXUS Logistics envoie :
```
POST <votre adresse>
X-Nexus-Timestamp: 1760000000
X-Nexus-Signature: sha256=<hex>
{ "event": "order.delivered", "at": "2026-10-08T14:32:00.000Z", "external_ref": "NXM-2026-0042", "number": 42,
  "status": "delivered", "payment_status": "paid", "tracking_token": "…", "data": { "invoice": "FAC-2026-000042", … } }
```
Événements : `order.confirmed`, `order.prepared`, `order.in_transit`, `order.delivered`, `order.failed`,
`order.cancelled`. Vérification (Node / Workers) :
```js
const expected = hex(HMAC_SHA256(secret, `${timestamp}.${rawBody}`));
if (`sha256=${expected}` !== signatureHeader || Math.abs(Date.now() / 1000 - timestamp) > 300) return new Response('', { status: 401 });
```
Répondre 2xx rapidement ; sinon l'appel est réessayé (toutes les 5 min, 6 essais au plus).

## 5. Côté dépôt `nexus-market` (à faire dans ce dépôt-là)
- À la commande payée (ou confirmée en paiement à la livraison) : `POST /api/v1/orders` avec la clé de
  l'entreprise « NEXUS Market » (secret `NXL_API_KEY`), `external_ref` = identifiant de la commande NEXUS.
- Nouvelle route `POST /api/logistique/webhook` : vérifier la signature (secret `NXL_WEBHOOK_SECRET`), puis mettre
  à jour le statut de la commande NEXUS (expédiée, livrée, annulée) et le lien de suivi.
- Retirer `functions/api/_lib/lg-fallback.js` et la tâche `/cron/notify-retry` pour les messages `lg_*` : les
  messages aux clients partent désormais de NEXUS Logistics (cycle C8).
