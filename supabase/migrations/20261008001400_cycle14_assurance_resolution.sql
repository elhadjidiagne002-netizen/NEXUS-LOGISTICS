-- =====================================================================
-- NEXUS LOGISTICS — cycle 14 · Incidents : assurance colis et résolution (module 13, P2)
-- · Assurance : option payante à la commande (valeur déclarée → prime), proposée
--   par le devis au panier ; elle relève le plafond d'indemnisation.
-- · Plafond d'indemnisation : valeur assurée si assurée ; sinon valeur des
--   produits, limitée par le réglage uninsured_cap_fcfa (à valider, chapitre 14).
-- · Résolution : avoir automatique de l'indemnité (si la commande est facturée),
--   clôture avec l'accord du client — recueilli par le service client (téléphone)
--   ou donné par le client depuis sa page de suivi.
-- =====================================================================

alter table public.orders
  add column if not exists insured_value_fcfa integer check (insured_value_fcfa is null or insured_value_fcfa > 0),
  add column if not exists insurance_fee_fcfa integer not null default 0;
alter table public.lg_incidents
  add column if not exists customer_agreed_at  timestamptz,
  add column if not exists customer_refused_at timestamptz,
  add column if not exists agreement_via       text,
  add column if not exists credit_note_id      uuid;

insert into public.lg_message_templates (event_key, label, position, body_fr) values
 ('lg_incident_proposal', 'Proposition d''indemnisation', 15,
  'Bonjour {prenom}, suite au problème sur votre commande {commande}, nous vous proposons : {resolution}{indemnite}. Acceptez ou refusez ici : {lien}')
on conflict (event_key) do nothing;

-- Réglages : ajoute les clés d'assurance à la liste blanche
create or replace function public.lg_set_config(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_clean jsonb;
begin
  if not public.lg_is_admin() then raise exception 'forbidden'; end if;
  select coalesce(jsonb_object_agg(key, value), '{}') into v_clean from jsonb_each(p)
   where key in ('max_attempts', 'proof_radius_m', 'cash_limit_fcfa', 'pick_lock_minutes', 'tva_rate', 'detour_coef',
                 'otp_ttl_hours', 'otp_attempts', 'heavy_kg', 'require_photo', 'staged_max_hours', 'stop_max_minutes',
                 'offline_max_minutes', 'pay_per_package', 'pay_fixed_trip', 'bonus_zero_failure', 'tracking_base_url',
                 'invoice_issuer', 'manager_phone', 'eur_to_fcfa', 'double_check_fcfa', 'bonus_on_time', 'peak_days',
                 'expiry_alert_days', 'insurance_rate_pct', 'insurance_min_fcfa', 'insurance_max_value_fcfa', 'uninsured_cap_fcfa', 'manager_email', 'maintenance_alert_km');
  insert into public.app_config (key, value, updated_at) values ('nexus_logistics_cfg', v_clean, now())
  on conflict (key) do update set value = app_config.value || excluded.value, updated_at = now();
  perform public.lg_audit('config', 'app_config', 'nexus_logistics_cfg', v_clean);
  return jsonb_build_object('ok', true, 'config', (select value from public.app_config where key = 'nexus_logistics_cfg'));
end; $$;

-- 1. ASSURANCE -------------------------------------------------------------------------------
-- Prime : 2 % de la valeur déclarée, 300 F minimum ; valeur assurable jusqu'à 1 000 000 F (réglables)
create or replace function public.lg_insurance_fee(p_value integer) returns integer
language sql stable security definer set search_path = public as $$
  select case when p_value is null or p_value <= 0 then 0
              when p_value > coalesce((public.lg_cfg('insurance_max_value_fcfa'))::text::int, 1000000) then null
              else greatest(coalesce((public.lg_cfg('insurance_min_fcfa'))::text::int, 300),
                            round(p_value * coalesce((public.lg_cfg('insurance_rate_pct'))::text::numeric, 2) / 100)::int) end
$$;

-- Devis : paramètre facultatif de valeur déclarée (même calcul de livraison que le cycle 10)
drop function if exists public.lg_quote(text, integer, integer, text);
create or replace function public.lg_quote(p_zone text, p_weight_g integer, p_subtotal_fcfa integer default 0,
                                           p_service text default 'standard', p_declared_value_fcfa integer default null) returns jsonb
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
  v_fee int;
  v_price int;
begin
  select * into zs from public.lg_zone_settings where zone = p_zone;
  if zs.zone is not null and not zs.served then return jsonb_build_object('ok', false, 'error', 'zone_not_served'); end if;
  if not exists (select 1 from public.delivery_zones where name = p_zone) then
    return jsonb_build_object('ok', false, 'error', 'unknown_zone');
  end if;
  v_fee := public.lg_insurance_fee(p_declared_value_fcfa);
  if v_fee is null then return jsonb_build_object('ok', false, 'error', 'value_too_high',
    'max_value_fcfa', coalesce((public.lg_cfg('insurance_max_value_fcfa'))::text::int, 1000000)); end if;
  v_kind := case when p_weight_g <= 20000 then 'moto' when p_weight_g <= 150000 then 'tricycle' else 'fourgonnette' end;
  select * into rc from public.lg_rate_cards
   where active and service = coalesce(p_service, 'standard') and max_weight_g >= p_weight_g
     and (zone = p_zone or zone is null) and (vehicle_kind = v_kind or vehicle_kind is null)
   order by (zone is not null) desc, (vehicle_kind is not null) desc, max_weight_g asc limit 1;
  if rc.id is null then return jsonb_build_object('ok', false, 'error', 'no_rate'); end if;
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
  v_price := case when v_free then 0
                  else rc.price_fcfa + (select coalesce(sum((x ->> 'amount_fcfa')::int), 0) from jsonb_array_elements(v_sur) x) end;
  return jsonb_build_object('ok', true, 'zone', p_zone, 'service', rc.service, 'vehicle_kind', v_kind,
    'price_fcfa', v_price, 'base_fcfa', rc.price_fcfa, 'surcharges', v_sur,
    'free', v_free, 'free_above_fcfa', zs.free_above_fcfa, 'promised_at', v_promise,
    -- l'assurance est une ligne à part : la livraison offerte n'offre pas l'assurance
    'insured_value_fcfa', p_declared_value_fcfa, 'insurance_fee_fcfa', v_fee, 'total_fcfa', v_price + v_fee);
end; $$;

-- Assurer une commande déjà passée (commande par téléphone), tant que rien n'est chargé
create or replace function public.lg_order_insure(p_order uuid, p_value integer) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_fee int;
begin
  if not public.lg_has_role(array['support', 'dispatcher']) then raise exception 'forbidden'; end if;
  if exists (select 1 from public.lg_packages where order_id = p_order and status in ('loaded', 'out_for_delivery', 'delivered')) then
    return jsonb_build_object('ok', false, 'error', 'already_loaded');
  end if;
  v_fee := public.lg_insurance_fee(p_value);
  if v_fee is null then return jsonb_build_object('ok', false, 'error', 'value_too_high'); end if;
  update public.orders set insured_value_fcfa = nullif(p_value, 0), insurance_fee_fcfa = v_fee, updated_at = now() where id = p_order;
  if not found then raise exception 'unknown_order'; end if;
  perform public.lg_audit('order_insure', 'order', p_order::text, jsonb_build_object('value', p_value, 'fee', v_fee));
  return jsonb_build_object('ok', true, 'insured_value_fcfa', nullif(p_value, 0), 'insurance_fee_fcfa', v_fee);
end; $$;

-- 2. PLAFOND D'INDEMNISATION ----------------------------------------------------------------
create or replace function public.lg_incident_cap(p_incident uuid) returns integer
language sql stable security definer set search_path = public as $$
  select case when o.id is null then null           -- incident sans commande (véhicule, comportement…) : pas de plafond client
              when o.insured_value_fcfa is not null then o.insured_value_fcfa
              else least(public.lg_fcfa(o.total), coalesce((public.lg_cfg('uninsured_cap_fcfa'))::text::int, 50000)) end
    from public.lg_incidents i left join public.orders o on o.id = i.order_id where i.id = p_incident
$$;

-- 3. RÉSOLUTION ------------------------------------------------------------------------------
-- Une indemnité au client ne se clôt qu'avec son accord (p_customer_agreed, ou plus tard depuis
-- la page de suivi) ; sans accord, l'incident passe « résolu » et une proposition lui est envoyée.
drop function if exists public.lg_resolve_incident(uuid, text, integer, integer, boolean);
create or replace function public.lg_resolve_incident(p_id uuid, p_resolution text, p_compensation_fcfa integer default 0,
  p_deduction_fcfa integer default 0, p_close boolean default true, p_credit_note boolean default false,
  p_customer_agreed boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare i public.lg_incidents; v_cap int; v_comp int := coalesce(p_compensation_fcfa, 0); v_inv uuid; v_credit jsonb; v_close boolean;
begin
  if not public.lg_has_role(array['support', 'dispatcher']) then raise exception 'forbidden'; end if;
  select * into i from public.lg_incidents where id = p_id for update;
  if not found then raise exception 'unknown_incident'; end if;
  if i.status = 'closed' then return jsonb_build_object('ok', false, 'error', 'already_closed'); end if;
  if v_comp < 0 or coalesce(p_deduction_fcfa, 0) < 0 then raise exception 'invalid_amount'; end if;
  v_cap := public.lg_incident_cap(p_id);
  if v_comp > 0 and v_cap is not null and v_comp > v_cap then
    return jsonb_build_object('ok', false, 'error', 'over_cap', 'cap_fcfa', v_cap,
      'insured', (select insured_value_fcfa is not null from public.orders where id = i.order_id));
  end if;
  -- accord du client exigé pour clore une indemnité qui lui revient
  v_close := p_close and (v_comp = 0 or i.order_id is null or p_customer_agreed or i.customer_agreed_at is not null);
  update public.lg_incidents set resolution = p_resolution, compensation_fcfa = v_comp,
         deduction_fcfa = coalesce(p_deduction_fcfa, 0), status = case when v_close then 'closed' else 'resolved' end,
         customer_agreed_at = case when p_customer_agreed then coalesce(customer_agreed_at, now()) else customer_agreed_at end,
         agreement_via = case when p_customer_agreed then 'support' else agreement_via end,
         resolved_by = auth.uid(), resolved_at = now() where id = p_id;
  -- une retenue sur le chauffeur est tracée comme gain négatif
  if coalesce(p_deduction_fcfa, 0) > 0 and i.responsible_type = 'driver' and i.responsible_id is not null then
    insert into public.courier_earnings (courier_id, amount, type, status, payment_ref)
    values (i.responsible_id, -p_deduction_fcfa, 'payout', 'pending', 'retenue incident ' || i.number);
  end if;
  -- avoir de l'indemnité sur la facture de la commande (une seule fois)
  if p_credit_note and v_comp > 0 and i.credit_note_id is null and i.order_id is not null then
    select id into v_inv from public.invoices where order_id = i.order_id and type = 'buyer' and credit_of is null limit 1;
    if v_inv is not null then
      v_credit := public.lg_credit_note(v_inv, null, 'Indemnisation incident n° ' || i.number, v_comp);
      update public.lg_incidents set credit_note_id = (v_credit ->> 'id')::uuid where id = p_id;
    end if;
  end if;
  -- proposition au client à accepter depuis sa page de suivi
  if v_comp > 0 and i.order_id is not null and not v_close then
    perform public.lg_notify('lg_incident_proposal', i.order_id, jsonb_build_object('resolution', p_resolution,
      'indemnite', ' (indemnité de ' || to_char(v_comp, 'FM999G999G999') || ' F)'));
  end if;
  if i.kind = 'cash_gap' and v_close and i.trip_id is not null then perform public.lg_try_reconcile(i.trip_id); end if;
  perform public.lg_audit('incident_resolve', 'incident', i.number::text,
    jsonb_build_object('resolution', p_resolution, 'compensation', v_comp, 'closed', v_close));
  return jsonb_build_object('ok', true, 'closed', v_close, 'awaiting_customer', not v_close and p_close,
    'credit_note', v_credit ->> 'number', 'cap_fcfa', v_cap);
end; $$;

-- Le client répond depuis sa page de suivi (lien secret) : accepte (clôture) ou refuse (rouvert)
create or replace function public.lg_track_incidents(p_token uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare o public.orders;
begin
  o := public.lg_order_by_token(p_token);
  if o.id is null then return '[]'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'number', i.number, 'resolution', i.resolution,
            'compensation_fcfa', i.compensation_fcfa) order by i.created_at), '[]')
    from public.lg_incidents i where i.order_id = o.id and i.status = 'resolved' and i.compensation_fcfa > 0
     and i.customer_agreed_at is null and i.customer_refused_at is null);
end; $$;

create or replace function public.lg_track_incident_answer(p_token uuid, p_incident uuid, p_accept boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o public.orders; i public.lg_incidents;
begin
  o := public.lg_order_by_token(p_token);
  if o.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  select * into i from public.lg_incidents where id = p_incident and order_id = o.id for update;
  if not found or i.status <> 'resolved' or i.customer_agreed_at is not null or i.customer_refused_at is not null then
    return jsonb_build_object('ok', false, 'error', 'nothing_to_answer');
  end if;
  if p_accept then
    update public.lg_incidents set customer_agreed_at = now(), agreement_via = 'tracking', status = 'closed' where id = i.id;
  else
    update public.lg_incidents set customer_refused_at = now(), agreement_via = 'tracking', status = 'investigating' where id = i.id;
  end if;
  insert into public.audit_logs (actor_id, action, target_type, target_id, detail)
  values (null, 'lg.incident_customer_answer', 'incident', i.number::text, jsonb_build_object('accept', p_accept));
  return jsonb_build_object('ok', true, 'closed', p_accept);
end; $$;

create or replace function public.lg_incidents_list(p_status text default 'open') returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['support', 'dispatcher', 'dock_chief', 'cashier']) then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'id', i.id, 'number', i.number, 'kind', i.kind, 'severity', i.severity, 'status', i.status,
      'description', i.description, 'package', p.code, 'trip_number', t.number, 'order_short', upper(left(i.order_id::text, 4)),
      'responsible_type', i.responsible_type, 'created_at', i.created_at, 'due_at', i.due_at,
      'overdue', i.due_at < now() and i.status in ('open', 'investigating'),
      'resolution', i.resolution, 'compensation_fcfa', i.compensation_fcfa,
      'cap_fcfa', public.lg_incident_cap(i.id), 'insured_value_fcfa', o.insured_value_fcfa, 'has_order', i.order_id is not null,
      'customer_agreed_at', i.customer_agreed_at, 'customer_refused_at', i.customer_refused_at, 'agreement_via', i.agreement_via,
      'awaiting_customer', i.status = 'resolved' and i.compensation_fcfa > 0 and i.customer_agreed_at is null,
      'credit_note', (select invoice_number from public.invoices where id = i.credit_note_id)) order by i.created_at desc), '[]')
    from public.lg_incidents i left join public.lg_packages p on p.id = i.package_id left join public.lg_trips t on t.id = i.trip_id
    left join public.orders o on o.id = i.order_id
   where p_status is null or i.status = p_status or (p_status = 'open' and i.status in ('investigating', 'resolved')));
end; $$;
