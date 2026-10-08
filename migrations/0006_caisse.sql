-- NEXUS Logistics sur Cloudflare D1 — cycle C6 : caisse, gains des chauffeurs, factures et avoirs.
-- Portage de lg_cash_remittances, lg_cash_drops (20261007000400, cycle1), courier_earnings (table du site NEXUS
-- dans la version Postgres), invoices / invoice_lines (20261007000500_facturation). Montants en FCFA entiers ;
-- les montants HT et la TVA gardent deux décimales (comme la version Postgres).

ALTER TABLE couriers ADD COLUMN total_earned INTEGER NOT NULL DEFAULT 0;

-- Versement de fin de voyage (un seul par voyage) ; un écart ouvre un incident « cash_gap »
CREATE TABLE cash_remittances (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  trip_id       TEXT NOT NULL UNIQUE REFERENCES trips(id) ON DELETE CASCADE,
  courier_id    TEXT,
  expected_fcfa INTEGER NOT NULL,
  remitted_fcfa INTEGER NOT NULL CHECK (remitted_fcfa >= 0),
  gap_fcfa      INTEGER GENERATED ALWAYS AS (remitted_fcfa - expected_fcfa) VIRTUAL,
  cashier_id    TEXT,
  note          TEXT,
  validated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX cash_remittances_company ON cash_remittances(company_id, validated_at);

-- Versement intermédiaire (plafond d'espèces atteint en tournée)
CREATE TABLE cash_drops (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  trip_id     TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  courier_id  TEXT,
  amount_fcfa INTEGER NOT NULL CHECK (amount_fcfa > 0),
  cashier_id  TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX cash_drops_trip ON cash_drops(trip_id);

-- Gains des chauffeurs : crédités au rapprochement du voyage ; une retenue est un gain négatif (« payout »)
CREATE TABLE courier_earnings (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  courier_id  TEXT NOT NULL,
  trip_id     TEXT,
  amount_fcfa INTEGER NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('delivery', 'bonus', 'payout')),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
  ref         TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  paid_at     TEXT
);
CREATE INDEX courier_earnings_courier ON courier_earnings(company_id, courier_id, created_at);

-- Factures (FAC-AAAA-NNNNNN) et avoirs (AV-AAAA-NNNNNN), numérotés sans trou par entreprise et par année
-- (compteurs « FAC-2026 », « AV-2026 » de la table counters, incrémentés dans le même lot que la facture).
CREATE TABLE invoices (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  invoice_number TEXT NOT NULL,
  type           TEXT NOT NULL DEFAULT 'buyer',
  order_id       TEXT NOT NULL REFERENCES orders(id),
  vendor_id      TEXT,
  status         TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid', 'refunded')),
  credit_of      TEXT REFERENCES invoices(id),
  amount_ht      REAL NOT NULL DEFAULT 0,
  tva            REAL NOT NULL DEFAULT 0,
  amount_ttc     INTEGER NOT NULL DEFAULT 0,
  commission     INTEGER NOT NULL DEFAULT 0,
  net_vendor     INTEGER NOT NULL DEFAULT 0,
  metadata       TEXT NOT NULL DEFAULT '{}',
  issued_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (company_id, invoice_number)
);
-- une seule facture par commande (les avoirs s'y rattachent)
CREATE UNIQUE INDEX invoices_one_per_order ON invoices(order_id) WHERE credit_of IS NULL;
CREATE INDEX invoices_company ON invoices(company_id, issued_at);
CREATE INDEX invoices_credit_of ON invoices(credit_of);

CREATE TABLE invoice_lines (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  invoice_id    TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('product', 'delivery', 'discount', 'fee')),
  order_item_id TEXT,
  label         TEXT NOT NULL,
  quantity      INTEGER NOT NULL,
  unit_price_ht REAL NOT NULL,
  tva_rate      REAL NOT NULL,
  total_ht      REAL GENERATED ALWAYS AS (round(unit_price_ht * quantity, 2)) VIRTUAL,
  UNIQUE (invoice_id, position)
);
