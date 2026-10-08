-- Fournisseurs et bons de commande (achats de réassort) — 08/10/2026.
-- Un bon de commande : brouillon → envoyé (WhatsApp / impression) → reçu en partie → reçu ; ou annulé.
-- La réception d'un bon fait entrer la marchandise en stock (mouvement « in », réf. du bon) et met à jour le
-- dernier prix d'achat du produit. Numéros sans trou par entreprise et par année (compteur « bc-AAAA »).

CREATE TABLE suppliers (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  contact_name  TEXT,
  phone         TEXT,
  email         TEXT,
  address       TEXT,
  payment_terms TEXT,                 -- ex. « comptant », « 30 jours »
  lead_days     INTEGER,              -- délai habituel de livraison (jours)
  note          TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX suppliers_name ON suppliers(company_id, name COLLATE NOCASE);

ALTER TABLE products ADD COLUMN supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL;

-- reprise : chaque nom de fournisseur déjà saisi sur une fiche produit devient une fiche fournisseur
INSERT INTO suppliers (id, company_id, name)
  SELECT 'sup-' || lower(hex(randomblob(12))), company_id, trim(supplier) FROM products
   WHERE supplier IS NOT NULL AND trim(supplier) <> '' GROUP BY company_id, lower(trim(supplier));
UPDATE products SET supplier_id = (SELECT s.id FROM suppliers s WHERE s.company_id = products.company_id AND lower(s.name) = lower(trim(products.supplier)))
 WHERE supplier IS NOT NULL AND trim(supplier) <> '';

CREATE TABLE purchase_orders (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  number       TEXT NOT NULL,          -- BC-2026-000012
  supplier_id  TEXT NOT NULL REFERENCES suppliers(id),
  hub_id       TEXT,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'partial', 'received', 'cancelled')),
  expected_on  TEXT,                   -- date de livraison attendue (AAAA-MM-JJ)
  note         TEXT,
  total_fcfa   INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at      TEXT,
  received_at  TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT
);
CREATE UNIQUE INDEX purchase_orders_number ON purchase_orders(company_id, number);
CREATE INDEX purchase_orders_status ON purchase_orders(company_id, status, created_at);

CREATE TABLE purchase_order_lines (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL,
  po_id          TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id     TEXT NOT NULL REFERENCES products(id),
  qty_ordered    INTEGER NOT NULL CHECK (qty_ordered > 0),
  qty_received   INTEGER NOT NULL DEFAULT 0,
  unit_cost_fcfa INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX purchase_order_lines_po ON purchase_order_lines(po_id);
CREATE INDEX purchase_order_lines_product ON purchase_order_lines(company_id, product_id);

ALTER TABLE stock_moves ADD COLUMN po_id TEXT;   -- réception d'un bon de commande
