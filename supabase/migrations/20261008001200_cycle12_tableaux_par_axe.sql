-- =====================================================================
-- NEXUS LOGISTICS — cycle 12 · Tableaux par axe (module 14, P2)
-- Les indicateurs de livraison découpés par zone, vendeur, chauffeur,
-- véhicule, jour de la semaine ou heure : mêmes définitions que lg_kpis
-- (présentations = scans « deliver » et « fail » de la période). Export
-- Excel côté écran (CSV ; séparateur point-virgule, comme les autres exports).
-- =====================================================================

create or replace function public.lg_kpis_by_axis(p_axis text, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_from timestamptz := p_from::timestamp at time zone 'Africa/Dakar';
        v_to   timestamptz := (p_to + 1)::timestamp at time zone 'Africa/Dakar';
begin
  if not public.lg_has_role(array['dispatcher', 'accountant', 'support']) then raise exception 'forbidden'; end if;
  if p_axis not in ('zone', 'vendor', 'courier', 'vehicle', 'weekday', 'hour') then raise exception 'invalid_axis'; end if;
  return (with pres as (
      select e.event, e.server_at, p.attempts, p.zone, o.vendor_name, o.promised_at,
             coalesce(o.cod_confirmed_at, o.paid_at, o.created_at) confirmed_at, s.eta,
             c.name courier, v.plate, v.kind vehicle_kind, (e.server_at at time zone 'Africa/Dakar') local_at
        from public.lg_scan_events e
        join public.lg_packages p on p.id = e.package_id
        join public.orders o on o.id = p.order_id
        left join public.lg_trip_packages tp on tp.package_id = p.id and tp.trip_id = e.trip_id
        left join public.lg_trip_stops s on s.id = tp.stop_id
        left join public.lg_trips t on t.id = e.trip_id
        left join public.couriers c on c.id = t.courier_id
        left join public.lg_vehicles v on v.id = t.vehicle_id
       where e.event in ('deliver', 'fail') and e.server_at >= v_from and e.server_at < v_to),
    keyed as (select *, case p_axis
        when 'zone' then coalesce(zone, '?')
        when 'vendor' then coalesce(vendor_name, '—')
        when 'courier' then coalesce(courier, '—')
        when 'vehicle' then coalesce(plate || ' (' || vehicle_kind || ')', '—')
        when 'weekday' then extract(isodow from local_at)::text
        else lpad(extract(hour from local_at)::text, 2, '0') end k from pres),
    agg as (select k, count(*) n,
        count(*) filter (where event = 'deliver') d,
        count(*) filter (where event = 'fail') f,
        count(*) filter (where event = 'deliver' and attempts = 0) first_ok,
        count(*) filter (where event = 'deliver' and server_at <= coalesce(promised_at, eta + interval '30 minutes')) on_time,
        count(*) filter (where event = 'deliver' and coalesce(promised_at, eta) is not null) timed,
        avg(server_at - confirmed_at) filter (where event = 'deliver') lead
       from keyed group by k)
    select jsonb_build_object('axis', p_axis, 'from', p_from, 'to', p_to,
      'rows', coalesce(jsonb_agg(jsonb_build_object(
          'key', k,
          'label', case when p_axis = 'weekday' then (array['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'])[k::int]
                        when p_axis = 'hour' then k || ' h' else k end,
          'presentations', n, 'delivered', d, 'failed', f,
          'failure_pct', round(100.0 * f / nullif(n, 0), 1),
          'first_attempt_pct', round(100.0 * first_ok / nullif(d, 0), 1),
          'on_time_pct', round(100.0 * on_time / nullif(timed, 0), 1),
          'lead_hours', round((extract(epoch from lead) / 3600)::numeric, 1))
        order by case when p_axis in ('weekday', 'hour') then k end, n desc, k), '[]'))
    from agg);
end; $$;
