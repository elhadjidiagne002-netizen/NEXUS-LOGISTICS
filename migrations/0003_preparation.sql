-- NEXUS Logistics sur Cloudflare D1 — cycle C3 : préparation et entrepôt.
-- Portage de lg_pick_tasks / lg_pick_lines / lg_packages / lg_package_items / lg_scan_events (socle),
-- lg_waves, lg_stock_locations, lg_product_locations, lg_inventory_counts (cycle 4), lg_stock_lots,
-- lg_lot_moves (cycle 6), lg_incidents (créée ici : le double contrôle en ouvre ; gérée au cycle C11).

-- Montant retiré par les ruptures (avant remise) : le montant à encaisser suit sans relire les lignes.
ALTER TABLE orders ADD COLUMN shortage_fcfa INTEGER NOT NULL DEFAULT 0;
-- Qui a fait l'action rejouable (productivité : scans de mauvais produit par préparateur).
ALTER TABLE action_log ADD COLUMN actor_id TEXT;

-- Assertions dans un lot env.DB.batch : « INSERT INTO batch_guards (ok) SELECT 0 WHERE NOT (condition) »
-- fait échouer (et annuler) TOUT le lot si la condition est fausse. Aucune ligne n'y est jamais écrite.
CREATE TABLE batch_guards (ok INTEGER CHECK (ok = 1));

-- Tâche de préparation : une par commande prête (payée, ou paiement à la livraison confirmé).
CREATE TABLE pick_tasks (
  id               TEXT PRIMARY KEY,
  company_id       TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id         TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  hub_id           TEXT,
  vendor_id        TEXT,
  status           TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'picking', 'packed', 'staged', 'cancelled')),
  picker_id        TEXT,
  cutoff_at        TEXT,
  started_at       TEXT,
  done_at          TEXT,
  last_activity_at TEXT,
  wave_id          TEXT,
  wave_bin         INTEGER,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX pick_tasks_queue ON pick_tasks(company_id, status, cutoff_at);
CREATE INDEX pick_tasks_order ON pick_tasks(order_id);
CREATE INDEX pick_tasks_wave ON pick_tasks(wave_id);
-- une seule tâche vivante par commande (rejeu de la confirmation, double clic)
CREATE UNIQUE INDEX pick_tasks_one_open ON pick_tasks(order_id) WHERE status <> 'cancelled';

CREATE TABLE pick_lines (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  task_id       TEXT NOT NULL REFERENCES pick_tasks(id) ON DELETE CASCADE,
  order_item_id TEXT NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  product_id    TEXT,
  qty_ordered   INTEGER NOT NULL CHECK (qty_ordered > 0),
  qty_picked    INTEGER NOT NULL DEFAULT 0 CHECK (qty_picked >= 0 AND qty_picked <= qty_ordered),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'picked', 'short', 'substituted')),
  manual_entry  INTEGER NOT NULL DEFAULT 0,
  picked_at     TEXT
);
CREATE INDEX pick_lines_task ON pick_lines(task_id);

CREATE TABLE waves (
  id         TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  number     INTEGER NOT NULL,
  hub_id     TEXT,
  picker_id  TEXT,
  status     TEXT NOT NULL DEFAULT 'picking' CHECK (status IN ('picking', 'done', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  done_at    TEXT,
  UNIQUE (company_id, number)
);

-- Colis. Code NXP-XXXXXX imprimé en QR, unique dans l'entreprise.
CREATE TABLE packages (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code           TEXT NOT NULL,
  order_id       TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  pick_task_id   TEXT,
  hub_id         TEXT,
  seq_in_order   INTEGER NOT NULL DEFAULT 1,
  count_in_order INTEGER NOT NULL DEFAULT 1,
  weight_g       INTEGER CHECK (weight_g IS NULL OR weight_g > 0),
  length_cm      REAL,
  width_cm       REAL,
  height_cm      REAL,
  volume_l       REAL,
  handling       TEXT NOT NULL DEFAULT '[]',
  zone           TEXT,
  direction      TEXT NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound', 'return')),
  status         TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'packed', 'staged', 'loaded', 'out_for_delivery',
                   'delivered', 'failed', 'returned_hub', 'returned_vendor', 'lost', 'damaged', 'cancelled')),
  holder_type    TEXT NOT NULL DEFAULT 'hub' CHECK (holder_type IN ('vendor', 'hub', 'driver', 'customer')),
  holder_id      TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  check_required INTEGER NOT NULL DEFAULT 0,
  checked_by     TEXT,
  checked_at     TEXT,
  check_photo    TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (company_id, code)
);
CREATE INDEX packages_order ON packages(order_id);
CREATE INDEX packages_task ON packages(pick_task_id);
CREATE INDEX packages_status ON packages(company_id, status, zone);

CREATE TABLE package_items (
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  package_id    TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  order_item_id TEXT NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (package_id, order_item_id)
);

-- Journal de scans, en AJOUT SEUL (déclencheur) : corriger = nouvel événement.
CREATE TABLE scan_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id      TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  client_event_id TEXT NOT NULL,
  package_id      TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  event           TEXT NOT NULL CHECK (event IN ('pack', 'stage', 'load', 'unload', 'deliver', 'fail', 'return_hub',
                    'return_vendor', 'receive', 'inventory', 'damage')),
  actor_id        TEXT,
  trip_id         TEXT,
  hub_id          TEXT,
  lat             REAL,
  lng             REAL,
  manual_entry    INTEGER NOT NULL DEFAULT 0,
  device_at       TEXT NOT NULL,
  server_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  meta            TEXT NOT NULL DEFAULT '{}',
  UNIQUE (company_id, client_event_id)
);
CREATE INDEX scan_events_package ON scan_events(package_id, server_at);
CREATE TRIGGER scan_events_append_only BEFORE UPDATE ON scan_events
BEGIN SELECT RAISE(ABORT, 'scan_events est un journal : ajout seul'); END;

-- Entrepôt : emplacements (A-03-2 : allée, étagère, niveau), quantités par emplacement, lots datés.
CREATE TABLE stock_locations (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  hub_id          TEXT NOT NULL,
  code            TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'shelf' CHECK (kind IN ('shelf', 'floor', 'cold', 'bulk')),
  label           TEXT,
  active          INTEGER NOT NULL DEFAULT 1,
  last_counted_at TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (company_id, hub_id, code)
);

CREATE TABLE product_locations (
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL REFERENCES stock_locations(id) ON DELETE CASCADE,
  qty         INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (product_id, location_id)
);
CREATE INDEX product_locations_location ON product_locations(location_id);

-- Invariant : dans un emplacement, somme(lots) <= product_locations.qty (le reste = stock non loti).
CREATE TABLE stock_lots (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL REFERENCES stock_locations(id) ON DELETE CASCADE,
  lot_code    TEXT,
  expires_on  TEXT,
  qty         INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (lot_code IS NOT NULL OR expires_on IS NOT NULL)
);
CREATE UNIQUE INDEX stock_lots_key ON stock_lots(product_id, location_id, coalesce(lot_code, ''), coalesce(expires_on, '9999-12-31'));
CREATE INDEX stock_lots_expiry ON stock_lots(company_id, expires_on);

CREATE TABLE lot_moves (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  lot_id       TEXT NOT NULL REFERENCES stock_lots(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('in', 'pick', 'adjust', 'discard')),
  qty          INTEGER NOT NULL,
  pick_line_id TEXT,
  reason       TEXT,
  by_user      TEXT,
  at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX lot_moves_lot ON lot_moves(lot_id);

CREATE TABLE inventory_counts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL REFERENCES stock_locations(id) ON DELETE CASCADE,
  product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  expected    INTEGER NOT NULL,
  counted     INTEGER NOT NULL CHECK (counted >= 0),
  gap         INTEGER NOT NULL,
  reason      TEXT,
  counted_by  TEXT,
  counted_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX inventory_counts_company ON inventory_counts(company_id, counted_at);

-- Incidents (colis abîmé, article manquant, écart de caisse…). Numéro sans trou (compteur « incident »).
CREATE TABLE incidents (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  number              INTEGER NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('damaged', 'lost', 'missing_item', 'wrong_product', 'refused', 'cash_gap',
                        'driver_behavior', 'vehicle_breakdown', 'accident', 'late', 'other')),
  severity            TEXT NOT NULL DEFAULT 'normal' CHECK (severity IN ('low', 'normal', 'high', 'critical')),
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'resolved', 'closed')),
  package_id          TEXT,
  trip_id             TEXT,
  stop_id             TEXT,
  order_id            TEXT,
  description         TEXT,
  photos              TEXT NOT NULL DEFAULT '[]',
  reported_by         TEXT,
  responsible_type    TEXT CHECK (responsible_type IN ('vendor', 'hub', 'driver', 'customer', 'unknown')),
  responsible_id      TEXT,
  resolution          TEXT,
  compensation_fcfa   INTEGER NOT NULL DEFAULT 0,
  deduction_fcfa      INTEGER NOT NULL DEFAULT 0,
  due_at              TEXT,
  resolved_by         TEXT,
  resolved_at         TEXT,
  customer_agreed_at  TEXT,
  customer_refused_at TEXT,
  agreement_via       TEXT,
  credit_note_id      TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (company_id, number)
);
CREATE INDEX incidents_company ON incidents(company_id, status, created_at);
CREATE INDEX incidents_package ON incidents(package_id);
