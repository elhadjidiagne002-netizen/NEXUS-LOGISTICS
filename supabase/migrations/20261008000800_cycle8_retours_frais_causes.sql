-- =====================================================================
-- NEXUS LOGISTICS — cycle 8 · Retours : frais et causes (module 08, P2)
-- Chaque retour reçoit une cause ; la cause dit qui supporte les frais
-- (vendeur, client, NEXUS, personne) et combien. Les frais sont CONSTATÉS
-- (lg_return_charges), pas encaissés : la retenue sur reversement ou la
-- facturation au client reste une décision humaine (chapitre 14).
-- Statistiques par motif, par vendeur, par quartier.
-- =====================================================================

create table if not exists public.lg_return_causes (
  code      text primary key,
  label     text not null,
  payer     text not null check (payer in ('vendor', 'customer', 'nexus', 'none')),
  fee_mode  text not null default 'none' check (fee_mode in ('none', 'delivery', 'fixed')),  -- delivery = frais de livraison de la commande
  fee_fcfa  integer not null default 0 check (fee_fcfa >= 0),
  active    boolean not null default true,
  position  smallint not null default 0
);
-- Valeurs proposées, modifiables par l'administrateur (à valider : chapitre 14)
insert into public.lg_return_causes (code, label, payer, fee_mode, position) values
  ('vendor_error',     'Erreur du vendeur (mauvais produit, taille, couleur)', 'vendor',   'delivery', 1),
  ('defective',        'Produit défectueux ou non conforme',                   'vendor',   'delivery', 2),
  ('transport_damage', 'Abîmé pendant le transport',                           'nexus',    'none',     3),
  ('changed_mind',     'Changement d''avis du client',                         'customer', 'delivery', 4),
  ('refused_at_door',  'Refus à la porte',                                     'customer', 'delivery', 5),
  ('customer_absent',  'Client absent ou injoignable',                         'customer', 'delivery', 6),
  ('other',            'Autre',                                                'none',     'none',     7)
on conflict (code) do nothing;

create table if not exists public.lg_return_charges (
  id          bigint generated always as identity primary key,
  package_id  uuid not null unique references public.lg_packages(id),
  order_id    uuid not null references public.orders(id),
  cause       text not null references public.lg_return_causes(code),
  payer       text not null,
  amount_fcfa integer not null default 0,
  vendor_id   uuid,
  zone        text,
  note        text,
  classified_by uuid references public.profiles(id),
  classified_at timestamptz not null default now()
);
create index if not exists lg_return_charges_at_idx on public.lg_return_charges (classified_at);

alter table public.lg_return_causes  enable row level security;
alter table public.lg_return_charges enable row level security;

-- Montant des frais d'une cause pour une commande
create or replace function public.lg_return_fee(p_cause text, p_order uuid) returns integer
language sql stable security definer set search_path = public as $$
  select case c.fee_mode when 'fixed' then c.fee_fcfa
                         when 'delivery' then coalesce((select delivery_fee_fcfa from public.orders where id = p_order), 0)
                         else 0 end
    from public.lg_return_causes c where c.code = p_cause
$$;

-- Cause suggérée : d'après le motif d'échec (colis non livré) ou la catégorie de la demande client
create or replace function public.lg_return_suggest(p_package uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when p.direction = 'return' then (
      select case when r.category || ' ' || r.description ~* '(d[ée]fect|cass|panne|ne marche|non conforme)' then 'defective'
                  when r.category || ' ' || r.description ~* '(mauvais|erreur|taille|couleur|pas le bon)' then 'vendor_error'
                  when r.category || ' ' || r.description ~* '(avis|plus besoin|ne veu)' then 'changed_mind' end
        from public.return_requests r where r.order_id = p.order_id order by r.created_at desc limit 1)
    else (select case s.failure_reason when 'refused' then 'refused_at_door' when 'damaged' then 'transport_damage'
                                       when 'wrong_product' then 'vendor_error' when 'absent' then 'customer_absent'
                                       when 'unreachable' then 'customer_absent' end
            from public.lg_trip_packages tp join public.lg_trip_stops s on s.id = tp.stop_id
           where tp.package_id = p.id and s.failure_reason is not null order by s.completed_at desc nulls last limit 1)
  end
  from public.lg_packages p where p.id = p_package
$$;

-- 1. RÉGLAGE DES CAUSES ---------------------------------------------------------------------
create or replace function public.lg_return_causes() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['dock_chief', 'support', 'accountant', 'dispatcher']) then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(to_jsonb(c) order by c.position, c.code), '[]') from public.lg_return_causes c);
end; $$;

create or replace function public.lg_return_cause_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_code text := lower(trim(p ->> 'code'));
begin
  if not public.lg_is_admin() then raise exception 'forbidden'; end if;
  if v_code is null or v_code !~ '^[a-z_]{2,40}$' then raise exception 'invalid_code'; end if;
  insert into public.lg_return_causes (code, label, payer, fee_mode, fee_fcfa, active, position)
  values (v_code, coalesce(nullif(trim(p ->> 'label'), ''), v_code), coalesce(p ->> 'payer', 'none'), coalesce(p ->> 'fee_mode', 'none'),
          coalesce((p ->> 'fee_fcfa')::int, 0), coalesce((p ->> 'active')::boolean, true),
          coalesce((p ->> 'position')::int, (select coalesce(max(position), 0) + 1 from public.lg_return_causes)))
  on conflict (code) do update set label = excluded.label, payer = excluded.payer, fee_mode = excluded.fee_mode,
    fee_fcfa = excluded.fee_fcfa, active = excluded.active,
    position = coalesce((p ->> 'position')::int, lg_return_causes.position);
  perform public.lg_audit('return_cause', 'lg_return_causes', v_code, p);
  return jsonb_build_object('ok', true, 'code', v_code);
end; $$;

-- 2. CLASSEMENT D'UN RETOUR (au contrôle ; reclassement possible, tracé) ---------------------
create or replace function public.lg_return_classify(p_code text, p_cause text, p_event uuid default null, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p public.lg_packages; o public.orders; c public.lg_return_causes; res jsonb; v_amount int;
begin
  if not public.lg_has_role(array['dock_chief', 'support']) then raise exception 'forbidden'; end if;
  res := public.lg_idem_get(p_event); if res is not null then return res; end if;
  select * into p from public.lg_packages where code = public.lg_norm_code(p_code);
  if not found then return public.lg_idem_put(p_event, 'return_classify', jsonb_build_object('ok', false, 'error', 'unknown_package')); end if;
  -- un colis client (direction retour) ou un colis sorti en livraison qui a échoué
  if not (p.direction = 'return' or p.attempts > 0 or p.status in ('returned_hub', 'returned_vendor')) then
    return public.lg_idem_put(p_event, 'return_classify', jsonb_build_object('ok', false, 'error', 'not_a_return'));
  end if;
  select * into c from public.lg_return_causes where code = p_cause and active;
  if not found then return public.lg_idem_put(p_event, 'return_classify', jsonb_build_object('ok', false, 'error', 'unknown_cause')); end if;
  select * into o from public.orders where id = p.order_id;
  v_amount := case when c.payer = 'none' then 0 else public.lg_return_fee(c.code, o.id) end;
  insert into public.lg_return_charges (package_id, order_id, cause, payer, amount_fcfa, vendor_id, zone, note, classified_by)
  values (p.id, o.id, c.code, c.payer, v_amount, o.vendor_id, coalesce(o.delivery_zone, o.shipping_city), nullif(trim(p_note), ''), auth.uid())
  on conflict (package_id) do update set cause = excluded.cause, payer = excluded.payer, amount_fcfa = excluded.amount_fcfa,
    note = excluded.note, classified_by = excluded.classified_by, classified_at = now();
  perform public.lg_audit('return_classify', 'package', p.code, jsonb_build_object('cause', c.code, 'payer', c.payer, 'amount_fcfa', v_amount));
  return public.lg_idem_put(p_event, 'return_classify', jsonb_build_object('ok', true, 'cause', c.code, 'payer', c.payer, 'amount_fcfa', v_amount));
end; $$;

-- 3. FILE DE CONTRÔLE : avec la cause suggérée ------------------------------------------------
create or replace function public.lg_returns_to_inspect() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['dock_chief', 'support']) then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('code', p.code, 'direction', p.direction, 'order_short', upper(left(p.order_id::text, 8)),
            'attempts', p.attempts, 'since', p.updated_at, 'vendor', o.vendor_name,
            'cause', (select cause from public.lg_return_charges where package_id = p.id),
            'suggested_cause', public.lg_return_suggest(p.id),
            'items', (select string_agg(coalesce(oi.product_name, '?') || ' × ' || pi.quantity, ', ') from public.lg_package_items pi
                       join public.order_items oi on oi.id = pi.order_item_id where pi.package_id = p.id)) order by p.updated_at), '[]')
    from public.lg_packages p join public.orders o on o.id = p.order_id
   where p.status = 'returned_hub' and (p.direction = 'return' or p.attempts >= (public.lg_cfg('max_attempts'))::text::int));
end; $$;

-- 4. STATISTIQUES -----------------------------------------------------------------------------
create or replace function public.lg_return_stats(p_from date default null, p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_fromd date := coalesce(p_from, public.lg_today() - 29);
        v_tod   date := coalesce(p_to, public.lg_today());
        v_from  timestamptz := v_fromd::timestamp at time zone 'Africa/Dakar';
        v_to    timestamptz := (v_tod + 1)::timestamp at time zone 'Africa/Dakar';
begin
  if not public.lg_has_role(array['dock_chief', 'support', 'accountant', 'dispatcher']) then raise exception 'forbidden'; end if;
  return (with ch as (select rc.*, coalesce(o.vendor_name, '—') vendor_name from public.lg_return_charges rc join public.orders o on o.id = rc.order_id
                       where rc.classified_at >= v_from and rc.classified_at < v_to),
    delivered as (select vendor_id, count(*) n from public.orders where delivered_at >= v_from and delivered_at < v_to group by vendor_id)
  select jsonb_build_object('from', v_fromd, 'to', v_tod,
    'totals', jsonb_build_object('returns', (select count(*) from ch),
        'vendor_fcfa', (select coalesce(sum(amount_fcfa), 0) from ch where payer = 'vendor'),
        'customer_fcfa', (select coalesce(sum(amount_fcfa), 0) from ch where payer = 'customer'),
        'nexus_fcfa', (select coalesce(sum(amount_fcfa), 0) from ch where payer = 'nexus'),
        -- colis revenus au quai sur la période et pas encore classés
        'unclassified', (select count(*) from public.lg_packages p where p.updated_at >= v_from and p.updated_at < v_to
                           and (p.direction = 'return' or p.attempts > 0)
                           and p.status in ('returned_hub', 'returned_vendor', 'damaged', 'cancelled')
                           and not exists (select 1 from public.lg_return_charges rc where rc.package_id = p.id))),
    'by_cause', (select coalesce(jsonb_agg(jsonb_build_object('cause', c.code, 'label', c.label, 'payer', c.payer, 'count', x.n, 'amount_fcfa', x.a)
                   order by x.n desc, c.position), '[]')
                   from (select cause, count(*) n, sum(amount_fcfa) a from ch group by cause) x join public.lg_return_causes c on c.code = x.cause),
    'by_vendor', (select coalesce(jsonb_agg(jsonb_build_object('vendor_id', x.vendor_id, 'name', x.name, 'count', x.n,
                    'vendor_fault', x.vf, 'amount_fcfa', x.a, 'delivered', coalesce(d.n, 0),
                    'return_pct', round(100.0 * x.n / nullif(coalesce(d.n, 0) + x.n, 0), 1)) order by x.n desc, x.name), '[]')
                    from (select vendor_id, max(vendor_name) name, count(*) n, count(*) filter (where payer = 'vendor') vf,
                                 coalesce(sum(amount_fcfa) filter (where payer = 'vendor'), 0) a from ch group by vendor_id) x
                    left join delivered d on d.vendor_id is not distinct from x.vendor_id),
    'by_zone', (select coalesce(jsonb_agg(jsonb_build_object('zone', coalesce(zone, '?'), 'count', n,
                  'causes', causes) order by n desc), '[]')
                  from (select zone, sum(k)::int n, jsonb_object_agg(cause, k) causes from (
                          select zone, cause, count(*) k from ch group by zone, cause) z group by zone) y)));
end; $$;
