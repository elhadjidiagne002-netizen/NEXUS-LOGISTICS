-- =====================================================================
-- NEXUS LOGISTICS — cycle 7 · Productivité de la préparation (module 01, P2)
-- Lignes préparées par heure, taux d'erreur, taux de rupture par vendeur,
-- consommation d'emballages. Lecture seule : rien n'est écrit.
-- =====================================================================

-- Temps de travail : une vague compte une seule fois (ses commandes sont prélevées ensemble),
-- de la première prise à la dernière fermeture, plafonné à 3 h (préparation abandonnée puis reprise).
create or replace function public.lg_pick_productivity(p_from date default null, p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_fromd date := coalesce(p_from, public.lg_today() - 6);
        v_tod   date := coalesce(p_to, public.lg_today());
        v_from  timestamptz := v_fromd::timestamp at time zone 'Africa/Dakar';
        v_to    timestamptz := (v_tod + 1)::timestamp at time zone 'Africa/Dakar';
begin
  if not public.lg_has_role(array['dock_chief', 'dispatcher', 'accountant', 'support']) then raise exception 'forbidden'; end if;
  return (with
    tasks as (select * from public.lg_pick_tasks where done_at >= v_from and done_at < v_to and picker_id is not null and started_at is not null),
    spans as (select picker_id, least(extract(epoch from max(done_at) - min(started_at)) / 60, 180) mins
                from tasks group by picker_id, coalesce(wave_id, id)),
    lines as (select t.picker_id, t.vendor_id, l.* from tasks t join public.lg_pick_lines l on l.task_id = t.id where l.status <> 'pending'),
    wrong as (select actor_id picker_id, count(*) n from public.lg_action_log
               where fn in ('pick_scan', 'wave_scan') and result ->> 'error' = 'unexpected_product'
                 and created_at >= v_from and created_at < v_to group by actor_id),
    checks as (select t.picker_id, count(distinct i.id) n from public.lg_incidents i
                 join public.lg_packages p on p.id = i.package_id join tasks t on t.id = p.pick_task_id
                where i.kind = 'missing_item' group by t.picker_id),
    per_picker as (select t.picker_id,
                     count(distinct t.id) orders,
                     (select count(*) from lines l where l.picker_id = t.picker_id) nlines,
                     (select coalesce(sum(qty_picked), 0) from lines l where l.picker_id = t.picker_id) units,
                     (select count(*) from lines l where l.picker_id = t.picker_id and l.manual_entry) manual,
                     (select count(*) from lines l where l.picker_id = t.picker_id and l.status = 'short') short,
                     (select coalesce(sum(mins), 0) from spans s where s.picker_id = t.picker_id) mins
                   from tasks t group by t.picker_id),
    pk as (select case when volume_l is null then 'unmeasured' when volume_l < 5 then 'small' when volume_l < 30 then 'medium' else 'large' end size,
                  count(*) n, round(avg(weight_g)) avg_g
             from public.lg_packages where direction = 'outbound' and created_at >= v_from and created_at < v_to and status <> 'cancelled'
            group by 1)
    select jsonb_build_object('from', v_fromd, 'to', v_tod,
      'pickers', (select coalesce(jsonb_agg(jsonb_build_object('picker_id', pp.picker_id, 'name', coalesce(pr.name, '—'),
          'orders', pp.orders, 'lines', pp.nlines, 'units', pp.units, 'minutes', round(pp.mins),
          'lines_per_hour', case when pp.mins >= 1 then round(pp.nlines / (pp.mins / 60.0), 1) end,
          'manual_pct', round(100.0 * pp.manual / nullif(pp.nlines, 0), 1),
          'short_pct', round(100.0 * pp.short / nullif(pp.nlines, 0), 1),
          'wrong_scans', coalesce(w.n, 0), 'check_errors', coalesce(c.n, 0),
          -- erreurs pour 100 lignes : mauvais produit scanné + écart trouvé au double contrôle
          'error_pct', round(100.0 * (coalesce(w.n, 0) + coalesce(c.n, 0)) / nullif(pp.nlines, 0), 1))
          order by pp.nlines desc), '[]')
        from per_picker pp left join public.profiles pr on pr.id = pp.picker_id
        left join wrong w on w.picker_id = pp.picker_id left join checks c on c.picker_id = pp.picker_id),
      'vendors', (select coalesce(jsonb_agg(v order by (v ->> 'short_pct')::numeric desc nulls last, v ->> 'name'), '[]') from (
          select jsonb_build_object('vendor_id', t.vendor_id,
            'name', coalesce(max(o.vendor_name), max(pr.name), '—'),
            'orders', count(distinct t.id),
            'lines', (select count(*) from lines l where l.vendor_id is not distinct from t.vendor_id),
            'short_pct', round(100.0 * (select count(*) from lines l where l.vendor_id is not distinct from t.vendor_id and l.status = 'short')
                               / nullif((select count(*) from lines l where l.vendor_id is not distinct from t.vendor_id), 0), 1),
            'prep_hours', round((avg(extract(epoch from t.done_at - t.created_at)) / 3600)::numeric, 1)) v
            from tasks t join public.orders o on o.id = t.order_id left join public.profiles pr on pr.id = t.vendor_id
           group by t.vendor_id) s),
      'packaging', (select coalesce(jsonb_agg(jsonb_build_object('size', size, 'count', n, 'avg_weight_g', avg_g)
                      order by array_position(array['small', 'medium', 'large', 'unmeasured'], size)), '[]') from pk),
      'totals', jsonb_build_object(
          'orders', (select count(*) from tasks),
          'lines', (select count(*) from lines),
          'units', (select coalesce(sum(qty_picked), 0) from lines),
          'hours', (select round(coalesce(sum(mins), 0) / 60.0, 1) from spans),
          -- moins d'une minute cumulée : pas de cadence (sinon des centaines de milliers de lignes par heure)
          'lines_per_hour', (select case when sum(mins) >= 1 then round((select count(*) from lines) / (sum(mins) / 60.0), 1) end from spans),
          'short_pct', (select round(100.0 * count(*) filter (where status = 'short') / nullif(count(*), 0), 1) from lines),
          'packages', (select coalesce(sum(n), 0) from pk))));
end; $$;
