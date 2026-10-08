-- =====================================================================
-- NEXUS LOGISTICS — cycle 17 · Dépôt par le vendeur (module 09, P2)
-- « Le vendeur apporte lui-même ses colis au hub dans un créneau réservé. »
-- Le chef de quai ouvre des créneaux de dépôt ; le vendeur en réserve un pour
-- ses colis prêts chez lui ; tant qu'un dépôt est prévu, on n'envoie pas de
-- chauffeur les collecter ; au hub, le scan d'entrée prend le colis directement
-- des mains du vendeur (sans voyage) et note l'arrivée.
-- =====================================================================

create table if not exists public.lg_dropoff_slots (
  id         uuid primary key default gen_random_uuid(),
  hub_id     uuid not null references public.lg_hubs(id),
  day        date not null,
  start_time time not null,
  end_time   time not null check (end_time > start_time),
  capacity   integer not null check (capacity > 0),
  unique (hub_id, day, start_time)
);
create table if not exists public.lg_dropoff_bookings (
  id          uuid primary key default gen_random_uuid(),
  slot_id     uuid not null references public.lg_dropoff_slots(id) on delete cascade,
  vendor_id   uuid not null references public.profiles(id),
  packages    integer not null default 0,           -- colis prêts au moment de la réservation
  status      text not null default 'booked' check (status in ('booked', 'arrived', 'cancelled')),
  arrived_at  timestamptz,
  received    integer not null default 0,
  created_at  timestamptz not null default now(),
  unique (slot_id, vendor_id)
);
alter table public.lg_dropoff_slots    enable row level security;
alter table public.lg_dropoff_bookings enable row level security;

-- Le créneau en cours ou à venir d'un vendeur (pas encore passé)
create or replace function public.lg_dropoff_upcoming(p_vendor uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select b.id from public.lg_dropoff_bookings b join public.lg_dropoff_slots s on s.id = b.slot_id
   where b.vendor_id = p_vendor and b.status = 'booked'
     and (s.day + s.end_time) at time zone 'Africa/Dakar' > now()
   order by s.day, s.start_time limit 1
$$;

-- 1. CRÉNEAUX (chef de quai) ------------------------------------------------------------------
create or replace function public.lg_dropoff_slots_create(p_from date, p_days integer, p_times text[], p_capacity integer,
                                                          p_hub uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_hub uuid; d date; tm text; n int := 0;
begin
  if not public.lg_has_role(array['dock_chief']) then raise exception 'forbidden'; end if;
  if coalesce(p_capacity, 0) <= 0 or coalesce(p_days, 0) not between 1 and 31 then raise exception 'invalid_quantity'; end if;
  v_hub := coalesce(p_hub, (select hub_id from public.lg_staff_roles where user_id = auth.uid() and hub_id is not null limit 1),
                    (select id from public.lg_hubs where active order by created_at limit 1));
  for d in select generate_series(p_from, p_from + p_days - 1, interval '1 day')::date loop
    foreach tm in array p_times loop
      insert into public.lg_dropoff_slots (hub_id, day, start_time, end_time, capacity)
      values (v_hub, d, split_part(tm, '-', 1)::time, split_part(tm, '-', 2)::time, p_capacity)
      on conflict (hub_id, day, start_time) do update set capacity = excluded.capacity, end_time = excluded.end_time;
      n := n + 1;
    end loop;
  end loop;
  return jsonb_build_object('ok', true, 'slots', n);
end; $$;

-- 2. RÉSERVATION (vendeur) -------------------------------------------------------------------
create or replace function public.lg_dropoff_available(p_days integer default 5) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('vendor', 'admin')) or public.lg_device_blocked() then
    raise exception 'forbidden';
  end if;
  return jsonb_build_object(
    'ready_packages', (select count(*) from public.lg_packages where status = 'staged' and hub_id is null
                         and holder_type = 'vendor' and holder_id = auth.uid()),
    'booking', (select jsonb_build_object('id', b.id, 'day', s.day, 'start', s.start_time, 'end', s.end_time, 'hub', h.name, 'packages', b.packages)
                  from public.lg_dropoff_bookings b join public.lg_dropoff_slots s on s.id = b.slot_id join public.lg_hubs h on h.id = s.hub_id
                 where b.id = public.lg_dropoff_upcoming(auth.uid())),
    'slots', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'day', s.day, 'start', s.start_time, 'end', s.end_time, 'hub', h.name,
                'left', s.capacity - (select count(*) from public.lg_dropoff_bookings b where b.slot_id = s.id and b.status <> 'cancelled'))
                order by s.day, s.start_time), '[]')
                from public.lg_dropoff_slots s join public.lg_hubs h on h.id = s.hub_id
               where s.day between public.lg_today() and public.lg_today() + coalesce(p_days, 5)
                 and (s.day + s.start_time) at time zone 'Africa/Dakar' > now()
                 and s.capacity > (select count(*) from public.lg_dropoff_bookings b where b.slot_id = s.id and b.status <> 'cancelled')));
end; $$;

create or replace function public.lg_dropoff_book(p_slot uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.lg_dropoff_slots; v_ready int; v_id uuid;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role = 'vendor') or public.lg_device_blocked() then
    raise exception 'forbidden';
  end if;
  select * into s from public.lg_dropoff_slots where id = p_slot for update;
  if not found or (s.day + s.start_time) at time zone 'Africa/Dakar' <= now() then
    return jsonb_build_object('ok', false, 'error', 'slot_unavailable');
  end if;
  if (select count(*) from public.lg_dropoff_bookings where slot_id = s.id and status <> 'cancelled') >= s.capacity then
    return jsonb_build_object('ok', false, 'error', 'slot_unavailable');
  end if;
  select count(*) into v_ready from public.lg_packages where status = 'staged' and hub_id is null and holder_type = 'vendor' and holder_id = auth.uid();
  if v_ready = 0 then return jsonb_build_object('ok', false, 'error', 'nothing_to_drop'); end if;
  -- un seul dépôt prévu à la fois : le nouveau remplace l'ancien
  update public.lg_dropoff_bookings set status = 'cancelled' where id = public.lg_dropoff_upcoming(auth.uid());
  insert into public.lg_dropoff_bookings (slot_id, vendor_id, packages) values (s.id, auth.uid(), v_ready)
  on conflict (slot_id, vendor_id) do update set status = 'booked', packages = excluded.packages
  returning id into v_id;
  perform public.lg_audit('dropoff_book', 'dropoff', v_id::text, jsonb_build_object('day', s.day, 'start', s.start_time, 'packages', v_ready));
  return jsonb_build_object('ok', true, 'id', v_id, 'packages', v_ready);
end; $$;

create or replace function public.lg_dropoff_cancel(p_booking uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b public.lg_dropoff_bookings;
begin
  select * into b from public.lg_dropoff_bookings where id = p_booking for update;
  if not found then raise exception 'unknown_booking'; end if;
  if not (b.vendor_id = auth.uid() and not public.lg_device_blocked()) and not public.lg_has_role(array['dock_chief']) then raise exception 'forbidden'; end if;
  if b.status <> 'booked' then return jsonb_build_object('ok', false, 'error', 'bad_status'); end if;
  update public.lg_dropoff_bookings set status = 'cancelled' where id = p_booking;
  return jsonb_build_object('ok', true);
end; $$;

-- 3. AU HUB : réception directe d'un colis apporté par le vendeur ------------------------------
create or replace function public.lg_dropoff_receive(p_code text, p_event uuid, p_weight_g integer default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p public.lg_packages; res jsonb; v_hub uuid; v_booking uuid;
begin
  if not public.lg_has_role(array['dock_chief', 'picker']) then raise exception 'forbidden'; end if;
  res := public.lg_idem_get(p_event); if res is not null then return res; end if;
  select * into p from public.lg_packages where code = public.lg_norm_code(p_code) for update;
  if not found then return public.lg_idem_put(p_event, 'dropoff', jsonb_build_object('ok', false, 'error', 'unknown_package')); end if;
  if p.status <> 'staged' or p.holder_type <> 'vendor' or p.hub_id is not null then
    return public.lg_idem_put(p_event, 'dropoff', jsonb_build_object('ok', false, 'error', 'not_at_vendor', 'status', p.status));
  end if;
  -- un colis déjà prévu dans une collecte ne se reçoit pas en dépôt (le chauffeur le cherche)
  if exists (select 1 from public.lg_trip_packages tp where tp.package_id = p.id and tp.outcome is null) then
    return public.lg_idem_put(p_event, 'dropoff', jsonb_build_object('ok', false, 'error', 'in_pickup_trip'));
  end if;
  v_hub := coalesce((select hub_id from public.lg_staff_roles where user_id = auth.uid() and active and hub_id is not null limit 1),
                    (select id from public.lg_hubs where active order by created_at limit 1));
  update public.lg_packages set holder_type = 'hub', holder_id = v_hub, hub_id = v_hub,
         weight_g = coalesce(p_weight_g, weight_g), updated_at = now() where id = p.id;
  insert into public.lg_scan_events (client_event_id, package_id, event, actor_id, hub_id, device_at, meta)
  values (coalesce(p_event, gen_random_uuid()), p.id, 'receive', auth.uid(), v_hub, now(), jsonb_build_object('dropoff', true, 'weight_g', p_weight_g));
  -- la réservation du jour du vendeur (même arrivé en avance ou en retard) passe « arrivé »
  select b.id into v_booking from public.lg_dropoff_bookings b join public.lg_dropoff_slots s on s.id = b.slot_id
   where b.vendor_id = p.holder_id and b.status in ('booked', 'arrived') and s.day = public.lg_today() order by s.start_time limit 1;
  if v_booking is not null then
    update public.lg_dropoff_bookings set status = 'arrived', arrived_at = coalesce(arrived_at, now()), received = received + 1 where id = v_booking;
  end if;
  return public.lg_idem_put(p_event, 'dropoff', jsonb_build_object('ok', true, 'code', p.code, 'zone', p.zone, 'next', 'staged',
    'booked', v_booking is not null));
end; $$;

create or replace function public.lg_dropoffs_today() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['dock_chief', 'picker', 'dispatcher']) then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'vendor', coalesce(v.shop_name, v.name), 'phone', v.phone,
            'start', s.start_time, 'end', s.end_time, 'packages', b.packages, 'received', b.received, 'status', b.status,
            'late', b.status = 'booked' and (s.day + s.end_time) at time zone 'Africa/Dakar' < now()) order by s.start_time, v.name), '[]')
    from public.lg_dropoff_bookings b join public.lg_dropoff_slots s on s.id = b.slot_id join public.profiles v on v.id = b.vendor_id
   where s.day = public.lg_today() and b.status <> 'cancelled');
end; $$;

-- 4. COLLECTES : un vendeur qui a réservé un dépôt n'est pas proposé à la collecte -------------
create or replace function public.lg_pickups_pending() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['dispatcher', 'dock_chief']) then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('vendor_id', v.id, 'vendor', coalesce(v.shop_name, v.company_name, v.name),
            'address', v.address, 'phone', v.phone, 'lat', v.home_lat, 'lng', v.home_lng, 'packages', n, 'weight_g', w, 'oldest', oldest)
            order by oldest), '[]')
    from (select p.holder_id vendor_id, count(*) n, sum(coalesce(p.weight_g, 0)) w, min(p.updated_at) oldest
            from public.lg_packages p
           where p.status = 'staged' and p.hub_id is null and p.holder_type = 'vendor'
             and not exists (select 1 from public.lg_trip_packages tp where tp.package_id = p.id and tp.outcome is null)
           group by p.holder_id) s join public.profiles v on v.id = s.vendor_id
   where public.lg_dropoff_upcoming(v.id) is null);
end; $$;
