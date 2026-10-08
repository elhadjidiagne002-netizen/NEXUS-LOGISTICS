-- NEXUS Logistics sur Cloudflare D1 — socle multi-entreprises (cycle C1).
-- Chaque entreprise (société de livraison, boutique qui livre, vendeur) a ses propres données :
-- TOUTE table métier porte company_id, et toute requête filtre dessus (test d'isolation).
-- Dates en texte ISO 8601 UTC ; montants en FCFA entiers ; identifiants = UUID texte.

CREATE TABLE companies (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL UNIQUE,          -- adresse publique (page de suivi, liens)
  kind         TEXT NOT NULL DEFAULT 'livraison' CHECK (kind IN ('livraison', 'boutique', 'vendeur', 'autre')),
  phone        TEXT,
  city         TEXT NOT NULL DEFAULT 'Dakar',
  plan         TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro')),
  plan_until   TEXT,
  settings     TEXT NOT NULL DEFAULT '{}',    -- réglages (JSON), cf. server/config.js
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  suspended_at TEXT
);

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  suspended_at  TEXT
);

-- Appartenance à une entreprise. owner/admin = administrateur de l'entreprise ;
-- staff = membre dont les droits viennent de staff_roles (préparateur, chef de quai…) ;
-- vendor = vendeur dont l'entreprise livre les colis ; courier = chauffeur-livreur.
CREATE TABLE members (
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'staff', 'vendor', 'courier')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (company_id, user_id)
);
CREATE INDEX members_user ON members(user_id);

CREATE TABLE hubs (
  id         TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'hub' CHECK (kind IN ('hub', 'relay', 'vendor')),
  address    TEXT,
  lat        REAL,
  lng        REAL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX hubs_company ON hubs(company_id);

-- Rôles logistiques (mêmes codes que la version Postgres : picker, dock_chief, dispatcher,
-- cashier, accountant, support), éventuellement limités à un hub.
CREATE TABLE staff_roles (
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('picker', 'dock_chief', 'dispatcher', 'cashier', 'accountant', 'support')),
  hub_id     TEXT REFERENCES hubs(id) ON DELETE SET NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  granted_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (company_id, user_id, role)
);

-- Chauffeurs-livreurs. user_id facultatif : un chauffeur peut exister avant d'avoir un compte.
CREATE TABLE couriers (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  phone        TEXT,
  vehicle_kind TEXT NOT NULL DEFAULT 'moto' CHECK (vehicle_kind IN ('moto', 'velo', 'voiture', 'fourgonnette', 'tricycle', 'pied')),
  active       INTEGER NOT NULL DEFAULT 1,
  last_lat     REAL,
  last_lng     REAL,
  last_seen_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX couriers_company ON couriers(company_id);
CREATE UNIQUE INDEX couriers_user ON couriers(company_id, user_id) WHERE user_id IS NOT NULL;

-- Sessions : on ne stocke que l'empreinte SHA-256 du jeton. company_id = entreprise active.
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- Appareils (blocage d'un téléphone perdu, déconnexion à distance).
CREATE TABLE devices (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id       TEXT NOT NULL,
  label           TEXT,
  user_agent      TEXT,
  session_id      TEXT,
  revoked_session TEXT,
  blocked         INTEGER NOT NULL DEFAULT 0,
  blocked_reason  TEXT,
  blocked_at      TEXT,
  revoked_at      TEXT,
  first_seen_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (company_id, user_id, device_id)
);

-- Invitations par lien (WhatsApp) : rôle de membre + rôles logistiques proposés.
CREATE TABLE invites (
  token_hash  TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('admin', 'staff', 'vendor', 'courier')),
  staff_roles TEXT NOT NULL DEFAULT '[]',
  name        TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  used_by     TEXT
);

-- Rejeu des actions de terrain (idempotence) : même p_event → même résultat, sans réécrire.
CREATE TABLE action_log (
  company_id TEXT NOT NULL,
  event_id   TEXT NOT NULL,
  fn         TEXT NOT NULL,
  result     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (company_id, event_id)
);

-- Numéros sans trou (factures, voyages, incidents…) : compteur par entreprise et par clé.
CREATE TABLE counters (
  company_id TEXT NOT NULL,
  key        TEXT NOT NULL,
  n          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, key)
);

-- Journal d'audit (qui a fait quoi).
CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT,
  user_id    TEXT,
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  TEXT,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX audit_company ON audit_log(company_id, created_at);

CREATE TABLE rate_limits (key TEXT NOT NULL, ts TEXT NOT NULL);
CREATE INDEX rate_limits_key ON rate_limits(key, ts);

-- Réglages de la plateforme (quotas de la formule gratuite, prix…), modifiables par l'admin plateforme.
CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
