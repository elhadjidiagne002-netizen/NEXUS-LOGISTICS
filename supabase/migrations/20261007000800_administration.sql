-- =====================================================================
-- NEXUS LOGISTICS — 08 · Module 15 Administration (P1) + écrans de liste
-- =====================================================================

-- Qui suis-je ? L'app choisit l'écran d'accueil d'après ces rôles.
create or replace function public.lg_me() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'user_id', p.id, 'name', p.name, 'email', p.email, 'profile_role', p.role,
    'is_admin', p.role = 'admin', 'is_vendor', p.role = 'vendor',
    'courier_id', public.lg_my_courier_id(),
    'roles', (select coalesce(jsonb_agg(jsonb_build_object('role', r.role, 'hub_id', r.hub_id, 'hub', h.name)), '[]')
                from public.lg_staff_roles r left join public.lg_hubs h on h.id = r.hub_id
               where r.user_id = p.id and r.active),
    'hubs', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'kind', kind, 'lat', lat, 'lng', lng)), '[]')
               from public.lg_hubs where active),
    'config', jsonb_build_object('max_attempts', public.lg_cfg('max_attempts'), 'require_photo', public.lg_cfg('require_photo'),
                                 'proof_radius_m', public.lg_cfg('proof_radius_m'), 'heavy_kg', public.lg_cfg('heavy_kg')))
  from public.profiles p where p.id = auth.uid()
$$;

-- RÔLES ----------------------------------------------------------------------------------
create or replace function public.lg_find_users(p_q text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_is_admin() then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'email', email, 'phone', phone, 'role', role)), '[]')
    from (select * from public.profiles
           where length(trim(p_q)) >= 3 and (name ilike '%' || p_q || '%' or email ilike '%' || p_q || '%' or phone ilike '%' || p_q || '%')
           limit 15) s);
end; $$;

create or replace function public.lg_staff_list() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_is_admin() then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('user_id', r.user_id, 'name', p.name, 'email', p.email, 'phone', p.phone,
            'role', r.role, 'hub', h.name, 'hub_id', r.hub_id, 'active', r.active, 'since', r.created_at) order by p.name, r.role), '[]')
    from public.lg_staff_roles r join public.profiles p on p.id = r.user_id left join public.lg_hubs h on h.id = r.hub_id);
end; $$;

create or replace function public.lg_grant_role(p_user uuid, p_role text, p_hub uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.lg_is_admin() then raise exception 'forbidden'; end if;
  insert into public.lg_staff_roles (user_id, role, hub_id, active, granted_by)
  values (p_user, p_role, p_hub, true, auth.uid())
  on conflict (user_id, role) do update set active = true, hub_id = excluded.hub_id, granted_by = auth.uid();
  perform public.lg_audit('role_grant', 'profile', p_user::text, jsonb_build_object('role', p_role, 'hub', p_hub));
  return jsonb_build_object('ok', true);
end; $$;

create or replace function public.lg_revoke_role(p_user uuid, p_role text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.lg_is_admin() then raise exception 'forbidden'; end if;
  update public.lg_staff_roles set active = false where user_id = p_user and role = p_role;
  perform public.lg_audit('role_revoke', 'profile', p_user::text, jsonb_build_object('role', p_role));
  return jsonb_build_object('ok', found);
end; $$;

-- LIEUX, VÉHICULES, DOCUMENTS ---------------------------------------------------------------
create or replace function public.lg_upsert_hub(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.lg_is_admin() then raise exception 'forbidden'; end if;
  insert into public.lg_hubs (id, name, kind, address, lat, lng, active)
  values (coalesce((p ->> 'id')::uuid, gen_random_uuid()), p ->> 'name', coalesce(p ->> 'kind', 'hub'), p ->> 'address',
          (p ->> 'lat')::float8, (p ->> 'lng')::float8, coalesce((p ->> 'active')::boolean, true))
  on conflict (id) do update set name = excluded.name, kind = excluded.kind, address = excluded.address,
                                 lat = excluded.lat, lng = excluded.lng, active = excluded.active
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end; $$;

create or replace function public.lg_upsert_vehicle(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not (public.lg_is_admin() or public.lg_has_role(array['dock_chief'])) then raise exception 'forbidden'; end if;
  insert into public.lg_vehicles (id, plate, kind, label, capacity_kg, capacity_l, max_packages, equipment, ownership, hub_id,
                                  default_courier_id, status, odometer_km)
  values (coalesce((p ->> 'id')::uuid, gen_random_uuid()), upper(trim(p ->> 'plate')), p ->> 'kind', p ->> 'label',
          (p ->> 'capacity_kg')::numeric, (p ->> 'capacity_l')::numeric, (p ->> 'max_packages')::int,
          coalesce(array(select jsonb_array_elements_text(p -> 'equipment')), '{}'), coalesce(p ->> 'ownership', 'interne'),
          (p ->> 'hub_id')::uuid, (p ->> 'default_courier_id')::uuid, coalesce(p ->> 'status', 'available'), (p ->> 'odometer_km')::int)
  on conflict (id) do update set plate = excluded.plate, kind = excluded.kind, label = excluded.label,
    capacity_kg = excluded.capacity_kg, capacity_l = excluded.capacity_l, max_packages = excluded.max_packages,
    equipment = excluded.equipment, ownership = excluded.ownership, hub_id = excluded.hub_id,
    default_courier_id = excluded.default_courier_id, odometer_km = coalesce(excluded.odometer_km, lg_vehicles.odometer_km),
    status = case when lg_vehicles.status = 'on_trip' then 'on_trip' else excluded.status end, updated_at = now()
  returning id into v_id;
  perform public.lg_audit('vehicle_upsert', 'vehicle', v_id::text, p);
  return jsonb_build_object('ok', true, 'id', v_id);
end; $$;

create or replace function public.lg_add_document(p_vehicle uuid, p_courier uuid, p_kind text, p_number text,
                                                  p_expires_at date, p_file_path text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not (public.lg_is_admin() or public.lg_has_role(array['dock_chief'])) then raise exception 'forbidden'; end if;
  insert into public.lg_vehicle_documents (vehicle_id, courier_id, kind, number, expires_at, file_path)
  values (p_vehicle, p_courier, p_kind, p_number, p_expires_at, p_file_path) returning id into v_id;
  if p_kind = 'permis' and p_courier is not null then
    update public.couriers set license_expires_at = greatest(coalesce(license_expires_at, p_expires_at), p_expires_at) where id = p_courier;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end; $$;

create or replace function public.lg_log_maintenance(p_vehicle uuid, p_kind text, p_odometer_km integer, p_cost_fcfa integer,
  p_note text, p_next_due_km integer default null) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not (public.lg_is_admin() or public.lg_has_role(array['dock_chief'])) then raise exception 'forbidden'; end if;
  insert into public.lg_vehicle_logs (vehicle_id, kind, odometer_km, cost_fcfa, note, next_due_km, created_by)
  values (p_vehicle, p_kind, p_odometer_km, p_cost_fcfa, p_note, p_next_due_km, auth.uid());
  update public.lg_vehicles set odometer_km = greatest(coalesce(odometer_km, 0), coalesce(p_odometer_km, 0)),
         status = case when p_kind = 'panne' and status = 'available' then 'maintenance' else status end, updated_at = now()
   where id = p_vehicle;
  return jsonb_build_object('ok', true);
end; $$;

create or replace function public.lg_set_vehicle_status(p_vehicle uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not (public.lg_is_admin() or public.lg_has_role(array['dock_chief'])) then raise exception 'forbidden'; end if;
  if p_status = 'on_trip' then raise exception 'invalid_status'; end if;
  update public.lg_vehicles set status = p_status, updated_at = now() where id = p_vehicle and status <> 'on_trip';
  return jsonb_build_object('ok', found);
end; $$;

-- TARIFS, ZONES, CRÉNEAUX, RÉMUNÉRATION, RÉGLAGES ---------------------------------------------
create or replace function public.lg_pricing() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['dispatcher']) then raise exception 'forbidden'; end if;
  return jsonb_build_object(
    'zones', (select coalesce(jsonb_agg(jsonb_build_object('name', z.name, 'city', z.city, 'lat', z.lat, 'lng', z.lng,
                'served', coalesce(s.served, true), 'cutoff_time', coalesce(s.cutoff_time, '12:00'),
                'delivery_days', coalesce(s.delivery_days, '{1,2,3,4,5,6}'), 'free_above_fcfa', s.free_above_fcfa) order by z.city, z.name), '[]')
              from public.delivery_zones z left join public.lg_zone_settings s on s.zone = z.name),
    'rate_cards', (select coalesce(jsonb_agg(to_jsonb(r) order by r.service, r.zone nulls first, r.vehicle_kind nulls first, r.max_weight_g), '[]')
                   from public.lg_rate_cards r where r.active),
    'pay_rules', (select coalesce(jsonb_agg(to_jsonb(p)), '[]') from public.lg_pay_rules p where p.active),
    'config', (select value from public.app_config where key = 'nexus_logistics_cfg'));
end; $$;

create or replace function public.lg_upsert_rate_card(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.lg_is_admin() then raise exception 'forbidden'; end if;
  if (p ->> 'id') is not null and coalesce((p ->> 'active')::boolean, true) = false then
    update public.lg_rate_cards set active = false where id = (p ->> 'id')::uuid;
    return jsonb_build_object('ok', true);
  end if;
  insert into public.lg_rate_cards (id, zone, vehicle_kind, max_weight_g, price_fcfa, lead_hours, service)
  values (coalesce((p ->> 'id')::uuid, gen_random_uuid()), nullif(p ->> 'zone', ''), nullif(p ->> 'vehicle_kind', ''),
          (p ->> 'max_weight_g')::int, (p ->> 'price_fcfa')::int, coalesce((p ->> 'lead_hours')::int, 24), coalesce(p ->> 'service', 'standard'))
  on conflict (id) do update set zone = excluded.zone, vehicle_kind = excluded.vehicle_kind, max_weight_g = excluded.max_weight_g,
    price_fcfa = excluded.price_fcfa, lead_hours = excluded.lead_hours, service = excluded.service
  returning id into v_id;
  perform public.lg_audit('rate_card', 'rate_card', v_id::text, p);
  return jsonb_build_object('ok', true, 'id', v_id);
end; $$;

create or replace function public.lg_set_zone(p_zone text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.lg_is_admin() then raise exception 'forbidden'; end if;
  insert into public.lg_zone_settings (zone, served, cutoff_time, delivery_days, free_above_fcfa, hub_id)
  values (p_zone, coalesce((p ->> 'served')::boolean, true), coalesce((p ->> 'cutoff_time')::time, '12:00'),
          coalesce(array(select jsonb_array_elements_text(p -> 'delivery_days')::smallint), '{1,2,3,4,5,6}'),
          (p ->> 'free_above_fcfa')::int, (p ->> 'hub_id')::uuid)
  on conflict (zone) do update set served = excluded.served, cutoff_time = excluded.cutoff_time,
    delivery_days = excluded.delivery_days, free_above_fcfa = excluded.free_above_fcfa, hub_id = excluded.hub_id;
  return jsonb_build_object('ok', true);
end; $$;

create or replace function public.lg_create_slots(p_zone text, p_from date, p_days integer, p_times text[], p_capacity integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.lg_has_role(array['dispatcher']) then raise exception 'forbidden'; end if;
  insert into public.lg_slots (zone, day, start_time, end_time, capacity)
  select p_zone, d::date, split_part(t, '-', 1)::time, split_part(t, '-', 2)::time, p_capacity
    from generate_series(p_from, p_from + (p_days - 1), interval '1 day') d, unnest(p_times) t
  on conflict (zone, day, start_time) do update set capacity = excluded.capacity;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'slots', n);
end; $$;

create or replace function public.lg_upsert_pay_rule(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.lg_is_admin() then raise exception 'forbidden'; end if;
  update public.lg_pay_rules set active = false
   where vehicle_kind is not distinct from nullif(p ->> 'vehicle_kind', '') and ownership is not distinct from nullif(p ->> 'ownership', '');
  insert into public.lg_pay_rules (vehicle_kind, ownership, fixed_per_trip, per_package, bonus_zero_failure, bonus_on_time)
  values (nullif(p ->> 'vehicle_kind', ''), nullif(p ->> 'ownership', ''), coalesce((p ->> 'fixed_per_trip')::int, 0),
          coalesce((p ->> 'per_package')::int, 500), coalesce((p ->> 'bonus_zero_failure')::int, 0), coalesce((p ->> 'bonus_on_time')::int, 0))
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end; $$;

-- Paramètres (chapitre 15) : fusion dans app_config.nexus_logistics_cfg ; clés connues seulement
create or replace function public.lg_set_config(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_clean jsonb;
begin
  if not public.lg_is_admin() then raise exception 'forbidden'; end if;
  select coalesce(jsonb_object_agg(key, value), '{}') into v_clean from jsonb_each(p)
   where key in ('max_attempts', 'proof_radius_m', 'cash_limit_fcfa', 'pick_lock_minutes', 'tva_rate', 'detour_coef',
                 'otp_ttl_hours', 'otp_attempts', 'heavy_kg', 'require_photo', 'staged_max_hours', 'stop_max_minutes',
                 'offline_max_minutes', 'pay_per_package', 'pay_fixed_trip', 'bonus_zero_failure', 'tracking_base_url',
                 'invoice_issuer', 'manager_phone', 'eur_to_fcfa', 'double_check_fcfa', 'bonus_on_time', 'peak_days');
  insert into public.app_config (key, value, updated_at) values ('nexus_logistics_cfg', v_clean, now())
  on conflict (key) do update set value = app_config.value || excluded.value, updated_at = now();
  perform public.lg_audit('config', 'app_config', 'nexus_logistics_cfg', v_clean);
  return jsonb_build_object('ok', true, 'config', (select value from public.app_config where key = 'nexus_logistics_cfg'));
end; $$;

-- LISTES POUR LES ÉCRANS --------------------------------------------------------------------
create or replace function public.lg_couriers_list() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['dock_chief', 'dispatcher', 'cashier']) then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'phone', c.phone, 'vehicle_type', c.vehicle_type,
            'status', c.status, 'rating', c.rating_avg, 'deliveries_done', c.deliveries_done,
            'busy', exists (select 1 from public.lg_trips t where t.courier_id = c.id and t.status in ('planned', 'loading', 'sealed', 'in_progress', 'completed')),
            'license_expires_at', c.license_expires_at) order by c.name), '[]')
    from public.couriers c where c.status = 'active');
end; $$;

create or replace function public.lg_trips_list(p_scope text default 'open') returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['dock_chief', 'dispatcher', 'cashier', 'support']) then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'number', t.number, 'label', t.label, 'status', t.status,
            'kind', t.kind, 'planned_departure', t.planned_departure, 'zones', t.zones,
            'vehicle', jsonb_build_object('plate', v.plate, 'kind', v.kind), 'courier', c.name,
            'stops', (select count(*) from public.lg_trip_stops where trip_id = t.id and status <> 'skipped'),
            'gauge', public.lg_trip_gauge_of(t.id)) order by t.planned_departure desc), '[]')
    from public.lg_trips t join public.lg_vehicles v on v.id = t.vehicle_id left join public.couriers c on c.id = t.courier_id
   where (p_scope = 'open' and t.status in ('planned', 'loading', 'sealed', 'in_progress', 'completed'))
      or (p_scope = 'all' and t.created_at > now() - interval '30 days'));
end; $$;

create or replace function public.lg_staged_packages() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['dock_chief', 'dispatcher', 'picker']) then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('zone', zone, 'packages', pk, 'count', n, 'oldest', oldest)
            order by oldest), '[]')
    from (select coalesce(p.zone, 'Sans zone') zone, count(*) n, min(p.updated_at) oldest,
                 jsonb_agg(jsonb_build_object('code', p.code, 'order_id', p.order_id, 'order_short', upper(left(p.order_id::text, 4)),
                   'weight_g', p.weight_g, 'handling', p.handling, 'status', p.status, 'attempts', p.attempts,
                   'since', p.updated_at, 'in_trip', tp.trip_id is not null) order by p.updated_at) pk
            from public.lg_packages p
            left join public.lg_trip_packages tp on tp.package_id = p.id and tp.outcome is null
           where p.status in ('staged', 'returned_hub') and p.hub_id is not null group by 1) s);
end; $$;
