-- =====================================================================
-- NEXUS LOGISTICS — cycle 21 · Détection automatique de l'arrivée (module 04, P2)
-- « Heure d'arrivée estimée … Détection automatique de l'arrivée sur place. »
-- Le téléphone envoie déjà sa position toutes les 10 s pendant la tournée
-- (lg_driver_ping). Quand le chauffeur est à moins de auto_arrive_m (80 m) de
-- l'arrêt en cours, avec un GPS assez précis (≤ 100 m), l'arrêt passe
-- « arrivé » sans qu'il ait à toucher l'écran — ce qui fait aussi tourner le
-- chronomètre de l'alerte « arrêt long ». Le bouton « Arrivé » reste disponible.
-- =====================================================================

alter table public.lg_trip_stops add column if not exists arrived_auto boolean not null default false;

create or replace function public.lg_driver_ping(p_lat double precision, p_lng double precision,
  p_accuracy_m integer default null, p_speed_kmh numeric default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_courier uuid := public.lg_my_courier_id(); v_trip uuid; v_last timestamptz; v_stored boolean := false;
        s public.lg_trip_stops; v_radius int := coalesce((public.lg_cfg('auto_arrive_m'))::text::int, 80);
begin
  if v_courier is null then raise exception 'not_a_courier'; end if;
  select id into v_trip from public.lg_trips where courier_id = v_courier and status = 'in_progress' limit 1;
  if v_trip is null then return jsonb_build_object('ok', true, 'stored', false, 'reason', 'off_duty'); end if;
  update public.profiles set current_lat = p_lat, current_lng = p_lng, location_updated_at = now() where id = auth.uid();
  select max(recorded_at) into v_last from public.lg_driver_positions where courier_id = v_courier;
  if v_last is null or v_last < now() - interval '55 seconds' then
    insert into public.lg_driver_positions (courier_id, trip_id, lat, lng, accuracy_m, speed_kmh)
    values (v_courier, v_trip, p_lat, p_lng, p_accuracy_m, p_speed_kmh);
    v_stored := true;
  end if;
  -- arrivée automatique sur l'arrêt en cours (GPS précis, rayon réglable, 0 = désactivé)
  if v_radius > 0 and p_lat is not null and coalesce(p_accuracy_m, 0) <= 100 then
    select * into s from public.lg_trip_stops where trip_id = v_trip and status = 'en_route' and lat is not null order by seq limit 1 for update;
    if found and public.lg_distance_m(s.lat, s.lng, p_lat, p_lng) <= v_radius then
      update public.lg_trip_stops set status = 'arrived', arrived_at = now(), arrived_auto = true where id = s.id;
      return jsonb_build_object('ok', true, 'stored', v_stored, 'arrived_stop', s.id, 'seq', s.seq);
    end if;
  end if;
  return jsonb_build_object('ok', true, 'stored', v_stored);
end; $$;
