-- Enseignes (clients professionnels), magasins, tarifs négociés et TVA par produit — 09/10/2026.
-- Une enseigne (ex. une chaîne de supermarchés) a ses conditions : prix convenus par produit (exprimés HT ou TTC),
-- remise générale sur les produits sans prix convenu, exonération de TVA, délai de paiement, adresse d'où viennent
-- ses bons (rattachement automatique à la collecte). Ses magasins sont des fiches client rattachées à l'enseigne.
-- Le prix et la TVA sont FIGÉS sur chaque ligne de commande à la création : la facture les reprend tels quels,
-- même si le tarif change ensuite.
-- Uniquement des ajouts (pas de reconstruction de table : cf. CLAUDE.md, règle 11).

CREATE TABLE accounts (
  id                 TEXT PRIMARY KEY,
  company_id         TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,              -- raison sociale facturée (ex. « Supermarchés Exemple SA »)
  prices_ht          INTEGER NOT NULL DEFAULT 1, -- 1 : prix convenus et prix des bons exprimés hors taxes
  vat_exempt         INTEGER NOT NULL DEFAULT 0, -- 1 : client exonéré de TVA (attestation)
  discount_pct       REAL NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct <= 90),
  payment_terms_days INTEGER CHECK (payment_terms_days IS NULL OR payment_terms_days BETWEEN 0 AND 365),
  sender_match       TEXT,                       -- domaine ou adresse e-mail des bons (ex. « enseigne.sn »)
  ninea              TEXT,
  rc                 TEXT,
  address            TEXT,
  email              TEXT,                       -- comptabilité de l'enseigne
  phone              TEXT,
  note               TEXT,
  active             INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (company_id, name)
);

CREATE TABLE account_prices (
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  price_fcfa  INTEGER NOT NULL CHECK (price_fcfa >= 0),   -- HT ou TTC selon accounts.prices_ht
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (account_id, product_id)
);
CREATE INDEX account_prices_company ON account_prices(company_id, product_id);

ALTER TABLE customers ADD COLUMN account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL;
CREATE INDEX customers_account ON customers(company_id, account_id) WHERE account_id IS NOT NULL;
ALTER TABLE orders ADD COLUMN account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL;

-- TVA du produit (NULL = taux de l'entreprise ; 0 = exonéré)
ALTER TABLE products ADD COLUMN vat_rate REAL CHECK (vat_rate IS NULL OR (vat_rate >= 0 AND vat_rate <= 30));

-- Ligne de commande : TVA et prix HT figés (NULL sur les anciennes lignes : la facture retombe sur le taux de
-- l'entreprise et le HT recalculé depuis le TTC, comme avant)
ALTER TABLE order_items ADD COLUMN vat_rate REAL;
ALTER TABLE order_items ADD COLUMN unit_price_ht REAL;
ALTER TABLE order_items ADD COLUMN price_source TEXT;   -- tariff | discount | given | catalogue
