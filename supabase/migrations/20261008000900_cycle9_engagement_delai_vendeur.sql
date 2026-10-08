-- =====================================================================
-- NEXUS LOGISTICS — cycle 9 · Engagement de délai des vendeurs (module 09, P2)
-- Le vendeur promet un délai de préparation ; il fixe l'heure limite de ses
-- commandes, il est mesuré (à l'heure / en retard), visible sur sa fiche, et
-- relancé automatiquement avant l'échéance puis en cas de retard.
-- L'engagement est EXPLICITE (une ligne par vendeur) : tant que le lieu de
-- préparation n'est pas tranché (chapitre 14), un vendeur sans engagement
-- garde l'heure limite par défaut et ne reçoit aucune relance.
-- =====================================================================

create table if not exists public.lg_vendor_commitments (
  vendor_id  uuid primary key references public.profiles(id) on delete cascade,
  prep_hours integer not null check (prep_hours between 1 and 96),
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);
-- une relance par commande et par étape (avant l'échéance, en retard)
create table if not exists public.lg_vendor_reminders_sent (
  task_id uuid not null references public.lg_pick_tasks(id) on delete cascade,
  stage   text not null check (stage in ('soon', 'late')),
  sent_at timestamptz not null default now(),
  primary key (task_id, stage)
);
alter table public.lg_vendor_commitments   enable row level security;
alter table public.lg_vendor_reminders_sent enable row level security;

insert into public.lg_message_templates (event_key, label, position, body_fr) values
 ('lg_vendor_prep_soon', 'Vendeur : commande à préparer bientôt', 13,
  'Bonjour {vendeur}, la commande {commande} doit être prête avant {heure} (votre engagement : {delai} h). Pensez à la préparer et à la remettre au livreur.'),
 ('lg_vendor_prep_late', 'Vendeur : commande en retard', 14,
  'Bonjour {vendeur}, la commande {commande} devait être prête à {heure}. Le client attend : préparez-la dès que possible ou signalez une rupture dans l''application.')
on conflict (event_key) do nothing;

-- 1. L'ENGAGEMENT FIXE L'HEURE LIMITE ---------------------------------------------------------
-- Une date promise au client (promised_at) reste prioritaire ; sinon, réception + délai promis.
create or replace function public.lg_trg_pick_task_cutoff() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_hours int; v_created timestamptz; v_promised timestamptz;
begin
  select prep_hours into v_hours from public.lg_vendor_commitments where vendor_id = new.vendor_id;
  if v_hours is null then return new; end if;
  select created_at, promised_at into v_created, v_promised from public.orders where id = new.order_id;
  if v_promised is null then
    new.cutoff_at := greatest(v_created, now()) + make_interval(hours => v_hours);
  end if;
  return new;
end; $$;
drop trigger if exists lg_pick_tasks_cutoff on public.lg_pick_tasks;
create trigger lg_pick_tasks_cutoff before insert on public.lg_pick_tasks
  for each row execute function public.lg_trg_pick_task_cutoff();

create or replace function public.lg_vendor_commitment_set(p_hours integer, p_vendor uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_vendor uuid := coalesce(p_vendor, auth.uid());
begin
  -- le vendeur s'engage pour lui-même ; l'administrateur ou le chef de quai pour n'importe quel vendeur
  if not (v_vendor = auth.uid() and exists (select 1 from public.profiles where id = auth.uid() and role = 'vendor'))
     and not public.lg_has_role(array['dock_chief']) then raise exception 'forbidden'; end if;
  if not exists (select 1 from public.profiles where id = v_vendor and role in ('vendor', 'admin')) then raise exception 'unknown_vendor'; end if;
  if p_hours is null then
    delete from public.lg_vendor_commitments where vendor_id = v_vendor;
  else
    if p_hours < 1 or p_hours > 96 then raise exception 'invalid_hours'; end if;
    insert into public.lg_vendor_commitments (vendor_id, prep_hours, updated_by) values (v_vendor, p_hours, auth.uid())
    on conflict (vendor_id) do update set prep_hours = excluded.prep_hours, updated_by = excluded.updated_by, updated_at = now();
  end if;
  perform public.lg_audit('vendor_commitment', 'profile', v_vendor::text, jsonb_build_object('prep_hours', p_hours));
  return jsonb_build_object('ok', true, 'vendor_id', v_vendor, 'prep_hours', p_hours);
end; $$;

-- 2. MESURE ---------------------------------------------------------------------------------
create or replace function public.lg_vendor_commitment_stats(p_vendor uuid, p_days integer default 30) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('vendor_id', p_vendor,
    'prep_hours', (select prep_hours from public.lg_vendor_commitments where vendor_id = p_vendor),
    'done', count(*) filter (where t.done_at is not null),
    'on_time', count(*) filter (where t.done_at <= t.cutoff_at),
    'on_time_pct', round(100.0 * count(*) filter (where t.done_at <= t.cutoff_at) / nullif(count(*) filter (where t.done_at is not null), 0), 1),
    'avg_hours', round((extract(epoch from avg(t.done_at - t.created_at)) / 3600)::numeric, 1),
    'open', (select count(*) from public.lg_pick_tasks o where o.vendor_id = p_vendor and o.status in ('todo', 'picking')),
    'open_late', (select count(*) from public.lg_pick_tasks o where o.vendor_id = p_vendor and o.status in ('todo', 'picking') and o.cutoff_at < now()),
    'reminders', (select count(*) from public.lg_vendor_reminders_sent r join public.lg_pick_tasks o on o.id = r.task_id
                   where o.vendor_id = p_vendor and r.sent_at > now() - make_interval(days => coalesce(p_days, 30))))
  from public.lg_pick_tasks t
  where t.vendor_id = p_vendor and t.status <> 'cancelled' and t.created_at > now() - make_interval(days => coalesce(p_days, 30))
$$;

-- Fiche du vendeur connecté : son engagement, sa ponctualité, ses commandes ouvertes et le temps restant
create or replace function public.lg_my_commitment() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('vendor', 'admin')) then raise exception 'forbidden'; end if;
  return public.lg_vendor_commitment_stats(auth.uid(), 30) || jsonb_build_object(
    'tasks', (select coalesce(jsonb_agg(jsonb_build_object('task_id', t.id, 'order_short', upper(left(t.order_id::text, 8)), 'status', t.status,
               'cutoff_at', t.cutoff_at, 'minutes_left', round(extract(epoch from t.cutoff_at - now()) / 60)) order by t.cutoff_at nulls last), '[]')
                from public.lg_pick_tasks t where t.vendor_id = auth.uid() and t.status in ('todo', 'picking')));
end; $$;

-- Tableau du chef de quai : tous les vendeurs engagés ou ayant eu des commandes
create or replace function public.lg_vendor_commitments_list(p_days integer default 30) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['dock_chief', 'dispatcher', 'support', 'accountant']) then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(public.lg_vendor_commitment_stats(v.id, p_days) || jsonb_build_object('name', coalesce(v.name, '—'))
            order by (select prep_hours from public.lg_vendor_commitments where vendor_id = v.id) nulls last, v.name), '[]')
    from public.profiles v
   where v.role = 'vendor' and (exists (select 1 from public.lg_vendor_commitments c where c.vendor_id = v.id)
          or exists (select 1 from public.lg_pick_tasks t where t.vendor_id = v.id and t.created_at > now() - make_interval(days => coalesce(p_days, 30)))));
end; $$;

-- 3. RELANCES AUTOMATIQUES (planificateur, à placer avec lg_watchdog) ----------------------
-- 2 h avant l'échéance, puis à l'échéance dépassée ; une seule fois par étape et par commande.
-- Seules les commandes non prises par le hub (personne, ou le vendeur lui-même) sont relancées.
create or replace function public.lg_vendor_reminders() returns jsonb
language plpgsql security definer set search_path = public as $$
declare r record; v_stage text; v_vars jsonb; n int := 0;
begin
  for r in select t.id, t.order_id, t.cutoff_at, t.vendor_id, c.prep_hours, p.name, p.email, coalesce(nullif(p.whatsapp_number, ''), p.phone) phone
             from public.lg_pick_tasks t join public.lg_vendor_commitments c on c.vendor_id = t.vendor_id
             join public.profiles p on p.id = t.vendor_id
            where t.status in ('todo', 'picking') and t.cutoff_at is not null and t.cutoff_at < now() + interval '2 hours'
              and (t.picker_id is null or t.picker_id = t.vendor_id) loop
    v_stage := case when r.cutoff_at <= now() then 'late' else 'soon' end;
    -- en retard sans avoir été prévenu avant : seulement le message de retard
    continue when exists (select 1 from public.lg_vendor_reminders_sent where task_id = r.id and stage = v_stage);
    insert into public.lg_vendor_reminders_sent (task_id, stage) values (r.id, v_stage);
    continue when exists (select 1 from public.lg_message_templates where event_key = 'lg_vendor_prep_' || v_stage and not active);
    v_vars := jsonb_build_object('vendeur', split_part(coalesce(r.name, ''), ' ', 1), 'commande', upper(left(r.order_id::text, 8)),
                                 'heure', to_char(r.cutoff_at at time zone 'Africa/Dakar', 'HH24"h"MI'), 'delai', r.prep_hours);
    insert into public.notification_outbox (event_key, recipient, vars)
    values ('lg_vendor_prep_' || v_stage, jsonb_build_object('phone', r.phone, 'email', r.email, 'userId', r.vendor_id),
            v_vars || jsonb_build_object('texte', public.lg_render_message('lg_vendor_prep_' || v_stage, v_vars)));
    n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'sent', n);
end; $$;
