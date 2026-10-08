-- NEXUS Logistics sur Cloudflare D1 — cycle C7 : pilotage, renforts, tâches planifiées.
-- Portage de lg_reinforcement_calls / lg_reinforcement_answers (cycle 22). Les indicateurs (lg_kpis, lg_costs…) sont
-- calculés à la lecture : aucune table. Les tâches planifiées gardent leur dernier passage (cron_runs).

-- Appel à renforts pour un jour de pic : chaque chauffeur actif répond disponible / pas disponible
CREATE TABLE reinforcement_calls (
  id         TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  day        TEXT NOT NULL,
  needed     INTEGER NOT NULL CHECK (needed > 0),
  zones      TEXT NOT NULL DEFAULT '[]',
  note       TEXT,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (company_id, day)
);

CREATE TABLE reinforcement_answers (
  call_id     TEXT NOT NULL REFERENCES reinforcement_calls(id) ON DELETE CASCADE,
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  courier_id  TEXT NOT NULL,
  available   INTEGER,
  answered_at TEXT,
  PRIMARY KEY (call_id, courier_id)
);

-- Dernier passage de chaque tâche planifiée (surveillance, purge…), pour la tour de contrôle
CREATE TABLE cron_runs (
  task    TEXT PRIMARY KEY,
  ran_at  TEXT NOT NULL,
  result  TEXT
);
