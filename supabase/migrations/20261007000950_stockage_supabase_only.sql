-- =====================================================================
-- NEXUS LOGISTICS — 10 · Stockage privé et correctif RLS (Supabase uniquement)
-- Le nom contient « supabase_only » : ignoré par le banc de test PGlite
-- (pas de schéma storage). Point n° 6 du chapitre 02 : les deux espaces
-- existants sont publics ; preuves, signatures et factures exigent un
-- espace PRIVÉ, lu par liens signés.
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('lg-proofs', 'lg-proofs', false, 1048576, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
                               allowed_mime_types = excluded.allowed_mime_types;

-- Dépôt : chauffeurs (preuves de leurs arrêts), équipes logistiques. Chemin imposé :
--   <voyage>/<arrêt>/<uuid>.jpg   ou   docs/<véhicule>/<uuid>.pdf
drop policy if exists lg_proofs_insert on storage.objects;
create policy lg_proofs_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'lg-proofs' and (
    public.lg_has_role(array['picker', 'dock_chief', 'dispatcher', 'support', 'cashier'])
    or exists (select 1 from public.lg_trips t join public.couriers c on c.id = t.courier_id
                where c.user_id = auth.uid() and t.id::text = split_part(name, '/', 1)
                  and t.status in ('sealed', 'in_progress', 'completed'))));

-- Lecture (liens signés générés côté client) : équipes et vendeur concerné
drop policy if exists lg_proofs_read on storage.objects;
create policy lg_proofs_read on storage.objects for select to authenticated
  using (bucket_id = 'lg-proofs' and (
    public.lg_has_role(array['dock_chief', 'dispatcher', 'support', 'cashier', 'accountant'])
    or exists (select 1 from public.lg_trips t join public.couriers c on c.id = t.courier_id
                where c.user_id = auth.uid() and t.id::text = split_part(name, '/', 1))));

-- Pas de modification ni de suppression par les apps : une preuve ne se réécrit pas.

-- Alerte relevée pendant la lecture de la base (chapitre 02) : table de sauvegarde sans RLS.
-- Sans règle, plus personne n'y accède par l'API ; la donnée reste en base.
do $$ begin
  if to_regclass('public.descriptions_backup_20260921') is not null then
    execute 'alter table public.descriptions_backup_20260921 enable row level security';
  end if;
end $$;
