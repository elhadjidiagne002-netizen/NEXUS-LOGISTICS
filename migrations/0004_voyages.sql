-- NEXUS Logistics sur Cloudflare D1 — cycle C4 : flotte, quai et voyages.
-- Portage de lg_vehicles, lg_vehicle_documents, lg_vehicle_logs, lg_trips, lg_trip_stops, lg_trip_packages,
-- lg_docks (cycle 11), lg_dropoff_slots / lg_dropoff_bookings (cycle 17), lg_slots (créneaux client), lg_alerts.
-- Le plan de chargement (zone et ordre de chaque colis dans le véhicule) n'est PAS stocké : il se calcule à la
-- lecture (server/rpc/voyages.js), sinon chaque scan réécrirait tous les colis du voyage (budget d'écritures D1).

ALTER TABLE couriers ADD COLUMN license_expires_at TEXT;
ALTER TABLE couriers ADD COLUMN cash_limit_fcfa INTEGER;          -- NULL = plafond général (réglage)
ALTER TABLE couriers ADD COLUMN deliveries_done INTEGER NOT NULL DEFAULT 0;
ALTER TABLE couriers ADD COLUMN rating_avg REAL NOT NULL DEFAULT 5;
ALTER TABLE couriers ADD COLUMN rating_count INTEGER NOT NULL DEFAULT 0;
-- Adresse et position d'un membre (vendeur : lieu de collecte de ses colis)
ALTER TABLE members ADD COLUMN address TEXT;
ALTER TABLE members ADD COLUMN lat REAL;
ALTER TABLE members ADD COLUMN lng REAL;
-- Créneau de livraison choisi par le client
ALTER TABLE orders ADD COLUMN slot_id TEXT;

CREATE TABLE vehicles (
  id                 TEXT PRIMARY KEY,
  company_id         TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  plate              TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('vélo', 'moto', 'tricycle', 'voiture', 'fourgonnette', 'camion')),
  label              TEXT,
  capacity_kg        REAL NOT NULL CHECK (capacity_kg > 0),
  capacity_l         REAL,
  max_packages       INTEGER,
  equipment          TEXT NOT NULL DEFAULT '[]',
  ownership          TEXT NOT NULL DEFAULT 'interne' CHECK (ownership IN ('interne', 'partenaire', 'independant')),
  hub_id             TEXT,
  default_courier_id TEXT,
  status             TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'on_trip', 'maintenance', 'retired')),
  odometer_km        INTEGER,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (company_id, plate)
);

CREATE TABLE vehicle_documents (
  id         TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  vehicle_id TEXT REFERENCES vehicles(id) ON DELETE CASCADE,
  courier_id TEXT REFERENCES couriers(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('assurance', 'visite_technique', 'carte_grise', 'permis', 'autre')),
  number     TEXT,
  expires_at TEXT NOT NULL,
  file_path  TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (vehicle_id IS NOT NULL OR courier_id IS NOT NULL)
);
CREATE INDEX vehicle_documents_vehicle ON vehicle_documents(vehicle_id);

CREATE TABLE vehicle_logs (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  vehicle_id  TEXT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  trip_id     TEXT,
  kind        TEXT NOT NULL CHECK (kind IN ('checklist', 'entretien', 'panne', 'kilometrage', 'pneus', 'vidange')),
  odometer_km INTEGER,
  checklist   TEXT,
  ok          INTEGER NOT NULL DEFAULT 1,
  cost_fcfa   INTEGER,
  note        TEXT,
  photos      TEXT NOT NULL DEFAULT '[]',
  next_due_km INTEGER,
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX vehicle_logs_vehicle ON vehicle_logs(vehicle_id, created_at);

CREATE TABLE docks (
  id         TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  hub_id     TEXT NOT NULL,
  code       TEXT NOT NULL,
  label      TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (company_id, hub_id, code)
);

-- Voyages. Numéro sans trou (compteur « voyage »). Un véhicule et un chauffeur n'ont qu'un voyage ouvert à la fois.
CREATE TABLE trips (
  id                     TEXT PRIMARY KEY,
  company_id             TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  number                 INTEGER NOT NULL,
  kind                   TEXT NOT NULL DEFAULT 'delivery' CHECK (kind IN ('delivery', 'pickup', 'mixed', 'transfer')),
  label                  TEXT,
  hub_id                 TEXT,
  vehicle_id             TEXT NOT NULL REFERENCES vehicles(id),
  courier_id             TEXT REFERENCES couriers(id),
  planned_departure      TEXT,
  status                 TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('draft', 'planned', 'loading', 'sealed', 'in_progress',
                           'completed', 'reconciled', 'cancelled')),
  zones                  TEXT NOT NULL DEFAULT '[]',
  load_weight_g          INTEGER NOT NULL DEFAULT 0,
  load_volume_l          REAL NOT NULL DEFAULT 0,
  load_count             INTEGER NOT NULL DEFAULT 0,
  cod_expected_fcfa      INTEGER NOT NULL DEFAULT 0,
  cash_collected_fcfa    INTEGER NOT NULL DEFAULT 0,
  distance_km            REAL,
  courier_signature_path TEXT,
  sealed_by              TEXT,
  sealed_at              TEXT,
  started_at             TEXT,
  ended_at               TEXT,
  dock_id                TEXT,
  dock_queued_at         TEXT,
  dock_assigned_at       TEXT,
  created_by             TEXT,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (company_id, number)
);
CREATE INDEX trips_company_status ON trips(company_id, status);
CREATE UNIQUE INDEX trips_vehicle_open ON trips(vehicle_id) WHERE status IN ('planned', 'loading', 'sealed', 'in_progress');
CREATE UNIQUE INDEX trips_courier_open ON trips(courier_id) WHERE courier_id IS NOT NULL AND status IN ('planned', 'loading', 'sealed', 'in_progress', 'completed');

CREATE TABLE trip_stops (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  trip_id           TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'delivery' CHECK (kind IN ('delivery', 'pickup', 'return')),
  order_id          TEXT REFERENCES orders(id),
  vendor_id         TEXT,
  contact_name      TEXT,
  contact_phone     TEXT,
  address           TEXT,
  landmark          TEXT,
  lat               REAL,
  lng               REAL,
  window_start      TEXT,
  window_end        TEXT,
  eta               TEXT,
  cod_due_fcfa      INTEGER NOT NULL DEFAULT 0 CHECK (cod_due_fcfa >= 0),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'en_route', 'arrived', 'delivered', 'failed', 'skipped')),
  failure_reason    TEXT,
  arrived_at        TEXT,
  arrived_auto      INTEGER NOT NULL DEFAULT 0,
  completed_at      TEXT,
  call_attempted_at TEXT
);
CREATE INDEX trip_stops_trip ON trip_stops(trip_id, seq);
CREATE INDEX trip_stops_order ON trip_stops(order_id);

CREATE TABLE trip_packages (
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  trip_id       TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  package_id    TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  stop_id       TEXT,
  loaded_at     TEXT,
  loaded_by     TEXT,
  outcome       TEXT CHECK (outcome IN ('delivered', 'failed', 'returned', 'removed', 'received')),
  transfer_from TEXT,
  PRIMARY KEY (trip_id, package_id)
);
-- un colis ne se trouve que dans un seul voyage en cours
CREATE UNIQUE INDEX trip_packages_active ON trip_packages(package_id) WHERE outcome IS NULL;
CREATE INDEX trip_packages_stop ON trip_packages(stop_id);

-- Créneaux de dépôt par les vendeurs (cycle 17)
CREATE TABLE dropoff_slots (
  id         TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  hub_id     TEXT NOT NULL,
  day        TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time   TEXT NOT NULL CHECK (end_time > start_time),
  capacity   INTEGER NOT NULL CHECK (capacity > 0),
  UNIQUE (company_id, hub_id, day, start_time)
);
CREATE TABLE dropoff_bookings (
  id         TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  slot_id    TEXT NOT NULL REFERENCES dropoff_slots(id) ON DELETE CASCADE,
  vendor_id  TEXT NOT NULL,
  packages   INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'arrived', 'cancelled')),
  arrived_at TEXT,
  received   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (slot_id, vendor_id)
);

-- Créneaux de livraison proposés aux clients (page de suivi)
CREATE TABLE delivery_slots (
  id         TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  zone       TEXT NOT NULL,
  day        TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time   TEXT NOT NULL,
  capacity   INTEGER NOT NULL CHECK (capacity > 0),
  booked     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (company_id, zone, day, start_time)
);

-- Alertes de la tour de contrôle : une seule ouverte par situation (dedupe_key).
CREATE TABLE alerts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('late', 'long_stop', 'failure', 'not_scanned', 'cash_gap', 'driver_offline', 'far_delivery',
               'stale_package', 'doc_expiring', 'cash_limit', 'sos', 'overload', 'maintenance_due')),
  severity   TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  trip_id    TEXT,
  stop_id    TEXT,
  package_id TEXT,
  message    TEXT NOT NULL,
  dedupe_key TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  acked_by   TEXT,
  acked_at   TEXT
);
CREATE UNIQUE INDEX alerts_dedupe ON alerts(company_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX alerts_open ON alerts(company_id, acked_at, created_at);
