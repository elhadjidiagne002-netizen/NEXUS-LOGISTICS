-- =====================================================================
-- NEXUS LOGISTICS — 06 · Module 06 Suivi client et notifications
-- Page publique par lien unique (tracking_token), sans compte : ces
-- fonctions sont les SEULES ouvertes au rôle anon. Elles ne renvoient que
-- le nécessaire (chapitre 08 : « le client ne lit rien directement »).
-- =====================================================================

create table if not exists public.lg_ratings (
  order_id   uuid primary key references public.orders(id) on delete cascade,
  courier_id uuid references public.couriers(id),
  rating     smallint not null check (rating between 1 and 5),
  comment    text,
  created_at timestamptz not null default now()
);

create table if not exists public.lg_customer_requests (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references public.orders(id) on delete cascade,
  kind       text not null check (kind in ('reschedule', 'callback', 'help', 'address', 'third_party', 'stockout_choice')),
  payload    jsonb not null default '{}',
  channel    text not null default 'suivi' check (channel in ('suivi', 'whatsapp', 'support')),
  status     text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  handled_by uuid references public.profiles(id),
  handled_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists lg_customer_requests_open_idx on public.lg_customer_requests (status, created_at);

alter table public.lg_ratings enable row level security;
alter table public.lg_customer_requests enable row level security;

create or replace function public.lg_order_by_token(p_token uuid) returns public.orders
language sql stable security definer set search_path = public as $$
  select * from public.orders where tracking_token = p_token
$$;

-- PAGE DE SUIVI ------------------------------------------------------------------------------
create or replace function public.lg_track(p_token uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  o       public.orders;
  s       public.lg_trip_stops;
  t       public.lg_trips;
  v_pos   jsonb;
  v_before int;
  v_packed timestamptz;
  v_fail  record;
  v_inv   public.invoices;
  v_loaded boolean;
begin
  o := public.lg_order_by_token(p_token);
  if o.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  select st.* into s from public.lg_trip_stops st join public.lg_trips tr on tr.id = st.trip_id
   where st.order_id = o.id and st.kind = 'delivery' and st.status <> 'skipped' and tr.status <> 'cancelled'
   order by tr.created_at desc limit 1;
  if s.id is not null then select * into t from public.lg_trips where id = s.trip_id; end if;

  select min(created_at) into v_packed from public.lg_packages where order_id = o.id;
  select exists (select 1 from public.lg_packages where order_id = o.id
                  and status in ('loaded', 'out_for_delivery', 'delivered')) into v_loaded;
  select st.completed_at, r.label into v_fail from public.lg_trip_stops st join public.lg_failure_reasons r on r.code = st.failure_reason
   where st.order_id = o.id and st.status = 'failed' order by st.completed_at desc limit 1;
  select * into v_inv from public.invoices where order_id = o.id and type = 'buyer' and credit_of is null limit 1;

  -- position du livreur : seulement quand il roule vers CE client (chapitre 11)
  if t.status = 'in_progress' and s.status in ('en_route', 'arrived') then
    select jsonb_build_object('lat', p.current_lat, 'lng', p.current_lng, 'at', p.location_updated_at) into v_pos
      from public.couriers c join public.profiles p on p.id = c.user_id
     where c.id = t.courier_id and p.location_updated_at > now() - interval '15 minutes';
  end if;
  if t.status = 'in_progress' and s.status in ('pending', 'en_route') then
    select count(*) into v_before from public.lg_trip_stops where trip_id = t.id and seq < s.seq and status in ('pending', 'en_route', 'arrived');
  end if;

  return jsonb_build_object(
    'ok', true,
    'order', jsonb_build_object('short', upper(left(o.id::text, 8)), 'status', o.status, 'vendor', o.vendor_name,
                                'zone', o.delivery_zone, 'landmark', o.landmark, 'created_at', o.created_at,
                                'payment_method', o.payment_method, 'paid', coalesce(o.payment_status, '') = 'paid',
                                'promised_at', o.promised_at, 'has_position', o.delivery_lat is not null,
                                'first_name', split_part(coalesce(o.buyer_name, ''), ' ', 1)),
    'amount_due_fcfa', public.lg_order_due_fcfa(o.id),
    'steps', jsonb_build_array(
      jsonb_build_object('key', 'confirmed', 'label', 'Commande confirmée',
                         'at', coalesce(o.cod_confirmed_at, o.paid_at, case when o.payment_method <> 'cod' then o.created_at end)),
      jsonb_build_object('key', 'prepared', 'label', 'Colis préparé', 'at', v_packed),
      jsonb_build_object('key', 'shipped', 'label', 'En route', 'at', o.in_transit_at),
      jsonb_build_object('key', 'delivered', 'label', 'Livré', 'at', o.delivered_at)),
    'failure', case when v_fail.completed_at is not null and o.status <> 'delivered'
                    then jsonb_build_object('at', v_fail.completed_at, 'reason', v_fail.label) end,
    'delivery', case when s.id is not null then jsonb_build_object(
        'eta', s.eta, 'status', s.status, 'stops_before', v_before,
        'courier', (select split_part(name, ' ', 1) from public.couriers where id = t.courier_id),
        'courier_rating', (select rating_avg from public.couriers where id = t.courier_id),
        'position', v_pos, 'dest', case when s.lat is not null then jsonb_build_object('lat', s.lat, 'lng', s.lng) end) end,
    'can_confirm', o.payment_method = 'cod' and o.cod_confirmed_at is null and o.status not in ('cancelled', 'delivered'),
    'can_edit_address', not v_loaded and o.status not in ('cancelled', 'delivered'),
    'can_rate', o.status = 'delivered' and not exists (select 1 from public.lg_ratings where order_id = o.id),
    'invoice', case when v_inv.id is not null then jsonb_build_object('number', v_inv.invoice_number, 'ttc', v_inv.amount_ttc) end);
end; $$;

create or replace function public.lg_track_confirm(p_token uuid, p_yes boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o public.orders;
begin
  o := public.lg_order_by_token(p_token);
  if o.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if p_yes then
    return public.lg_confirm_cod_internal(o.id, 'suivi');
  end if;
  return public.lg_cancel_unconfirmed(o.id, 'Annulée par le client (page de suivi)');
end; $$;

-- Le client pose son épingle et un repère tant que rien n'est chargé
create or replace function public.lg_track_set_location(p_token uuid, p_lat double precision, p_lng double precision,
                                                        p_landmark text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o public.orders;
begin
  o := public.lg_order_by_token(p_token);
  if o.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if p_lat not between 12 and 17 or p_lng not between -18 and -11 then
    return jsonb_build_object('ok', false, 'error', 'outside_senegal');
  end if;
  if exists (select 1 from public.lg_packages where order_id = o.id and status in ('loaded', 'out_for_delivery', 'delivered')) then
    return jsonb_build_object('ok', false, 'error', 'already_loaded');
  end if;
  update public.orders set delivery_lat = p_lat, delivery_lng = p_lng,
         landmark = coalesce(nullif(trim(left(p_landmark, 200)), ''), landmark), updated_at = now()
   where id = o.id;
  update public.orders set delivery_zone = public.lg_order_zone(o.id) where id = o.id and delivery_zone is null;
  update public.lg_trip_stops st set lat = p_lat, lng = p_lng,
         landmark = coalesce(nullif(trim(left(p_landmark, 200)), ''), st.landmark)
    from public.lg_trips tr where tr.id = st.trip_id and st.order_id = o.id and tr.status in ('planned', 'loading');
  return jsonb_build_object('ok', true);
end; $$;

create or replace function public.lg_track_rate(p_token uuid, p_rating integer, p_comment text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o public.orders; v_courier uuid;
begin
  o := public.lg_order_by_token(p_token);
  if o.id is null or o.status <> 'delivered' then return jsonb_build_object('ok', false, 'error', 'not_delivered'); end if;
  if p_rating not between 1 and 5 then return jsonb_build_object('ok', false, 'error', 'invalid_rating'); end if;
  select t.courier_id into v_courier from public.lg_trip_stops s join public.lg_trips t on t.id = s.trip_id
   where s.order_id = o.id and s.status = 'delivered' order by s.completed_at desc limit 1;
  insert into public.lg_ratings (order_id, courier_id, rating, comment) values (o.id, v_courier, p_rating, left(p_comment, 500))
  on conflict (order_id) do nothing;
  if found and v_courier is not null then
    update public.couriers set rating_avg = round((rating_avg * rating_count + p_rating) / (rating_count + 1), 2),
           rating_count = rating_count + 1, updated_at = now() where id = v_courier;
  end if;
  if p_rating <= 2 then
    insert into public.lg_customer_requests (order_id, kind, payload)
    values (o.id, 'help', jsonb_build_object('reason', 'note_basse', 'rating', p_rating, 'comment', left(p_comment, 500)));
  end if;
  return jsonb_build_object('ok', true);
end; $$;

-- Après un échec, ou à tout moment : demande au service client (créneau, rappel, aide, tiers)
create or replace function public.lg_track_request(p_token uuid, p_kind text, p_payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public as $$
declare o public.orders; v_id uuid;
begin
  o := public.lg_order_by_token(p_token);
  if o.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if p_kind not in ('reschedule', 'callback', 'help', 'third_party') then return jsonb_build_object('ok', false, 'error', 'invalid_kind'); end if;
  if (select count(*) from public.lg_customer_requests where order_id = o.id and created_at > now() - interval '1 hour') >= 5 then
    return jsonb_build_object('ok', false, 'error', 'too_many_requests');
  end if;
  insert into public.lg_customer_requests (order_id, kind, payload)
  values (o.id, p_kind, coalesce(p_payload, '{}') - 'order_id') returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end; $$;

create or replace function public.lg_track_invoice(p_token uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare o public.orders; v_id uuid;
begin
  o := public.lg_order_by_token(p_token);
  if o.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  select id into v_id from public.invoices where order_id = o.id and type = 'buyer' and credit_of is null limit 1;
  if v_id is null then return jsonb_build_object('ok', false, 'error', 'no_invoice'); end if;
  return public.lg_invoice_doc(v_id) || jsonb_build_object('ok', true);
end; $$;

-- RÉPONSES WHATSAPP (annexe B) --------------------------------------------------------------
-- Appelée par le webhook entrant (service_role). Rattache la réponse au dernier message
-- logistique envoyé à ce numéro et agit : OUI/NON, 1-5, 1/2/3.
create or replace function public.lg_handle_reply(p_phone text, p_text text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  m    record;
  v    text := upper(trim(regexp_replace(coalesce(p_text, ''), '[^[:alnum:]]', '', 'g')));
  o    public.orders;
  res  jsonb;
begin
  select n.event_key, n.vars, n.created_at, (n.vars ->> 'lien') as lien into m
    from public.notification_outbox n
   where n.event_key in ('lg_cod_confirm', 'lg_delivered', 'lg_failed', 'lg_stockout')
     and public.lg_phone_key(n.recipient ->> 'phone') = public.lg_phone_key(p_phone)
     and n.created_at > now() - interval '7 days'
   order by n.created_at desc limit 1;
  if m.event_key is null then return jsonb_build_object('handled', false); end if;
  select * into o from public.orders
   where tracking_token::text = regexp_replace(m.lien, '^.*/', '') limit 1;
  if o.id is null then return jsonb_build_object('handled', false); end if;

  if m.event_key = 'lg_cod_confirm' then
    if v in ('OUI', 'WAW', 'YES', '1', 'OK') then
      res := public.lg_confirm_cod_internal(o.id, 'whatsapp');
      return jsonb_build_object('handled', true, 'action', 'confirmed', 'reply', 'Merci ! Votre commande est confirmée.');
    elsif v in ('NON', 'DEDET', 'NO', '2') then
      res := public.lg_cancel_unconfirmed(o.id, 'Annulée par le client (WhatsApp)');
      return jsonb_build_object('handled', true, 'action', 'cancelled', 'reply', 'C''est noté, votre commande est annulée.');
    end if;
  elsif m.event_key = 'lg_delivered' and v ~ '^[1-5]$' then
    perform public.lg_track_rate(o.tracking_token, v::int, null);
    return jsonb_build_object('handled', true, 'action', 'rated', 'reply', 'Merci pour votre note !');
  elsif m.event_key = 'lg_failed' and v in ('1', '2', '3') then
    insert into public.lg_customer_requests (order_id, kind, channel, payload)
    values (o.id, case v when '3' then 'callback' else 'reschedule' end, 'whatsapp',
            jsonb_build_object('choice', case v when '1' then 'demain' when '2' then 'autre_jour' else 'rappel' end));
    return jsonb_build_object('handled', true, 'action', 'request',
      'reply', case v when '1' then 'Entendu, nous repassons demain.' when '2' then 'Un conseiller vous contacte pour fixer le jour.'
                      else 'Un conseiller vous rappelle rapidement.' end);
  elsif m.event_key = 'lg_stockout' and v in ('1', '2', '3') then
    insert into public.lg_customer_requests (order_id, kind, channel, payload)
    values (o.id, 'stockout_choice', 'whatsapp', jsonb_build_object(
      'choice', case v when '1' then 'replace' when '2' then 'refund' else 'wait' end, 'line_id', m.vars ->> 'line_id'));
    return jsonb_build_object('handled', true, 'action', 'stockout_choice', 'reply', 'Merci, votre choix est enregistré.');
  end if;
  return jsonb_build_object('handled', false, 'expected', m.event_key);
end; $$;

-- File du service client
create or replace function public.lg_requests_list(p_status text default 'open') returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['support', 'dispatcher']) then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'kind', r.kind, 'payload', r.payload, 'channel', r.channel, 'status', r.status, 'created_at', r.created_at,
      'order_id', o.id, 'order_short', upper(left(o.id::text, 8)), 'customer', o.buyer_name, 'phone', o.buyer_phone,
      'order_status', o.status, 'zone', o.delivery_zone,
      'tracking_url', (public.lg_cfg('tracking_base_url') #>> '{}') || o.tracking_token) order by r.created_at), '[]')
    from public.lg_customer_requests r join public.orders o on o.id = r.order_id
   where r.status = coalesce(p_status, r.status));
end; $$;

create or replace function public.lg_request_done(p_id uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['support', 'dispatcher']) then raise exception 'forbidden'; end if;
  update public.lg_customer_requests set status = 'done', handled_by = auth.uid(), handled_at = now(),
         payload = payload || jsonb_build_object('note', p_note) where id = p_id and status = 'open';
  return jsonb_build_object('ok', found);
end; $$;
