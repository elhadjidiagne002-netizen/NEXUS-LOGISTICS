-- =====================================================================
-- NEXUS LOGISTICS — cycle 19 · Entretien préventif (module 10, P2) + correction d'indicateur
-- 1. Le carnet enregistrait « prochain entretien à N km » (next_due_km) sans que personne
--    ne soit jamais prévenu. Kilométrage estimé = dernier relevé (contrôle de départ,
--    entretien, fiche) + distance des voyages partis depuis ; alerte dans la tour de
--    contrôle quand l'échéance approche (réglage maintenance_alert_km, 500 km) ou est
--    dépassée, posée à la clôture d'un voyage et à chaque relevé. Badge dans la Flotte.
-- 2. lg_kpis : « colis par heure » sans valeur sous 30 min de tournée cumulée.
-- =====================================================================

alter table public.lg_alerts drop constraint if exists lg_alerts_kind_check;
alter table public.lg_alerts add constraint lg_alerts_kind_check check (kind in ('late', 'long_stop', 'failure', 'not_scanned', 'cash_gap',
  'driver_offline', 'far_delivery', 'stale_package', 'doc_expiring', 'cash_limit', 'sos', 'overload', 'maintenance_due'));

-- Kilométrage estimé : dernier relevé connu + km des voyages partis après ce relevé
create or replace function public.lg_vehicle_km_estimate(p_vehicle uuid) returns integer
language sql stable security definer set search_path = public as $$
  with r as (select odometer_km km, created_at at from public.lg_vehicle_logs
              where vehicle_id = p_vehicle and odometer_km is not null order by odometer_km desc, created_at desc limit 1),
       base as (select coalesce((select km from r), v.odometer_km) km, coalesce((select at from r), v.updated_at) at
                  from public.lg_vehicles v where v.id = p_vehicle)
  select case when base.km is null then null
              else (base.km + coalesce((select sum(t.distance_km) from public.lg_trips t
                                         where t.vehicle_id = p_vehicle and t.started_at > base.at), 0))::int end
    from base
$$;

-- Prochain entretien : la dernière échéance notée au carnet
create or replace function public.lg_vehicle_maintenance(p_vehicle uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when l.next_due_km is null then null else jsonb_build_object(
      'kind', l.kind, 'due_km', l.next_due_km, 'km', e.km, 'remaining_km', l.next_due_km - e.km,
      'state', case when e.km is null then 'unknown' when e.km >= l.next_due_km then 'overdue'
                    when l.next_due_km - e.km <= coalesce((public.lg_cfg('maintenance_alert_km'))::text::int, 500) then 'soon' else 'ok' end) end
    from (select kind, next_due_km from public.lg_vehicle_logs where vehicle_id = p_vehicle and next_due_km is not null
           order by created_at desc limit 1) l,
         lateral (select public.lg_vehicle_km_estimate(p_vehicle) km) e
$$;

create or replace function public.lg_maintenance_check(p_vehicle uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m jsonb := public.lg_vehicle_maintenance(p_vehicle); v_plate text;
begin
  if m is null or m ->> 'state' not in ('soon', 'overdue') then return; end if;
  select plate into v_plate from public.lg_vehicles where id = p_vehicle;
  perform public.lg_raise_alert('maintenance_due', case when m ->> 'state' = 'overdue' then 'warning' else 'info' end,
    case when m ->> 'state' = 'overdue'
         then format('%s : %s dépassé de %s km (prévu à %s km)', v_plate, m ->> 'kind', -(m ->> 'remaining_km')::int, m ->> 'due_km')
         else format('%s : %s dans %s km (à %s km)', v_plate, m ->> 'kind', m ->> 'remaining_km', m ->> 'due_km') end,
    null, null, null, format('maint:%s:%s:%s', p_vehicle, m ->> 'due_km', m ->> 'state'));
end; $$;

-- Posée à la clôture d'un voyage (distance connue) et à chaque relevé de compteur
create or replace function public.lg_trg_maintenance_trip() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('completed', 'reconciled') and old.status is distinct from new.status and old.status not in ('completed', 'reconciled') then
    begin perform public.lg_maintenance_check(new.vehicle_id);
    exception when others then null; end;   -- une alerte ne doit jamais bloquer la clôture
  end if;
  return new;
end; $$;
drop trigger if exists lg_trips_maintenance on public.lg_trips;
create trigger lg_trips_maintenance after update of status on public.lg_trips
  for each row execute function public.lg_trg_maintenance_trip();

create or replace function public.lg_trg_maintenance_log() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin perform public.lg_maintenance_check(new.vehicle_id);
  exception when others then null; end;
  return new;
end; $$;
drop trigger if exists lg_vehicle_logs_maintenance on public.lg_vehicle_logs;
create trigger lg_vehicle_logs_maintenance after insert on public.lg_vehicle_logs
  for each row execute function public.lg_trg_maintenance_log();

-- Flotte : avec l'échéance d'entretien
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
      'on_trip', (select number from public.lg_trips t where t.vehicle_id = v.id and t.status in ('planned', 'loading', 'sealed', 'in_progress') limit 1),
      'maintenance', public.lg_vehicle_maintenance(v.id)
    ) order by v.status, v.kind, v.plate), '[]') from public.lg_vehicles v where v.status <> 'retired');
end; $$;

-- Indicateurs : cadence protégée
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
      -- moins de 30 min de tournée cumulée : pas de cadence (vu en démo : « 934 colis par heure »)
      'packages_per_hour', (select case when sum(extract(epoch from (coalesce(ended_at, now()) - started_at))) >= 1800
                                        then round(sum(delivered) / (sum(extract(epoch from (coalesce(ended_at, now()) - started_at))) / 3600), 1) end from trips),
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
