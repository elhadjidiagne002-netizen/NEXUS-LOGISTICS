-- Tableau de bord d'administration de la plateforme (/admin/), comme My shop et CV en ligne : connexion avec le
-- compte Devizo (lu en lecture seule dans la base devizo, liaison AUTH_DB), e-mail obligatoirement dans ADMIN_EMAILS.
-- Session séparée des comptes des entreprises (cookie lg_admin limité à /api/admin) ; chaque action est journalisée.

CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE admin_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  admin      TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX admin_audit_created ON admin_audit(created_at);
