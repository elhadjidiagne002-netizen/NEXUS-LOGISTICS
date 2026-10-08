-- NEXUS Logistics sur Cloudflare D1 — cycle C8 : messages aux clients, aux chauffeurs et au gérant.
-- Portage de lg_message_templates et de notification_outbox (table du site NEXUS dans la version Postgres).
-- Envoi gratuit par défaut : le message attend dans la file et part d'un geste (lien wa.me pré-rempli) ; envoi
-- automatique si l'entreprise branche SA propre instance WhatsApp (Green API) ; e-mail de secours (Brevo).

-- Modèle modifié par l'entreprise (les modèles par défaut sont dans server/rpc/messages.js : une ligne n'est écrite
-- qu'à la modification)
CREATE TABLE message_templates (
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  event_key  TEXT NOT NULL,
  body_fr    TEXT NOT NULL,
  body_wo    TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (company_id, event_key)
);

-- File d'envoi : le texte final est calculé à la création (le modèle peut changer ensuite)
CREATE TABLE outbox (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  event_key       TEXT NOT NULL,
  order_id        TEXT,
  phone           TEXT,
  email           TEXT,
  vars            TEXT NOT NULL DEFAULT '{}',
  text            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
  whatsapp_status TEXT CHECK (whatsapp_status IN ('sent', 'failed', 'skipped', 'manual')),
  email_status    TEXT CHECK (email_status IN ('sent', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at         TEXT
);
CREATE INDEX outbox_company ON outbox(company_id, created_at);
CREATE INDEX outbox_pending ON outbox(status, created_at) WHERE status = 'pending';
CREATE INDEX outbox_phone ON outbox(company_id, phone, created_at);

-- Instance WhatsApp de l'entreprise (Green API) : jeton chiffré (AES-GCM, clé SECRETS_KEY), jamais renvoyé en clair
CREATE TABLE channels (
  company_id     TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  provider       TEXT NOT NULL CHECK (provider IN ('green_api')),
  instance_id    TEXT NOT NULL,
  token_enc      TEXT NOT NULL,
  webhook_secret TEXT NOT NULL UNIQUE,
  active         INTEGER NOT NULL DEFAULT 1,
  last_error     TEXT,
  updated_by     TEXT,
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
