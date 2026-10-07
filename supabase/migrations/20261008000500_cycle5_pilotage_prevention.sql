-- =====================================================================
-- NEXUS LOGISTICS — cycle 5 · anticiper, motiver, prévenir
--  · prévision de volume par jour et par zone, besoin en véhicules (module 14, P3)
--  · détection d'anomalies et de schémas de fraude (module 13, P3)
--  · classement des chauffeurs (module 05, P2) — la prime de ponctualité est dans lg_try_reconcile
--  · contrôle des retours : remise en vente, retour vendeur, rebut (module 07, P2)
--  · livraison à un tiers (module 06, P2)
-- =====================================================================

-- 1. PRÉVISION -----------------------------------------------------------------------------
-- Moyenne pondérée du même jour de la semaine sur les 4 dernières semaines (0,4 / 0,3 / 0,2 / 0,1),
-- multipliée par le coefficient d'un jour de pic s'il est déclaré (réglage « peak_days » :
-- [{"date":"2026-05-27","factor":2.5,"label":"Tabaski"}]). Besoin en véhicules = colis ÷ colis
-- moyens par voyage observés (12 par défaut).
create or replace function public.lg_forecast(p_days integer default 7) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Africa/Dakar')::date;
  v_per_trip numeric;
  v_fleet int;
begin
  if not public.lg_has_role(array['dispatcher', 'accountant']) then raise exception 'forbidden'; end if;
  select coalesce(round(avg(n), 1), 12) into v_per_trip from (
    select count(*) n from public.lg_trip_packages tp join public.lg_trips t on t.id = tp.trip_id
     where t.started_at > now() - interval '28 days' and tp.outcome in ('delivered', 'failed') group by t.id) s;
  v_per_trip := greatest(v_per_trip, 4);
  select count(*) into v_fleet from public.lg_vehicles where status in ('available', 'on_trip');
  return (with days as (select (v_today + g)::date d from generate_series(1, greatest(coalesce(p_days, 7), 1)) g),
    hist as (select (o.created_at at time zone 'Africa/Dakar')::date d, coalesce(o.delivery_zone, o.shipping_city, '?') zone, count(*) n
               from public.orders o where o.status <> 'cancelled' and o.created_at > now() - interval '35 days' group by 1, 2),
    peaks as (select (x ->> 'date')::date d, coalesce((x ->> 'factor')::numeric, 1) f, x ->> 'label' label
                from jsonb_array_elements(coalesce(public.lg_cfg('peak_days'), '[]')) x),
    fz as (select dd.d, h.zone,
              round(sum(h.n * case (dd.d - h.d) / 7 when 1 then .4 when 2 then .3 when 3 then .2 when 4 then .1 else 0 end), 1) n
             from days dd join hist h on extract(dow from h.d) = extract(dow from dd.d) and (dd.d - h.d) between 7 and 28
            group by dd.d, h.zone),
    fd as (select dd.d, coalesce(sum(fz.n), 0) * coalesce(max(pk.f), 1) total, max(pk.label) peak,
              coalesce(jsonb_agg(jsonb_build_object('zone', fz.zone, 'orders', round(fz.n * coalesce(pk.f, 1), 1)) order by fz.n desc)
                       filter (where fz.zone is not null), '[]') zones
             from days dd left join fz on fz.d = dd.d left join peaks pk on pk.d = dd.d group by dd.d)
    select jsonb_build_object('per_trip', v_per_trip, 'fleet', v_fleet,
      'days', coalesce(jsonb_agg(jsonb_build_object('date', d, 'weekday', to_char(d, 'TMDay'), 'orders', round(total, 1), 'peak', peak,
          'vehicles_needed', ceil(total * 1.15 / v_per_trip)::int, 'under_capacity', ceil(total * 1.15 / v_per_trip) > v_fleet,
          'zones', (select coalesce(jsonb_agg(z), '[]') from (select jsonb_array_elements(zones) z limit 5) s)) order by d), '[]'))
    from fd);
end; $$;

-- 2. ANOMALIES ET SCHÉMAS DE FRAUDE ---------------------------------------------------------
create or replace function public.lg_anomalies(p_days integer default 30) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_from timestamptz := now() - make_interval(days => coalesce(p_days, 30)); v_radius int := (public.lg_cfg('proof_radius_m'))::text::int;
begin
  if not public.lg_has_role(array['dispatcher', 'support', 'accountant']) then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(a order by (a ->> 'score')::numeric desc), '[]') from (
    -- chauffeur : livraisons validées loin de l'adresse
    select jsonb_build_object('kind', 'far_deliveries', 'subject_type', 'driver', 'subject', c.name, 'score', round(100.0 * far / n),
      'metric', format('%s livraisons sur %s validées à plus de %s m de l''adresse', far, n, v_radius),
      'severity', case when 100.0 * far / n >= 40 then 'critical' else 'warning' end) a
      from (select t.courier_id, count(*) n, count(*) filter (where pf.distance_m > v_radius) far
              from public.lg_proofs pf join public.lg_trip_stops s on s.id = pf.stop_id join public.lg_trips t on t.id = s.trip_id
             where pf.kind in ('otp', 'signature') and pf.created_at > v_from group by t.courier_id) x
      join public.couriers c on c.id = x.courier_id where n >= 3 and 100.0 * far / n >= 20
    union all
    -- chauffeur : écarts de caisse répétés
    select jsonb_build_object('kind', 'cash_gaps', 'subject_type', 'driver', 'subject', c.name, 'score', 50 + count(*) * 10,
      'metric', format('%s écart(s) de caisse, %s F au total', count(*), sum(r.gap_fcfa)), 'severity', 'critical')
      from public.lg_cash_remittances r join public.couriers c on c.id = r.courier_id
     where r.validated_at > v_from and r.gap_fcfa < 0 group by c.name having count(*) >= 2
    union all
    -- chauffeur : taux d'échec anormal
    select jsonb_build_object('kind', 'driver_failures', 'subject_type', 'driver', 'subject', c.name, 'score', round(100.0 * f / (d + f)),
      'metric', format('%s échec(s) sur %s présentations', f, d + f), 'severity', 'warning')
      from (select t.courier_id, count(*) filter (where s.status = 'delivered') d, count(*) filter (where s.status = 'failed') f
              from public.lg_trip_stops s join public.lg_trips t on t.id = s.trip_id
             where s.completed_at > v_from and s.kind = 'delivery' group by t.courier_id) x
      join public.couriers c on c.id = x.courier_id where d + f >= 5 and 100.0 * f / (d + f) > 30
    union all
    -- client : refus ou échecs répétés (risque sur le paiement à la livraison)
    select jsonb_build_object('kind', 'customer_refusals', 'subject_type', 'customer', 'subject', max(o.buyer_name) || ' · ' ||
      regexp_replace(public.lg_phone_key(o.buyer_phone), '(\d{2})\d{4}(\d{3})', '\1****\2'), 'score', 40 + count(*) * 15,
      'metric', format('%s échec(s) dont %s refus', count(*), count(*) filter (where s.failure_reason = 'refused')),
      'severity', case when count(*) filter (where s.failure_reason = 'refused') >= 2 then 'critical' else 'warning' end)
      from public.lg_trip_stops s join public.orders o on o.id = s.order_id
     where s.status = 'failed' and s.completed_at > v_from group by public.lg_phone_key(o.buyer_phone)
    having count(*) >= 3 or count(*) filter (where s.failure_reason = 'refused') >= 2
    union all
    -- vendeur : ruptures fréquentes (stock affiché faux)
    select jsonb_build_object('kind', 'vendor_stockouts', 'subject_type', 'vendor', 'subject', coalesce(max(pr.shop_name), max(pr.name)),
      'score', round(100.0 * count(*) filter (where l.status = 'short') / count(*)),
      'metric', format('%s ligne(s) en rupture sur %s', count(*) filter (where l.status = 'short'), count(*)), 'severity', 'warning')
      from public.lg_pick_lines l join public.lg_pick_tasks t on t.id = l.task_id left join public.profiles pr on pr.id = t.vendor_id
     where t.created_at > v_from group by t.vendor_id
    having count(*) >= 5 and 100.0 * count(*) filter (where l.status = 'short') / count(*) > 15
    union all
    -- zone : échecs anormaux (adresses, accès)
    select jsonb_build_object('kind', 'zone_failures', 'subject_type', 'zone', 'subject', zone, 'score', round(100.0 * f / (d + f)),
      'metric', format('%s échec(s) sur %s présentations', f, d + f), 'severity', 'info')
      from (select o.delivery_zone zone, count(*) filter (where s.status = 'delivered') d, count(*) filter (where s.status = 'failed') f
              from public.lg_trip_stops s join public.orders o on o.id = s.order_id
             where s.completed_at > v_from and s.kind = 'delivery' group by o.delivery_zone) z
     where d + f >= 5 and 100.0 * f / (d + f) > 25
  ) q);
end; $$;

-- 3. CLASSEMENT DES CHAUFFEURS ---------------------------------------------------------------
create or replace function public.lg_driver_scores(p_days integer default 7) returns table (
  courier_id uuid, name text, delivered int, failed int, first_attempt_pct numeric, on_time_pct numeric, rating numeric,
  earnings int, score numeric, rank int)
language sql stable security definer set search_path = public as $$
  with s as (
    select t.courier_id, count(*) filter (where st.status = 'delivered') delivered, count(*) filter (where st.status = 'failed') failed,
           count(*) filter (where st.status = 'delivered' and st.completed_at <= coalesce(st.window_end, st.eta + interval '30 minutes')) on_time,
           count(*) filter (where st.status = 'delivered' and not exists (select 1 from public.lg_trip_stops s2 where s2.order_id = st.order_id
                              and s2.status = 'failed' and s2.completed_at < st.completed_at)) first_ok
      from public.lg_trip_stops st join public.lg_trips t on t.id = st.trip_id
     where st.completed_at > now() - make_interval(days => p_days) and st.kind = 'delivery' group by t.courier_id)
  select c.id, c.name, coalesce(s.delivered, 0)::int, coalesce(s.failed, 0)::int,
         round(100.0 * s.first_ok / nullif(s.delivered + s.failed, 0)), round(100.0 * s.on_time / nullif(s.delivered, 0)), c.rating_avg,
         coalesce((select sum(amount) from public.courier_earnings e where e.courier_id = c.id and e.created_at > now() - make_interval(days => p_days)), 0)::int,
         -- note : volume (40) + réussite à la 1re présentation (30) + ponctualité (20) + note client (10)
         round(40 * least(coalesce(s.delivered, 0) / 40.0, 1) + 0.3 * coalesce(100.0 * s.first_ok / nullif(s.delivered + s.failed, 0), 0)
               + 0.2 * coalesce(100.0 * s.on_time / nullif(s.delivered, 0), 0) + 2 * coalesce(c.rating_avg, 0), 1),
         rank() over (order by round(40 * least(coalesce(s.delivered, 0) / 40.0, 1) + 0.3 * coalesce(100.0 * s.first_ok / nullif(s.delivered + s.failed, 0), 0)
               + 0.2 * coalesce(100.0 * s.on_time / nullif(s.delivered, 0), 0) + 2 * coalesce(c.rating_avg, 0), 1) desc)::int
    from public.couriers c left join s on s.courier_id = c.id where c.status = 'active'
$$;

create or replace function public.lg_leaderboard(p_days integer default 7) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.lg_has_role(array['dispatcher', 'cashier', 'accountant']) or public.lg_my_courier_id() is not null) then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(to_jsonb(x) || jsonb_build_object('me', x.courier_id = public.lg_my_courier_id()) order by x.rank), '[]')
            from public.lg_driver_scores(coalesce(p_days, 7)) x);
end; $$;

-- 4. CONTRÔLE DES RETOURS ---------------------------------------------------------------------
create table if not exists public.lg_return_inspections (
  id          uuid primary key default gen_random_uuid(),
  package_id  uuid not null references public.lg_packages(id),
  condition   text not null check (condition in ('neuf', 'bon', 'abime', 'inutilisable')),
  decision    text not null check (decision in ('restock', 'vendor', 'scrap')),
  note        text,
  photo_path  text,
  inspected_by uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);
alter table public.lg_return_inspections enable row level security;

create or replace function public.lg_return_inspect(p_code text, p_condition text, p_decision text, p_event uuid,
  p_note text default null, p_photo_path text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p public.lg_packages; res jsonb; pi record; v_credit jsonb; v_loc uuid;
begin
  if not public.lg_has_role(array['dock_chief', 'support']) then raise exception 'forbidden'; end if;
  res := public.lg_idem_get(p_event); if res is not null then return res; end if;
  select * into p from public.lg_packages where code = public.lg_norm_code(p_code) for update;
  if not found or p.status <> 'returned_hub' then
    return public.lg_idem_put(p_event, 'inspect', jsonb_build_object('ok', false, 'error', 'bad_status', 'status', p.status));
  end if;
  if p_decision = 'restock' and p_condition not in ('neuf', 'bon') then
    return public.lg_idem_put(p_event, 'inspect', jsonb_build_object('ok', false, 'error', 'not_resellable'));
  end if;
  insert into public.lg_return_inspections (package_id, condition, decision, note, photo_path, inspected_by)
  values (p.id, p_condition, p_decision, p_note, p_photo_path, auth.uid());
  if p_decision = 'vendor' then
    v_credit := public.lg_return_vendor(p.code, gen_random_uuid(), coalesce(p_note, 'Retour client contrôlé : ' || p_condition));
  else
    -- remise en vente (rangée au hub) ou rebut : le client est remboursé dans les deux cas
    for pi in select pi2.order_item_id, pi2.quantity, oi.product_id from public.lg_package_items pi2
                join public.order_items oi on oi.id = pi2.order_item_id where pi2.package_id = p.id loop
      update public.order_items set line_status = 'cancelled' where id = pi.order_item_id;
      if p_decision = 'restock' then
        update public.products set stock = coalesce(stock, 0) + pi.quantity, updated_at = now() where id = pi.product_id;
        select pl.location_id into v_loc from public.lg_product_locations pl join public.lg_stock_locations l on l.id = pl.location_id
         where pl.product_id = pi.product_id and l.hub_id = p.hub_id order by pl.qty desc limit 1;
        if v_loc is not null then update public.lg_product_locations set qty = qty + pi.quantity, updated_at = now()
                                   where product_id = pi.product_id and location_id = v_loc; end if;
      end if;
    end loop;
    update public.lg_packages set status = case when p_decision = 'scrap' then 'damaged' else 'cancelled' end, updated_at = now() where id = p.id;
    insert into public.lg_scan_events (client_event_id, package_id, event, actor_id, hub_id, device_at, meta)
    values (gen_random_uuid(), p.id, case when p_decision = 'scrap' then 'damage' else 'inventory' end, auth.uid(), p.hub_id, now(),
            jsonb_build_object('inspection', p_decision, 'condition', p_condition));
    v_credit := public.lg_credit_package(p.id, case when p_decision = 'scrap' then 'Retour mis au rebut' else 'Retour remis en vente' end);
    if p_decision = 'scrap' then
      insert into public.lg_incidents (kind, package_id, order_id, description, photos, reported_by, responsible_type, due_at)
      values ('damaged', p.id, p.order_id, coalesce(p_note, 'Retour inutilisable, mis au rebut'),
              case when p_photo_path is null then '{}' else array[p_photo_path] end, auth.uid(), 'unknown', now() + interval '72 hours');
    end if;
  end if;
  return public.lg_idem_put(p_event, 'inspect', jsonb_build_object('ok', true, 'decision', p_decision,
    'credit_note', coalesce(v_credit ->> 'credit_note', v_credit ->> 'number')));
end; $$;

create or replace function public.lg_returns_to_inspect() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['dock_chief', 'support']) then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('code', p.code, 'direction', p.direction, 'order_short', upper(left(p.order_id::text, 8)),
            'attempts', p.attempts, 'since', p.updated_at, 'vendor', o.vendor_name,
            'items', (select string_agg(coalesce(oi.product_name, '?') || ' × ' || pi.quantity, ', ') from public.lg_package_items pi
                       join public.order_items oi on oi.id = pi.order_item_id where pi.package_id = p.id)) order by p.updated_at), '[]')
    from public.lg_packages p join public.orders o on o.id = p.order_id
   where p.status = 'returned_hub' and (p.direction = 'return' or p.attempts >= (public.lg_cfg('max_attempts'))::text::int));
end; $$;

-- 5. LIVRAISON À UN TIERS ---------------------------------------------------------------------
alter table public.orders add column if not exists recipient_name text, add column if not exists recipient_phone text;
insert into public.lg_message_templates (event_key, label, position, body_fr) values
 ('lg_third_party_code', 'Code pour la personne désignée', 12,
  'Bonjour {destinataire}, {prenom} vous a désigné pour recevoir son colis NEXUS Market. Le livreur arrive vers {heure}. Code de livraison à lui donner : {code}.')
on conflict (event_key) do nothing;

create or replace function public.lg_track_third_party(p_token uuid, p_name text, p_phone text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o public.orders;
begin
  o := public.lg_order_by_token(p_token);
  if o.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if length(trim(coalesce(p_name, ''))) < 2 or length(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')) < 9 then
    return jsonb_build_object('ok', false, 'error', 'invalid_recipient');
  end if;
  if o.status in ('delivered', 'cancelled') then return jsonb_build_object('ok', false, 'error', 'order_closed'); end if;
  update public.orders set recipient_name = left(trim(p_name), 80), recipient_phone = left(trim(p_phone), 20), updated_at = now() where id = o.id;
  update public.lg_trip_stops st set contact_name = coalesce(o.buyer_name, '') || ' (remis à ' || left(trim(p_name), 80) || ')'
    from public.lg_trips t where t.id = st.trip_id and st.order_id = o.id and st.status in ('pending', 'en_route');
  -- tournée déjà partie : le code part tout de suite à la personne désignée
  if exists (select 1 from public.lg_trip_stops st join public.lg_trips t on t.id = st.trip_id
              where st.order_id = o.id and t.status = 'in_progress' and st.status in ('pending', 'en_route')) then
    perform public.lg_send_third_party_code(o.id);
  end if;
  return jsonb_build_object('ok', true);
end; $$;

create or replace function public.lg_send_third_party_code(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o public.orders; v_code text; v_vars jsonb; v_eta timestamptz;
begin
  select * into o from public.orders where id = p_order;
  if o.recipient_phone is null then return; end if;
  v_code := public.lg_issue_delivery_code(p_order);   -- nouveau code : l'ancien ne vaut plus
  select eta into v_eta from public.lg_trip_stops where order_id = p_order and status in ('pending', 'en_route') order by eta limit 1;
  v_vars := jsonb_build_object('destinataire', split_part(o.recipient_name, ' ', 1), 'prenom', split_part(coalesce(o.buyer_name, ''), ' ', 1),
                               'code', v_code, 'heure', coalesce(to_char(v_eta at time zone 'Africa/Dakar', 'HH24"h"MI'), 'aujourd''hui'),
                               'commande', upper(left(o.id::text, 8)));
  insert into public.notification_outbox (event_key, recipient, vars)
  values ('lg_third_party_code', jsonb_build_object('phone', o.recipient_phone),
          v_vars || jsonb_build_object('texte', public.lg_render_message('lg_third_party_code', v_vars)));
  -- le client garde la trace : même code, envoyé aussi à lui
  perform public.lg_notify('lg_out_for_delivery', p_order, jsonb_build_object('code', v_code, 'livreur', 'votre livreur',
    'heure', coalesce(to_char(v_eta at time zone 'Africa/Dakar', 'HH24"h"MI'), 'aujourd''hui')));
end; $$;
