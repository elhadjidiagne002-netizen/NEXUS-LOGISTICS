-- =====================================================================
-- NEXUS LOGISTICS — cycle 3
--  · planification automatique des voyages (module 04, P2) : simulation puis création
--  · double contrôle au-delà d'un montant (module 01, P2)
-- =====================================================================

-- 1. PLANIFICATION AUTOMATIQUE ------------------------------------------------------------
-- Heuristique de « balayage » : les commandes à quai sont triées par angle autour du hub,
-- puis remplissent les véhicules disponibles (le plus grand d'abord) jusqu'à la première
-- limite atteinte : poids, volume, nombre de colis, ou plafond d'espèces du chauffeur.
-- Les commandes voisines tombent donc dans le même voyage. Rien n'est créé si p_apply = false.
create or replace function public.lg_autoplan_run(p_apply boolean default false, p_hub uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  hub     public.lg_hubs;
  veh     record;
  ord     record;
  plan    jsonb := '[]';
  cur     jsonb;
  left_o  jsonb := '[]';
  used_c  uuid[] := '{}';
  v_cour  uuid;
  v_cname text;
  i       int;
  v_trip  jsonb;
  created jsonb := '[]';
  v_limit int;
  v_ids   uuid[];
  n_veh   int := 0;
begin
  if not public.lg_has_role(array['dispatcher']) then raise exception 'forbidden'; end if;
  select * into hub from public.lg_hubs where active and (p_hub is null or id = p_hub) order by created_at limit 1;

  -- véhicules prêts : disponibles, en règle, sans voyage ouvert ; chauffeur habituel s'il est libre
  for veh in
    select v.*, c.id as courier_id, c.name as courier_name, coalesce(c.cash_limit_fcfa, (public.lg_cfg('cash_limit_fcfa'))::text::int) as cash_limit
      from public.lg_vehicles v
      left join lateral (
        select c.* from public.couriers c
         where c.status = 'active' and (c.license_expires_at is null or c.license_expires_at >= current_date)
           and not exists (select 1 from public.lg_trips t where t.courier_id = c.id and t.status in ('planned', 'loading', 'sealed', 'in_progress', 'completed'))
         order by (c.id = v.default_courier_id) desc, c.deliveries_done desc limit 1) c on true
     where v.status = 'available' and (p_hub is null or v.hub_id = p_hub)
       and not exists (select 1 from public.lg_trips t where t.vehicle_id = v.id and t.status in ('planned', 'loading', 'sealed', 'in_progress'))
       and not exists (select 1 from public.lg_vehicle_documents d where d.vehicle_id = v.id and d.expires_at < current_date
                         and d.kind in ('assurance', 'visite_technique', 'carte_grise')
                         and not exists (select 1 from public.lg_vehicle_documents d2 where d2.vehicle_id = v.id and d2.kind = d.kind and d2.expires_at >= current_date))
     order by v.capacity_kg desc
  loop
    v_cour := veh.courier_id; v_cname := veh.courier_name;
    continue when v_cour is null;
    -- un même chauffeur ne peut pas prendre deux véhicules
    if v_cour = any (used_c) then
      select c.id, c.name into v_cour, v_cname from public.couriers c
       where c.status = 'active' and not (c.id = any (used_c))
         and not exists (select 1 from public.lg_trips t where t.courier_id = c.id and t.status in ('planned', 'loading', 'sealed', 'in_progress', 'completed'))
       limit 1;
      continue when v_cour is null;
    end if;
    used_c := used_c || v_cour;
    plan := plan || jsonb_build_object('vehicle_id', veh.id, 'plate', veh.plate, 'kind', veh.kind, 'courier_id', v_cour,
      'courier', v_cname, 'cap_g', veh.capacity_kg * 1000, 'cap_l', coalesce(veh.capacity_l, 0), 'cap_n', coalesce(veh.max_packages, 0),
      'cash_limit', veh.cash_limit, 'cooler', 'glacière' = any (veh.equipment), 'two_wheels', veh.kind in ('moto', 'vélo'),
      'w', 0, 'v', 0, 'n', 0, 'cod', 0, 'orders', '[]'::jsonb, 'zones', '[]'::jsonb);
    n_veh := n_veh + 1;
  end loop;

  -- commandes à quai, par angle autour du hub (balayage)
  for ord in
    select o.id, o.delivery_zone zone, coalesce(o.delivery_lat, z.lat) lat, coalesce(o.delivery_lng, z.lng) lng,
           sum(coalesce(p.weight_g, 1000)) w, sum(coalesce(p.volume_l, 0)) vol, count(*) n,
           bool_or('froid' = any (p.handling)) cold, bool_or('lourd' = any (p.handling)) heavy,
           public.lg_order_due_fcfa(o.id) cod
      from public.lg_packages p join public.orders o on o.id = p.order_id left join public.delivery_zones z on z.name = o.delivery_zone
     where p.status = 'staged' and p.hub_id is not null and p.direction = 'outbound' and (p_hub is null or p.hub_id = p_hub)
       and not exists (select 1 from public.lg_trip_packages tp where tp.package_id = p.id and tp.outcome is null)
     group by o.id, o.delivery_zone, o.delivery_lat, o.delivery_lng, z.lat, z.lng
     order by atan2(coalesce(o.delivery_lat, z.lat, hub.lat) - hub.lat, coalesce(o.delivery_lng, z.lng, hub.lng) - hub.lng)
  loop
    v_trip := null;
    -- premier véhicule (dans l'ordre du balayage) qui accepte encore la commande
    for i in 0 .. jsonb_array_length(plan) - 1 loop
      cur := plan -> i;
      if (cur ->> 'w')::numeric + ord.w <= (cur ->> 'cap_g')::numeric
         and ((cur ->> 'cap_l')::numeric = 0 or (cur ->> 'v')::numeric + ord.vol <= (cur ->> 'cap_l')::numeric)
         and ((cur ->> 'cap_n')::int = 0 or (cur ->> 'n')::int + ord.n <= (cur ->> 'cap_n')::int)
         and (cur ->> 'cod')::int + ord.cod <= (cur ->> 'cash_limit')::int
         and (not ord.cold or (cur ->> 'cooler')::boolean)
         and (not ord.heavy or not (cur ->> 'two_wheels')::boolean) then
        plan := jsonb_set(plan, array[i::text], cur || jsonb_build_object(
          'w', (cur ->> 'w')::numeric + ord.w, 'v', (cur ->> 'v')::numeric + ord.vol, 'n', (cur ->> 'n')::int + ord.n,
          'cod', (cur ->> 'cod')::int + ord.cod,
          'orders', (cur -> 'orders') || jsonb_build_object('id', ord.id, 'zone', ord.zone, 'lat', ord.lat, 'lng', ord.lng, 'n', ord.n, 'w', ord.w),
          'zones', case when (cur -> 'zones') ? coalesce(ord.zone, '?') then cur -> 'zones' else (cur -> 'zones') || to_jsonb(coalesce(ord.zone, '?')) end));
        v_trip := '{}';
        exit;
      end if;
    end loop;
    if v_trip is null then
      left_o := left_o || jsonb_build_object('id', ord.id, 'zone', ord.zone, 'w', ord.w, 'n', ord.n,
        'reason', case when n_veh = 0 then 'aucun véhicule libre' when ord.cold then 'glacière requise' else 'capacité atteinte' end);
    end if;
  end loop;

  -- seuls les véhicules qui ont reçu des commandes deviennent des voyages
  select coalesce(jsonb_agg(x || jsonb_build_object(
      'fill_pct', greatest(round(100 * (x ->> 'w')::numeric / nullif((x ->> 'cap_g')::numeric, 0)),
                           coalesce(round(100 * (x ->> 'v')::numeric / nullif((x ->> 'cap_l')::numeric, 0)), 0),
                           coalesce(round(100 * (x ->> 'n')::numeric / nullif((x ->> 'cap_n')::numeric, 0)), 0)),
      'label', (select string_agg(z, ' · ') from (select jsonb_array_elements_text(x -> 'zones') z limit 3) s))), '[]')
    into plan from jsonb_array_elements(plan) x where jsonb_array_length(x -> 'orders') > 0;

  if p_apply then
    for i in 0 .. jsonb_array_length(plan) - 1 loop
      cur := plan -> i;
      v_trip := public.lg_trip_create((cur ->> 'vehicle_id')::uuid, (cur ->> 'courier_id')::uuid, cur ->> 'label', 'delivery',
                                      null, hub.id, '{}');
      for ord in select (e ->> 'id')::uuid id from jsonb_array_elements(cur -> 'orders') e loop
        perform public.lg_trip_add_order((v_trip ->> 'trip_id')::uuid, ord.id);
      end loop;
      -- ordre des arrêts : plus proche voisin depuis le hub (l'app affine avec le 2-opt)
      select array_agg(id order by rn) into v_ids from (
        with recursive pts as (select s.id, s.lat, s.lng from public.lg_trip_stops s where s.trip_id = (v_trip ->> 'trip_id')::uuid),
        walk(id, lat, lng, rn, seen) as (
          select * from (select p.id, p.lat, p.lng, 1, array[p.id] from pts p
                          order by public.lg_distance_m(hub.lat, hub.lng, p.lat, p.lng) nulls last limit 1) a
          union all
          select n.id, n.lat, n.lng, w.rn + 1, w.seen || n.id from walk w
            cross join lateral (select p.id, p.lat, p.lng from pts p where not (p.id = any (w.seen))
                                 order by public.lg_distance_m(w.lat, w.lng, p.lat, p.lng) nulls last limit 1) n)
        select id, rn from walk) s;
      if v_ids is not null then perform public.lg_trip_reorder((v_trip ->> 'trip_id')::uuid, v_ids); end if;
      created := created || (v_trip || jsonb_build_object('label', cur ->> 'label', 'orders', jsonb_array_length(cur -> 'orders')));
    end loop;
    perform public.lg_audit('autoplan', 'trip', null, jsonb_build_object('trips', jsonb_array_length(created)));
  end if;

  return jsonb_build_object('ok', true, 'applied', p_apply, 'trips', plan, 'unassigned', left_o, 'created', created,
    'vehicles_free', n_veh);
end; $$;

-- 2. DOUBLE CONTRÔLE ------------------------------------------------------------------------
alter table public.lg_packages
  add column if not exists check_required boolean not null default false,
  add column if not exists checked_by uuid references public.profiles(id),
  add column if not exists checked_at timestamptz,
  add column if not exists check_photo text;

-- Au colisage : le colis d'une commande dont la valeur dépasse le seuil exige un second contrôle
create or replace function public.lg_trg_double_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_threshold int := coalesce((public.lg_cfg('double_check_fcfa'))::text::int, 100000);
begin
  if new.direction = 'outbound' and v_threshold > 0
     and (select public.lg_fcfa(total) from public.orders where id = new.order_id) >= v_threshold then
    new.check_required := true;
  end if;
  return new;
end; $$;
drop trigger if exists lg_packages_double_check on public.lg_packages;
create trigger lg_packages_double_check before insert on public.lg_packages
  for each row execute function public.lg_trg_double_check();

create or replace function public.lg_double_check(p_code text, p_event uuid, p_ok boolean default true,
                                                  p_photo_path text default null, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p public.lg_packages; t public.lg_pick_tasks; res jsonb;
begin
  if not public.lg_has_role(array['picker', 'dock_chief']) then raise exception 'forbidden'; end if;
  res := public.lg_idem_get(p_event); if res is not null then return res; end if;
  select * into p from public.lg_packages where code = public.lg_norm_code(p_code) for update;
  if not found then return public.lg_idem_put(p_event, 'double_check', jsonb_build_object('ok', false, 'error', 'unknown_package')); end if;
  if not p.check_required then return public.lg_idem_put(p_event, 'double_check', jsonb_build_object('ok', true, 'not_required', true)); end if;
  select * into t from public.lg_pick_tasks where id = p.pick_task_id;
  if t.picker_id = auth.uid() then
    return public.lg_idem_put(p_event, 'double_check', jsonb_build_object('ok', false, 'error', 'same_person'));
  end if;
  if not p_ok then
    insert into public.lg_incidents (kind, package_id, order_id, description, photos, reported_by, responsible_type, responsible_id, due_at)
    values ('missing_item', p.id, p.order_id, coalesce(p_note, 'Écart constaté au double contrôle'),
            case when p_photo_path is null then '{}' else array[p_photo_path] end, auth.uid(), 'hub', p.hub_id, now() + interval '4 hours');
    return public.lg_idem_put(p_event, 'double_check', jsonb_build_object('ok', true, 'incident', true));
  end if;
  update public.lg_packages set checked_by = auth.uid(), checked_at = now(), check_photo = p_photo_path, updated_at = now() where id = p.id;
  insert into public.lg_scan_events (client_event_id, package_id, event, actor_id, hub_id, device_at, meta)
  values (coalesce(p_event, gen_random_uuid()), p.id, 'inventory', auth.uid(), p.hub_id, now(), jsonb_build_object('double_check', true));
  return public.lg_idem_put(p_event, 'double_check', jsonb_build_object('ok', true, 'code', p.code));
end; $$;

-- 3. NUMÉROS SANS SAUT -------------------------------------------------------------------
-- Une séquence Postgres pré-réserve 32 valeurs et les perd à un redémarrage brutal : vu en
-- démo, voyage n° 2 suivi du n° 34. Voyages et incidents prennent un compteur transactionnel
-- (invoice_sequences, année 0 = compteur perpétuel), sous verrou.
create or replace function public.lg_next_counter(p_prefix text) returns integer
language plpgsql security definer set search_path = public as $$
declare v int;
begin
  perform pg_advisory_xact_lock(hashtext('lg_counter:' || p_prefix));
  update public.invoice_sequences set last_seq = last_seq + 1 where prefix = p_prefix and year = 0 returning last_seq into v;
  if v is null then
    insert into public.invoice_sequences (prefix, year, last_seq) values (p_prefix, 0, 1);
    v := 1;
  end if;
  return v;
end; $$;
-- départ au-delà des numéros déjà attribués (base réelle non vide un jour)
insert into public.invoice_sequences (prefix, year, last_seq)
select 'TRIP', 0, coalesce(max(number), 0) from public.lg_trips
 where not exists (select 1 from public.invoice_sequences where prefix = 'TRIP' and year = 0);
insert into public.invoice_sequences (prefix, year, last_seq)
select 'INC', 0, coalesce(max(number), 0) from public.lg_incidents
 where not exists (select 1 from public.invoice_sequences where prefix = 'INC' and year = 0);
alter table public.lg_trips alter column number set default public.lg_next_counter('TRIP');
alter table public.lg_incidents alter column number set default public.lg_next_counter('INC');
