-- Collecte automatique des données (cycle D1, 09/10/2026) : documents reçus par e-mail (adresse dédiée
-- <cle>@commandes.nexusmarket.sn, Worker mail/) ou déposés dans l'application, convertis en texte (Workers AI
-- toMarkdown), lus par l'IA (Groq, repli Workers AI) selon un « modèle d'extraction », vérifiés par un humain,
-- puis transformés en commande (ou simplement exportés vers Excel). Généralisation du script d'extraction MINAM.

-- Adresse de réception propre à l'entreprise : <inbound_key>@commandes.nexusmarket.sn (clé non devinable).
ALTER TABLE companies ADD COLUMN inbound_key TEXT;
UPDATE companies SET inbound_key = slug || '-' || lower(hex(randomblob(3))) WHERE inbound_key IS NULL;
CREATE UNIQUE INDEX companies_inbound_key ON companies(inbound_key);

-- Modèles d'extraction : quels champs lire, pour quel expéditeur. kind = order (bon de commande → commande),
-- invoice, delivery_note, price_list ou custom (n'importe quelles données, exportées telles quelles).
CREATE TABLE extraction_templates (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'order' CHECK (kind IN ('order', 'invoice', 'delivery_note', 'price_list', 'custom')),
  sender_match TEXT,                   -- adresse, domaine (@auchan.sn) ou mot du sujet ; vide = tous
  fields       TEXT NOT NULL DEFAULT '[]',   -- champs d'en-tête supplémentaires [{key, label, type}]
  line_fields  TEXT NOT NULL DEFAULT '[]',   -- colonnes de lignes supplémentaires [{key, label, type}]
  instructions TEXT,                   -- consignes en clair pour l'IA (« le PCB est le nombre d'unités par colis »)
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX extraction_templates_company ON extraction_templates(company_id);

CREATE TABLE inbox_documents (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source       TEXT NOT NULL CHECK (source IN ('email', 'upload')),
  sender       TEXT,
  subject      TEXT,
  message_id   TEXT,                   -- dédoublonnage d'un e-mail renvoyé
  filename     TEXT,
  content_type TEXT,
  size         INTEGER,
  file_path    TEXT,                   -- table files / R2 : inbox/<id>/<nom>
  template_id  TEXT,
  status       TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'extracting', 'to_review', 'converted', 'done', 'rejected', 'error')),
  text         TEXT,                   -- texte du document (tronqué)
  data         TEXT,                   -- données extraites puis corrigées (JSON)
  confidence   REAL,
  error        TEXT,
  order_id     TEXT,
  reviewed_by  TEXT,
  received_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  extracted_at TEXT,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX inbox_documents_company ON inbox_documents(company_id, status, received_at);
CREATE UNIQUE INDEX inbox_documents_message ON inbox_documents(company_id, message_id, filename) WHERE message_id IS NOT NULL;

-- Correspondances apprises : code ou libellé d'un client (EAN, n° d'article, « 500G SURGELE ATTIEKE ») → produit.
CREATE TABLE product_aliases (
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  alias       TEXT NOT NULL,           -- normalisé : majuscules, sans accents, espaces simples
  scope       TEXT NOT NULL DEFAULT '',-- expéditeur / client concerné ('' = tous)
  product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  units_per_case INTEGER,              -- PCB appris pour ce client (facultatif)
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (company_id, alias, scope)
);
