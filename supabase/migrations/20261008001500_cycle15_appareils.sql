-- =====================================================================
-- NEXUS LOGISTICS — cycle 15 · Appareils (module 15, P2)
-- Liste des téléphones utilisés, déconnexion à distance, blocage d'un appareil
-- perdu. L'app envoie un identifiant d'appareil (en-tête x-lg-device, généré
-- une fois sur le téléphone) ; PostgREST le met à disposition dans
-- request.headers, et la session Supabase est dans request.jwt.claims.
-- Le blocage est appliqué CÔTÉ SERVEUR : les contrôles d'identité
-- (lg_has_role, lg_is_admin, lg_my_courier_id, lg_trip_courier_user)
-- échouent pour un appareil bloqué, ou pour la session révoquée — une
-- nouvelle connexion par mot de passe crée une nouvelle session, qui passe.
-- Sans en-tête (ancienne version de l'app) : comportement inchangé.
-- =====================================================================

create table if not exists public.lg_devices (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  device_id       text not null check (length(device_id) between 8 and 64),
  label           text,
  user_agent      text,
  session_id      text,                -- dernière session vue sur cet appareil
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  revoked_session text,                -- session coupée à distance (une reconnexion en crée une autre)
  revoked_at      timestamptz,
  blocked         boolean not null default false,  -- appareil perdu ou volé : plus rien ne passe
  blocked_at      timestamptz,
  blocked_by      uuid references public.profiles(id),
  unique (user_id, device_id)
);
alter table public.lg_devices enable row level security;

create or replace function public.lg_req_device() returns text language sql stable as $$
  select nullif(current_setting('request.headers', true), '')::json ->> 'x-lg-device'
$$;
create or replace function public.lg_req_session() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::json ->> 'session_id'
$$;

create or replace function public.lg_device_blocked() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.lg_req_device() is not null and exists (
    select 1 from public.lg_devices d where d.user_id = auth.uid() and d.device_id = public.lg_req_device()
       and (d.blocked or (d.revoked_session is not null and d.revoked_session = public.lg_req_session()))), false)
$$;

-- Contrôles d'identité : un appareil bloqué n'a plus aucun rôle
create or replace function public.lg_has_role(p_roles text[])
returns boolean language sql stable security definer set search_path = public as $$
  select not public.lg_device_blocked() and (
         exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
      or exists (select 1 from public.lg_staff_roles r
                  where r.user_id = auth.uid() and r.active and r.role = any (p_roles)));
$$;
create or replace function public.lg_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select not public.lg_device_blocked() and exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
$$;
create or replace function public.lg_my_courier_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.couriers where user_id = auth.uid() and not public.lg_device_blocked() order by created_at limit 1
$$;
create or replace function public.lg_trip_courier_user(p_trip uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select c.user_id from public.lg_trips t join public.couriers c on c.id = t.courier_id
   where t.id = p_trip and not public.lg_device_blocked()
$$;

-- L'app s'annonce à l'ouverture puis toutes les 5 minutes ; elle se déconnecte si la réponse l'exige
create or replace function public.lg_device_ping(p_device text, p_label text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.lg_devices; v_ua text := left(nullif(current_setting('request.headers', true), '')::json ->> 'user-agent', 300);
begin
  if auth.uid() is null then raise exception 'forbidden'; end if;
  if p_device is null or length(p_device) not between 8 and 64 then raise exception 'invalid_device'; end if;
  insert into public.lg_devices (user_id, device_id, label, user_agent, session_id)
  values (auth.uid(), p_device, nullif(trim(p_label), ''), v_ua, public.lg_req_session())
  on conflict (user_id, device_id) do update set last_seen_at = now(),
    label = coalesce(nullif(trim(excluded.label), ''), lg_devices.label), user_agent = coalesce(excluded.user_agent, lg_devices.user_agent),
    session_id = coalesce(excluded.session_id, lg_devices.session_id)
  returning * into d;
  if d.blocked then return jsonb_build_object('ok', false, 'error', 'device_blocked'); end if;
  if d.revoked_session is not null and d.revoked_session = public.lg_req_session() then
    return jsonb_build_object('ok', false, 'error', 'device_revoked');
  end if;
  return jsonb_build_object('ok', true, 'id', d.id);
end; $$;

-- Liste : l'administrateur voit tout ; chacun voit ses appareils
create or replace function public.lg_devices_list(p_user uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_admin boolean := public.lg_is_admin();
begin
  if auth.uid() is null or public.lg_device_blocked() then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'user_id', d.user_id, 'user', p.name, 'label', d.label,
            'user_agent', d.user_agent, 'first_seen_at', d.first_seen_at, 'last_seen_at', d.last_seen_at,
            'blocked', d.blocked, 'blocked_at', d.blocked_at, 'revoked_at', d.revoked_at,
            'this_device', d.device_id = public.lg_req_device() and d.user_id = auth.uid(),
            'active_session', d.session_id is not null and d.session_id is distinct from d.revoked_session)
            order by d.blocked desc, d.last_seen_at desc), '[]')
    from public.lg_devices d join public.profiles p on p.id = d.user_id
   where (v_admin and (p_user is null or d.user_id = p_user)) or d.user_id = auth.uid());
end; $$;

-- Déconnexion à distance : la session actuelle de l'appareil ne passe plus (l'administrateur ou le titulaire)
create or replace function public.lg_device_revoke(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.lg_devices;
begin
  select * into d from public.lg_devices where id = p_id for update;
  if not found then raise exception 'unknown_device'; end if;
  if not (public.lg_is_admin() or (d.user_id = auth.uid() and not public.lg_device_blocked())) then raise exception 'forbidden'; end if;
  if d.session_id is null then return jsonb_build_object('ok', false, 'error', 'no_session'); end if;
  update public.lg_devices set revoked_session = d.session_id, revoked_at = now() where id = p_id;
  perform public.lg_audit('device_revoke', 'device', p_id::text, jsonb_build_object('user', d.user_id, 'label', d.label));
  return jsonb_build_object('ok', true);
end; $$;

-- Blocage (appareil perdu ou volé) et déblocage : administrateur seulement
create or replace function public.lg_device_block(p_id uuid, p_blocked boolean default true) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.lg_devices;
begin
  if not public.lg_is_admin() then raise exception 'forbidden'; end if;
  select * into d from public.lg_devices where id = p_id for update;
  if not found then raise exception 'unknown_device'; end if;
  if p_blocked and d.user_id = auth.uid() and d.device_id = public.lg_req_device() then
    return jsonb_build_object('ok', false, 'error', 'cannot_block_self');
  end if;
  update public.lg_devices set blocked = coalesce(p_blocked, true), blocked_at = case when p_blocked then now() end,
         blocked_by = case when p_blocked then auth.uid() end where id = p_id;
  perform public.lg_audit(case when p_blocked then 'device_block' else 'device_unblock' end, 'device', p_id::text,
    jsonb_build_object('user', d.user_id, 'label', d.label));
  return jsonb_build_object('ok', true, 'blocked', coalesce(p_blocked, true));
end; $$;
