-- =====================================================================
-- NEXUS LOGISTICS — cycle 11 · Plusieurs quais (module 03, P2)
-- Affectation d'un quai par voyage, file d'attente des véhicules arrivés au
-- hub, temps moyen de chargement et d'attente par quai.
-- Un quai est occupé par un voyage affecté qui n'est pas encore parti ; il se
-- libère tout seul au départ (lg_trip_start) ou à l'annulation.
-- =====================================================================

create table if not exists public.lg_docks (
  id         uuid primary key default gen_random_uuid(),
  hub_id     uuid not null references public.lg_hubs(id),
  code       text not null,                 -- Q1, Q2…
  label      text,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (hub_id, code)
);
alter table public.lg_docks enable row level security;
alter table public.lg_trips
  add column if not exists dock_id          uuid references public.lg_docks(id),
  add column if not exists dock_queued_at   timestamptz,   -- véhicule arrivé au hub, en attente
  add column if not exists dock_assigned_at timestamptz;

-- Un voyage occupe son quai tant qu'il n'est pas parti
create or replace function public.lg_dock_busy(p_dock uuid, p_except uuid default null) returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.lg_trips where dock_id = p_dock and status in ('draft', 'planned', 'loading', 'sealed')
     and id is distinct from p_except order by dock_assigned_at limit 1
$$;

create or replace function public.lg_dock_upsert(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_hub uuid;
begin
  if not public.lg_has_role(array['dock_chief']) then raise exception 'forbidden'; end if;
  v_hub := coalesce((p ->> 'hub_id')::uuid, (select hub_id from public.lg_staff_roles where user_id = auth.uid() and hub_id is not null limit 1),
                    (select id from public.lg_hubs where active order by created_at limit 1));
  if nullif(trim(p ->> 'code'), '') is null then raise exception 'code_required'; end if;
  insert into public.lg_docks (hub_id, code, label, active)
  values (v_hub, upper(trim(p ->> 'code')), p ->> 'label', coalesce((p ->> 'active')::boolean, true))
  on conflict (hub_id, code) do update set label = excluded.label, active = excluded.active
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end; $$;

-- Arrivée du véhicule au hub : le chauffeur (son voyage) ou le chef de quai le signale
create or replace function public.lg_dock_checkin(p_trip uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.lg_trips;
begin
  select * into t from public.lg_trips where id = p_trip for update;
  if not found then raise exception 'unknown_trip'; end if;
  if public.lg_trip_courier_user(p_trip) is distinct from auth.uid() and not public.lg_has_role(array['dock_chief', 'dispatcher']) then
    raise exception 'forbidden';
  end if;
  if t.status not in ('draft', 'planned', 'loading', 'sealed') then return jsonb_build_object('ok', false, 'error', 'trip_started'); end if;
  update public.lg_trips set dock_queued_at = coalesce(dock_queued_at, now()), updated_at = now() where id = p_trip;
  return jsonb_build_object('ok', true, 'dock', (select code from public.lg_docks where id = t.dock_id));
end; $$;

-- Affectation d'un quai (p_dock null = premier quai libre du hub)
create or replace function public.lg_dock_assign(p_trip uuid, p_dock uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.lg_trips; d public.lg_docks; v_busy uuid;
begin
  if not public.lg_has_role(array['dock_chief', 'dispatcher']) then raise exception 'forbidden'; end if;
  select * into t from public.lg_trips where id = p_trip for update;
  if not found then raise exception 'unknown_trip'; end if;
  if t.status not in ('draft', 'planned', 'loading', 'sealed') then return jsonb_build_object('ok', false, 'error', 'trip_started'); end if;
  if p_dock is null then
    select * into d from public.lg_docks k where k.active and (t.hub_id is null or k.hub_id = t.hub_id)
       and public.lg_dock_busy(k.id, p_trip) is null order by k.code limit 1;
    if not found then return jsonb_build_object('ok', false, 'error', 'no_free_dock'); end if;
  else
    select * into d from public.lg_docks where id = p_dock and active;
    if not found then raise exception 'unknown_dock'; end if;
    v_busy := public.lg_dock_busy(d.id, p_trip);
    if v_busy is not null then
      return jsonb_build_object('ok', false, 'error', 'dock_busy', 'trip', (select number from public.lg_trips where id = v_busy));
    end if;
  end if;
  update public.lg_trips set dock_id = d.id, dock_assigned_at = now(), updated_at = now() where id = p_trip;
  perform public.lg_audit('dock_assign', 'trip', t.number::text, jsonb_build_object('dock', d.code));
  return jsonb_build_object('ok', true, 'dock', d.code, 'dock_id', d.id);
end; $$;

-- Tableau des quais : occupation, file d'attente, temps moyens (7 derniers jours)
create or replace function public.lg_dock_board(p_hub uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['dock_chief', 'dispatcher']) then raise exception 'forbidden'; end if;
  return jsonb_build_object(
    'docks', (select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'code', k.code, 'label', k.label, 'active', k.active,
        'trip', (select jsonb_build_object('id', t.id, 'number', t.number, 'status', t.status, 'vehicle', v.plate, 'courier', c.name,
                   'planned_departure', t.planned_departure, 'arrived', t.dock_queued_at is not null, 'assigned_at', t.dock_assigned_at,
                   'loaded', (select count(*) from public.lg_trip_packages tp where tp.trip_id = t.id and tp.loaded_at is not null),
                   'packages', (select count(*) from public.lg_trip_packages tp where tp.trip_id = t.id))
                   from public.lg_trips t join public.lg_vehicles v on v.id = t.vehicle_id left join public.couriers c on c.id = t.courier_id
                  where t.id = public.lg_dock_busy(k.id)),
        -- chargement : premier colis chargé → scellé
        'avg_loading_min', (select round(avg(extract(epoch from t.sealed_at - f.first_load) / 60))
                              from public.lg_trips t, lateral (select min(tp.loaded_at) first_load from public.lg_trip_packages tp where tp.trip_id = t.id) f
                             where t.dock_id = k.id and t.sealed_at > now() - interval '7 days' and f.first_load is not null and t.sealed_at > f.first_load),
        'trips_7d', (select count(*) from public.lg_trips t where t.dock_id = k.id and t.dock_assigned_at > now() - interval '7 days'))
        order by k.code), '[]')
      from public.lg_docks k where p_hub is null or k.hub_id = p_hub),
    -- véhicules arrivés sans quai, du plus ancien au plus récent
    'queue', (select coalesce(jsonb_agg(jsonb_build_object('trip_id', t.id, 'number', t.number, 'status', t.status, 'vehicle', v.plate,
        'courier', c.name, 'queued_at', t.dock_queued_at, 'waiting_min', round(extract(epoch from now() - t.dock_queued_at) / 60),
        'planned_departure', t.planned_departure) order by t.dock_queued_at), '[]')
      from public.lg_trips t join public.lg_vehicles v on v.id = t.vehicle_id left join public.couriers c on c.id = t.courier_id
     where t.dock_queued_at is not null and t.dock_id is null and t.status in ('draft', 'planned', 'loading', 'sealed')
       and (p_hub is null or t.hub_id = p_hub)),
    -- voyages du jour à charger, pas encore arrivés ni affectés
    'upcoming', (select coalesce(jsonb_agg(jsonb_build_object('trip_id', t.id, 'number', t.number, 'status', t.status, 'vehicle', v.plate,
        'courier', c.name, 'planned_departure', t.planned_departure) order by t.planned_departure nulls last, t.number), '[]')
      from public.lg_trips t join public.lg_vehicles v on v.id = t.vehicle_id left join public.couriers c on c.id = t.courier_id
     where t.dock_queued_at is null and t.dock_id is null and t.status in ('planned', 'loading')
       and (p_hub is null or t.hub_id = p_hub)),
    'avg_wait_min', (select round(avg(extract(epoch from dock_assigned_at - dock_queued_at) / 60)) from public.lg_trips
                      where dock_queued_at is not null and dock_assigned_at > dock_queued_at and dock_assigned_at > now() - interval '7 days'));
end; $$;

-- Pour le chauffeur : son quai et sa place dans la file
create or replace function public.lg_trip_dock(p_trip uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare t public.lg_trips;
begin
  select * into t from public.lg_trips where id = p_trip;
  if not found then raise exception 'unknown_trip'; end if;
  if public.lg_trip_courier_user(p_trip) is distinct from auth.uid() and not public.lg_has_role(array['dock_chief', 'dispatcher']) then
    raise exception 'forbidden';
  end if;
  return jsonb_build_object('dock', (select code from public.lg_docks where id = t.dock_id), 'queued_at', t.dock_queued_at,
    'position', case when t.dock_id is null and t.dock_queued_at is not null then
      (select count(*) from public.lg_trips q where q.dock_queued_at is not null and q.dock_id is null
          and q.status in ('draft', 'planned', 'loading', 'sealed') and q.dock_queued_at <= t.dock_queued_at
          and q.hub_id is not distinct from t.hub_id) end);
end; $$;
