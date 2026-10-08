-- =====================================================================
-- NEXUS LOGISTICS — cycle 13 · Coûts (modules 10 et 14, P2)
-- Coût au kilomètre et par colis, par véhicule ; marge par zone ; coût des
-- échecs. Coûts de la période = dépenses de voyage non rejetées + entretien
-- (carnet du véhicule) + rémunération des chauffeurs (courier_earnings
-- 'delivery' et 'bonus') — même base que cost_per_delivery de lg_kpis, plus
-- l'entretien. Recettes = frais de livraison des commandes livrées.
-- Répartitions (approximations assumées, affichées comme telles) :
--   · la paie d'un chauffeur va aux véhicules au prorata de ses livraisons ;
--   · le coût total va aux zones au prorata des présentations.
-- =====================================================================

create or replace function public.lg_costs(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_from timestamptz := p_from::timestamp at time zone 'Africa/Dakar';
        v_to   timestamptz := (p_to + 1)::timestamp at time zone 'Africa/Dakar';
begin
  if not public.lg_has_role(array['dispatcher', 'accountant']) then raise exception 'forbidden'; end if;
  return (with
    trips as (select t.id, t.vehicle_id, t.courier_id, coalesce(t.distance_km, 0) km,
                     (public.lg_trip_gauge_of(t.id) ->> 'fill_pct')::numeric fill
                from public.lg_trips t where t.started_at >= v_from and t.started_at < v_to),
    pres as (select e.event, p.zone, t.vehicle_id, t.courier_id
               from public.lg_scan_events e join public.lg_packages p on p.id = e.package_id
               left join public.lg_trips t on t.id = e.trip_id
              where e.event in ('deliver', 'fail') and e.server_at >= v_from and e.server_at < v_to),
    exp as (select coalesce(x.vehicle_id, t.vehicle_id) vehicle_id, x.amount_fcfa
              from public.lg_trip_expenses x left join public.lg_trips t on t.id = x.trip_id
             where x.status <> 'rejected' and x.created_at >= v_from and x.created_at < v_to),
    maint as (select vehicle_id, cost_fcfa from public.lg_vehicle_logs
               where cost_fcfa > 0 and created_at >= v_from and created_at < v_to),
    pay as (select courier_id, sum(amount) amount from public.courier_earnings
             where type in ('delivery', 'bonus') and created_at >= v_from and created_at < v_to group by courier_id),
    -- paie d'un chauffeur répartie sur ses véhicules au prorata de ses livraisons
    pay_veh as (select d.vehicle_id, sum(pay.amount * d.n / nullif(tot.n, 0)) amount
                  from (select courier_id, vehicle_id, count(*) n from pres where event = 'deliver' and courier_id is not null group by 1, 2) d
                  join (select courier_id, count(*) n from pres where event = 'deliver' and courier_id is not null group by 1) tot using (courier_id)
                  join pay using (courier_id) group by d.vehicle_id),
    tot as (select (select coalesce(sum(amount_fcfa), 0) from exp) expenses,
                   (select coalesce(sum(cost_fcfa), 0) from maint) maintenance,
                   (select coalesce(sum(amount), 0) from pay) driver_pay,
                   (select count(*) from pres) n, (select count(*) from pres where event = 'deliver') d,
                   (select count(*) from pres where event = 'fail') f,
                   (select coalesce(sum(km), 0) from trips) km,
                   (select coalesce(sum(o.delivery_fee_fcfa), 0) from public.orders o
                     where o.delivered_at >= v_from and o.delivered_at < v_to) revenue),
    c as (select *, expenses + maintenance + driver_pay cost from tot),
    veh as (select v.id, v.plate, v.kind,
                   (select count(*) from trips where vehicle_id = v.id) ntrips,
                   (select coalesce(sum(km), 0) from trips where vehicle_id = v.id) km,
                   (select round(avg(fill)) from trips where vehicle_id = v.id) fill,
                   (select count(*) from pres where vehicle_id = v.id and event = 'deliver') delivered,
                   (select coalesce(sum(amount_fcfa), 0) from exp where vehicle_id = v.id) expenses,
                   (select coalesce(sum(cost_fcfa), 0) from maint where vehicle_id = v.id) maintenance,
                   (select coalesce(round(sum(amount)), 0) from pay_veh where vehicle_id = v.id) driver_pay
              from public.lg_vehicles v),
    zones as (select coalesce(zone, '?') zone, count(*) n, count(*) filter (where event = 'deliver') d, count(*) filter (where event = 'fail') f
                from pres group by 1),
    zrev as (select coalesce(o.delivery_zone, '?') zone, sum(o.delivery_fee_fcfa) revenue from public.orders o
              where o.delivered_at >= v_from and o.delivered_at < v_to group by 1)
  select jsonb_build_object('from', p_from, 'to', p_to,
    'totals', (select jsonb_build_object('cost_fcfa', cost, 'expenses_fcfa', expenses, 'maintenance_fcfa', maintenance,
        'driver_pay_fcfa', driver_pay, 'presentations', n, 'delivered', d, 'failed', f, 'km', km, 'revenue_fcfa', revenue,
        'margin_fcfa', revenue - cost,
        'cost_per_presentation_fcfa', round(cost / nullif(n, 0)), 'cost_per_delivery_fcfa', round(cost / nullif(d, 0)),
        'cost_per_km_fcfa', round(cost / nullif(km, 0)),
        -- une présentation ratée coûte autant qu'une réussie, sans recette
        'failure_cost_fcfa', round(cost * f / nullif(n, 0))) from c),
    'by_vehicle', (select coalesce(jsonb_agg(jsonb_build_object('vehicle_id', id, 'plate', plate, 'kind', kind, 'trips', ntrips, 'km', km,
        'fill_pct', fill, 'delivered', delivered, 'expenses_fcfa', expenses, 'maintenance_fcfa', maintenance, 'driver_pay_fcfa', driver_pay,
        'cost_fcfa', expenses + maintenance + driver_pay,
        'cost_per_km_fcfa', round((expenses + maintenance + driver_pay) / nullif(km, 0)),
        'cost_per_package_fcfa', round((expenses + maintenance + driver_pay) / nullif(delivered, 0)))
        order by expenses + maintenance + driver_pay desc, plate), '[]')
      from veh where ntrips > 0 or expenses + maintenance > 0),
    'by_zone', (select coalesce(jsonb_agg(jsonb_build_object('zone', z.zone, 'presentations', z.n, 'delivered', z.d, 'failed', z.f,
        'revenue_fcfa', coalesce(r.revenue, 0), 'cost_fcfa', round(c.cost * z.n / nullif(c.n, 0)),
        'margin_fcfa', coalesce(r.revenue, 0) - round(c.cost * z.n / nullif(c.n, 0)),
        'failure_cost_fcfa', round(c.cost * z.f / nullif(c.n, 0))) order by z.n desc, z.zone), '[]')
      from zones z cross join c left join zrev r on r.zone = z.zone)));
end; $$;
