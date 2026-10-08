-- Produits et stock (08/10/2026) : un seul chiffre de stock par produit (products.stock), tenu par TOUS les
-- mouvements (réception, préparation, correction, inventaire, rebut, retour, transfert), et un historique de ces
-- mouvements. products.stock NULL = stock non suivi (produit gardé chez le vendeur sans comptage).

ALTER TABLE products ADD COLUMN min_stock INTEGER;          -- seuil d'alerte (« à commander » en dessous)
ALTER TABLE products ADD COLUMN cost_fcfa INTEGER;          -- prix d'achat (valeur du stock), facultatif
ALTER TABLE products ADD COLUMN supplier TEXT;              -- fournisseur habituel, facultatif

CREATE TABLE stock_moves (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  TEXT NOT NULL,
  product_id  TEXT NOT NULL,
  location_id TEXT,                                          -- emplacement concerné (NULL : stock sans emplacement)
  kind        TEXT NOT NULL CHECK (kind IN ('in', 'pick', 'adjust', 'count', 'discard', 'return', 'transfer', 'initial')),
  qty         INTEGER NOT NULL,                              -- signé : + entrée, − sortie
  stock_after INTEGER,                                       -- stock du produit après le mouvement (si suivi)
  order_id    TEXT,                                          -- commande concernée (préparation, retour)
  ref         TEXT,                                          -- bon de livraison fournisseur, référence libre
  reason      TEXT,
  by_user     TEXT,
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX stock_moves_product ON stock_moves(company_id, product_id, at);
CREATE INDEX stock_moves_company ON stock_moves(company_id, at);
