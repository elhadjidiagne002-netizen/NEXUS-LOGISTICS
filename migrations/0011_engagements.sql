-- NEXUS Logistics sur Cloudflare D1 — cycle C11 : engagement de délai de préparation des vendeurs (cycle 9 Postgres).
-- Le vendeur s'engage à préparer en N heures ; l'heure limite de chaque préparation en découle ; il est relancé
-- (WhatsApp ou e-mail, file d'envoi) 2 h avant l'échéance puis en retard, une seule fois par étape.

CREATE TABLE vendor_commitments (
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  vendor_id  TEXT NOT NULL,
  prep_hours INTEGER NOT NULL CHECK (prep_hours BETWEEN 1 AND 96),
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (company_id, vendor_id)
);

CREATE TABLE vendor_reminders_sent (
  task_id    TEXT NOT NULL REFERENCES pick_tasks(id) ON DELETE CASCADE,
  stage      TEXT NOT NULL CHECK (stage IN ('soon', 'late')),
  company_id TEXT NOT NULL,
  sent_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (task_id, stage)
);
