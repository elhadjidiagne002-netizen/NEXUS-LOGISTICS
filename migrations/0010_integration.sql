-- NEXUS Logistics sur Cloudflare D1 — cycle C10 : intégration des boutiques en ligne (dont NEXUS Market).
-- Les statuts de livraison des commandes reçues par l'API repartent vers la boutique par un appel signé (HMAC-SHA256).

-- Adresse de rappel de l'entreprise (une par entreprise) ; secret de signature chiffré (SECRETS_KEY)
CREATE TABLE webhook_endpoints (
  company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Événements à envoyer (créés seulement pour les commandes qui ont une référence externe et si une adresse existe)
CREATE TABLE webhook_events (
  id         TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id   TEXT NOT NULL,
  event      TEXT NOT NULL,
  payload    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at    TEXT
);
CREATE INDEX webhook_events_pending ON webhook_events(status, created_at) WHERE status = 'pending';
CREATE INDEX webhook_events_company ON webhook_events(company_id, created_at);
