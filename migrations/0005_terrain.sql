-- NEXUS Logistics sur Cloudflare D1 — cycle C5 : livraison sur le terrain.
-- Portage de lg_delivery_codes, lg_proofs, lg_cod_collections, lg_verified_addresses, lg_driver_positions,
-- lg_trip_expenses (socle et pilotage), lg_return_causes / lg_return_charges (cycle 8), lg_return_inspections
-- (cycle 5) ; demandes de retour (return_requests, table du site NEXUS dans la version Postgres).
-- Fichiers (photos, signatures) : R2 si la liaison PROOFS existe, sinon table `files` (repli gratuit, D1).

-- Code de livraison donné par le client (4 chiffres). Gardé en clair : il s'affiche aussi sur sa page de suivi
-- privée ; il expire (otp_ttl_hours) et ses essais sont décomptés (otp_attempts).
CREATE TABLE delivery_codes (
  order_id      TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code          TEXT NOT NULL,
  attempts_left INTEGER NOT NULL DEFAULT 3,
  expires_at    TEXT NOT NULL,
  verified_at   TEXT
);

CREATE TABLE proofs (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  stop_id        TEXT NOT NULL REFERENCES trip_stops(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('otp', 'signature', 'photo', 'failure_photo')),
  file_path      TEXT,
  recipient_name TEXT,
  lat            REAL,
  lng            REAL,
  distance_m     INTEGER,
  created_by     TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX proofs_stop ON proofs(stop_id);

-- Encaissements à la livraison (espèces, Wave, Orange Money)
CREATE TABLE cod_collections (
  id                    TEXT PRIMARY KEY,
  company_id            TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  stop_id               TEXT NOT NULL REFERENCES trip_stops(id),
  order_id              TEXT NOT NULL REFERENCES orders(id),
  courier_id            TEXT NOT NULL,
  amount_due_fcfa       INTEGER NOT NULL,
  amount_collected_fcfa INTEGER NOT NULL CHECK (amount_collected_fcfa >= 0),
  method                TEXT NOT NULL CHECK (method IN ('cash', 'wave', 'orange_money')),
  payment_ref           TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX cod_collections_stop ON cod_collections(stop_id);

-- Adresse vérifiée : la position réelle de remise sert à la commande suivante du même client
CREATE TABLE verified_addresses (
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  phone_key  TEXT NOT NULL,
  lat        REAL NOT NULL,
  lng        REAL NOT NULL,
  landmark   TEXT,
  zone       TEXT,
  deliveries INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (company_id, phone_key)
);

-- Trace GPS échantillonnée (une position toutes les 2 minutes au plus, pendant un voyage seulement)
CREATE TABLE driver_positions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  courier_id  TEXT NOT NULL,
  trip_id     TEXT,
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  accuracy_m  INTEGER,
  speed_kmh   REAL,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX driver_positions_courier ON driver_positions(courier_id, recorded_at);

CREATE TABLE trip_expenses (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  trip_id      TEXT,
  vehicle_id   TEXT,
  courier_id   TEXT,
  kind         TEXT NOT NULL CHECK (kind IN ('carburant', 'peage', 'reparation', 'amende', 'stationnement', 'autre')),
  amount_fcfa  INTEGER NOT NULL CHECK (amount_fcfa > 0),
  receipt_path TEXT,
  note         TEXT,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_by   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX trip_expenses_company ON trip_expenses(company_id, created_at);

-- Retour demandé par un client livré (saisi par le service client) → arrêt de reprise
CREATE TABLE return_requests (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id    TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  category    TEXT,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending', 'approved', 'rejected', 'done')),
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX return_requests_company ON return_requests(company_id, status);

-- Causes de retour et qui paie (valeurs par défaut dans server/rpc/retours.js, ligne écrite à la modification)
CREATE TABLE return_causes (
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code       TEXT NOT NULL,
  label      TEXT NOT NULL,
  payer      TEXT NOT NULL CHECK (payer IN ('vendor', 'customer', 'company', 'none')),
  fee_mode   TEXT NOT NULL DEFAULT 'none' CHECK (fee_mode IN ('none', 'delivery', 'fixed')),
  fee_fcfa   INTEGER NOT NULL DEFAULT 0 CHECK (fee_fcfa >= 0),
  active     INTEGER NOT NULL DEFAULT 1,
  position   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, code)
);

CREATE TABLE return_charges (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  package_id    TEXT NOT NULL UNIQUE REFERENCES packages(id) ON DELETE CASCADE,
  order_id      TEXT NOT NULL,
  cause         TEXT NOT NULL,
  payer         TEXT NOT NULL,
  amount_fcfa   INTEGER NOT NULL DEFAULT 0,
  vendor_id     TEXT,
  zone          TEXT,
  note          TEXT,
  classified_by TEXT,
  classified_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE return_inspections (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  package_id   TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  condition    TEXT NOT NULL CHECK (condition IN ('neuf', 'bon', 'abime', 'inutilisable')),
  decision     TEXT NOT NULL CHECK (decision IN ('restock', 'vendor', 'scrap')),
  note         TEXT,
  photo_path   TEXT,
  inspected_by TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Repli de stockage des photos et signatures quand R2 n'est pas branché (≤ 1,5 Mo par fichier).
CREATE TABLE files (
  company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  path         TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size         INTEGER NOT NULL,
  data         BLOB NOT NULL,
  created_by   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (company_id, path)
);
