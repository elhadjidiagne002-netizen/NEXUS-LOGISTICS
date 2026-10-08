-- NEXUS Logistics sur Cloudflare D1 — cycle C9 : offre payante, administration de la plateforme, suivi des erreurs.
-- Formules : gratuite (quotas) et Pro (abonnement mensuel) ; paiement Wave / Orange Money DÉCLARÉ par l'entreprise
-- puis validé par l'administrateur de la plateforme (ADMIN_EMAILS). Quotas et prix : table app_settings (clé « plans »).

CREATE TABLE plan_payments (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  months      INTEGER NOT NULL CHECK (months BETWEEN 1 AND 12),
  amount_fcfa INTEGER NOT NULL CHECK (amount_fcfa >= 0),
  method      TEXT NOT NULL CHECK (method IN ('wave', 'orange_money')),
  ref         TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  declared_by TEXT,
  declared_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_by  TEXT,
  decided_at  TEXT,
  note        TEXT
);
CREATE INDEX plan_payments_status ON plan_payments(status, declared_at);
CREATE INDEX plan_payments_company ON plan_payments(company_id, declared_at);

-- Erreurs de l'interface remontées par les navigateurs (suivi maison, sans service payant)
CREATE TABLE client_errors (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT,
  user_id    TEXT,
  message    TEXT NOT NULL,
  stack      TEXT,
  url        TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX client_errors_created ON client_errors(created_at);
