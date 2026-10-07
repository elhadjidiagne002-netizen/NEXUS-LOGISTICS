-- =====================================================================
-- NEXUS LOGISTICS — 07 · Modules 04 Tour de contrôle, 09 Vendeurs,
-- 10 Flotte, 12 Tarification, 14 Analytique (P1 + P2)
-- =====================================================================

-- 1. TABLES P2 ---------------------------------------------------------------------------
create table if not exists public.lg_driver_positions (
  id          bigint generated always as identity primary key,
  courier_id  uuid not null references public.couriers(id) on delete cascade,
  trip_id     uuid references public.lg_trips(id) on delete set null,
  lat         double precision not null,
  lng         double precision not null,
  accuracy_m  integer,
  speed_kmh   numeric(5,1),
  recorded_at timestamptz not null default now()
);
create index if not exists lg_driver_positions_idx on public.lg_driver_positions (courier_id, recorded_at desc);

create table if not exists public.lg_rate_cards (
  id            uuid primary key default gen_random_uuid(),
  zone          text references public.delivery_zones(name) on delete cascade,  -- null = toutes zones
  vehicle_kind  text,                                                           -- null = tous véhicules
  max_weight_g  integer not null,                                               -- tranche : jusqu'à …
  price_fcfa    integer not null check (price_fcfa >= 0),
  lead_hours    integer not null default 24,                                    -- délai promis
  service       text not null default 'standard' check (service in ('standard', 'express', 'programme')),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

create table if not exists public.lg_zone_settings (
  zone              text primary key references public.delivery_zones(name) on delete cascade,
  served            boolean not null default true,
  cutoff_time       time not null default '12:00',          -- heure limite de commande
  delivery_days     smallint[] not null default '{1,2,3,4,5,6}', -- 0 = dimanche
  free_above_fcfa   integer,                                -- livraison offerte au-delà
  hub_id            uuid references public.lg_hubs(id)
);

create table if not exists public.lg_slots (
  id         uuid primary key default gen_random_uuid(),
  zone       text references public.delivery_zones(name) on delete cascade,
  day        date not null,
  start_time time not null,
  end_time   time not null,
  capacity   integer not null check (capacity > 0),
  booked     integer not null default 0,
  unique (zone, day, start_time)
);
alter table public.orders add column if not exists slot_id uuid references public.lg_slots(id);

create table if not exists public.lg_trip_expenses (
  id         uuid primary key default gen_random_uuid(),
  trip_id    uuid references public.lg_trips(id),
  vehicle_id uuid references public.lg_vehicles(id),
  courier_id uuid references public.couriers(id),
  kind       text not null check (kind in ('carburant', 'peage', 'reparation', 'amende', 'stationnement', 'autre')),
  amount_fcfa integer not null check (amount_fcfa > 0),
  receipt_path text,
  note       text,
  status     text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.lg_vehicle_logs (
  id          uuid primary key default gen_random_uuid(),
  vehicle_id  uuid not null references public.lg_vehicles(id) on delete cascade,
  trip_id     uuid references public.lg_trips(id),
  kind        text not null check (kind in ('checklist', 'entretien', 'panne', 'kilometrage', 'pneus', 'vidange')),
  odometer_km integer,
  checklist   jsonb,           -- {pneus:true, freins:true, feux:false, …}
  ok          boolean not null default true,
  cost_fcfa   integer,
  note        text,
  photos      text[] not null default '{}',
  next_due_km integer,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);

alter table public.lg_driver_positions enable row level security;
alter table public.lg_rate_cards       enable row level security;
alter table public.lg_zone_settings    enable row level security;
alter table public.lg_slots            enable row level security;
alter table public.lg_trip_expenses    enable row level security;
alter table public.lg_vehicle_logs     enable row level security;

-- 2. POSITION DU CHAUFFEUR ---------------------------------------------------------------
-- Diffusion côté app toutes les 10 s (canal temps réel) ; écriture en base au plus
-- une fois par minute, et seulement pendant un voyage (chapitre 11, données personnelles).
create or replace function public.lg_driver_ping(p_lat double precision, p_lng double precision,
  p_accuracy_m integer default null, p_speed_kmh numeric default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_courier uuid := public.lg_my_courier_id(); v_trip uuid; v_last timestamptz;
begin
  if v_courier is null then raise exception 'not_a_courier'; end if;
  select id into v_trip from public.lg_trips where courier_id = v_courier and status = 'in_progress' limit 1;
  if v_trip is null then return jsonb_build_object('ok', true, 'stored', false, 'reason', 'off_duty'); end if;
  update public.profiles set current_lat = p_lat, current_lng = p_lng, location_updated_at = now() where id = auth.uid();
  select max(recorded_at) into v_last from public.lg_driver_positions where courier_id = v_courier;
  if v_last is null or v_last < now() - interval '55 seconds' then
    insert into public.lg_driver_positions (courier_id, trip_id, lat, lng, accuracy_m, speed_kmh)
    values (v_courier, v_trip, p_lat, p_lng, p_accuracy_m, p_speed_kmh);
    return jsonb_build_object('ok', true, 'stored', true);
  end if;
  return jsonb_build_object('ok', true, 'stored', false);
end; $$;

-- Bouton d'alerte (panne, accident, agression) : position transmise au répartiteur
create or replace function public.lg_sos(p_kind text, p_lat double precision default null, p_lng double precision default null,
                                         p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_courier uuid := public.lg_my_courier_id(); v_trip uuid; v_num int; v_name text;
begin
  if v_courier is null then raise exception 'not_a_courier'; end if;
  select id into v_trip from public.lg_trips where courier_id = v_courier and status in ('sealed', 'in_progress') limit 1;
  select name into v_name from public.couriers where id = v_courier;
  insert into public.lg_incidents (kind, severity, trip_id, description, reported_by, responsible_type, responsible_id, due_at)
  values (case p_kind when 'panne' then 'vehicle_breakdown' when 'accident' then 'accident' else 'other' end, 'critical',
          v_trip, format('ALERTE %s — %s%s', upper(p_kind), v_name, coalesce(' : ' || p_note, '')),
          auth.uid(), 'driver', v_courier, now() + interval '1 hour')
  returning number into v_num;
  perform public.lg_raise_alert('sos', 'critical',
    format('ALERTE %s : %s (%s)', upper(p_kind), v_name,
           coalesce(round(p_lat::numeric, 5) || ', ' || round(p_lng::numeric, 5), 'position inconnue')),
    v_trip, null, null, 'sos:' || v_courier || ':' || to_char(now(), 'YYYYMMDDHH24MI'));
  if p_lat is not null then
    update public.profiles set current_lat = p_lat, current_lng = p_lng, location_updated_at = now() where id = auth.uid();
  end if;
  return jsonb_build_object('ok', true, 'incident', v_num);
end; $$;

-- 3. TOUR DE CONTRÔLE ----------------------------------------------------------------------
create or replace function public.lg_dashboard(p_day date default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_day date := coalesce(p_day, (now() at time zone 'Africa/Dakar')::date);
        v_from timestamptz; v_to timestamptz;
begin
  if not public.lg_has_role(array['dispatcher', 'dock_chief', 'support', 'cashier']) then raise exception 'forbidden'; end if;
  v_from := v_day::timestamp at time zone 'Africa/Dakar';
  v_to := v_from + interval '1 day';
  return jsonb_build_object(
    'day', v_day,
    'kpis', jsonb_build_object(
      'packages_today', (select count(distinct tp.package_id) from public.lg_trip_packages tp join public.lg_trips t on t.id = tp.trip_id
                          where coalesce(t.started_at, t.planned_departure) >= v_from and coalesce(t.started_at, t.planned_departure) < v_to
                            and tp.outcome is distinct from 'removed'),
      'delivered', (select count(*) from public.lg_scan_events where event = 'deliver' and server_at >= v_from and server_at < v_to),
      'failed', (select count(*) from public.lg_scan_events where event = 'fail' and server_at >= v_from and server_at < v_to),
      'to_pick', (select count(*) from public.lg_pick_tasks where status in ('todo', 'picking')),
      'staged', (select count(*) from public.lg_packages where status = 'staged'),
      'staged_old', (select count(*) from public.lg_packages where status = 'staged'
                       and updated_at < now() - make_interval(hours => (public.lg_cfg('staged_max_hours'))::text::int)),
      'returns_waiting', (select count(*) from public.lg_packages where status = 'returned_hub'),
      'trips_late', (select count(distinct s.trip_id) from public.lg_trip_stops s join public.lg_trips t on t.id = s.trip_id
                      where t.status = 'in_progress' and s.status in ('pending', 'en_route', 'arrived') and s.eta < now() - interval '15 minutes'),
      'cash_out_fcfa', (select coalesce(sum(public.lg_trip_cash_outstanding(t.id)), 0) from public.lg_trips t
                         where t.status in ('sealed', 'in_progress', 'completed')
                           and not exists (select 1 from public.lg_cash_remittances r where r.trip_id = t.id)),
      'to_collect', (select count(*) from public.lg_packages where status = 'staged' and hub_id is null),
      'cod_to_collect_fcfa', (select coalesce(sum(s.cod_due_fcfa), 0) from public.lg_trip_stops s join public.lg_trips t on t.id = s.trip_id
                                where t.status in ('sealed', 'in_progress') and s.status in ('pending', 'en_route', 'arrived')),
      'open_incidents', (select count(*) from public.lg_incidents where status in ('open', 'investigating')),
      'open_requests', (select count(*) from public.lg_customer_requests where status = 'open')),
    'trips', (select coalesce(jsonb_agg(x order by x.urgency desc, x.number), '[]') from (
      select t.id, t.number, t.label, t.status, t.kind, t.planned_departure, t.started_at, t.cod_expected_fcfa,
             v.kind as vehicle_kind, v.plate, c.name as courier, c.phone as courier_phone,
             (select count(*) from public.lg_trip_stops where trip_id = t.id and status <> 'skipped') as stops_total,
             (select count(*) from public.lg_trip_stops where trip_id = t.id and status in ('delivered', 'failed')) as stops_done,
             (select count(*) from public.lg_trip_stops where trip_id = t.id and status = 'failed') as failures,
             (select greatest(0, round(extract(epoch from (now() - min(eta))) / 60)) from public.lg_trip_stops
               where trip_id = t.id and status in ('pending', 'en_route', 'arrived') and eta < now()) as late_min,
             (select round(extract(epoch from (now() - max(arrived_at))) / 60) from public.lg_trip_stops
               where trip_id = t.id and status = 'arrived') as stopped_min,
             public.lg_trip_gauge_of(t.id) as gauge,
             case when p.location_updated_at > now() - interval '30 minutes'
                  then jsonb_build_object('lat', p.current_lat, 'lng', p.current_lng, 'at', p.location_updated_at) end as position,
             (select coalesce(jsonb_agg(jsonb_build_object('seq', s.seq, 'status', s.status, 'lat', s.lat, 'lng', s.lng,
                       'name', s.contact_name, 'eta', s.eta) order by s.seq), '[]')
                from public.lg_trip_stops s where s.trip_id = t.id and s.status <> 'skipped') as stops,
             (case when t.status = 'in_progress' then 2 when t.status in ('loading', 'sealed') then 1 else 0 end
              + coalesce((select count(*) from public.lg_alerts a where a.trip_id = t.id and a.acked_at is null), 0) * 3) as urgency
        from public.lg_trips t join public.lg_vehicles v on v.id = t.vehicle_id
        left join public.couriers c on c.id = t.courier_id left join public.profiles p on p.id = c.user_id
       where t.status in ('planned', 'loading', 'sealed', 'in_progress', 'completed')
          or (t.status = 'reconciled' and t.ended_at >= v_from)) x),
    'alerts', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'kind', a.kind, 'severity', a.severity, 'message', a.message,
                 'trip_id', a.trip_id, 'created_at', a.created_at) order by a.created_at desc), '[]')
                 from (select * from public.lg_alerts where acked_at is null order by created_at desc limit 50) a),
    'to_assign', (select coalesce(jsonb_agg(jsonb_build_object('order_id', o.id, 'order_short', upper(left(o.id::text, 4)),
                    'zone', o.delivery_zone, 'packages', n, 'weight_g', w, 'cod_fcfa',
                    public.lg_order_due_fcfa(o.id),
                    'lat', o.delivery_lat, 'lng', o.delivery_lng, 'promised_at', o.promised_at, 'oldest', oldest) order by oldest), '[]')
                  from (select p.order_id, count(*) n, sum(p.weight_g) w, min(p.updated_at) oldest from public.lg_packages p
                         where p.status = 'staged' and p.hub_id is not null and p.direction = 'outbound'
                           and not exists (select 1 from public.lg_trip_packages tp where tp.package_id = p.id and tp.outcome is null)
                         group by p.order_id) s join public.orders o on o.id = s.order_id));
end; $$;

create or replace function public.lg_ack_alert(p_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['dispatcher', 'dock_chief', 'support', 'cashier']) then raise exception 'forbidden'; end if;
  update public.lg_alerts set acked_by = auth.uid(), acked_at = now(), dedupe_key = null where id = p_id and acked_at is null;
  return jsonb_build_object('ok', found);
end; $$;

-- Suggestion d'affectation (chapitre 10) : éliminatoires puis note
create or replace function public.lg_suggest_trips(p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare o public.orders; v_w int; v_n int; v_v numeric; v_cod int; v_hand text[];
begin
  if not public.lg_has_role(array['dispatcher', 'dock_chief']) then raise exception 'forbidden'; end if;
  select * into o from public.orders where id = p_order;
  select coalesce(sum(weight_g), 0), count(*), coalesce(sum(volume_l), 0), coalesce(array_agg(distinct h) filter (where h is not null), '{}')
    into v_w, v_n, v_v, v_hand
    from public.lg_packages p left join lateral unnest(p.handling) h on true
   where p.order_id = p_order and p.status = 'staged';
  v_cod := public.lg_order_due_fcfa(p_order);
  return (select coalesce(jsonb_agg(x order by x.score desc), '[]') from (
    select t.id as trip_id, t.number, t.label, v.kind as vehicle_kind, c.name as courier,
           -- note : proximité (0-50) + remplissage (0-30) + équilibre (0-20)
           round(50 * exp(-coalesce((select min(public.lg_distance_m(s.lat, s.lng, o.delivery_lat, o.delivery_lng))
                                     from public.lg_trip_stops s where s.trip_id = t.id and s.status <> 'skipped'), 8000) / 4000.0)
                 + 30 * least(1, (t.load_weight_g + v_w) / (v.capacity_kg * 1000.0))
                 + 20 * (1 - least(1, (select count(*) from public.lg_trip_stops where trip_id = t.id and status <> 'skipped') / 20.0))) as score,
           (select min(public.lg_distance_m(s.lat, s.lng, o.delivery_lat, o.delivery_lng)) from public.lg_trip_stops s
             where s.trip_id = t.id and s.status <> 'skipped') as nearest_m,
           round(100.0 * (t.load_weight_g + v_w) / (v.capacity_kg * 1000)) as weight_after_pct
      from public.lg_trips t join public.lg_vehicles v on v.id = t.vehicle_id left join public.couriers c on c.id = t.courier_id
     where t.status in ('planned', 'loading')
       and (coalesce(array_length(t.zones, 1), 0) = 0 or o.delivery_zone = any (t.zones))
       and t.load_weight_g + v_w <= v.capacity_kg * 1000
       and (v.max_packages is null or t.load_count + v_n <= v.max_packages)
       and (coalesce(v.capacity_l, 0) = 0 or t.load_volume_l + v_v <= v.capacity_l)
       and (not ('froid' = any (v_hand)) or 'glacière' = any (v.equipment))
       and t.cod_expected_fcfa + v_cod <= coalesce(c.cash_limit_fcfa, (public.lg_cfg('cash_limit_fcfa'))::text::int) * 2
    ) x);
end; $$;

-- Planification automatique (P2) : regroupe les commandes à quai par zone en voyages
-- proposés, dans la limite de capacité du véhicule choisi. Ne crée rien : le répartiteur valide.
create or replace function public.lg_autoplan(p_vehicle_kind text default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['dispatcher']) then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('zone', zone, 'city', city, 'orders', orders, 'packages', n,
                                                       'weight_g', w, 'cod_fcfa', cod) order by city, w desc), '[]')
    from (select o.delivery_zone zone, z.city, jsonb_agg(o.id) orders, sum(s.n) n, sum(s.w) w,
                 sum(public.lg_order_due_fcfa(o.id)) cod
            from (select p.order_id, count(*) n, sum(coalesce(p.weight_g, 0)) w from public.lg_packages p
                   where p.status = 'staged'
                     and not exists (select 1 from public.lg_trip_packages tp where tp.package_id = p.id and tp.outcome is null)
                   group by p.order_id) s
            join public.orders o on o.id = s.order_id left join public.delivery_zones z on z.name = o.delivery_zone
           group by o.delivery_zone, z.city) g);
end; $$;

-- Relecture : trajet réel d'un voyage
create or replace function public.lg_trip_track(p_trip uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['dispatcher', 'support']) then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_array(lat, lng, recorded_at) order by recorded_at), '[]')
            from public.lg_driver_positions where trip_id = p_trip);
end; $$;

-- 4. VEILLE AUTOMATIQUE (à brancher dans nexus_cron_horaire et toutes les 5 min côté Worker)
create or replace function public.lg_watchdog() returns jsonb
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  -- retards sur l'heure estimée
  for r in select s.id, s.trip_id, s.seq, t.number, round(extract(epoch from now() - s.eta) / 60) m
             from public.lg_trip_stops s join public.lg_trips t on t.id = s.trip_id
            where t.status = 'in_progress' and s.status in ('pending', 'en_route') and s.eta < now() - interval '20 minutes' loop
    perform public.lg_raise_alert('late', 'warning', format('Voyage %s, arrêt %s : %s min de retard', r.number, r.seq, r.m),
                                  r.trip_id, r.id, null, 'late:' || r.id); n := n + 1;
  end loop;
  -- arrêt anormalement long
  for r in select s.id, s.trip_id, s.seq, t.number, round(extract(epoch from now() - s.arrived_at) / 60) m
             from public.lg_trip_stops s join public.lg_trips t on t.id = s.trip_id
            where t.status = 'in_progress' and s.status = 'arrived'
              and s.arrived_at < now() - make_interval(mins => (public.lg_cfg('stop_max_minutes'))::text::int) loop
    perform public.lg_raise_alert('long_stop', 'warning', format('Voyage %s : arrêt %s depuis %s min', r.number, r.seq, r.m),
                                  r.trip_id, r.id, null, 'long:' || r.id); n := n + 1;
  end loop;
  -- chauffeur hors ligne pendant un voyage
  for r in select t.id, t.number, c.name, p.location_updated_at
             from public.lg_trips t join public.couriers c on c.id = t.courier_id join public.profiles p on p.id = c.user_id
            where t.status = 'in_progress'
              and coalesce(p.location_updated_at, t.started_at) < now() - make_interval(mins => (public.lg_cfg('offline_max_minutes'))::text::int) loop
    perform public.lg_raise_alert('driver_offline', 'warning', format('Voyage %s : %s sans position depuis %s', r.number, r.name,
                                  to_char(r.location_updated_at at time zone 'Africa/Dakar', 'HH24:MI')),
                                  r.id, null, null, 'offline:' || r.id || ':' || to_char(now(), 'YYYYMMDDHH24')); n := n + 1;
  end loop;
  -- colis oubliés à quai
  for r in select p.id, p.code, p.zone from public.lg_packages p
            where p.status = 'staged' and p.updated_at < now() - make_interval(hours => (public.lg_cfg('staged_max_hours'))::text::int)
              and not exists (select 1 from public.lg_trip_packages tp where tp.package_id = p.id and tp.outcome is null) loop
    perform public.lg_raise_alert('stale_package', 'info', format('Colis %s (%s) à quai depuis plus de %s h', r.code, r.zone,
                                  public.lg_cfg('staged_max_hours')), null, null, r.id, 'stale:' || r.id); n := n + 1;
  end loop;
  -- documents qui expirent sous 15 jours
  for r in select d.id, d.kind, d.expires_at, coalesce(v.plate, c.name) who from public.lg_vehicle_documents d
             left join public.lg_vehicles v on v.id = d.vehicle_id left join public.couriers c on c.id = d.courier_id
            where d.expires_at between current_date and current_date + 15
              and not exists (select 1 from public.lg_vehicle_documents d2 where d2.kind = d.kind and d2.expires_at > d.expires_at
                               and (d2.vehicle_id = d.vehicle_id or d2.courier_id = d.courier_id)) loop
    perform public.lg_raise_alert('doc_expiring', 'info', format('%s : %s expire le %s', r.who, replace(r.kind, '_', ' '),
                                  to_char(r.expires_at, 'DD/MM/YYYY')), null, null, null, 'doc:' || r.id); n := n + 1;
  end loop;
  -- préparations verrouillées par un préparateur inactif : libérées
  update public.lg_pick_tasks set picker_id = null
   where status = 'picking' and last_activity_at < now() - make_interval(mins => (public.lg_cfg('pick_lock_minutes'))::text::int) * 4;
  return jsonb_build_object('ok', true, 'alerts_checked', n);
end; $$;

-- Rapport du soir envoyé au gérant par WhatsApp (via notification_outbox)
create or replace function public.lg_evening_report(p_phone text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb; k jsonb;
begin
  v := public.lg_kpis((now() at time zone 'Africa/Dakar')::date, (now() at time zone 'Africa/Dakar')::date);
  k := v -> 'kpis';
  insert into public.notification_outbox (event_key, recipient, vars)
  values ('lg_evening_report', jsonb_build_object('phone', coalesce(p_phone, public.lg_cfg('manager_phone') #>> '{}')),
          (select x || jsonb_build_object('texte', public.lg_render_message('lg_evening_report', x)) from (select
          jsonb_build_object('livres', k -> 'delivered', 'echecs', k -> 'failed', 'premiere_presentation', k -> 'first_attempt_pct',
                             'ponctualite', k -> 'on_time_pct', 'especes', k -> 'cash_gap_fcfa', 'a_quai', k -> 'staged_over_24h') x) q));
  return v;
end; $$;

-- Purge des positions détaillées après 30 jours (chapitre 11)
create or replace function public.lg_purge() returns jsonb
language plpgsql security definer set search_path = public as $$
declare n int; m int;
begin
  delete from public.lg_driver_positions where recorded_at < now() - interval '30 days';
  get diagnostics n = row_count;
  delete from public.lg_action_log where created_at < now() - interval '30 days';
  get diagnostics m = row_count;
  delete from public.lg_alerts where acked_at < now() - interval '30 days';
  return jsonb_build_object('positions', n, 'actions', m);
end; $$;

-- 5. INDICATEURS DE PILOTAGE (chapitre 12) -------------------------------------------------
create or replace function public.lg_kpis(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_from timestamptz := p_from::timestamp at time zone 'Africa/Dakar';
        v_to   timestamptz := (p_to + 1)::timestamp at time zone 'Africa/Dakar';
begin
  if auth.uid() is not null and not public.lg_has_role(array['dispatcher', 'accountant', 'support']) then raise exception 'forbidden'; end if;
  return jsonb_build_object('from', p_from, 'to', p_to, 'kpis', (
    with deliv as (
      select p.id, p.attempts, e.server_at as delivered_at, o.promised_at, o.created_at as ordered_at,
             coalesce(o.cod_confirmed_at, o.paid_at, o.created_at) as confirmed_at, s.eta
        from public.lg_scan_events e join public.lg_packages p on p.id = e.package_id join public.orders o on o.id = p.order_id
        left join public.lg_trip_packages tp on tp.package_id = p.id and tp.outcome = 'delivered'
        left join public.lg_trip_stops s on s.id = tp.stop_id
       where e.event = 'deliver' and e.server_at >= v_from and e.server_at < v_to),
    att as (select count(*) filter (where event = 'deliver') d, count(*) filter (where event = 'fail') f
              from public.lg_scan_events where event in ('deliver', 'fail') and server_at >= v_from and server_at < v_to),
    picks as (select t.vendor_id, t.done_at, o.created_at, coalesce(o.cod_confirmed_at, o.paid_at, o.created_at) conf
                from public.lg_pick_tasks t join public.orders o on o.id = t.order_id
               where t.done_at >= v_from and t.done_at < v_to),
    lines as (select count(*) total, count(*) filter (where l.status = 'short') short
                from public.lg_pick_lines l join public.lg_pick_tasks t on t.id = l.task_id
               where t.done_at >= v_from and t.done_at < v_to),
    trips as (select t.id, t.started_at, t.ended_at, public.lg_trip_gauge_of(t.id) g,
                     (select count(*) from public.lg_trip_packages where trip_id = t.id and outcome = 'delivered') delivered
                from public.lg_trips t where t.started_at >= v_from and t.started_at < v_to and t.status in ('completed', 'reconciled', 'in_progress')),
    cash as (select coalesce(sum(abs(gap_fcfa)), 0) gap, coalesce(sum(expected_fcfa), 0) exp, count(*) filter (where gap_fcfa <> 0) n
               from public.lg_cash_remittances where validated_at >= v_from and validated_at < v_to),
    inc as (select count(*) filter (where kind in ('wrong_product', 'missing_item')) n from public.lg_incidents
             where created_at >= v_from and created_at < v_to),
    reasons as (select coalesce(jsonb_agg(jsonb_build_object('reason', r.label, 'count', n) order by n desc), '[]') j
                  from (select e.meta ->> 'reason' code, count(*) n from public.lg_scan_events e
                         where e.event = 'fail' and e.server_at >= v_from and e.server_at < v_to group by 1) x
                  left join public.lg_failure_reasons r on r.code = x.code)
    select jsonb_build_object(
      'delivered', (select count(*) from deliv),
      'failed', (select f from att),
      'first_attempt_pct', (select round(100.0 * count(*) filter (where attempts = 0) / nullif(count(*), 0)) from deliv),
      'on_time_pct', (select round(100.0 * count(*) filter (where delivered_at <= coalesce(promised_at, eta + interval '30 minutes'))
                                   / nullif(count(*) filter (where coalesce(promised_at, eta) is not null), 0)) from deliv),
      'end_to_end_hours', (select round(extract(epoch from avg(delivered_at - confirmed_at)) / 3600, 1) from deliv),
      'prep_hours', (select round(extract(epoch from avg(done_at - conf)) / 3600, 1) from picks),
      'stockout_pct', (select round(100.0 * short / nullif(total, 0), 1) from lines),
      'prep_error_pct', (select round(100.0 * (select n from inc) / nullif((select count(*) from deliv), 0), 1)),
      'fill_pct', (select round(avg((g ->> 'fill_pct')::numeric)) from trips),
      'packages_per_trip', (select round(avg(delivered), 1) from trips),
      'packages_per_hour', (select round(sum(delivered) / nullif(sum(extract(epoch from (coalesce(ended_at, now()) - started_at)) / 3600), 0), 1) from trips),
      'failure_rate_pct', (select round(100.0 * f / nullif(d + f, 0), 1) from att),
      'failure_reasons', (select j from reasons),
      'cash_gap_fcfa', (select gap from cash), 'cash_gap_pct', (select round(100.0 * gap / nullif(exp, 0), 2) from cash),
      'trips_with_gap', (select n from cash),
      'staged_over_24h', (select count(*) from public.lg_packages where status = 'staged' and updated_at < now() - interval '24 hours'),
      'cost_per_delivery_fcfa', (select round((coalesce((select sum(amount_fcfa) from public.lg_trip_expenses where created_at >= v_from and created_at < v_to and status <> 'rejected'), 0)
                                              + coalesce((select sum(amount) from public.courier_earnings where created_at >= v_from and created_at < v_to and type in ('delivery', 'bonus')), 0))
                                             / nullif((select count(*) from deliv), 0)))
    )),
    'by_zone', (select coalesce(jsonb_agg(jsonb_build_object('zone', zone, 'delivered', d, 'failed', f,
                   'failure_pct', round(100.0 * f / nullif(d + f, 0))) order by d + f desc), '[]')
      from (select p.zone, count(*) filter (where e.event = 'deliver') d, count(*) filter (where e.event = 'fail') f
              from public.lg_scan_events e join public.lg_packages p on p.id = e.package_id
             where e.event in ('deliver', 'fail') and e.server_at >= v_from and e.server_at < v_to group by p.zone) z),
    'by_courier', (select coalesce(jsonb_agg(jsonb_build_object('courier', c.name, 'delivered', d, 'failed', f, 'rating', c.rating_avg)
                     order by d desc), '[]')
      from (select t.courier_id, count(*) filter (where tp.outcome = 'delivered') d, count(*) filter (where tp.outcome = 'failed') f
              from public.lg_trips t join public.lg_trip_packages tp on tp.trip_id = t.id
             where t.started_at >= v_from and t.started_at < v_to group by t.courier_id) x join public.couriers c on c.id = x.courier_id),
    'by_vendor', (select coalesce(jsonb_agg(jsonb_build_object('vendor', coalesce(pr.shop_name, pr.name), 'tasks', n,
                    'prep_hours', h, 'stockout_lines', s) order by n desc), '[]')
      from (select t.vendor_id, count(distinct t.id) n, round(extract(epoch from avg(t.done_at - t.created_at)) / 3600, 1) h,
                   count(*) filter (where l.status = 'short') s
              from public.lg_pick_tasks t join public.lg_pick_lines l on l.task_id = t.id
             where t.done_at >= v_from and t.done_at < v_to group by t.vendor_id) x left join public.profiles pr on pr.id = x.vendor_id));
end; $$;

-- 6. TARIFICATION AU PANIER (module 12) — ouverte au site public ----------------------------
create or replace function public.lg_quote(p_zone text, p_weight_g integer, p_subtotal_fcfa integer default 0,
                                           p_service text default 'standard') returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  rc  public.lg_rate_cards;
  zs  public.lg_zone_settings;
  v_kind text;
  v_now timestamp := now() at time zone 'Africa/Dakar';
  v_day date;
  v_promise timestamptz;
begin
  select * into zs from public.lg_zone_settings where zone = p_zone;
  if zs.zone is not null and not zs.served then return jsonb_build_object('ok', false, 'error', 'zone_not_served'); end if;
  if not exists (select 1 from public.delivery_zones where name = p_zone) then
    return jsonb_build_object('ok', false, 'error', 'unknown_zone');
  end if;
  v_kind := case when p_weight_g <= 20000 then 'moto' when p_weight_g <= 150000 then 'tricycle' else 'fourgonnette' end;
  select * into rc from public.lg_rate_cards
   where active and service = coalesce(p_service, 'standard') and max_weight_g >= p_weight_g
     and (zone = p_zone or zone is null) and (vehicle_kind = v_kind or vehicle_kind is null)
   order by (zone is not null) desc, (vehicle_kind is not null) desc, max_weight_g asc limit 1;
  if rc.id is null then return jsonb_build_object('ok', false, 'error', 'no_rate'); end if;
  -- délai promis : jour de livraison ouvert suivant l'heure limite
  v_day := v_now::date + case when v_now::time > coalesce(zs.cutoff_time, '12:00') then 1 else 0 end
                       + ceil(greatest(rc.lead_hours - 24, 0) / 24.0)::int;
  for i in 0..7 loop
    exit when extract(dow from v_day)::smallint = any (coalesce(zs.delivery_days, '{1,2,3,4,5,6}'));
    v_day := v_day + 1;
  end loop;
  v_promise := (v_day + time '19:00') at time zone 'Africa/Dakar';
  if rc.service = 'express' then v_promise := least(v_promise, now() + make_interval(hours => rc.lead_hours)); end if;
  return jsonb_build_object('ok', true, 'zone', p_zone, 'service', rc.service, 'vehicle_kind', v_kind,
    'price_fcfa', case when zs.free_above_fcfa is not null and p_subtotal_fcfa >= zs.free_above_fcfa then 0 else rc.price_fcfa end,
    'free', zs.free_above_fcfa is not null and p_subtotal_fcfa >= zs.free_above_fcfa,
    'free_above_fcfa', zs.free_above_fcfa, 'promised_at', v_promise);
end; $$;

create or replace function public.lg_slots_available(p_zone text, p_days integer default 5) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'day', day, 'start', start_time, 'end', end_time,
                                               'left', capacity - booked) order by day, start_time), '[]')
    from public.lg_slots where zone = p_zone and day between current_date and current_date + p_days and booked < capacity
$$;

-- Choix ou changement de créneau par le client, tant que rien n'est chargé
create or replace function public.lg_track_book_slot(p_token uuid, p_slot uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o public.orders; sl public.lg_slots;
begin
  o := public.lg_order_by_token(p_token);
  if o.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if exists (select 1 from public.lg_packages where order_id = o.id and status in ('loaded', 'out_for_delivery', 'delivered')) then
    return jsonb_build_object('ok', false, 'error', 'already_loaded');
  end if;
  select * into sl from public.lg_slots where id = p_slot for update;
  if not found or sl.booked >= sl.capacity or sl.zone is distinct from o.delivery_zone then
    return jsonb_build_object('ok', false, 'error', 'slot_unavailable');
  end if;
  if o.slot_id is not null then update public.lg_slots set booked = greatest(booked - 1, 0) where id = o.slot_id; end if;
  update public.lg_slots set booked = booked + 1 where id = p_slot;
  update public.orders set slot_id = p_slot,
         promised_at = (sl.day + sl.end_time) at time zone 'Africa/Dakar', updated_at = now() where id = o.id;
  update public.lg_trip_stops st set window_start = (sl.day + sl.start_time) at time zone 'Africa/Dakar',
         window_end = (sl.day + sl.end_time) at time zone 'Africa/Dakar'
    from public.lg_trips tr where tr.id = st.trip_id and st.order_id = o.id and tr.status in ('planned', 'loading');
  return jsonb_build_object('ok', true);
end; $$;

-- 7. FLOTTE -----------------------------------------------------------------------------------
create or replace function public.lg_fleet() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['dock_chief', 'dispatcher']) then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'id', v.id, 'plate', v.plate, 'kind', v.kind, 'label', v.label, 'status', v.status, 'ownership', v.ownership,
      'capacity_kg', v.capacity_kg, 'capacity_l', v.capacity_l, 'max_packages', v.max_packages, 'equipment', v.equipment,
      'odometer_km', v.odometer_km, 'hub_id', v.hub_id,
      'default_courier', (select jsonb_build_object('id', c.id, 'name', c.name) from public.couriers c where c.id = v.default_courier_id),
      'documents', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'kind', d.kind, 'number', d.number, 'expires_at', d.expires_at,
                      'expired', d.expires_at < current_date, 'soon', d.expires_at < current_date + 15) order by d.expires_at), '[]')
                    from public.lg_vehicle_documents d where d.vehicle_id = v.id),
      'last_check', (select jsonb_build_object('at', l.created_at, 'ok', l.ok) from public.lg_vehicle_logs l
                      where l.vehicle_id = v.id and l.kind = 'checklist' order by l.created_at desc limit 1),
      'costs_30d_fcfa', (select coalesce(sum(amount_fcfa), 0) from public.lg_trip_expenses e
                          where e.vehicle_id = v.id and e.created_at > now() - interval '30 days' and e.status <> 'rejected')
             + (select coalesce(sum(cost_fcfa), 0) from public.lg_vehicle_logs l where l.vehicle_id = v.id and l.created_at > now() - interval '30 days'),
      'km_30d', (select sum(distance_km) from public.lg_trips t where t.vehicle_id = v.id and t.started_at > now() - interval '30 days'),
      'on_trip', (select number from public.lg_trips t where t.vehicle_id = v.id and t.status in ('planned', 'loading', 'sealed', 'in_progress') limit 1)
    ) order by v.status, v.kind, v.plate), '[]') from public.lg_vehicles v where v.status <> 'retired');
end; $$;

-- Contrôle du véhicule avant départ (photos possibles), par le chauffeur ou le chef de quai
create or replace function public.lg_vehicle_check(p_vehicle uuid, p_checklist jsonb, p_odometer_km integer default null,
  p_trip uuid default null, p_photos text[] default '{}', p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ok boolean;
begin
  if not (public.lg_has_role(array['dock_chief']) or public.lg_my_courier_id() is not null) then raise exception 'forbidden'; end if;
  select bool_and(value::text = 'true') into v_ok from jsonb_each(p_checklist);
  insert into public.lg_vehicle_logs (vehicle_id, trip_id, kind, odometer_km, checklist, ok, note, photos, created_by)
  values (p_vehicle, p_trip, 'checklist', p_odometer_km, p_checklist, coalesce(v_ok, true), p_note, coalesce(p_photos, '{}'), auth.uid());
  if p_odometer_km is not null then
    update public.lg_vehicles set odometer_km = greatest(coalesce(odometer_km, 0), p_odometer_km), updated_at = now() where id = p_vehicle;
  end if;
  if not coalesce(v_ok, true) then
    perform public.lg_raise_alert('overload', 'warning', 'Contrôle véhicule non conforme : ' ||
      (select string_agg(key, ', ') from jsonb_each(p_checklist) where value::text <> 'true'), p_trip, null, null,
      'check:' || p_vehicle || ':' || current_date);
  end if;
  return jsonb_build_object('ok', true, 'conform', coalesce(v_ok, true));
end; $$;

create or replace function public.lg_add_expense(p_kind text, p_amount_fcfa integer, p_receipt_path text default null,
  p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_courier uuid := public.lg_my_courier_id(); v_trip public.lg_trips;
begin
  if v_courier is null then raise exception 'not_a_courier'; end if;
  select * into v_trip from public.lg_trips where courier_id = v_courier and status in ('sealed', 'in_progress', 'completed')
   order by created_at desc limit 1;
  insert into public.lg_trip_expenses (trip_id, vehicle_id, courier_id, kind, amount_fcfa, receipt_path, note, created_by)
  values (v_trip.id, v_trip.vehicle_id, v_courier, p_kind, p_amount_fcfa, p_receipt_path, p_note, auth.uid());
  return jsonb_build_object('ok', true);
end; $$;

-- 8. PORTAIL VENDEUR (module 09) ------------------------------------------------------------
create or replace function public.lg_vendor_overview() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('vendor', 'admin')) then raise exception 'forbidden'; end if;
  return jsonb_build_object(
    'to_prepare', (select count(*) from public.lg_pick_tasks where vendor_id = auth.uid() and status in ('todo', 'picking')),
    'in_transit', (select count(*) from public.lg_packages p join public.orders o on o.id = p.order_id
                    where o.vendor_id = auth.uid() and p.status in ('staged', 'loaded', 'out_for_delivery')),
    'returns', (select count(*) from public.lg_packages p join public.orders o on o.id = p.order_id
                 where o.vendor_id = auth.uid() and p.status in ('failed', 'returned_hub')),
    'avg_prep_hours_30d', (select round(extract(epoch from avg(done_at - created_at)) / 3600, 1) from public.lg_pick_tasks
                            where vendor_id = auth.uid() and done_at > now() - interval '30 days'),
    'stockout_pct_30d', (select round(100.0 * count(*) filter (where l.status = 'short') / nullif(count(*), 0), 1)
                          from public.lg_pick_lines l join public.lg_pick_tasks t on t.id = l.task_id
                         where t.vendor_id = auth.uid() and t.done_at > now() - interval '30 days'),
    'packages', (select coalesce(jsonb_agg(jsonb_build_object('code', p.code, 'status', p.status, 'order_short', upper(left(o.id::text, 8)),
                   'zone', p.zone, 'updated_at', p.updated_at, 'attempts', p.attempts) order by p.updated_at desc), '[]')
                   from (select * from public.lg_packages) p join public.orders o on o.id = p.order_id
                  where o.vendor_id = auth.uid() and p.updated_at > now() - interval '30 days'),
    'products_missing_data', (select count(*) from public.products where vendor_id = auth.uid() and coalesce(is_shippable, true)
                               and coalesce(active, true) and (weight_g is null or (barcode is null and sku is null))));
end; $$;

-- Fiches produit : code, poids, taille (import par fichier côté app → appels successifs)
create or replace function public.lg_product_logistics(p_product uuid, p_barcode text default null, p_sku text default null,
  p_weight_g integer default null, p_length_cm numeric default null, p_width_cm numeric default null, p_height_cm numeric default null,
  p_handling text[] default null, p_is_shippable boolean default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare pr public.products;
begin
  select * into pr from public.products where id = p_product for update;
  if not found then raise exception 'unknown_product'; end if;
  if pr.vendor_id is distinct from auth.uid() and not public.lg_has_role(array['picker', 'dock_chief']) then raise exception 'forbidden'; end if;
  update public.products set
    barcode = coalesce(nullif(trim(p_barcode), ''), barcode), sku = coalesce(nullif(trim(p_sku), ''), sku),
    weight_g = coalesce(p_weight_g, weight_g), length_cm = coalesce(p_length_cm, length_cm),
    width_cm = coalesce(p_width_cm, width_cm), height_cm = coalesce(p_height_cm, height_cm),
    handling = coalesce(p_handling, handling), is_shippable = coalesce(p_is_shippable, is_shippable), updated_at = now()
  where id = p_product;
  return jsonb_build_object('ok', true);
end; $$;

create or replace function public.lg_products_to_complete(p_vendor uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v uuid := coalesce(p_vendor, auth.uid());
begin
  if v <> auth.uid() and not public.lg_has_role(array['picker', 'dock_chief']) then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'barcode', barcode, 'sku', sku, 'weight_g', weight_g,
            'length_cm', length_cm, 'width_cm', width_cm, 'height_cm', height_cm, 'handling', handling,
            'internal_code', 'NXI-' || upper(left(id::text, 8))) order by name), '[]')
    from public.products where vendor_id = v and coalesce(is_shippable, true) and coalesce(active, true));
end; $$;
