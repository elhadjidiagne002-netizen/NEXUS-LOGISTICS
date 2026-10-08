-- =====================================================================
-- NEXUS LOGISTICS — cycle 22 · Appel de livreurs en renfort (module 04, P2 « Gestion des pics »)
-- La prévision (lg_forecast) signalait la sous-capacité ; rien ne permettait d'agir.
-- Le répartiteur lance un appel pour un jour ; chaque chauffeur actif reçoit le message
-- (WhatsApp, e-mail de secours) et répond depuis son application ; les réponses
-- remontent au répartiteur. Un appel par jour : le relancer met à jour le besoin.
-- =====================================================================

create table if not exists public.lg_reinforcement_calls (
  id         uuid primary key default gen_random_uuid(),
  day        date not null unique,
  needed     integer not null check (needed > 0),
  zones      text[] not null default '{}',
  note       text,
  status     text not null default 'open' check (status in ('open', 'closed')),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
create table if not exists public.lg_reinforcement_answers (
  call_id     uuid not null references public.lg_reinforcement_calls(id) on delete cascade,
  courier_id  uuid not null references public.couriers(id) on delete cascade,
  available   boolean,                 -- null = prévenu, pas encore répondu
  notified_at timestamptz not null default now(),
  answered_at timestamptz,
  primary key (call_id, courier_id)
);
alter table public.lg_reinforcement_calls   enable row level security;
alter table public.lg_reinforcement_answers enable row level security;

insert into public.lg_message_templates (event_key, label, position, body_fr) values
 ('lg_reinforcement', 'Appel de renfort (chauffeurs)', 16,
  'Bonjour {prenom}, NEXUS a besoin de livreurs en renfort le {jour}{zones}. Êtes-vous disponible ? Répondez dans l''application NEXUS Logistics (Ma journée).')
on conflict (event_key) do nothing;

create or replace function public.lg_reinforcement_call(p_day date, p_needed integer, p_zones text[] default '{}', p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c public.lg_reinforcement_calls; r record; v_vars jsonb; n int := 0;
begin
  if not public.lg_has_role(array['dispatcher']) then raise exception 'forbidden'; end if;
  if p_day < public.lg_today() then raise exception 'past_day'; end if;
  if coalesce(p_needed, 0) <= 0 then raise exception 'invalid_quantity'; end if;
  insert into public.lg_reinforcement_calls (day, needed, zones, note, created_by)
  values (p_day, p_needed, coalesce(p_zones, '{}'), nullif(trim(p_note), ''), auth.uid())
  on conflict (day) do update set needed = excluded.needed, zones = excluded.zones, note = excluded.note, status = 'open'
  returning * into c;
  -- chaque chauffeur actif non encore prévenu pour ce jour reçoit le message une fois
  for r in select co.id, co.name, co.phone, p.email from public.couriers co left join public.profiles p on p.id = co.user_id
            where co.status = 'active'
              and not exists (select 1 from public.lg_reinforcement_answers a where a.call_id = c.id and a.courier_id = co.id) loop
    insert into public.lg_reinforcement_answers (call_id, courier_id) values (c.id, r.id);
    if not exists (select 1 from public.lg_message_templates where event_key = 'lg_reinforcement' and not active) then
      v_vars := jsonb_build_object('prenom', split_part(coalesce(r.name, ''), ' ', 1),
                  'jour', to_char(p_day, 'DD/MM'), 'zones', case when cardinality(c.zones) > 0 then ' (' || array_to_string(c.zones, ', ') || ')' else '' end);
      insert into public.notification_outbox (event_key, recipient, vars)
      values ('lg_reinforcement', jsonb_strip_nulls(jsonb_build_object('phone', r.phone, 'email', r.email)),
              v_vars || jsonb_build_object('texte', public.lg_render_message('lg_reinforcement', v_vars)));
    end if;
    n := n + 1;
  end loop;
  perform public.lg_audit('reinforcement_call', 'day', p_day::text, jsonb_build_object('needed', p_needed, 'notified', n));
  return jsonb_build_object('ok', true, 'id', c.id, 'notified', n);
end; $$;

-- Chauffeur : appels ouverts pour aujourd'hui et les jours suivants, et sa réponse
create or replace function public.lg_my_reinforcements() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_courier uuid := public.lg_my_courier_id();
begin
  if v_courier is null then return '[]'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'day', c.day, 'zones', c.zones, 'note', c.note, 'available', a.available)
            order by c.day), '[]')
    from public.lg_reinforcement_calls c join public.lg_reinforcement_answers a on a.call_id = c.id and a.courier_id = v_courier
   where c.status = 'open' and c.day >= public.lg_today());
end; $$;

create or replace function public.lg_reinforcement_answer(p_call uuid, p_available boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_courier uuid := public.lg_my_courier_id();
begin
  if v_courier is null then raise exception 'not_a_courier'; end if;
  update public.lg_reinforcement_answers a set available = p_available, answered_at = now()
    from public.lg_reinforcement_calls c
   where a.call_id = p_call and a.courier_id = v_courier and c.id = a.call_id and c.status = 'open' and c.day >= public.lg_today();
  if not found then return jsonb_build_object('ok', false, 'error', 'call_closed'); end if;
  return jsonb_build_object('ok', true);
end; $$;

-- Répartiteur : réponses par jour
create or replace function public.lg_reinforcements(p_days integer default 7) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['dispatcher']) then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'day', c.day, 'needed', c.needed, 'zones', c.zones, 'note', c.note, 'status', c.status,
            'yes', (select count(*) from public.lg_reinforcement_answers a where a.call_id = c.id and a.available),
            'no', (select count(*) from public.lg_reinforcement_answers a where a.call_id = c.id and a.available = false),
            'waiting', (select count(*) from public.lg_reinforcement_answers a where a.call_id = c.id and a.available is null),
            'available', (select coalesce(jsonb_agg(jsonb_build_object('courier_id', co.id, 'name', co.name, 'phone', co.phone,
                            'vehicle', co.vehicle_type, 'at', a.answered_at) order by a.answered_at), '[]')
                            from public.lg_reinforcement_answers a join public.couriers co on co.id = a.courier_id
                           where a.call_id = c.id and a.available)) order by c.day), '[]')
    from public.lg_reinforcement_calls c
   where c.day between public.lg_today() and public.lg_today() + coalesce(p_days, 7));
end; $$;

create or replace function public.lg_reinforcement_close(p_call uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['dispatcher']) then raise exception 'forbidden'; end if;
  update public.lg_reinforcement_calls set status = 'closed' where id = p_call;
  if not found then raise exception 'unknown_call'; end if;
  return jsonb_build_object('ok', true);
end; $$;
