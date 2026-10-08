-- =====================================================================
-- NEXUS LOGISTICS — cycle 20 · Retour de tournée (module 03, P2)
-- « Scan des colis non livrés à leur retour au quai, par une autre personne que
-- le chauffeur. Écart signalé immédiatement. » Le scan existait (lg_return_hub) ;
-- l'alerte not_scanned était prévue mais jamais levée. Désormais :
--   · à la clôture du voyage, s'il reste des colis à rapporter, une alerte
--     not_scanned (tour de contrôle) liste leurs codes ;
--   · le quai voit les colis attendus, voyage par voyage ;
--   · l'alerte se lève toute seule quand le dernier colis est rescanné.
-- =====================================================================

-- Colis qu'un voyage doit rapporter : échec de livraison pas encore rentré, ou chargé jamais livré
create or replace function public.lg_trip_unreturned(p_trip uuid) returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(p.code order by p.code), '{}')
    from public.lg_trip_packages tp join public.lg_packages p on p.id = tp.package_id
   where tp.trip_id = p_trip
     and ((tp.outcome = 'failed' and p.status = 'failed')
          or (tp.outcome is null and tp.loaded_at is not null and p.holder_type = 'driver' and p.status in ('loaded', 'out_for_delivery')))
$$;

create or replace function public.lg_trg_trip_return_watch() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_codes text[];
begin
  if new.status = 'completed' and old.status is distinct from 'completed' then
    begin
      v_codes := public.lg_trip_unreturned(new.id);
      if cardinality(v_codes) > 0 then
        perform public.lg_raise_alert('not_scanned', 'warning',
          format('Voyage %s terminé : %s colis à rescanner au quai (%s)', new.number, cardinality(v_codes), array_to_string(v_codes, ', ')),
          new.id, null, null, 'return:' || new.id);
      end if;
    exception when others then null;          -- jamais bloquant pour la clôture
    end;
  end if;
  return new;
end; $$;
drop trigger if exists lg_trips_return_watch on public.lg_trips;
create trigger lg_trips_return_watch after update of status on public.lg_trips
  for each row execute function public.lg_trg_trip_return_watch();

-- Dernier colis rentré : l'alerte du voyage se lève d'elle-même
create or replace function public.lg_trg_package_returned() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if new.status is distinct from old.status and old.status in ('failed', 'loaded', 'out_for_delivery') then
    for r in select distinct tp.trip_id from public.lg_trip_packages tp where tp.package_id = new.id loop
      if cardinality(public.lg_trip_unreturned(r.trip_id)) = 0 then
        update public.lg_alerts set acked_at = now() where dedupe_key = 'return:' || r.trip_id and acked_at is null;
      end if;
    end loop;
  end if;
  return new;
end; $$;
drop trigger if exists lg_packages_returned on public.lg_packages;
create trigger lg_packages_returned after update of status on public.lg_packages
  for each row execute function public.lg_trg_package_returned();

-- Pour le quai : voyages terminés dont des colis ne sont pas encore rentrés
create or replace function public.lg_returns_expected() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['dock_chief', 'dispatcher', 'cashier']) then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('trip_id', t.id, 'number', t.number, 'courier', c.name, 'phone', c.phone,
            'ended_at', t.ended_at, 'minutes', round(extract(epoch from now() - t.ended_at) / 60), 'codes', to_jsonb(x.codes))
            order by t.ended_at), '[]')
    from public.lg_trips t left join public.couriers c on c.id = t.courier_id,
         lateral (select public.lg_trip_unreturned(t.id) codes) x
   where t.status in ('completed', 'reconciled') and t.ended_at > now() - interval '7 days' and cardinality(x.codes) > 0);
end; $$;
