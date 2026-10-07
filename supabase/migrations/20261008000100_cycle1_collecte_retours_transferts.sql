-- =====================================================================
-- NEXUS LOGISTICS — cycle 1 · les fonctions P1 qui manquaient
--  · versement intermédiaire de caisse (module 08, plafond d'encours)
--  · réaffectation d'un arrêt + transfert de colis par double scan (module 04)
--  · retour demandé par le client → arrêt de reprise (module 07)
--  · collecte chez les vendeurs + réception au hub (module 09)
-- =====================================================================

-- 1. VERSEMENT INTERMÉDIAIRE -----------------------------------------------------------
create or replace function public.lg_cash_drop(p_trip uuid, p_amount_fcfa integer, p_note text default null,
                                               p_event uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.lg_trips; res jsonb; v_out int;
begin
  if not public.lg_has_role(array['cashier']) then raise exception 'forbidden'; end if;
  res := public.lg_idem_get(p_event); if res is not null then return res; end if;
  select * into t from public.lg_trips where id = p_trip for update;
  if not found or t.status not in ('sealed', 'in_progress', 'completed') then raise exception 'trip_not_on_road'; end if;
  if public.lg_trip_courier_user(p_trip) = auth.uid() then raise exception 'same_person'; end if;
  v_out := public.lg_trip_cash_outstanding(p_trip);
  if p_amount_fcfa <= 0 or p_amount_fcfa > v_out then
    return public.lg_idem_put(p_event, 'cash_drop', jsonb_build_object('ok', false, 'error', 'exceeds_cash', 'outstanding', v_out));
  end if;
  insert into public.lg_cash_drops (trip_id, courier_id, amount_fcfa, cashier_id, note)
  values (p_trip, t.courier_id, p_amount_fcfa, auth.uid(), p_note);
  -- l'alerte de plafond est levée : le chauffeur peut repartir
  update public.lg_alerts set acked_at = now(), acked_by = auth.uid(), dedupe_key = null
   where dedupe_key = 'cash_limit:' || p_trip and acked_at is null;
  perform public.lg_audit('cash_drop', 'trip', p_trip::text, jsonb_build_object('amount', p_amount_fcfa));
  return public.lg_idem_put(p_event, 'cash_drop', jsonb_build_object('ok', true, 'outstanding', v_out - p_amount_fcfa,
    'receipt', format('Versement intermédiaire voyage %s — %s F reçus le %s', t.number, p_amount_fcfa,
                      to_char(now() at time zone 'Africa/Dakar', 'DD/MM/YYYY HH24:MI'))));
end; $$;

-- Caisse : voyages à clôturer + chauffeurs sur la route avec des espèces
create or replace function public.lg_cash_desk() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['cashier', 'accountant']) then raise exception 'forbidden'; end if;
  return jsonb_build_object(
    'to_close', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', t.id, 'number', t.number, 'label', t.label, 'status', t.status, 'ended_at', t.ended_at,
        'courier', (select name from public.couriers where id = t.courier_id)) || public.lg_trip_summary(t.id) order by t.ended_at), '[]')
      from public.lg_trips t where t.status = 'completed'),
    'on_road', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', t.id, 'number', t.number, 'courier', c.name, 'outstanding_fcfa', public.lg_trip_cash_outstanding(t.id),
        'limit_fcfa', coalesce(c.cash_limit_fcfa, (public.lg_cfg('cash_limit_fcfa'))::text::int),
        'over_limit', public.lg_courier_cash(c.id) > coalesce(c.cash_limit_fcfa, (public.lg_cfg('cash_limit_fcfa'))::text::int))
        order by public.lg_trip_cash_outstanding(t.id) desc), '[]')
      from public.lg_trips t join public.couriers c on c.id = t.courier_id
      where t.status in ('sealed', 'in_progress') and public.lg_trip_cash_outstanding(t.id) > 0),
    'recent', (select coalesce(jsonb_agg(jsonb_build_object(
        'trip_number', t.number, 'courier', (select name from public.couriers where id = r.courier_id),
        'expected_fcfa', r.expected_fcfa, 'remitted_fcfa', r.remitted_fcfa, 'gap_fcfa', r.gap_fcfa,
        'validated_at', r.validated_at, 'trip_status', t.status) order by r.validated_at desc), '[]')
      from (select * from public.lg_cash_remittances order by validated_at desc limit 30) r join public.lg_trips t on t.id = r.trip_id));
end; $$;

-- 2. RÉAFFECTATION D'UN ARRÊT (panne, surcharge) ---------------------------------------
-- Les colis déjà chargés chez le premier chauffeur restent « à récupérer » : le second les
-- scanne en les prenant (double scan), sans quoi il ne peut pas les livrer.
create or replace function public.lg_transfer_stop(p_stop uuid, p_to_trip uuid, p_event uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.lg_trip_stops; src public.lg_trips; dst public.lg_trips; res jsonb; v_seq int; n int; r record;
begin
  if not public.lg_has_role(array['dispatcher', 'dock_chief']) then raise exception 'forbidden'; end if;
  res := public.lg_idem_get(p_event); if res is not null then return res; end if;
  select * into s from public.lg_trip_stops where id = p_stop for update;
  if not found then raise exception 'unknown_stop'; end if;
  if s.status not in ('pending', 'en_route', 'arrived') then raise exception 'stop_closed'; end if;
  select * into src from public.lg_trips where id = s.trip_id for update;
  select * into dst from public.lg_trips where id = p_to_trip for update;
  if not found or dst.id = src.id or dst.status not in ('planned', 'loading', 'sealed', 'in_progress') then
    raise exception 'invalid_destination';
  end if;
  select coalesce(max(seq), 0) + 1 into v_seq from public.lg_trip_stops where trip_id = p_to_trip;
  update public.lg_trip_stops set trip_id = p_to_trip, seq = v_seq, status = 'pending', arrived_at = null where id = p_stop;
  -- colis : l'ancienne ligne est retirée, la nouvelle attend le scan de prise en charge
  -- d'abord retirer (un colis n'est que dans un seul voyage actif), puis rattacher
  n := 0;
  for r in update public.lg_trip_packages set outcome = 'removed' where trip_id = src.id and stop_id = p_stop and outcome is null
           returning package_id, loaded_at loop
    insert into public.lg_trip_packages (trip_id, package_id, stop_id, transfer_from)
    values (p_to_trip, r.package_id, p_stop, case when r.loaded_at is not null then src.id end);
    n := n + 1;
  end loop;
  -- re-numérotation du voyage d'origine
  with o as (select id, row_number() over (order by seq) rn from public.lg_trip_stops where trip_id = src.id)
  update public.lg_trip_stops x set seq = o.rn from o where o.id = x.id;
  perform public.lg_trip_refresh(src.id); perform public.lg_trip_refresh(p_to_trip);
  perform public.lg_trip_compute_eta(src.id); perform public.lg_trip_compute_eta(p_to_trip);
  if src.status = 'in_progress' then perform public.lg_advance_trip(src.id); end if;
  if dst.status = 'in_progress' then perform public.lg_advance_trip(p_to_trip); end if;
  perform public.lg_audit('stop_transfer', 'stop', p_stop::text, jsonb_build_object('from', src.number, 'to', dst.number));
  return public.lg_idem_put(p_event, 'transfer', jsonb_build_object('ok', true, 'packages', n,
    'to_take', (select count(*) from public.lg_trip_packages where trip_id = p_to_trip and stop_id = p_stop and transfer_from is not null)));
end; $$;

-- Prise en charge d'un colis transféré : par le chauffeur qui le reçoit (ou le chef de quai)
create or replace function public.lg_take_transfer(p_trip uuid, p_code text, p_event uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.lg_trips; p public.lg_packages; tp public.lg_trip_packages; res jsonb;
begin
  res := public.lg_idem_get(p_event); if res is not null then return res; end if;
  select * into t from public.lg_trips where id = p_trip for update;
  if not found then raise exception 'unknown_trip'; end if;
  if not (coalesce(public.lg_trip_courier_user(p_trip) = auth.uid(), false) or public.lg_has_role(array['dock_chief', 'dispatcher'])) then
    raise exception 'forbidden';
  end if;
  select * into p from public.lg_packages where code = public.lg_norm_code(p_code) for update;
  select * into tp from public.lg_trip_packages where trip_id = p_trip and package_id = p.id and outcome is null;
  if tp.package_id is null or tp.loaded_at is not null then
    return public.lg_idem_put(p_event, 'take', jsonb_build_object('ok', false, 'error', 'not_to_take'));
  end if;
  update public.lg_trip_packages set loaded_at = now(), loaded_by = auth.uid() where trip_id = p_trip and package_id = p.id;
  update public.lg_packages set holder_type = 'driver', holder_id = t.courier_id,
         status = case when t.status = 'in_progress' and p.direction = 'outbound' then 'out_for_delivery' else 'loaded' end,
         updated_at = now() where id = p.id;
  insert into public.lg_scan_events (client_event_id, package_id, event, actor_id, trip_id, device_at, meta)
  values (coalesce(p_event, gen_random_uuid()), p.id, 'load', auth.uid(), p_trip, now(),
          jsonb_build_object('transfer_from', tp.transfer_from));
  perform public.lg_trip_refresh(p_trip);
  return public.lg_idem_put(p_event, 'take', jsonb_build_object('ok', true, 'code', p.code));
end; $$;

-- 3. COLLECTE CHEZ LES VENDEURS (premier kilomètre) ------------------------------------
-- Un colis « à quai » sans lieu (hub_id nul) est prêt chez son vendeur.
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
           group by p.holder_id) s join public.profiles v on v.id = s.vendor_id);
end; $$;

create or replace function public.lg_trip_add_pickup(p_trip uuid, p_vendor uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.lg_trips; v public.profiles; v_stop uuid; n int;
begin
  if not public.lg_has_role(array['dispatcher', 'dock_chief']) then raise exception 'forbidden'; end if;
  select * into t from public.lg_trips where id = p_trip for update;
  if not found or t.status not in ('planned', 'loading', 'sealed', 'in_progress') then raise exception 'trip_not_open'; end if;
  select * into v from public.profiles where id = p_vendor;
  insert into public.lg_trip_stops (trip_id, seq, kind, contact_name, contact_phone, address, lat, lng)
  values (p_trip, (select coalesce(max(seq), 0) + 1 from public.lg_trip_stops where trip_id = p_trip), 'pickup',
          coalesce(v.shop_name, v.company_name, v.name), v.phone, v.address, v.home_lat, v.home_lng)
  returning id into v_stop;
  insert into public.lg_trip_packages (trip_id, package_id, stop_id)
  select p_trip, p.id, v_stop from public.lg_packages p
   where p.status = 'staged' and p.hub_id is null and p.holder_type = 'vendor' and p.holder_id = p_vendor
     and not exists (select 1 from public.lg_trip_packages tp where tp.package_id = p.id and tp.outcome is null);
  get diagnostics n = row_count;
  if n = 0 then delete from public.lg_trip_stops where id = v_stop; raise exception 'nothing_to_collect'; end if;
  if t.status = 'in_progress' then perform public.lg_trip_compute_eta(p_trip); end if;
  return jsonb_build_object('ok', true, 'stop_id', v_stop, 'packages', n);
end; $$;

-- 4. RETOUR DEMANDÉ PAR LE CLIENT ----------------------------------------------------------
-- Une demande approuvée (table return_requests du site) crée un colis « retour » et un arrêt
-- de reprise. Le chauffeur colle l'étiquette sur place (code lisible sur son écran).
create or replace function public.lg_returns_pending() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['dispatcher', 'dock_chief', 'support']) then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'order_id', r.order_id, 'order_short', upper(left(r.order_id::text, 8)),
            'customer', o.buyer_name, 'zone', o.delivery_zone, 'reason', coalesce(r.category, '') || coalesce(' — ' || r.description, ''),
            'created_at', r.created_at) order by r.created_at), '[]')
    from public.return_requests r join public.orders o on o.id = r.order_id
   where r.status = 'approved'
     and not exists (select 1 from public.lg_packages p where p.order_id = r.order_id and p.direction = 'return'));
end; $$;

create or replace function public.lg_trip_add_return(p_trip uuid, p_return uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.lg_trips; r public.return_requests; o public.orders; v_stop uuid; v_pkg uuid; v_code text;
begin
  if not public.lg_has_role(array['dispatcher', 'dock_chief']) then raise exception 'forbidden'; end if;
  select * into t from public.lg_trips where id = p_trip for update;
  if not found or t.status not in ('planned', 'loading', 'sealed', 'in_progress') then raise exception 'trip_not_open'; end if;
  select * into r from public.return_requests where id = p_return;
  if not found or r.status <> 'approved' then raise exception 'return_not_approved'; end if;
  if exists (select 1 from public.lg_packages where order_id = r.order_id and direction = 'return') then raise exception 'already_scheduled'; end if;
  select * into o from public.orders where id = r.order_id;
  v_code := public.lg_new_package_code();
  insert into public.lg_packages (code, order_id, direction, zone, status, holder_type, holder_id, hub_id)
  values (v_code, o.id, 'return', o.delivery_zone, 'created', 'customer', null, t.hub_id) returning id into v_pkg;
  insert into public.lg_package_items (package_id, order_item_id, quantity)
  select v_pkg, oi.id, greatest(coalesce(nullif(oi.picked_qty, 0), oi.quantity), 1) from public.order_items oi
   where oi.order_id = o.id and oi.line_status <> 'cancelled';
  insert into public.lg_trip_stops (trip_id, seq, kind, order_id, contact_name, contact_phone, address, landmark, lat, lng)
  values (p_trip, (select coalesce(max(seq), 0) + 1 from public.lg_trip_stops where trip_id = p_trip), 'return', o.id,
          o.buyer_name, o.buyer_phone, concat_ws(', ', o.delivery_zone, nullif(o.buyer_address, '')), o.landmark, o.delivery_lat, o.delivery_lng)
  returning id into v_stop;
  insert into public.lg_trip_packages (trip_id, package_id, stop_id) values (p_trip, v_pkg, v_stop);
  perform public.lg_notify('lg_return_scheduled', o.id, '{}');
  if t.status = 'in_progress' then perform public.lg_trip_compute_eta(p_trip); end if;
  return jsonb_build_object('ok', true, 'stop_id', v_stop, 'code', v_code);
end; $$;

-- 5. COLLECTE PAR LE CHAUFFEUR (vendeur ou client) -----------------------------------------
create or replace function public.lg_collect(p_stop uuid, p_event uuid, p_codes text[], p_photo_path text default null,
  p_lat double precision default null, p_lng double precision default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.lg_trip_stops; t public.lg_trips; res jsonb; v_expected text[]; v_given text[]; v_next uuid;
begin
  res := public.lg_idem_get(p_event); if res is not null then return res; end if;
  select * into s from public.lg_trip_stops where id = p_stop for update;
  if not found then raise exception 'unknown_stop'; end if;
  t := public.lg_assert_driver(s.trip_id);
  if t.status <> 'in_progress' then raise exception 'trip_not_in_progress'; end if;
  if s.kind not in ('pickup', 'return') then return jsonb_build_object('ok', false, 'error', 'not_a_pickup_stop'); end if;
  if s.status not in ('pending', 'en_route', 'arrived') then return jsonb_build_object('ok', false, 'error', 'stop_closed'); end if;
  select coalesce(array_agg(p.code order by p.code), '{}') into v_expected
    from public.lg_trip_packages tp join public.lg_packages p on p.id = tp.package_id where tp.stop_id = p_stop and tp.outcome is null;
  select coalesce(array_agg(distinct public.lg_norm_code(c) order by public.lg_norm_code(c)), '{}') into v_given from unnest(p_codes) c;
  if v_given <> v_expected then
    return jsonb_build_object('ok', false, 'error', 'package_mismatch', 'expected', to_jsonb(v_expected), 'given', to_jsonb(v_given));
  end if;
  if s.kind = 'return' and (public.lg_cfg('require_photo'))::text::boolean and p_photo_path is null then
    return jsonb_build_object('ok', false, 'error', 'photo_required');
  end if;
  if p_photo_path is not null then
    insert into public.lg_proofs (stop_id, kind, file_path, lat, lng, distance_m, created_by)
    values (p_stop, 'photo', p_photo_path, p_lat, p_lng, public.lg_distance_m(s.lat, s.lng, p_lat, p_lng), auth.uid());
  end if;
  update public.lg_trip_packages set loaded_at = now(), loaded_by = auth.uid() where stop_id = p_stop and outcome is null;
  update public.lg_packages p set status = 'loaded', holder_type = 'driver', holder_id = t.courier_id, updated_at = now()
    from public.lg_trip_packages tp where tp.package_id = p.id and tp.stop_id = p_stop and tp.outcome is null;
  insert into public.lg_scan_events (client_event_id, package_id, event, actor_id, trip_id, lat, lng, device_at, meta)
  select gen_random_uuid(), tp.package_id, 'load', auth.uid(), s.trip_id, p_lat, p_lng, now(), jsonb_build_object('collect', s.kind)
    from public.lg_trip_packages tp where tp.stop_id = p_stop and tp.outcome is null;
  update public.lg_trip_stops set status = 'delivered', completed_at = now(), arrived_at = coalesce(arrived_at, now()) where id = p_stop;
  perform public.lg_trip_refresh(s.trip_id);
  v_next := public.lg_advance_trip(s.trip_id);
  return public.lg_idem_put(p_event, 'collect', jsonb_build_object('ok', true, 'packages', cardinality(v_expected), 'next_stop', v_next));
end; $$;

-- 6. RÉCEPTION AU HUB (scan d'entrée, contrôle, pesée) --------------------------------------
create or replace function public.lg_receive(p_code text, p_event uuid, p_hub uuid default null, p_weight_g integer default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p public.lg_packages; tp public.lg_trip_packages; res jsonb; v_hub uuid;
begin
  if not public.lg_has_role(array['dock_chief', 'picker']) then raise exception 'forbidden'; end if;
  res := public.lg_idem_get(p_event); if res is not null then return res; end if;
  select * into p from public.lg_packages where code = public.lg_norm_code(p_code) for update;
  if not found then return public.lg_idem_put(p_event, 'receive', jsonb_build_object('ok', false, 'error', 'unknown_package')); end if;
  select * into tp from public.lg_trip_packages where package_id = p.id and outcome is null and loaded_at is not null;
  if tp.trip_id is null or p.status <> 'loaded' then
    return public.lg_idem_put(p_event, 'receive', jsonb_build_object('ok', false, 'error', 'not_in_transit_to_hub', 'status', p.status));
  end if;
  if exists (select 1 from public.couriers where id = p.holder_id and user_id = auth.uid()) then
    return public.lg_idem_put(p_event, 'receive', jsonb_build_object('ok', false, 'error', 'same_person'));
  end if;
  v_hub := coalesce(p_hub, (select hub_id from public.lg_staff_roles where user_id = auth.uid() and active and hub_id is not null limit 1),
                    (select hub_id from public.lg_trips where id = tp.trip_id));
  update public.lg_trip_packages set outcome = 'received' where trip_id = tp.trip_id and package_id = p.id;
  update public.lg_packages set status = case when p.direction = 'return' then 'returned_hub' else 'staged' end,
         holder_type = 'hub', holder_id = v_hub, hub_id = v_hub, weight_g = coalesce(p_weight_g, weight_g), updated_at = now()
   where id = p.id;
  insert into public.lg_scan_events (client_event_id, package_id, event, actor_id, trip_id, hub_id, device_at, meta)
  values (coalesce(p_event, gen_random_uuid()), p.id, 'receive', auth.uid(), tp.trip_id, v_hub, now(),
          jsonb_build_object('direction', p.direction, 'weight_g', p_weight_g));
  perform public.lg_trip_refresh(tp.trip_id);
  perform public.lg_try_reconcile(tp.trip_id);
  return public.lg_idem_put(p_event, 'receive', jsonb_build_object('ok', true, 'code', p.code, 'direction', p.direction,
    'zone', p.zone, 'next', case when p.direction = 'return' then 'return_vendor' else 'staged' end));
end; $$;
