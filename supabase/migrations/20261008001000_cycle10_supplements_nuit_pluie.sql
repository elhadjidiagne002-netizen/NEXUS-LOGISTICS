-- =====================================================================
-- NEXUS LOGISTICS — cycle 10 · Offres : suppléments nuit et forte pluie (module 12, P2)
-- Express, programmé et « gratuit au-delà de » existaient déjà (lg_quote).
-- Ajout : suppléments ajoutés au devis, DÉSACTIVÉS par défaut — aucun prix
-- ne change tant que l'administrateur n'en active pas un, ou que le
-- répartiteur ne déclare pas une forte pluie (pour quelques heures, zones choisies).
-- Une livraison offerte (gratuit au-delà de) reste offerte : pas de supplément.
-- =====================================================================

create table if not exists public.lg_surcharges (
  code        text primary key,
  label       text not null,
  amount_fcfa integer not null default 0 check (amount_fcfa >= 0),
  active      boolean not null default false,
  start_time  time,                 -- fenêtre horaire (heure de Dakar), peut passer minuit
  end_time    time,
  services    text[],               -- null = tous services
  zones       text[],               -- null = toutes zones
  until       timestamptz,          -- fin d'une déclaration (pluie) ; null = sans limite
  updated_by  uuid references public.profiles(id),
  updated_at  timestamptz not null default now()
);
alter table public.lg_surcharges enable row level security;
insert into public.lg_surcharges (code, label, amount_fcfa, start_time, end_time, services) values
  ('night', 'Supplément nuit', 1000, '20:00', '07:00', '{express}'),
  ('rain',  'Supplément forte pluie', 500, null, null, null)
on conflict (code) do nothing;

-- Suppléments qui s'appliquent maintenant à cette zone et ce service
create or replace function public.lg_surcharges_now(p_zone text, p_service text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('code', code, 'label', label, 'amount_fcfa', amount_fcfa) order by code), '[]')
    from public.lg_surcharges s, lateral (select (now() at time zone 'Africa/Dakar')::time t) n
   where s.active and s.amount_fcfa > 0
     and (s.until is null or s.until > now())
     and (s.services is null or coalesce(p_service, 'standard') = any (s.services))
     and (s.zones is null or p_zone = any (s.zones))
     and (s.start_time is null or s.end_time is null
          or (s.start_time <= s.end_time and n.t >= s.start_time and n.t < s.end_time)
          or (s.start_time > s.end_time and (n.t >= s.start_time or n.t < s.end_time)))
$$;

-- Devis au panier : identique au précédent, plus les suppléments
create or replace function public.lg_quote(p_zone text, p_weight_g integer, p_subtotal_fcfa integer default 0,
                                           p_service text default 'standard') returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  rc  public.lg_rate_cards;
  zs  public.lg_zone_settings;
  v_kind text;
  v_now timestamp := now() at time zone 'Africa/Dakar';
  v_day date;
  v_promise timestamptz;
  v_free boolean;
  v_sur jsonb;
begin
  select * into zs from public.lg_zone_settings where zone = p_zone;
  if zs.zone is not null and not zs.served then return jsonb_build_object('ok', false, 'error', 'zone_not_served'); end if;
  if not exists (select 1 from public.delivery_zones where name = p_zone) then
    return jsonb_build_object('ok', false, 'error', 'unknown_zone');
  end if;
  v_kind := case when p_weight_g <= 20000 then 'moto' when p_weight_g <= 150000 then 'tricycle' else 'fourgonnette' end;
  select * into rc from public.lg_rate_cards
   where active and service = coalesce(p_service, 'standard') and max_weight_g >= p_weight_g
     and (zone = p_zone or zone is null) and (vehicle_kind = v_kind or vehicle_kind is null)
   order by (zone is not null) desc, (vehicle_kind is not null) desc, max_weight_g asc limit 1;
  if rc.id is null then return jsonb_build_object('ok', false, 'error', 'no_rate'); end if;
  -- délai promis : jour de livraison ouvert suivant l'heure limite
  v_day := v_now::date + case when v_now::time > coalesce(zs.cutoff_time, '12:00') then 1 else 0 end
                       + ceil(greatest(rc.lead_hours - 24, 0) / 24.0)::int;
  for i in 0..7 loop
    exit when extract(dow from v_day)::smallint = any (coalesce(zs.delivery_days, '{1,2,3,4,5,6}'));
    v_day := v_day + 1;
  end loop;
  v_promise := (v_day + time '19:00') at time zone 'Africa/Dakar';
  if rc.service = 'express' then v_promise := least(v_promise, now() + make_interval(hours => rc.lead_hours)); end if;
  v_free := zs.free_above_fcfa is not null and p_subtotal_fcfa >= zs.free_above_fcfa;
  v_sur := case when v_free then '[]'::jsonb else public.lg_surcharges_now(p_zone, rc.service) end;
  return jsonb_build_object('ok', true, 'zone', p_zone, 'service', rc.service, 'vehicle_kind', v_kind,
    'price_fcfa', case when v_free then 0
                       else rc.price_fcfa + (select coalesce(sum((x ->> 'amount_fcfa')::int), 0) from jsonb_array_elements(v_sur) x) end,
    'base_fcfa', rc.price_fcfa, 'surcharges', v_sur,
    'free', v_free, 'free_above_fcfa', zs.free_above_fcfa, 'promised_at', v_promise);
end; $$;

-- Réglage (administrateur)
create or replace function public.lg_surcharges_list() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['dispatcher']) then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(to_jsonb(s) || jsonb_build_object('in_force', s.active and (s.until is null or s.until > now()))
            order by s.code), '[]') from public.lg_surcharges s);
end; $$;

create or replace function public.lg_surcharge_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_code text := lower(trim(p ->> 'code'));
begin
  if not public.lg_is_admin() then raise exception 'forbidden'; end if;
  if v_code is null or v_code !~ '^[a-z_]{2,30}$' then raise exception 'invalid_code'; end if;
  insert into public.lg_surcharges (code, label, amount_fcfa, active, start_time, end_time, services, zones, updated_by)
  values (v_code, coalesce(nullif(trim(p ->> 'label'), ''), v_code), coalesce((p ->> 'amount_fcfa')::int, 0),
          coalesce((p ->> 'active')::boolean, false), nullif(p ->> 'start_time', '')::time, nullif(p ->> 'end_time', '')::time,
          case when jsonb_typeof(p -> 'services') = 'array' then array(select jsonb_array_elements_text(p -> 'services')) end,
          case when jsonb_typeof(p -> 'zones') = 'array' then array(select jsonb_array_elements_text(p -> 'zones')) end, auth.uid())
  on conflict (code) do update set label = excluded.label, amount_fcfa = excluded.amount_fcfa, active = excluded.active,
    start_time = excluded.start_time, end_time = excluded.end_time, services = excluded.services, zones = excluded.zones,
    updated_by = excluded.updated_by, updated_at = now();
  perform public.lg_audit('surcharge', 'lg_surcharges', v_code, p);
  return jsonb_build_object('ok', true, 'code', v_code);
end; $$;

-- Forte pluie : le répartiteur déclare (ou lève) le supplément pour quelques heures et des zones
create or replace function public.lg_surcharge_declare(p_code text, p_hours integer, p_zones text[] default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.lg_surcharges;
begin
  if not public.lg_has_role(array['dispatcher']) then raise exception 'forbidden'; end if;
  select * into s from public.lg_surcharges where code = p_code for update;
  if not found then raise exception 'unknown_surcharge'; end if;
  if coalesce(p_hours, 0) <= 0 then
    update public.lg_surcharges set active = false, until = null, updated_by = auth.uid(), updated_at = now() where code = p_code;
  else
    if p_hours > 24 then raise exception 'invalid_hours'; end if;
    update public.lg_surcharges set active = true, until = now() + make_interval(hours => p_hours),
           zones = nullif(p_zones, '{}'), updated_by = auth.uid(), updated_at = now() where code = p_code;
  end if;
  perform public.lg_audit('surcharge_declare', 'lg_surcharges', p_code, jsonb_build_object('hours', p_hours, 'zones', p_zones));
  return jsonb_build_object('ok', true, 'code', p_code, 'until', (select until from public.lg_surcharges where code = p_code));
end; $$;
