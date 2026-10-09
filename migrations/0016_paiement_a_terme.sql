-- Paiement à terme (sur facture) — 09/10/2026.
-- Les commandes des enseignes (bons de commande « 15 jours », « 30 jours ») ne sont ni payées d'avance ni encaissées
-- par le chauffeur : elles partent tout de suite en préparation, rien n'est à encaisser à la livraison, la facture
-- porte une échéance (date de livraison + délai) et la somme reste à recevoir jusqu'à l'enregistrement du règlement.
--
-- ⚠️ La contrainte orders.payment_method IN ('cod','prepaid') N'EST PAS modifiée : changer un CHECK en SQLite impose
-- de reconstruire la table, et la suppression de l'ancienne table déclenche les ON DELETE CASCADE (order_items,
-- vérifié : toutes les lignes de commande seraient effacées). Une commande à terme est donc enregistrée
-- payment_method = 'prepaid' (rien à encaisser), payment_status = 'pending', payment_terms_days NON NULL.
-- Le mode affiché et exposé (« account ») est dérivé par payMode() (server/rpc/commandes.js).

ALTER TABLE orders ADD COLUMN payment_terms_days INTEGER CHECK (payment_terms_days IS NULL OR payment_terms_days BETWEEN 0 AND 365);
ALTER TABLE orders ADD COLUMN due_at TEXT;          -- échéance, fixée à la livraison
ALTER TABLE orders ADD COLUMN payment_ref TEXT;     -- référence du règlement reçu (virement, chèque…)
ALTER TABLE orders ADD COLUMN payment_via TEXT;     -- transfer | cheque | cash | mobile | other

-- Client « en compte » : ses commandes passent à terme par défaut, avec son délai.
ALTER TABLE customers ADD COLUMN payment_terms_days INTEGER CHECK (payment_terms_days IS NULL OR payment_terms_days BETWEEN 0 AND 365);

CREATE INDEX orders_receivables ON orders(company_id, due_at) WHERE payment_terms_days IS NOT NULL AND payment_status <> 'paid';

-- Relances d'impayés envoyées (une par étape et par commande, rejouable sans doublon).
CREATE TABLE payment_reminders_sent (
  order_id   TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  stage      TEXT NOT NULL CHECK (stage IN ('soon', 'late', 'late2')),
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sent_at    TEXT NOT NULL,
  PRIMARY KEY (order_id, stage)
);
