-- NEXUS Logistics sur Cloudflare D1 — cycle C2 : commandes, clients, catalogue, zones, tarifs, suivi client.
-- Portage de delivery_zones + lg_zone_settings, lg_rate_cards, lg_surcharges, orders / order_items (colonnes
-- logistiques), products (fiche logistique), lg_customer_requests, lg_ratings, numeros_bannis.
-- Toute table porte company_id ; montants en FCFA entiers ; dates en texte ISO UTC (Dakar = UTC toute l'année).

-- Zones de livraison (quartiers) : centre, polygone facultatif ([[lat,lng],…] en JSON) et réglages d'ouverture.
CREATE TABLE zones (
  company_id      TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  city            TEXT,
  lat             REAL,
  lng             REAL,
  polygon         TEXT,
  served          INTEGER NOT NULL DEFAULT 1,
  cutoff_time     TEXT NOT NULL DEFAULT '12:00',            -- heure limite de commande (heure de Dakar)
  delivery_days   TEXT NOT NULL DEFAULT '[1,2,3,4,5,6]',    -- 0 = dimanche
  free_above_fcfa INTEGER,                                  -- livraison offerte au-delà de ce panier
  hub_id          TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (company_id, name)
);

-- Grille tarifaire : prix par tranche de poids, par zone et véhicule (NULL = tous), + prix au km facultatif.
CREATE TABLE rate_cards (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  zone         TEXT,
  vehicle_kind TEXT,
  max_weight_g INTEGER NOT NULL CHECK (max_weight_g > 0),
  price_fcfa   INTEGER NOT NULL CHECK (price_fcfa >= 0),
  per_km_fcfa  INTEGER NOT NULL DEFAULT 0 CHECK (per_km_fcfa >= 0),
  lead_hours   INTEGER NOT NULL DEFAULT 24,
  service      TEXT NOT NULL DEFAULT 'standard' CHECK (service IN ('standard', 'express', 'programme')),
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX rate_cards_company ON rate_cards(company_id, active);

-- Suppléments (nuit, forte pluie…). Les suppléments par défaut existent sans ligne (server/rpc/commandes.js) :
-- une ligne n'est écrite que lorsque l'administrateur ou le répartiteur les modifie.
CREATE TABLE surcharges (
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  label       TEXT NOT NULL,
  amount_fcfa INTEGER NOT NULL DEFAULT 0 CHECK (amount_fcfa >= 0),
  active      INTEGER NOT NULL DEFAULT 0,
  start_time  TEXT,
  end_time    TEXT,
  services    TEXT,          -- JSON, NULL = tous services
  zones       TEXT,          -- JSON, NULL = toutes zones
  until       TEXT,          -- fin d'une déclaration (pluie)
  updated_by  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (company_id, code)
);

-- Clients destinataires : un par numéro de téléphone (9 derniers chiffres) et par entreprise.
CREATE TABLE customers (
  id         TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL,
  phone_key  TEXT NOT NULL,
  address    TEXT,
  landmark   TEXT,
  lat        REAL,
  lng        REAL,
  zone       TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (company_id, phone_key)
);

-- Numéros bannis (refus répétés, fraude) : commande refusée.
CREATE TABLE banned_numbers (
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  phone_key  TEXT NOT NULL,
  phone      TEXT,
  reason     TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (company_id, phone_key)
);

-- Catalogue logistique : poids, dimensions, manutention (froid, fragile…), codes pour le « bip ».
CREATE TABLE products (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  vendor_id    TEXT,                       -- membre vendeur propriétaire de la fiche (facultatif)
  vendor_name  TEXT,
  name         TEXT NOT NULL,
  sku          TEXT,
  barcode      TEXT,
  price_fcfa   INTEGER NOT NULL DEFAULT 0 CHECK (price_fcfa >= 0),
  stock        INTEGER,
  weight_g     INTEGER CHECK (weight_g IS NULL OR weight_g > 0),
  length_cm    REAL,
  width_cm     REAL,
  height_cm    REAL,
  handling     TEXT NOT NULL DEFAULT '[]', -- JSON : fragile, froid, liquide, lourd, vivant…
  is_shippable INTEGER NOT NULL DEFAULT 1,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX products_company ON products(company_id, name);
CREATE INDEX products_barcode ON products(company_id, barcode);
CREATE INDEX products_sku ON products(company_id, sku);
CREATE INDEX products_vendor ON products(company_id, vendor_id);

-- Commandes à livrer. number = numéro visible sans trou (compteur « commande ») ; tracking_token = lien secret
-- de la page de suivi publique ; external_ref = référence de la boutique (API par clé, import) : pas de doublon.
CREATE TABLE orders (
  id                 TEXT PRIMARY KEY,
  company_id         TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  number             INTEGER NOT NULL,
  external_ref       TEXT,
  source             TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'csv', 'api')),
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'in_transit', 'delivered', 'cancelled')),
  payment_method     TEXT NOT NULL DEFAULT 'cod' CHECK (payment_method IN ('cod', 'prepaid')),
  payment_status     TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid')),
  customer_id        TEXT REFERENCES customers(id) ON DELETE SET NULL,
  buyer_name         TEXT NOT NULL,
  buyer_phone        TEXT NOT NULL,
  buyer_email        TEXT,
  buyer_address      TEXT,
  landmark           TEXT,
  delivery_lat       REAL,
  delivery_lng       REAL,
  delivery_zone      TEXT,
  vendor_id          TEXT,
  vendor_name        TEXT,
  hub_id             TEXT,
  service            TEXT NOT NULL DEFAULT 'standard',
  weight_g           INTEGER,
  subtotal_fcfa      INTEGER NOT NULL DEFAULT 0,
  discount_fcfa      INTEGER NOT NULL DEFAULT 0,
  delivery_fee_fcfa  INTEGER NOT NULL DEFAULT 0,
  insured_value_fcfa INTEGER CHECK (insured_value_fcfa IS NULL OR insured_value_fcfa > 0),
  insurance_fee_fcfa INTEGER NOT NULL DEFAULT 0,
  total_fcfa         INTEGER NOT NULL DEFAULT 0,
  promised_at        TEXT,
  tracking_token     TEXT NOT NULL UNIQUE,
  cod_confirmed_at   TEXT,
  cod_confirmed_via  TEXT,
  recipient_name     TEXT,
  recipient_phone    TEXT,
  note               TEXT,
  paid_at            TEXT,
  processing_at      TEXT,
  in_transit_at      TEXT,
  delivered_at       TEXT,
  cancelled_at       TEXT,
  cancel_reason      TEXT,
  created_by         TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (company_id, number)
);
CREATE INDEX orders_company_status ON orders(company_id, status, created_at);
CREATE INDEX orders_company_customer ON orders(company_id, customer_id);
CREATE UNIQUE INDEX orders_external_ref ON orders(company_id, external_ref) WHERE external_ref IS NOT NULL;

CREATE TABLE order_items (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id        TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id      TEXT,
  product_name    TEXT NOT NULL,
  quantity        INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_fcfa INTEGER NOT NULL DEFAULT 0 CHECK (unit_price_fcfa >= 0),
  weight_g        INTEGER,
  line_status     TEXT NOT NULL DEFAULT 'open' CHECK (line_status IN ('open', 'picked', 'short', 'cancelled')),
  picked_qty      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX order_items_order ON order_items(order_id);

-- Demandes des clients (page de suivi, WhatsApp, service client) et notes de livraison.
CREATE TABLE customer_requests (
  id         TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id   TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('reschedule', 'callback', 'help', 'address', 'third_party', 'stockout_choice')),
  payload    TEXT NOT NULL DEFAULT '{}',
  channel    TEXT NOT NULL DEFAULT 'suivi' CHECK (channel IN ('suivi', 'whatsapp', 'support')),
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  handled_by TEXT,
  handled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX customer_requests_open ON customer_requests(company_id, status, created_at);
CREATE INDEX customer_requests_order ON customer_requests(order_id, created_at);

CREATE TABLE ratings (
  order_id   TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  courier_id TEXT,
  rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment    TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Clés d'API des boutiques en ligne (POST /api/v1/orders) : seule l'empreinte SHA-256 est gardée.
CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  prefix       TEXT NOT NULL,              -- début de la clé, pour la reconnaître dans la liste
  key_hash     TEXT NOT NULL UNIQUE,
  created_by   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used_at TEXT,
  revoked_at   TEXT
);
CREATE INDEX api_keys_company ON api_keys(company_id);
