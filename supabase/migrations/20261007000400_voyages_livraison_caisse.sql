-- =====================================================================
-- NEXUS LOGISTICS — 04 · Modules 03 Chargement, 05 Chauffeur, 07 Retours,
-- 08 Caisse, 13 Incidents (socle P1, plus les briques P2 nécessaires)
-- =====================================================================

-- 0. TABLES COMPLÉMENTAIRES -------------------------------------------------------
create table if not exists public.lg_vehicle_documents (
  id          uuid primary key default gen_random_uuid(),
  vehicle_id  uuid references public.lg_vehicles(id) on delete cascade,
  courier_id  uuid references public.couriers(id) on delete cascade,  -- permis du chauffeur
  kind        text not null check (kind in ('assurance', 'visite_technique', 'carte_grise', 'permis', 'autre')),
  number      text,
  expires_at  date not null,
  file_path   text,
  created_at  timestamptz not null default now(),
  check (vehicle_id is not null or courier_id is not null)
);

create table if not exists public.lg_pay_rules (
  id                 uuid primary key default gen_random_uuid(),
  vehicle_kind       text,                 -- null = règle par défaut
  ownership          text,                 -- interne / partenaire / independant ; null = toutes
  fixed_per_trip     integer not null default 0,
  per_package        integer not null default 500,
  bonus_zero_failure integer not null default 0,
  bonus_on_time      integer not null default 0,
  active             boolean not null default true,
  created_at         timestamptz not null default now()
);

create sequence if not exists public.lg_incident_number_seq;
create table if not exists public.lg_incidents (
  id               uuid primary key default gen_random_uuid(),
  number           integer not null unique default nextval('public.lg_incident_number_seq'),
  kind             text not null check (kind in ('damaged', 'lost', 'missing_item', 'wrong_product', 'refused',
                                                 'cash_gap', 'driver_behavior', 'vehicle_breakdown', 'accident',
                                                 'late', 'other')),
  severity         text not null default 'normal' check (severity in ('low', 'normal', 'high', 'critical')),
  status           text not null default 'open' check (status in ('open', 'investigating', 'resolved', 'closed')),
  package_id       uuid references public.lg_packages(id),
  trip_id          uuid references public.lg_trips(id),
  stop_id          uuid references public.lg_trip_stops(id),
  order_id         uuid references public.orders(id),
  description      text,
  photos           text[] not null default '{}',
  reported_by      uuid references public.profiles(id),
  responsible_type text check (responsible_type in ('vendor', 'hub', 'driver', 'customer', 'unknown')),
  responsible_id   uuid,
  resolution       text,
  compensation_fcfa integer not null default 0,
  deduction_fcfa   integer not null default 0,     -- retenue éventuelle (chauffeur, vendeur)
  dispute_id       uuid,
  due_at           timestamptz,
  resolved_by      uuid references public.profiles(id),
  resolved_at      timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists lg_incidents_open_idx on public.lg_incidents (status, created_at desc);

-- Adresse vérifiée : la position réelle de remise sert à la commande suivante
create table if not exists public.lg_verified_addresses (
  phone_key  text primary key,           -- 9 derniers chiffres du téléphone
  lat        double precision not null,
  lng        double precision not null,
  landmark   text,
  zone       text,
  deliveries integer not null default 1,
  updated_at timestamptz not null default now()
);

-- Versements intermédiaires (plafond d'encours, module 08)
create table if not exists public.lg_cash_drops (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid not null references public.lg_trips(id),
  courier_id  uuid not null references public.couriers(id),
  amount_fcfa integer not null check (amount_fcfa > 0),
  cashier_id  uuid not null references public.profiles(id),
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists lg_cash_drops_trip_idx on public.lg_cash_drops (trip_id);

-- Sens du colis : livraison (par défaut) ou retour client
alter table public.lg_packages add column if not exists direction text not null default 'outbound';
alter table public.lg_packages drop constraint if exists lg_packages_direction_check;
alter table public.lg_packages add constraint lg_packages_direction_check check (direction in ('outbound', 'return'));
-- issue « reçu au hub » pour un colis collecté chez un vendeur ou repris chez un client
alter table public.lg_trip_packages drop constraint if exists lg_trip_packages_outcome_check;
alter table public.lg_trip_packages add constraint lg_trip_packages_outcome_check
  check (outcome in ('delivered', 'failed', 'returned', 'removed', 'received'));
alter table public.lg_trip_packages add column if not exists transfer_from uuid references public.lg_trips(id);
-- coordonnées des vendeurs pour les collectes (colonnes présentes en prod)
alter table public.profiles add column if not exists home_lat double precision;
alter table public.profiles add column if not exists home_lng double precision;

alter table public.lg_cash_drops         enable row level security;
alter table public.lg_vehicle_documents  enable row level security;
alter table public.lg_pay_rules          enable row level security;
alter table public.lg_incidents          enable row level security;
alter table public.lg_verified_addresses enable row level security;

create or replace function public.lg_phone_key(p text) returns text language sql immutable as $$
  select nullif(right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 9), '')
$$;

-- 1. OUTILS ----------------------------------------------------------------------------
-- Espèces encore dues par un voyage : encaissées en espèces − versements intermédiaires
create or replace function public.lg_trip_cash_outstanding(p_trip uuid) returns integer
language sql stable security definer set search_path = public as $$
  select (coalesce((select sum(cc.amount_collected_fcfa) from public.lg_cod_collections cc
                     join public.lg_trip_stops s on s.id = cc.stop_id where s.trip_id = p_trip and cc.method = 'cash'), 0)
        - coalesce((select sum(amount_fcfa) from public.lg_cash_drops where trip_id = p_trip), 0))::int
$$;
-- Espèces portées par un chauffeur : voyages pas encore versés
create or replace function public.lg_courier_cash(p_courier uuid) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(sum(public.lg_trip_cash_outstanding(t.id)), 0)::int from public.lg_trips t
   where t.courier_id = p_courier and t.status in ('sealed', 'in_progress', 'completed')
     and not exists (select 1 from public.lg_cash_remittances r where r.trip_id = t.id)
$$;
create or replace function public.lg_trip_courier_user(p_trip uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select c.user_id from public.lg_trips t join public.couriers c on c.id = t.courier_id where t.id = p_trip
$$;

create or replace function public.lg_assert_driver(p_trip uuid) returns public.lg_trips
language plpgsql security definer set search_path = public as $$
declare t public.lg_trips;
begin
  select * into t from public.lg_trips where id = p_trip for update;
  if not found then raise exception 'unknown_trip'; end if;
  if public.lg_trip_courier_user(p_trip) is distinct from auth.uid() and not public.lg_is_admin() then
    raise exception 'not_your_trip';
  end if;
  return t;
end; $$;

-- Code de livraison : 4 chiffres, seul l'empreinte est gardée. Renvoie le code en clair
-- une seule fois, pour le message au client.
create or replace function public.lg_issue_delivery_code(p_order uuid) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare v_code text := lpad((floor(random() * 10000))::int::text, 4, '0');
begin
  insert into public.lg_delivery_codes (order_id, code_hash, attempts_left, expires_at, verified_at)
  values (p_order, crypt(v_code, gen_salt('bf', 6)), (public.lg_cfg('otp_attempts'))::text::int,
          now() + make_interval(hours => (public.lg_cfg('otp_ttl_hours'))::text::int), null)
  on conflict (order_id) do update
    set code_hash = excluded.code_hash, attempts_left = excluded.attempts_left,
        expires_at = excluded.expires_at, verified_at = null;
  return v_code;
end; $$;

-- Totaux du voyage recalculés depuis les colis chargés (jamais d'incrément aveugle)
create or replace function public.lg_trip_refresh(p_trip uuid) returns public.lg_trips
language plpgsql security definer set search_path = public as $$
declare t public.lg_trips;
begin
  update public.lg_trips tr set
    load_weight_g = coalesce(s.w, 0), load_volume_l = coalesce(s.v, 0), load_count = coalesce(s.n, 0),
    cod_expected_fcfa = (select coalesce(sum(cod_due_fcfa), 0) from public.lg_trip_stops
                          where trip_id = p_trip and kind = 'delivery' and status <> 'skipped'),
    updated_at = now()
  from (select sum(p.weight_g) w, sum(p.volume_l) v, count(*) n
          from public.lg_trip_packages tp join public.lg_packages p on p.id = tp.package_id
         where tp.trip_id = p_trip and tp.loaded_at is not null and tp.outcome is null) s
  where tr.id = p_trip returning tr.* into t;
  return t;
end; $$;

create or replace function public.lg_trip_gauge_of(p_trip uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'count', t.load_count, 'weight_g', t.load_weight_g, 'volume_l', t.load_volume_l,
    'capacity_kg', v.capacity_kg, 'capacity_l', v.capacity_l, 'max_packages', v.max_packages,
    'weight_pct', round(100.0 * t.load_weight_g / (v.capacity_kg * 1000)),
    'volume_pct', case when v.capacity_l > 0 then round(100.0 * t.load_volume_l / v.capacity_l) end,
    'count_pct',  case when v.max_packages > 0 then round(100.0 * t.load_count / v.max_packages) end,
    'fill_pct', greatest(round(100.0 * t.load_weight_g / (v.capacity_kg * 1000)),
                         coalesce(case when v.capacity_l > 0 then round(100.0 * t.load_volume_l / v.capacity_l) end, 0),
                         coalesce(case when v.max_packages > 0 then round(100.0 * t.load_count / v.max_packages) end, 0)),
    'planned', (select count(*) from public.lg_trip_packages where trip_id = t.id and outcome is null),
    'loaded',  (select count(*) from public.lg_trip_packages where trip_id = t.id and outcome is null and loaded_at is not null))
  from public.lg_trips t join public.lg_vehicles v on v.id = t.vehicle_id where t.id = p_trip
$$;

-- 2. CRÉATION D'UN VOYAGE ----------------------------------------------------------------
create or replace function public.lg_trip_create(p_vehicle uuid, p_courier uuid, p_label text default null,
  p_kind text default 'delivery', p_departure timestamptz default null, p_hub uuid default null,
  p_zones text[] default '{}') returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v public.lg_vehicles;
  c public.couriers;
  t public.lg_trips;
begin
  if not public.lg_has_role(array['dock_chief', 'dispatcher']) then raise exception 'forbidden'; end if;
  select * into v from public.lg_vehicles where id = p_vehicle for update;
  if not found then raise exception 'unknown_vehicle'; end if;
  if v.status in ('maintenance', 'retired') then raise exception 'vehicle_unavailable:%', v.status; end if;
  if exists (select 1 from public.lg_vehicle_documents d where d.vehicle_id = p_vehicle and d.expires_at < current_date
              and d.kind in ('assurance', 'visite_technique', 'carte_grise')
              and not exists (select 1 from public.lg_vehicle_documents d2 where d2.vehicle_id = p_vehicle
                                and d2.kind = d.kind and d2.expires_at >= current_date)) then
    raise exception 'vehicle_documents_expired';
  end if;
  if exists (select 1 from public.lg_trips where vehicle_id = p_vehicle
              and status in ('planned', 'loading', 'sealed', 'in_progress')) then
    raise exception 'vehicle_busy';
  end if;
  if p_courier is not null then
    select * into c from public.couriers where id = p_courier;
    if not found or c.status <> 'active' then raise exception 'courier_not_active'; end if;
    if c.license_expires_at is not null and c.license_expires_at < current_date then raise exception 'license_expired'; end if;
    -- clôture obligatoire avant le voyage suivant
    if exists (select 1 from public.lg_trips where courier_id = p_courier
                and status in ('planned', 'loading', 'sealed', 'in_progress', 'completed')) then
      raise exception 'courier_has_open_trip';
    end if;
  end if;

  insert into public.lg_trips (kind, label, hub_id, vehicle_id, courier_id, planned_departure, status, zones, created_by)
  values (coalesce(p_kind, 'delivery'), p_label, coalesce(p_hub, v.hub_id), p_vehicle, p_courier,
          coalesce(p_departure, now() + interval '1 hour'), 'planned', coalesce(p_zones, '{}'), auth.uid())
  returning * into t;
  perform public.lg_audit('trip_create', 'trip', t.id::text, jsonb_build_object('number', t.number));
  return jsonb_build_object('ok', true, 'trip_id', t.id, 'number', t.number);
end; $$;

create or replace function public.lg_trip_cancel(p_trip uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.lg_trips;
begin
  if not public.lg_has_role(array['dock_chief', 'dispatcher']) then raise exception 'forbidden'; end if;
  select * into t from public.lg_trips where id = p_trip for update;
  if t.status not in ('draft', 'planned', 'loading') then raise exception 'trip_not_cancellable:%', t.status; end if;
  update public.lg_packages p set status = 'staged', holder_type = 'hub', holder_id = coalesce(t.hub_id, p.hub_id), updated_at = now()
    from public.lg_trip_packages tp where tp.package_id = p.id and tp.trip_id = p_trip and tp.outcome is null and p.status = 'loaded';
  update public.lg_trip_packages set outcome = 'removed' where trip_id = p_trip and outcome is null;
  update public.lg_trips set status = 'cancelled', updated_at = now() where id = p_trip;
  perform public.lg_audit('trip_cancel', 'trip', p_trip::text, jsonb_build_object('reason', p_reason));
  return jsonb_build_object('ok', true);
end; $$;

-- 3. ARRÊTS -------------------------------------------------------------------------------
create or replace function public.lg_trip_ensure_stop(p_trip uuid, p_order uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_stop uuid;
  o      public.orders;
  v_seq  int;
  va     public.lg_verified_addresses;
begin
  select id into v_stop from public.lg_trip_stops
   where trip_id = p_trip and order_id = p_order and kind = 'delivery' and status <> 'skipped';
  if v_stop is not null then return v_stop; end if;
  select * into o from public.orders where id = p_order;
  select coalesce(max(seq), 0) + 1 into v_seq from public.lg_trip_stops where trip_id = p_trip;
  select * into va from public.lg_verified_addresses where phone_key = public.lg_phone_key(o.buyer_phone);
  insert into public.lg_trip_stops (trip_id, seq, kind, order_id, contact_name, contact_phone, address, landmark,
                                    lat, lng, cod_due_fcfa)
  values (p_trip, v_seq, 'delivery', p_order, o.buyer_name, o.buyer_phone,
          concat_ws(', ', o.delivery_zone, nullif(o.buyer_address, '')), coalesce(o.landmark, va.landmark),
          coalesce(o.delivery_lat, va.lat), coalesce(o.delivery_lng, va.lng),
          public.lg_order_due_fcfa(p_order))
  returning id into v_stop;
  return v_stop;
end; $$;

-- Affecter une commande (tous ses colis à quai) à un voyage
create or replace function public.lg_trip_add_order(p_trip uuid, p_order uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t      public.lg_trips;
  o      public.orders;
  v_stop uuid;
  n      int;
  v_missing int;
begin
  if not public.lg_has_role(array['dock_chief', 'dispatcher']) then raise exception 'forbidden'; end if;
  select * into t from public.lg_trips where id = p_trip for update;
  if not found or t.status not in ('planned', 'loading') then raise exception 'trip_not_open'; end if;
  select * into o from public.orders where id = p_order;
  if not found or o.status = 'cancelled' or o.has_dispute then raise exception 'order_blocked'; end if;
  if coalesce(array_length(t.zones, 1), 0) > 0 and not (o.delivery_zone = any (t.zones)) then
    raise exception 'wrong_zone';
  end if;
  if exists (select 1 from public.lg_packages p join public.lg_trip_packages tp on tp.package_id = p.id
              where p.order_id = p_order and tp.outcome is null and tp.trip_id <> p_trip) then
    raise exception 'order_in_other_trip';
  end if;
  v_stop := public.lg_trip_ensure_stop(p_trip, p_order);
  insert into public.lg_trip_packages (trip_id, package_id, stop_id)
  select p_trip, p.id, v_stop from public.lg_packages p
   where p.order_id = p_order and p.status = 'staged'
     and not exists (select 1 from public.lg_trip_packages tp where tp.package_id = p.id and tp.outcome is null)
  on conflict (trip_id, package_id) do update set stop_id = excluded.stop_id, outcome = null, loaded_at = null;
  get diagnostics n = row_count;
  select count(*) into v_missing from public.lg_packages where order_id = p_order and status in ('created', 'packed');
  perform public.lg_trip_refresh(p_trip);
  return jsonb_build_object('ok', true, 'stop_id', v_stop, 'packages', n, 'not_staged', v_missing);
end; $$;

create or replace function public.lg_trip_remove_stop(p_trip uuid, p_stop uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.lg_trips;
begin
  if not public.lg_has_role(array['dock_chief', 'dispatcher']) then raise exception 'forbidden'; end if;
  select * into t from public.lg_trips where id = p_trip for update;
  if t.status not in ('planned', 'loading') then raise exception 'trip_not_open'; end if;
  update public.lg_packages p set status = 'staged', holder_type = 'hub', holder_id = coalesce(t.hub_id, p.hub_id), updated_at = now()
    from public.lg_trip_packages tp
   where tp.package_id = p.id and tp.trip_id = p_trip and tp.stop_id = p_stop and tp.outcome is null and p.status = 'loaded';
  update public.lg_trip_packages set outcome = 'removed' where trip_id = p_trip and stop_id = p_stop and outcome is null;
  update public.lg_trip_stops set status = 'skipped' where id = p_stop and trip_id = p_trip;
  perform public.lg_trip_refresh(p_trip);
  return jsonb_build_object('ok', true);
end; $$;

-- 4. ORDRE DES ARRÊTS, PLAN DE CHARGEMENT, HEURES ESTIMÉES ----------------------------------
-- Plan (chapitre 10) : dernier livré chargé en premier (fond), lourd en bas, fragile en haut.
create or replace function public.lg_trip_load_plan(p_trip uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_kind text; v_n int;
begin
  select v.kind into v_kind from public.lg_trips t join public.lg_vehicles v on v.id = t.vehicle_id where t.id = p_trip;
  select count(*) into v_n from public.lg_trip_stops where trip_id = p_trip and status <> 'skipped';
  with ranked as (
    select tp.package_id, s.seq,
           dense_rank() over (order by s.seq) as stop_rank,
           row_number() over (order by s.seq desc,
                                       ('fragile' = any (p.handling)) asc,
                                       coalesce(p.weight_g, 0) desc) as load_seq
      from public.lg_trip_packages tp
      join public.lg_trip_stops s on s.id = tp.stop_id
      join public.lg_packages p on p.id = tp.package_id
     where tp.trip_id = p_trip and tp.outcome is null)
  update public.lg_trip_packages tp set
    load_seq = r.load_seq,
    load_zone = case when v_kind in ('moto', 'vélo') then 'caisson'
                     when r.stop_rank > ceil(v_n * 2.0 / 3) then 'fond'
                     when r.stop_rank > ceil(v_n / 3.0) then 'milieu'
                     else 'porte' end
  from ranked r where tp.trip_id = p_trip and tp.package_id = r.package_id;
end; $$;

-- Heure estimée : départ + trajets (vol d'oiseau × coefficient de détour à vitesse moyenne)
-- + temps moyen sur place par arrêt. Appris par quartier en phase 3.
create or replace function public.lg_trip_compute_eta(p_trip uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  t       public.lg_trips;
  s       record;
  v_lat   double precision;
  v_lng   double precision;
  v_clock timestamptz;
  v_speed numeric := 18;   -- km/h moyens en ville
  v_stop_min int := 8;
  v_km    numeric := 0;
  d       numeric;
begin
  select * into t from public.lg_trips where id = p_trip;
  select lat, lng into v_lat, v_lng from public.lg_hubs where id = t.hub_id;
  if t.status = 'in_progress' then
    select current_lat, current_lng into v_lat, v_lng from public.profiles
     where id = public.lg_trip_courier_user(p_trip) and current_lat is not null;
  end if;
  v_clock := greatest(coalesce(t.started_at, t.planned_departure, now()), now());
  for s in select * from public.lg_trip_stops where trip_id = p_trip and status in ('pending', 'en_route', 'arrived') order by seq loop
    d := coalesce(public.lg_distance_m(v_lat, v_lng, s.lat, s.lng), 3000) / 1000.0 * (public.lg_cfg('detour_coef'))::text::numeric;
    v_km := v_km + d;
    v_clock := v_clock + make_interval(secs => (d / v_speed * 3600)::int);
    update public.lg_trip_stops set eta = v_clock where id = s.id;
    v_clock := v_clock + make_interval(mins => v_stop_min);
    if s.lat is not null then v_lat := s.lat; v_lng := s.lng; end if;
  end loop;
  if t.status in ('planned', 'loading', 'sealed') then
    update public.lg_trips set distance_km = round(v_km, 1) where id = p_trip;
  end if;
end; $$;

-- Ordre décidé par l'app (plus proche voisin + 2-opt, src/lib/algo) ou à la main
create or replace function public.lg_trip_reorder(p_trip uuid, p_stop_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.lg_trips; i int;
begin
  select * into t from public.lg_trips where id = p_trip for update;
  if not found then raise exception 'unknown_trip'; end if;
  if not (public.lg_has_role(array['dock_chief', 'dispatcher'])
          or coalesce(public.lg_trip_courier_user(p_trip) = auth.uid() and t.status = 'in_progress', false)) then
    raise exception 'forbidden';
  end if;
  if t.status not in ('planned', 'loading', 'sealed', 'in_progress') then raise exception 'trip_closed'; end if;
  if (select count(*) from public.lg_trip_stops where trip_id = p_trip and id = any (p_stop_ids)) <> cardinality(p_stop_ids) then
    raise exception 'unknown_stop';
  end if;
  -- arrêts déjà faits gardent leur rang en tête ; les autres suivent l'ordre demandé
  for i in 1 .. cardinality(p_stop_ids) loop
    update public.lg_trip_stops set seq = 1000 + i where id = p_stop_ids[i] and trip_id = p_trip;
  end loop;
  with o as (select id, row_number() over (order by case when status in ('delivered', 'failed') then 0 else 1 end,
                                                    case when status in ('delivered', 'failed') then completed_at end, seq) rn
               from public.lg_trip_stops where trip_id = p_trip)
  update public.lg_trip_stops s set seq = o.rn from o where o.id = s.id;
  perform public.lg_trip_load_plan(p_trip);
  perform public.lg_trip_compute_eta(p_trip);
  return jsonb_build_object('ok', true);
end; $$;

-- 5. CHARGEMENT (remplace la fonction modèle de l'annexe A, même signature) -----------------
create or replace function public.lg_load_package(
  p_trip uuid, p_code text, p_event uuid, p_device_at timestamptz)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_trip  public.lg_trips;
  v_pkg   public.lg_packages;
  v_veh   public.lg_vehicles;
  v_tp    public.lg_trip_packages;
  v_stop  uuid;
  res     jsonb;
  warn    text[] := '{}';
  o       public.orders;
begin
  if not public.lg_has_role(array['dock_chief', 'dispatcher']) then raise exception 'forbidden'; end if;
  res := public.lg_idem_get(p_event); if res is not null then return res; end if;
  -- compatibilité avec l'annexe A : un scan déjà journalisé ne fait rien
  if exists (select 1 from public.lg_scan_events where client_event_id = p_event) then
    return jsonb_build_object('ok', true, 'replayed', true);
  end if;

  select * into v_trip from public.lg_trips where id = p_trip for update;
  if not found or v_trip.status not in ('planned', 'loading') then raise exception 'trip_not_loading'; end if;

  select * into v_pkg from public.lg_packages where code = public.lg_norm_code(p_code) for update;
  if not found then return public.lg_idem_put(p_event, 'load', jsonb_build_object('ok', false, 'error', 'unknown_package')); end if;

  select * into v_tp from public.lg_trip_packages where package_id = v_pkg.id and outcome is null;
  if v_tp.trip_id is not null and v_tp.trip_id <> p_trip then
    return public.lg_idem_put(p_event, 'load', jsonb_build_object('ok', false, 'error', 'in_other_trip'));
  end if;
  if v_tp.loaded_at is not null then
    return public.lg_idem_put(p_event, 'load', jsonb_build_object('ok', false, 'error', 'already_loaded', 'code', v_pkg.code));
  end if;
  if v_pkg.status <> 'staged' then
    return public.lg_idem_put(p_event, 'load', jsonb_build_object('ok', false, 'error', 'package_not_staged', 'status', v_pkg.status));
  end if;
  select * into o from public.orders where id = v_pkg.order_id;
  if o.status = 'cancelled' or coalesce(o.has_dispute, false) then
    return public.lg_idem_put(p_event, 'load', jsonb_build_object('ok', false, 'error', 'order_blocked'));
  end if;
  if coalesce(array_length(v_trip.zones, 1), 0) > 0 and not (v_pkg.zone = any (v_trip.zones)) then
    return public.lg_idem_put(p_event, 'load', jsonb_build_object('ok', false, 'error', 'wrong_zone', 'zone', v_pkg.zone));
  end if;

  select * into v_veh from public.lg_vehicles where id = v_trip.vehicle_id;
  if v_trip.load_weight_g + coalesce(v_pkg.weight_g, 0) > v_veh.capacity_kg * 1000 then
    return public.lg_idem_put(p_event, 'load', jsonb_build_object('ok', false, 'error', 'overweight'));
  end if;
  if v_veh.max_packages is not null and v_trip.load_count + 1 > v_veh.max_packages then
    return public.lg_idem_put(p_event, 'load', jsonb_build_object('ok', false, 'error', 'too_many_packages'));
  end if;
  if v_veh.capacity_l > 0 and v_trip.load_volume_l + coalesce(v_pkg.volume_l, 0) > v_veh.capacity_l then
    warn := array_append(warn, 'volume_full');
  end if;
  -- incompatibilités (annexe C)
  if 'froid' = any (v_pkg.handling) and not ('glacière' = any (v_veh.equipment)) then
    return public.lg_idem_put(p_event, 'load', jsonb_build_object('ok', false, 'error', 'needs_cooler'));
  end if;
  if exists (select 1 from public.lg_trip_packages tp join public.lg_packages p on p.id = tp.package_id
              where tp.trip_id = p_trip and tp.outcome is null and tp.loaded_at is not null
                and (('vivant' = any (p.handling)) <> ('vivant' = any (v_pkg.handling)))) then
    return public.lg_idem_put(p_event, 'load', jsonb_build_object('ok', false, 'error', 'incompatible_live'));
  end if;
  if ('alimentaire' = any (v_pkg.handling) and exists (select 1 from public.lg_trip_packages tp join public.lg_packages p on p.id = tp.package_id
         where tp.trip_id = p_trip and tp.outcome is null and 'chimique' = any (p.handling)))
     or ('chimique' = any (v_pkg.handling) and exists (select 1 from public.lg_trip_packages tp join public.lg_packages p on p.id = tp.package_id
         where tp.trip_id = p_trip and tp.outcome is null and 'alimentaire' = any (p.handling))) then
    warn := array_append(warn, 'separate_food_chemical');
  end if;
  if 'liquide' = any (v_pkg.handling) then warn := array_append(warn, 'liquid_upright_bottom'); end if;

  v_stop := public.lg_trip_ensure_stop(p_trip, v_pkg.order_id);
  insert into public.lg_trip_packages (trip_id, package_id, stop_id, loaded_at, loaded_by)
  values (p_trip, v_pkg.id, v_stop, now(), auth.uid())
  on conflict (trip_id, package_id) do update set loaded_at = now(), loaded_by = auth.uid(), outcome = null,
                                                  stop_id = coalesce(lg_trip_packages.stop_id, excluded.stop_id);

  update public.lg_packages
     set status = 'loaded', holder_type = 'driver', holder_id = v_trip.courier_id, updated_at = now()
   where id = v_pkg.id;
  update public.lg_trips set status = 'loading' where id = p_trip and status = 'planned';

  insert into public.lg_scan_events (client_event_id, package_id, event, actor_id, trip_id, hub_id, device_at)
  values (p_event, v_pkg.id, 'load', auth.uid(), p_trip, v_trip.hub_id, coalesce(p_device_at, now()));

  perform public.lg_trip_refresh(p_trip);
  perform public.lg_trip_load_plan(p_trip);
  res := public.lg_trip_gauge_of(p_trip);
  if (res ->> 'fill_pct')::int >= 90 then warn := array_append(warn, 'fill_90'); end if;

  return public.lg_idem_put(p_event, 'load', res || jsonb_build_object(
    'ok', true, 'code', v_pkg.code, 'weight_g', v_pkg.weight_g, 'handling', v_pkg.handling, 'warnings', to_jsonb(warn),
    'stop_seq', (select seq from public.lg_trip_stops where id = v_stop),
    'load_zone', (select load_zone from public.lg_trip_packages where trip_id = p_trip and package_id = v_pkg.id)));
end; $$;

create or replace function public.lg_unload_package(p_trip uuid, p_code text, p_event uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_trip public.lg_trips; v_pkg public.lg_packages; res jsonb;
begin
  if not public.lg_has_role(array['dock_chief', 'dispatcher']) then raise exception 'forbidden'; end if;
  res := public.lg_idem_get(p_event); if res is not null then return res; end if;
  select * into v_trip from public.lg_trips where id = p_trip for update;
  if v_trip.status not in ('planned', 'loading') then raise exception 'trip_not_loading'; end if;
  select * into v_pkg from public.lg_packages where code = public.lg_norm_code(p_code) for update;
  if not exists (select 1 from public.lg_trip_packages where trip_id = p_trip and package_id = v_pkg.id and outcome is null) then
    return public.lg_idem_put(p_event, 'unload', jsonb_build_object('ok', false, 'error', 'not_in_trip'));
  end if;
  update public.lg_trip_packages set outcome = 'removed' where trip_id = p_trip and package_id = v_pkg.id and outcome is null;
  if v_pkg.status = 'loaded' then
    update public.lg_packages set status = 'staged', holder_type = 'hub', holder_id = coalesce(v_trip.hub_id, hub_id), updated_at = now()
     where id = v_pkg.id;
    insert into public.lg_scan_events (client_event_id, package_id, event, actor_id, trip_id, hub_id, device_at, meta)
    values (coalesce(p_event, gen_random_uuid()), v_pkg.id, 'unload', auth.uid(), p_trip, v_trip.hub_id, now(),
            jsonb_build_object('reason', p_reason));
  end if;
  perform public.lg_audit('package_removed_from_trip', 'package', v_pkg.code, jsonb_build_object('trip', p_trip, 'reason', p_reason));
  perform public.lg_trip_refresh(p_trip);
  return public.lg_idem_put(p_event, 'unload', public.lg_trip_gauge_of(p_trip) || jsonb_build_object('ok', true));
end; $$;

-- Écran de chargement : jauge, colis prévus et chargés par arrêt
create or replace function public.lg_trip_loading_view(p_trip uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.lg_has_role(array['dock_chief', 'dispatcher', 'support', 'cashier'])
          or coalesce(public.lg_trip_courier_user(p_trip) = auth.uid(), false)) then raise exception 'forbidden'; end if;
  return (select jsonb_build_object(
    'trip', jsonb_build_object('id', t.id, 'number', t.number, 'label', t.label, 'status', t.status, 'kind', t.kind,
                               'zones', t.zones, 'planned_departure', t.planned_departure, 'cod_expected_fcfa', t.cod_expected_fcfa,
                               'distance_km', t.distance_km, 'signed', t.courier_signature_path is not null),
    'vehicle', jsonb_build_object('id', v.id, 'plate', v.plate, 'kind', v.kind, 'label', v.label, 'equipment', v.equipment),
    'courier', (select jsonb_build_object('id', c.id, 'name', c.name, 'phone', c.phone) from public.couriers c where c.id = t.courier_id),
    'gauge', public.lg_trip_gauge_of(t.id),
    'stops', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id, 'seq', s.seq, 'status', s.status, 'zone', o.delivery_zone, 'contact_name', s.contact_name,
        'order_short', upper(left(s.order_id::text, 4)), 'cod_due_fcfa', s.cod_due_fcfa, 'eta', s.eta,
        'lat', s.lat, 'lng', s.lng, 'landmark', s.landmark,
        'packages', (select coalesce(jsonb_agg(jsonb_build_object('code', p.code, 'weight_g', p.weight_g, 'handling', p.handling,
                       'status', p.status, 'loaded', tp.loaded_at is not null, 'load_zone', tp.load_zone, 'load_seq', tp.load_seq,
                       'outcome', tp.outcome) order by tp.load_seq), '[]')
                       from public.lg_trip_packages tp join public.lg_packages p on p.id = tp.package_id
                      where tp.trip_id = t.id and tp.stop_id = s.id and coalesce(tp.outcome, '') <> 'removed')
      ) order by s.seq), '[]')
      from public.lg_trip_stops s left join public.orders o on o.id = s.order_id
      where s.trip_id = t.id and s.status <> 'skipped'))
  from public.lg_trips t join public.lg_vehicles v on v.id = t.vehicle_id where t.id = p_trip);
end; $$;

-- 6. VALIDATION DU DÉPART (bordereau signé) --------------------------------------------------
create or replace function public.lg_trip_seal(p_trip uuid, p_signature_path text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.lg_trips; v_missing jsonb;
begin
  if not public.lg_has_role(array['dock_chief', 'dispatcher']) then raise exception 'forbidden'; end if;
  select * into t from public.lg_trips where id = p_trip for update;
  if t.status not in ('planned', 'loading') then raise exception 'trip_not_loading'; end if;
  if t.courier_id is null then raise exception 'no_courier'; end if;
  select coalesce(jsonb_agg(p.code), '[]') into v_missing
    from public.lg_trip_packages tp join public.lg_packages p on p.id = tp.package_id
    join public.lg_trip_stops st on st.id = tp.stop_id
   where tp.trip_id = p_trip and tp.outcome is null and tp.loaded_at is null and st.kind = 'delivery'
     and tp.transfer_from is null;   -- un colis transféré est pris en charge sur la route (double scan)
  if jsonb_array_length(v_missing) > 0 then
    return jsonb_build_object('ok', false, 'error', 'unloaded_packages', 'codes', v_missing);
  end if;
  if not exists (select 1 from public.lg_trip_packages where trip_id = p_trip and outcome is null) then
    raise exception 'empty_trip';
  end if;
  -- les arrêts sans colis chargé sont retirés
  update public.lg_trip_stops s set status = 'skipped'
   where s.trip_id = p_trip and s.kind = 'delivery' and s.status = 'pending'
     and not exists (select 1 from public.lg_trip_packages tp where tp.stop_id = s.id and tp.outcome is null);
  perform public.lg_trip_refresh(p_trip);
  perform public.lg_trip_compute_eta(p_trip);
  update public.lg_trips set status = 'sealed', sealed_by = auth.uid(), sealed_at = now(),
         courier_signature_path = coalesce(p_signature_path, courier_signature_path), updated_at = now()
   where id = p_trip;
  update public.lg_vehicles set status = 'on_trip', updated_at = now() where id = t.vehicle_id;
  perform public.lg_audit('trip_seal', 'trip', p_trip::text, '{}');
  return jsonb_build_object('ok', true) || public.lg_trip_loading_view(p_trip);
end; $$;

-- 7. APPLICATION CHAUFFEUR -------------------------------------------------------------------
create or replace function public.lg_trip_start(p_trip uuid, p_event uuid, p_signature_path text default null,
  p_lat double precision default null, p_lng double precision default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t      public.lg_trips;
  s      record;
  v_code text;
  res    jsonb;
  v_name text;
begin
  res := public.lg_idem_get(p_event); if res is not null then return res; end if;
  t := public.lg_assert_driver(p_trip);
  if t.status <> 'sealed' then raise exception 'trip_not_sealed:%', t.status; end if;
  if coalesce(p_signature_path, t.courier_signature_path) is null then raise exception 'signature_required'; end if;
  update public.lg_trips set status = 'in_progress', started_at = now(),
         courier_signature_path = coalesce(p_signature_path, courier_signature_path), updated_at = now()
   where id = p_trip;
  update public.lg_packages p set status = 'out_for_delivery', updated_at = now()
    from public.lg_trip_packages tp where tp.package_id = p.id and tp.trip_id = p_trip and tp.outcome is null
     and tp.loaded_at is not null and p.direction = 'outbound' and p.status = 'loaded';
  if p_lat is not null then
    update public.profiles set current_lat = p_lat, current_lng = p_lng, location_updated_at = now() where id = auth.uid();
  end if;
  select name into v_name from public.couriers where id = t.courier_id;
  perform public.lg_trip_compute_eta(p_trip);
  for s in select * from public.lg_trip_stops where trip_id = p_trip and kind = 'delivery' and status = 'pending' order by seq loop
    update public.orders set status = 'in_transit', in_transit_at = coalesce(in_transit_at, now()), updated_at = now()
     where id = s.order_id and status in ('pending', 'pending_payment', 'processing');
    if exists (select 1 from public.orders where id = s.order_id and recipient_phone is not null) then
      perform public.lg_send_third_party_code(s.order_id);
      continue;
    end if;
    v_code := public.lg_issue_delivery_code(s.order_id);
    perform public.lg_notify('lg_out_for_delivery', s.order_id, jsonb_build_object(
      'livreur', split_part(v_name, ' ', 1), 'code', v_code, 'heure', to_char(s.eta at time zone 'Africa/Dakar', 'HH24"h"MI')));
  end loop;
  update public.lg_trip_stops set status = 'en_route'
   where id = (select id from public.lg_trip_stops where trip_id = p_trip and status = 'pending' order by seq limit 1);
  return public.lg_idem_put(p_event, 'trip_start', jsonb_build_object('ok', true));
end; $$;

-- Ma journée : voyages non clôturés du chauffeur connecté, arrêts dans l'ordre
create or replace function public.lg_my_day() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_courier uuid := public.lg_my_courier_id();
begin
  if v_courier is null then raise exception 'not_a_courier'; end if;
  return jsonb_build_object(
    'courier', (select jsonb_build_object('id', c.id, 'name', c.name, 'rating', c.rating_avg, 'deliveries_done', c.deliveries_done,
                       'cash_limit_fcfa', coalesce(c.cash_limit_fcfa, (public.lg_cfg('cash_limit_fcfa'))::text::int))
                  from public.couriers c where c.id = v_courier),
    'cash_in_hand_fcfa', public.lg_courier_cash(v_courier),
    'earnings_pending_fcfa', (select coalesce(sum(amount), 0) from public.courier_earnings where courier_id = v_courier and status = 'pending'),
    'week', (select to_jsonb(x) || jsonb_build_object('of', (select count(*) from public.couriers where status = 'active'))
               from public.lg_driver_scores(7) x where x.courier_id = v_courier),
    'trips', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', t.id, 'number', t.number, 'label', t.label, 'status', t.status, 'kind', t.kind,
        'planned_departure', t.planned_departure, 'cod_expected_fcfa', t.cod_expected_fcfa, 'signed', t.courier_signature_path is not null,
        'vehicle', (select jsonb_build_object('plate', v.plate, 'kind', v.kind) from public.lg_vehicles v where v.id = t.vehicle_id),
        'stops', (select coalesce(jsonb_agg(jsonb_build_object(
            'id', s.id, 'seq', s.seq, 'kind', s.kind, 'status', s.status, 'order_id', s.order_id,
            'order_short', upper(left(s.order_id::text, 4)), 'contact_name', s.contact_name,
            -- le téléphone n'est montré que pendant la tournée (chapitre 11)
            'contact_phone', case when t.status in ('sealed', 'in_progress') then s.contact_phone end,
            'address', s.address, 'landmark', s.landmark, 'lat', s.lat, 'lng', s.lng, 'eta', s.eta,
            'cod_due_fcfa', s.cod_due_fcfa, 'failure_reason', s.failure_reason, 'called', s.call_attempted_at is not null,
            'packages', (select coalesce(jsonb_agg(jsonb_build_object('code', p.code, 'seq', p.seq_in_order, 'count', p.count_in_order,
                            'handling', p.handling, 'weight_g', p.weight_g, 'status', p.status, 'load_zone', tp.load_zone,
                            'to_take', tp.loaded_at is null and tp.transfer_from is not null, 'direction', p.direction)), '[]')
                           from public.lg_trip_packages tp join public.lg_packages p on p.id = tp.package_id
                          where tp.stop_id = s.id and coalesce(tp.outcome, '') <> 'removed')
          ) order by s.seq), '[]') from public.lg_trip_stops s where s.trip_id = t.id and s.status <> 'skipped')
      ) order by t.planned_departure), '[]')
      from public.lg_trips t
      where t.courier_id = v_courier and t.status in ('planned', 'loading', 'sealed', 'in_progress', 'completed')));
end; $$;

-- « Appeler » : trace la tentative d'appel exigée avant « client absent »
create or replace function public.lg_stop_call(p_stop uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.lg_trip_stops;
begin
  select * into s from public.lg_trip_stops where id = p_stop;
  if not found then raise exception 'unknown_stop'; end if;
  perform public.lg_assert_driver(s.trip_id);
  update public.lg_trip_stops set call_attempted_at = now() where id = p_stop;
  return jsonb_build_object('ok', true, 'phone', s.contact_phone);
end; $$;

create or replace function public.lg_stop_arrive(p_stop uuid, p_event uuid, p_lat double precision default null,
                                                 p_lng double precision default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.lg_trip_stops; res jsonb;
begin
  res := public.lg_idem_get(p_event); if res is not null then return res; end if;
  select * into s from public.lg_trip_stops where id = p_stop for update;
  if not found then raise exception 'unknown_stop'; end if;
  perform public.lg_assert_driver(s.trip_id);
  if s.status in ('pending', 'en_route') then
    update public.lg_trip_stops set status = 'arrived', arrived_at = now() where id = p_stop;
  end if;
  if p_lat is not null then
    update public.profiles set current_lat = p_lat, current_lng = p_lng, location_updated_at = now() where id = auth.uid();
  end if;
  return public.lg_idem_put(p_event, 'arrive', jsonb_build_object('ok', true));
end; $$;

-- Passe à l'arrêt suivant et prévient le client « à l'approche »
create or replace function public.lg_advance_trip(p_trip uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare s public.lg_trip_stops; v_name text;
begin
  if exists (select 1 from public.lg_trip_stops where trip_id = p_trip and status in ('en_route', 'arrived')) then return null; end if;
  select * into s from public.lg_trip_stops where trip_id = p_trip and status = 'pending' order by seq limit 1;
  if not found then return null; end if;
  perform public.lg_trip_compute_eta(p_trip);
  update public.lg_trip_stops set status = 'en_route' where id = s.id returning * into s;
  select c.name into v_name from public.lg_trips t join public.couriers c on c.id = t.courier_id where t.id = p_trip;
  if s.order_id is not null then
    perform public.lg_notify('lg_approaching', s.order_id, jsonb_build_object(
      'livreur', split_part(v_name, ' ', 1),
      'minutes', greatest(5, round(extract(epoch from (s.eta - now())) / 60)),
      'montant', s.cod_due_fcfa));
  end if;
  return s.id;
end; $$;

-- LIVRÉ : colis scannés, preuve (code client OU signature + nom), photo, encaissement exact.
-- Un code faux décrémente les essais SANS annuler l'opération (pas d'exception).
create or replace function public.lg_deliver(
  p_stop uuid, p_event uuid, p_codes text[], p_payments jsonb default '[]',
  p_otp text default null, p_recipient_name text default null, p_signature_path text default null,
  p_photo_path text default null, p_lat double precision default null, p_lng double precision default null,
  p_device_at timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  s        public.lg_trip_stops;
  t        public.lg_trips;
  dc       public.lg_delivery_codes;
  o        public.orders;
  res      jsonb;
  v_expected text[];
  v_given  text[];
  v_paid   int := 0;
  v_cash   int := 0;
  pay      jsonb;
  v_dist   int;
  v_far    boolean := false;
  v_limit  int;
  v_inhand int;
  v_inv    jsonb;
  v_next   uuid;
  v_proof_kind text;
begin
  res := public.lg_idem_get(p_event); if res is not null then return res; end if;
  select * into s from public.lg_trip_stops where id = p_stop for update;
  if not found then raise exception 'unknown_stop'; end if;
  t := public.lg_assert_driver(s.trip_id);
  if t.status <> 'in_progress' then raise exception 'trip_not_in_progress'; end if;
  if s.status not in ('pending', 'en_route', 'arrived') then
    return jsonb_build_object('ok', false, 'error', 'stop_closed', 'status', s.status);
  end if;
  if s.kind <> 'delivery' then return jsonb_build_object('ok', false, 'error', 'not_a_delivery_stop'); end if;
  if exists (select 1 from public.lg_trip_packages where stop_id = p_stop and outcome is null and loaded_at is null) then
    return jsonb_build_object('ok', false, 'error', 'transfer_pending');
  end if;

  -- 1. colis : ceux de l'arrêt, tous, et rien d'autre
  select coalesce(array_agg(p.code order by p.code), '{}') into v_expected
    from public.lg_trip_packages tp join public.lg_packages p on p.id = tp.package_id
   where tp.stop_id = p_stop and tp.outcome is null;
  select coalesce(array_agg(distinct public.lg_norm_code(c) order by public.lg_norm_code(c)), '{}') into v_given from unnest(p_codes) c;
  if v_given <> v_expected then
    return jsonb_build_object('ok', false, 'error', 'package_mismatch', 'expected', to_jsonb(v_expected), 'given', to_jsonb(v_given));
  end if;

  -- 2. preuve
  if p_otp is not null and p_otp <> '' then
    select * into dc from public.lg_delivery_codes where order_id = s.order_id for update;
    if not found or dc.expires_at < now() then
      return jsonb_build_object('ok', false, 'error', 'code_expired');
    end if;
    if dc.attempts_left <= 0 then
      return jsonb_build_object('ok', false, 'error', 'code_locked');
    end if;
    if dc.code_hash <> crypt(p_otp, dc.code_hash) then
      update public.lg_delivery_codes set attempts_left = attempts_left - 1 where order_id = s.order_id;
      return jsonb_build_object('ok', false, 'error', 'bad_code', 'attempts_left', dc.attempts_left - 1);
    end if;
    update public.lg_delivery_codes set verified_at = now() where order_id = s.order_id;
    v_proof_kind := 'otp';
  elsif p_signature_path is not null and nullif(trim(p_recipient_name), '') is not null then
    v_proof_kind := 'signature';
  else
    return jsonb_build_object('ok', false, 'error', 'proof_required');
  end if;
  if (public.lg_cfg('require_photo'))::text::boolean and p_photo_path is null then
    return jsonb_build_object('ok', false, 'error', 'photo_required');
  end if;

  -- 3. encaissement : le montant affiché, ni plus ni moins
  for pay in select * from jsonb_array_elements(coalesce(p_payments, '[]')) loop
    if pay ->> 'method' not in ('cash', 'wave', 'orange_money') or coalesce((pay ->> 'amount')::int, -1) < 0 then
      return jsonb_build_object('ok', false, 'error', 'invalid_payment');
    end if;
    v_paid := v_paid + (pay ->> 'amount')::int;
  end loop;
  if v_paid <> s.cod_due_fcfa then
    return jsonb_build_object('ok', false, 'error', 'amount_mismatch', 'due', s.cod_due_fcfa, 'given', v_paid);
  end if;

  -- 4. écritures
  insert into public.lg_proofs (stop_id, kind, file_path, recipient_name, lat, lng, distance_m, created_by)
  values (p_stop, v_proof_kind, case when v_proof_kind = 'signature' then p_signature_path end, p_recipient_name,
          p_lat, p_lng, public.lg_distance_m(s.lat, s.lng, p_lat, p_lng), auth.uid());
  if p_photo_path is not null then
    insert into public.lg_proofs (stop_id, kind, file_path, lat, lng, distance_m, created_by)
    values (p_stop, 'photo', p_photo_path, p_lat, p_lng, public.lg_distance_m(s.lat, s.lng, p_lat, p_lng), auth.uid());
  end if;
  for pay in select * from jsonb_array_elements(coalesce(p_payments, '[]')) loop
    if (pay ->> 'amount')::int > 0 then
      insert into public.lg_cod_collections (stop_id, order_id, courier_id, amount_due_fcfa, amount_collected_fcfa, method, payment_ref)
      values (p_stop, s.order_id, t.courier_id, s.cod_due_fcfa, (pay ->> 'amount')::int, pay ->> 'method', pay ->> 'ref');
      if pay ->> 'method' = 'cash' then v_cash := v_cash + (pay ->> 'amount')::int; end if;
    end if;
  end loop;

  update public.lg_packages p set status = 'delivered', holder_type = 'customer', holder_id = null, updated_at = now()
    from public.lg_trip_packages tp where tp.package_id = p.id and tp.stop_id = p_stop and tp.outcome is null;
  insert into public.lg_scan_events (client_event_id, package_id, event, actor_id, trip_id, lat, lng, device_at, meta)
  select gen_random_uuid(), tp.package_id, 'deliver', auth.uid(), s.trip_id, p_lat, p_lng, coalesce(p_device_at, now()),
         jsonb_build_object('stop', p_stop, 'proof', v_proof_kind)
    from public.lg_trip_packages tp where tp.stop_id = p_stop and tp.outcome is null;
  update public.lg_trip_packages set outcome = 'delivered' where stop_id = p_stop and outcome is null;
  update public.lg_trip_stops set status = 'delivered', completed_at = now(), arrived_at = coalesce(arrived_at, now()) where id = p_stop;
  update public.lg_trips set cash_collected_fcfa = cash_collected_fcfa + v_cash, updated_at = now() where id = s.trip_id;
  update public.couriers set deliveries_done = deliveries_done + 1, updated_at = now() where id = t.courier_id;
  if p_lat is not null then
    update public.profiles set current_lat = p_lat, current_lng = p_lng, location_updated_at = now() where id = auth.uid();
  end if;

  -- position trop loin de l'adresse prévue : acceptée mais signalée
  v_dist := public.lg_distance_m(s.lat, s.lng, p_lat, p_lng);
  if v_dist is not null and v_dist > (public.lg_cfg('proof_radius_m'))::text::int then
    v_far := true;
    perform public.lg_raise_alert('far_delivery', 'warning',
      format('Arrêt %s du voyage %s validé à %s m de l''adresse', s.seq, t.number, v_dist), s.trip_id, p_stop, null, 'far:' || p_stop);
  end if;

  -- 5. commande : livrée quand tous ses colis le sont
  select * into o from public.orders where id = s.order_id for update;
  if not exists (select 1 from public.lg_packages where order_id = s.order_id and status not in ('delivered', 'cancelled')) then
    update public.orders set status = 'delivered', delivered_at = now(), delivery_confirmed_at = now(),
           delivery_confirmed_by = 'lg:' || t.courier_id, delivery_photo_url = coalesce(p_photo_path, delivery_photo_url),
           payment_status = case when payment_method = 'cod' then 'paid' else payment_status end,
           paid_at = case when payment_method = 'cod' then coalesce(paid_at, now()) else paid_at end,
           updated_at = now()
     where id = s.order_id;
    -- adresse vérifiée pour la prochaine fois
    if p_lat is not null and public.lg_phone_key(o.buyer_phone) is not null and not v_far then
      insert into public.lg_verified_addresses (phone_key, lat, lng, landmark, zone)
      values (public.lg_phone_key(o.buyer_phone), p_lat, p_lng, coalesce(s.landmark, o.landmark), o.delivery_zone)
      on conflict (phone_key) do update set lat = excluded.lat, lng = excluded.lng,
        landmark = coalesce(excluded.landmark, lg_verified_addresses.landmark), zone = excluded.zone,
        deliveries = lg_verified_addresses.deliveries + 1, updated_at = now();
    end if;
    v_inv := public.lg_issue_invoice(s.order_id);
  end if;
  perform public.lg_notify('lg_delivered', s.order_id, jsonb_build_object(
    'heure', to_char(now() at time zone 'Africa/Dakar', 'HH24"h"MI'), 'facture', v_inv ->> 'number'));

  -- 6. plafond d'espèces
  select coalesce(cash_limit_fcfa, (public.lg_cfg('cash_limit_fcfa'))::text::int) into v_limit from public.couriers where id = t.courier_id;
  v_inhand := public.lg_courier_cash(t.courier_id);
  if v_inhand > v_limit then
    perform public.lg_raise_alert('cash_limit', 'critical',
      format('Le chauffeur du voyage %s porte %s F (plafond %s F)', t.number, v_inhand, v_limit), s.trip_id, null, null,
      'cash_limit:' || s.trip_id);
  end if;

  v_next := public.lg_advance_trip(s.trip_id);
  return public.lg_idem_put(p_event, 'deliver', jsonb_build_object(
    'ok', true, 'far', v_far, 'distance_m', v_dist, 'cash_in_hand_fcfa', v_inhand, 'must_remit', v_inhand > v_limit,
    'invoice', v_inv ->> 'number', 'next_stop', v_next));
end; $$;

-- ÉCHEC : motif de la liste, photo, tentative d'appel exigée pour certains motifs
create or replace function public.lg_fail(p_stop uuid, p_event uuid, p_reason text, p_photo_path text default null,
  p_note text default null, p_lat double precision default null, p_lng double precision default null,
  p_device_at timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s   public.lg_trip_stops;
  t   public.lg_trips;
  r   public.lg_failure_reasons;
  res jsonb;
  v_next uuid;
  v_inc uuid;
begin
  res := public.lg_idem_get(p_event); if res is not null then return res; end if;
  select * into s from public.lg_trip_stops where id = p_stop for update;
  if not found then raise exception 'unknown_stop'; end if;
  t := public.lg_assert_driver(s.trip_id);
  if t.status <> 'in_progress' then raise exception 'trip_not_in_progress'; end if;
  if s.status not in ('pending', 'en_route', 'arrived') then
    return jsonb_build_object('ok', false, 'error', 'stop_closed');
  end if;
  select * into r from public.lg_failure_reasons where code = p_reason;
  if not found then return jsonb_build_object('ok', false, 'error', 'unknown_reason'); end if;
  if r.requires_call and s.call_attempted_at is null then
    return jsonb_build_object('ok', false, 'error', 'call_required');
  end if;
  if (public.lg_cfg('require_photo'))::text::boolean and p_photo_path is null then
    return jsonb_build_object('ok', false, 'error', 'photo_required');
  end if;

  if p_photo_path is not null then
    insert into public.lg_proofs (stop_id, kind, file_path, lat, lng, distance_m, created_by)
    values (p_stop, 'failure_photo', p_photo_path, p_lat, p_lng, public.lg_distance_m(s.lat, s.lng, p_lat, p_lng), auth.uid());
  end if;
  update public.lg_packages p set status = 'failed',
         attempts = attempts + case when r.counts_attempt then 1 else 0 end, updated_at = now()
    from public.lg_trip_packages tp where tp.package_id = p.id and tp.stop_id = p_stop and tp.outcome is null;
  insert into public.lg_scan_events (client_event_id, package_id, event, actor_id, trip_id, lat, lng, device_at, meta)
  select gen_random_uuid(), tp.package_id, 'fail', auth.uid(), s.trip_id, p_lat, p_lng, coalesce(p_device_at, now()),
         jsonb_build_object('reason', p_reason, 'note', p_note)
    from public.lg_trip_packages tp where tp.stop_id = p_stop and tp.outcome is null;
  update public.lg_trip_packages set outcome = 'failed' where stop_id = p_stop and outcome is null;
  update public.lg_trip_stops set status = 'failed', failure_reason = p_reason, completed_at = now(),
         arrived_at = coalesce(arrived_at, now()) where id = p_stop;

  perform public.lg_raise_alert('failure', 'warning',
    format('Échec arrêt %s, voyage %s : %s', s.seq, t.number, r.label), s.trip_id, p_stop, null, 'fail:' || p_stop);
  if r.opens_incident then
    insert into public.lg_incidents (kind, trip_id, stop_id, order_id, description, photos, reported_by, responsible_type, due_at)
    values (case p_reason when 'damaged' then 'damaged' when 'wrong_product' then 'wrong_product'
                          when 'refused' then 'refused' when 'breakdown' then 'vehicle_breakdown' else 'other' end,
            s.trip_id, p_stop, s.order_id, coalesce(p_note, r.label),
            case when p_photo_path is null then '{}' else array[p_photo_path] end, auth.uid(),
            case p_reason when 'wrong_product' then 'vendor' when 'refused' then 'customer' else 'unknown' end,
            now() + interval '48 hours')
    returning id into v_inc;
  end if;
  perform public.lg_notify('lg_failed', s.order_id, jsonb_build_object(
    'heure', to_char(now() at time zone 'Africa/Dakar', 'HH24"h"MI'), 'motif', lower(r.label)));

  v_next := public.lg_advance_trip(s.trip_id);
  return public.lg_idem_put(p_event, 'fail', jsonb_build_object('ok', true, 'incident_id', v_inc, 'next_stop', v_next));
end; $$;

-- FIN DE TOURNÉE : chaque colis a une issue
create or replace function public.lg_trip_finish(p_trip uuid, p_event uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.lg_trips; res jsonb;
begin
  res := public.lg_idem_get(p_event); if res is not null then return res; end if;
  t := public.lg_assert_driver(p_trip);
  if t.status <> 'in_progress' then raise exception 'trip_not_in_progress'; end if;
  if exists (select 1 from public.lg_trip_stops where trip_id = p_trip and status in ('pending', 'en_route', 'arrived')) then
    return jsonb_build_object('ok', false, 'error', 'stops_pending');
  end if;
  update public.lg_trips set status = 'completed', ended_at = now(), updated_at = now() where id = p_trip;
  return public.lg_idem_put(p_event, 'trip_finish', public.lg_trip_summary(p_trip) || jsonb_build_object('ok', true));
end; $$;

create or replace function public.lg_trip_summary(p_trip uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'number', t.number, 'status', t.status,
    'delivered', (select count(*) from public.lg_trip_stops where trip_id = t.id and status = 'delivered'),
    'failed',    (select count(*) from public.lg_trip_stops where trip_id = t.id and status = 'failed'),
    'packages_to_return', (select coalesce(jsonb_agg(p.code), '[]') from public.lg_trip_packages tp
                             join public.lg_packages p on p.id = tp.package_id
                            where tp.trip_id = t.id and tp.outcome = 'failed' and p.status = 'failed'),
    'cash_to_remit_fcfa', public.lg_trip_cash_outstanding(t.id),
    'cash_dropped_fcfa', (select coalesce(sum(amount_fcfa), 0) from public.lg_cash_drops where trip_id = t.id),
    'to_hub', (select coalesce(jsonb_agg(p.code), '[]') from public.lg_trip_packages tp join public.lg_packages p on p.id = tp.package_id
                where tp.trip_id = t.id and tp.outcome is null and tp.loaded_at is not null and p.holder_type = 'driver' and p.status = 'loaded'),
    'mobile_collected_fcfa', (select coalesce(sum(cc.amount_collected_fcfa), 0) from public.lg_cod_collections cc
                             join public.lg_trip_stops s on s.id = cc.stop_id where s.trip_id = t.id and cc.method <> 'cash'),
    'cod_expected_fcfa', t.cod_expected_fcfa,
    'remitted', exists (select 1 from public.lg_cash_remittances r where r.trip_id = t.id))
  from public.lg_trips t where t.id = p_trip
$$;

-- 8. RETOURS -------------------------------------------------------------------------------
-- Réception au quai, par une autre personne que le chauffeur qui détenait le colis
create or replace function public.lg_return_hub(p_code text, p_event uuid, p_hub uuid default null,
                                                p_device_at timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  p   public.lg_packages;
  tp  public.lg_trip_packages;
  res jsonb;
  v_hub uuid;
begin
  if not public.lg_has_role(array['dock_chief']) then raise exception 'forbidden'; end if;
  res := public.lg_idem_get(p_event); if res is not null then return res; end if;
  select * into p from public.lg_packages where code = public.lg_norm_code(p_code) for update;
  if not found then return public.lg_idem_put(p_event, 'return_hub', jsonb_build_object('ok', false, 'error', 'unknown_package')); end if;
  if p.status not in ('failed', 'loaded', 'out_for_delivery') then
    return public.lg_idem_put(p_event, 'return_hub', jsonb_build_object('ok', false, 'error', 'bad_status', 'status', p.status));
  end if;
  if p.holder_type = 'driver' and exists (select 1 from public.couriers where id = p.holder_id and user_id = auth.uid()) then
    return public.lg_idem_put(p_event, 'return_hub', jsonb_build_object('ok', false, 'error', 'same_person'));
  end if;
  select * into tp from public.lg_trip_packages where package_id = p.id order by loaded_at desc nulls last limit 1;
  v_hub := coalesce(p_hub, (select hub_id from public.lg_trips where id = tp.trip_id), p.hub_id);
  if p.status in ('loaded', 'out_for_delivery') then
    update public.lg_trip_packages set outcome = 'returned' where trip_id = tp.trip_id and package_id = p.id and outcome is null;
  end if;
  update public.lg_packages set status = 'returned_hub', holder_type = 'hub', holder_id = v_hub, hub_id = v_hub, updated_at = now()
   where id = p.id;
  insert into public.lg_scan_events (client_event_id, package_id, event, actor_id, trip_id, hub_id, device_at)
  values (coalesce(p_event, gen_random_uuid()), p.id, 'return_hub', auth.uid(), tp.trip_id, v_hub, coalesce(p_device_at, now()));
  if tp.trip_id is not null then perform public.lg_try_reconcile(tp.trip_id); end if;
  return public.lg_idem_put(p_event, 'return_hub', jsonb_build_object(
    'ok', true, 'code', p.code, 'attempts', p.attempts,
    'can_retry', p.attempts < (public.lg_cfg('max_attempts'))::text::int,
    'to_vendor', exists (select 1 from public.lg_trip_stops s join public.lg_failure_reasons r on r.code = s.failure_reason
                          where s.id = tp.stop_id and r.to_vendor)));
end; $$;

-- Retour au vendeur : stock rétabli, avoir émis, commande annulée si plus rien ne part
create or replace function public.lg_return_vendor(p_code text, p_event uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  p   public.lg_packages;
  res jsonb;
  v_credit jsonb;
  pi  record;
begin
  if not public.lg_has_role(array['dock_chief', 'support']) then raise exception 'forbidden'; end if;
  res := public.lg_idem_get(p_event); if res is not null then return res; end if;
  select * into p from public.lg_packages where code = public.lg_norm_code(p_code) for update;
  if not found then return public.lg_idem_put(p_event, 'return_vendor', jsonb_build_object('ok', false, 'error', 'unknown_package')); end if;
  if p.status <> 'returned_hub' then
    return public.lg_idem_put(p_event, 'return_vendor', jsonb_build_object('ok', false, 'error', 'bad_status', 'status', p.status));
  end if;
  update public.lg_packages set status = 'returned_vendor', holder_type = 'vendor',
         holder_id = (select vendor_id from public.orders where id = p.order_id), updated_at = now() where id = p.id;
  for pi in select pi2.order_item_id, pi2.quantity, oi.product_id from public.lg_package_items pi2
              join public.order_items oi on oi.id = pi2.order_item_id where pi2.package_id = p.id loop
    update public.order_items set line_status = 'cancelled' where id = pi.order_item_id;
    update public.products set stock = coalesce(stock, 0) + pi.quantity, updated_at = now() where id = pi.product_id;
  end loop;
  insert into public.lg_scan_events (client_event_id, package_id, event, actor_id, hub_id, device_at, meta)
  values (coalesce(p_event, gen_random_uuid()), p.id, 'return_vendor', auth.uid(), p.hub_id, now(), jsonb_build_object('reason', p_reason));
  v_credit := public.lg_credit_package(p.id, coalesce(p_reason, 'Retour au vendeur'));
  if not exists (select 1 from public.lg_packages where order_id = p.order_id
                  and status not in ('returned_vendor', 'cancelled', 'lost')) then
    update public.orders set status = 'cancelled', cancelled_at = now(), cancel_reason = coalesce(p_reason, 'Colis retourné au vendeur'),
           updated_at = now() where id = p.order_id and status <> 'delivered';
  end if;
  perform public.lg_audit('return_vendor', 'package', p.code, jsonb_build_object('reason', p_reason));
  return public.lg_idem_put(p_event, 'return_vendor', jsonb_build_object('ok', true, 'credit_note', v_credit ->> 'number'));
end; $$;

-- 9. CAISSE --------------------------------------------------------------------------------
create or replace function public.lg_try_reconcile(p_trip uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  t       public.lg_trips;
  v       public.lg_vehicles;
  rule    public.lg_pay_rules;
  v_deliv int;
  v_fail  int;
  v_amt   int;
begin
  select * into t from public.lg_trips where id = p_trip for update;
  if t.status <> 'completed' then return false; end if;
  if not exists (select 1 from public.lg_cash_remittances where trip_id = p_trip) then return false; end if;
  -- un écart de caisse laisse le voyage « non rapproché » jusqu'à décision (chapitre 04)
  if exists (select 1 from public.lg_incidents where trip_id = p_trip and kind = 'cash_gap' and status in ('open', 'investigating')) then
    return false;
  end if;
  -- colis en échec pas encore rendus au quai
  if exists (select 1 from public.lg_trip_packages tp join public.lg_packages p on p.id = tp.package_id
              where tp.trip_id = p_trip and tp.outcome = 'failed' and p.status = 'failed') then
    return false;
  end if;
  -- colis collectés (vendeur, retour client) pas encore reçus au hub
  if exists (select 1 from public.lg_trip_packages tp join public.lg_packages p on p.id = tp.package_id
              where tp.trip_id = p_trip and tp.outcome is null and tp.loaded_at is not null and p.holder_type = 'driver') then
    return false;
  end if;
  update public.lg_trips set status = 'reconciled', updated_at = now() where id = p_trip;
  update public.lg_vehicles set status = 'available', updated_at = now() where id = t.vehicle_id and status = 'on_trip';

  -- gains du chauffeur, calculés à la clôture rapprochée (chapitre 10)
  select * into v from public.lg_vehicles where id = t.vehicle_id;
  select * into rule from public.lg_pay_rules
   where active and (vehicle_kind = v.kind or vehicle_kind is null) and (ownership = v.ownership or ownership is null)
   order by (vehicle_kind is not null) desc, (ownership is not null) desc, created_at desc limit 1;
  select count(*) filter (where tp.outcome = 'delivered'), count(*) filter (where tp.outcome = 'failed')
    into v_deliv, v_fail from public.lg_trip_packages tp where tp.trip_id = p_trip;
  v_amt := coalesce(rule.fixed_per_trip, (public.lg_cfg('pay_fixed_trip'))::text::int)
         + v_deliv * coalesce(rule.per_package, (public.lg_cfg('pay_per_package'))::text::int);
  if t.courier_id is not null and v_amt > 0 then
    insert into public.courier_earnings (courier_id, amount, type, status)
    values (t.courier_id, v_amt, 'delivery', 'pending');
  end if;
  if t.courier_id is not null and v_fail = 0 and v_deliv > 0
     and coalesce(rule.bonus_zero_failure, (public.lg_cfg('bonus_zero_failure'))::text::int) > 0 then
    insert into public.courier_earnings (courier_id, amount, type, status)
    values (t.courier_id, coalesce(rule.bonus_zero_failure, (public.lg_cfg('bonus_zero_failure'))::text::int), 'bonus', 'pending');
    v_amt := v_amt + coalesce(rule.bonus_zero_failure, (public.lg_cfg('bonus_zero_failure'))::text::int);
  end if;
  -- prime de ponctualité : par livraison faite avant la fin du créneau (ou l'heure estimée + 30 min)
  if t.courier_id is not null and coalesce(rule.bonus_on_time, (public.lg_cfg('bonus_on_time'))::text::int, 0) > 0 then
    select count(*) into v_fail from public.lg_trip_stops s
     where s.trip_id = p_trip and s.status = 'delivered' and s.completed_at <= coalesce(s.window_end, s.eta + interval '30 minutes');
    if v_fail > 0 then
      insert into public.courier_earnings (courier_id, amount, type, status, payment_ref)
      values (t.courier_id, v_fail * coalesce(rule.bonus_on_time, (public.lg_cfg('bonus_on_time'))::text::int), 'bonus', 'pending', 'ponctualité');
      v_amt := v_amt + v_fail * coalesce(rule.bonus_on_time, (public.lg_cfg('bonus_on_time'))::text::int);
    end if;
  end if;
  update public.couriers set total_earned = total_earned + v_amt, updated_at = now() where id = t.courier_id;
  return true;
end; $$;

create or replace function public.lg_remit_cash(p_trip uuid, p_remitted_fcfa integer, p_note text default null,
                                                p_event uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t      public.lg_trips;
  v_exp  int;
  v_gap  int;
  res    jsonb;
  v_rec  boolean;
begin
  if not public.lg_has_role(array['cashier']) then raise exception 'forbidden'; end if;
  res := public.lg_idem_get(p_event); if res is not null then return res; end if;
  select * into t from public.lg_trips where id = p_trip for update;
  if not found then raise exception 'unknown_trip'; end if;
  if t.status <> 'completed' then raise exception 'trip_not_completed:%', t.status; end if;
  if public.lg_trip_courier_user(p_trip) = auth.uid() then raise exception 'same_person'; end if;
  if exists (select 1 from public.lg_cash_remittances where trip_id = p_trip) then raise exception 'already_remitted'; end if;
  if p_remitted_fcfa < 0 then raise exception 'invalid_amount'; end if;
  v_exp := public.lg_trip_cash_outstanding(p_trip);   -- versements intermédiaires déduits
  insert into public.lg_cash_remittances (trip_id, courier_id, expected_fcfa, remitted_fcfa, cashier_id, note)
  values (p_trip, t.courier_id, v_exp, p_remitted_fcfa, auth.uid(), p_note);
  v_gap := p_remitted_fcfa - v_exp;
  if v_gap <> 0 then
    insert into public.lg_incidents (kind, severity, trip_id, description, reported_by, responsible_type, responsible_id, due_at)
    values ('cash_gap', case when abs(v_gap) >= 10000 then 'high' else 'normal' end, p_trip,
            format('Écart de caisse de %s F sur le voyage %s (attendu %s F, versé %s F)', v_gap, t.number, v_exp, p_remitted_fcfa),
            auth.uid(), 'driver', t.courier_id, now() + interval '24 hours');
    perform public.lg_raise_alert('cash_gap', 'critical', format('Écart de caisse %s F, voyage %s', v_gap, t.number),
                                  p_trip, null, null, 'gap:' || p_trip);
  end if;
  perform public.lg_audit('cash_remit', 'trip', p_trip::text, jsonb_build_object('expected', v_exp, 'remitted', p_remitted_fcfa));
  v_rec := public.lg_try_reconcile(p_trip);
  return public.lg_idem_put(p_event, 'remit', jsonb_build_object(
    'ok', true, 'expected_fcfa', v_exp, 'remitted_fcfa', p_remitted_fcfa, 'gap_fcfa', v_gap, 'reconciled', v_rec,
    'receipt', format('Reçu voyage %s — %s F versés le %s', t.number, p_remitted_fcfa,
                      to_char(now() at time zone 'Africa/Dakar', 'DD/MM/YYYY HH24:MI'))));
end; $$;

create or replace function public.lg_cash_desk() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['cashier', 'accountant']) then raise exception 'forbidden'; end if;
  return jsonb_build_object(
    'to_close', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', t.id, 'number', t.number, 'label', t.label, 'status', t.status, 'ended_at', t.ended_at,
        'courier', (select name from public.couriers where id = t.courier_id)) || public.lg_trip_summary(t.id) order by t.ended_at), '[]')
      from public.lg_trips t where t.status = 'completed'),
    'recent', (select coalesce(jsonb_agg(jsonb_build_object(
        'trip_number', t.number, 'courier', (select name from public.couriers where id = r.courier_id),
        'expected_fcfa', r.expected_fcfa, 'remitted_fcfa', r.remitted_fcfa, 'gap_fcfa', r.gap_fcfa,
        'validated_at', r.validated_at, 'trip_status', t.status) order by r.validated_at desc), '[]')
      from (select * from public.lg_cash_remittances order by validated_at desc limit 30) r join public.lg_trips t on t.id = r.trip_id));
end; $$;

-- 10. INCIDENTS ET CHAÎNE DE GARDE --------------------------------------------------------
create or replace function public.lg_open_incident(p_kind text, p_description text, p_code text default null,
  p_trip uuid default null, p_photos text[] default '{}', p_severity text default 'normal') returns jsonb
language plpgsql security definer set search_path = public as $$
declare p public.lg_packages; v_id uuid; v_num int;
begin
  if not (public.lg_has_role(array['picker', 'dock_chief', 'dispatcher', 'support', 'cashier'])
          or public.lg_my_courier_id() is not null) then raise exception 'forbidden'; end if;
  if p_code is not null then
    select * into p from public.lg_packages where code = public.lg_norm_code(p_code);
    if not found then raise exception 'unknown_package'; end if;
  end if;
  insert into public.lg_incidents (kind, severity, package_id, trip_id, order_id, description, photos, reported_by,
                                   responsible_type, responsible_id, due_at)
  values (p_kind, coalesce(p_severity, 'normal'), p.id,
          coalesce(p_trip, (select trip_id from public.lg_trip_packages where package_id = p.id order by loaded_at desc nulls last limit 1)),
          p.order_id, p_description, coalesce(p_photos, '{}'), auth.uid(),
          coalesce(p.holder_type, 'unknown'), p.holder_id,
          now() + case p_kind when 'lost' then interval '72 hours' when 'accident' then interval '4 hours' else interval '48 hours' end)
  returning id, number into v_id, v_num;
  if p_kind in ('damaged', 'lost') and p.id is not null then
    update public.lg_packages set status = p_kind, updated_at = now() where id = p.id and status not in ('delivered');
    insert into public.lg_scan_events (client_event_id, package_id, event, actor_id, device_at, meta)
    values (gen_random_uuid(), p.id, 'damage', auth.uid(), now(), jsonb_build_object('incident', v_num, 'kind', p_kind));
  end if;
  if p_kind in ('accident', 'vehicle_breakdown') then
    perform public.lg_raise_alert('sos', 'critical', format('Incident n° %s : %s', v_num, p_description), p_trip, null, p.id, 'sos:' || v_id);
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'number', v_num);
end; $$;

create or replace function public.lg_resolve_incident(p_id uuid, p_resolution text, p_compensation_fcfa integer default 0,
  p_deduction_fcfa integer default 0, p_close boolean default true) returns jsonb
language plpgsql security definer set search_path = public as $$
declare i public.lg_incidents;
begin
  if not public.lg_has_role(array['support', 'dispatcher']) then raise exception 'forbidden'; end if;
  select * into i from public.lg_incidents where id = p_id for update;
  if not found then raise exception 'unknown_incident'; end if;
  update public.lg_incidents set resolution = p_resolution, compensation_fcfa = coalesce(p_compensation_fcfa, 0),
         deduction_fcfa = coalesce(p_deduction_fcfa, 0), status = case when p_close then 'closed' else 'resolved' end,
         resolved_by = auth.uid(), resolved_at = now() where id = p_id;
  -- une retenue sur le chauffeur est tracée comme gain négatif
  if coalesce(p_deduction_fcfa, 0) > 0 and i.responsible_type = 'driver' and i.responsible_id is not null then
    insert into public.courier_earnings (courier_id, amount, type, status, payment_ref)
    values (i.responsible_id, -p_deduction_fcfa, 'payout', 'pending', 'retenue incident ' || i.number);
  end if;
  -- un écart de caisse résolu permet de rapprocher le voyage
  if i.kind = 'cash_gap' and p_close and i.trip_id is not null then perform public.lg_try_reconcile(i.trip_id); end if;
  perform public.lg_audit('incident_resolve', 'incident', i.number::text, jsonb_build_object('resolution', p_resolution));
  return jsonb_build_object('ok', true);
end; $$;

create or replace function public.lg_incidents_list(p_status text default 'open') returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['support', 'dispatcher', 'dock_chief', 'cashier']) then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'id', i.id, 'number', i.number, 'kind', i.kind, 'severity', i.severity, 'status', i.status,
      'description', i.description, 'package', p.code, 'trip_number', t.number, 'order_short', upper(left(i.order_id::text, 4)),
      'responsible_type', i.responsible_type, 'created_at', i.created_at, 'due_at', i.due_at,
      'overdue', i.due_at < now() and i.status in ('open', 'investigating'),
      'resolution', i.resolution, 'compensation_fcfa', i.compensation_fcfa) order by i.created_at desc), '[]')
    from public.lg_incidents i left join public.lg_packages p on p.id = i.package_id left join public.lg_trips t on t.id = i.trip_id
   where p_status is null or i.status = p_status or (p_status = 'open' and i.status = 'investigating'));
end; $$;

-- Fiche colis : historique complet des scans, détenteur actuel, preuves, incidents
create or replace function public.lg_package_card(p_code text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p public.lg_packages; o public.orders;
begin
  select * into p from public.lg_packages where code = public.lg_norm_code(p_code);
  if not found then raise exception 'unknown_package'; end if;
  select * into o from public.orders where id = p.order_id;
  if not (public.lg_has_role(array['picker', 'dock_chief', 'dispatcher', 'support', 'cashier', 'accountant'])
          or coalesce(o.vendor_id = auth.uid(), false)) then raise exception 'forbidden'; end if;
  return jsonb_build_object(
    'package', to_jsonb(p) - 'holder_id',
    'order', jsonb_build_object('id', o.id, 'short', upper(left(o.id::text, 4)), 'status', o.status, 'zone', o.delivery_zone,
                                'payment_method', o.payment_method, 'vendor_name', o.vendor_name),
    'holder', jsonb_build_object('type', p.holder_type, 'name', case p.holder_type
        when 'driver' then (select name from public.couriers where id = p.holder_id)
        when 'hub' then (select name from public.lg_hubs where id = p.holder_id)
        when 'vendor' then (select coalesce(shop_name, name) from public.profiles where id = p.holder_id)
        when 'customer' then 'Client' end),
    'timeline', (select coalesce(jsonb_agg(jsonb_build_object(
        'event', e.event, 'at', e.server_at, 'device_at', e.device_at, 'actor', pr.name, 'manual', e.manual_entry,
        'trip_number', t.number, 'lat', e.lat, 'lng', e.lng, 'meta', e.meta) order by e.server_at, e.id), '[]')
      from public.lg_scan_events e left join public.profiles pr on pr.id = e.actor_id left join public.lg_trips t on t.id = e.trip_id
      where e.package_id = p.id),
    'proofs', (select coalesce(jsonb_agg(jsonb_build_object('kind', pf.kind, 'file_path', pf.file_path, 'recipient', pf.recipient_name,
                 'distance_m', pf.distance_m, 'at', pf.created_at)), '[]')
      from public.lg_proofs pf join public.lg_trip_packages tp on tp.stop_id = pf.stop_id where tp.package_id = p.id),
    'incidents', (select coalesce(jsonb_agg(jsonb_build_object('number', number, 'kind', kind, 'status', status)), '[]')
      from public.lg_incidents where package_id = p.id));
end; $$;
