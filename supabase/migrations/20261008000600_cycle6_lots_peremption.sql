-- =====================================================================
-- NEXUS LOGISTICS — cycle 6 · Lots et dates de péremption (module 01, P2)
-- Rangement par lot, prélèvement « premier périmé, premier sorti » (FEFO),
-- mise au rebut motivée, traçabilité : quels clients ont reçu le lot X (rappel).
-- Invariant : dans un emplacement, somme(lots) <= lg_product_locations.qty
-- (le reste = stock non loti, rangé avant les lots ou sans date).
-- =====================================================================

create table if not exists public.lg_stock_lots (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references public.products(id) on delete cascade,
  location_id uuid not null references public.lg_stock_locations(id) on delete cascade,
  lot_code    text,
  expires_on  date,
  qty         integer not null default 0 check (qty >= 0),
  received_at timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (lot_code is not null or expires_on is not null)
);
create unique index if not exists lg_stock_lots_key
  on public.lg_stock_lots (product_id, location_id, coalesce(lot_code, ''), coalesce(expires_on, 'infinity'::date));
create index if not exists lg_stock_lots_expiry_idx on public.lg_stock_lots (expires_on) where qty > 0;

-- Mouvements de lot (quantité signée) : base de la traçabilité
create table if not exists public.lg_lot_moves (
  id           bigint generated always as identity primary key,
  lot_id       uuid not null references public.lg_stock_lots(id) on delete cascade,
  kind         text not null check (kind in ('in', 'pick', 'adjust', 'discard')),
  qty          integer not null,
  pick_line_id uuid references public.lg_pick_lines(id) on delete set null,
  reason       text,
  by_user      uuid references public.profiles(id),
  at           timestamptz not null default now()
);
create index if not exists lg_lot_moves_lot_idx on public.lg_lot_moves (lot_id);

alter table public.lg_stock_lots enable row level security;
alter table public.lg_lot_moves  enable row level security;

-- Jour calendaire de Dakar et état d'un lot
create or replace function public.lg_today() returns date language sql stable as $$
  select (now() at time zone 'Africa/Dakar')::date
$$;

create or replace function public.lg_expiry_days() returns integer language sql stable security definer set search_path = public as $$
  select coalesce((public.lg_cfg('expiry_alert_days'))::text::int, 30)
$$;

create or replace function public.lg_lot_state(p_expires date) returns text language sql stable security definer set search_path = public as $$
  select case when p_expires is null then 'ok' when p_expires < public.lg_today() then 'expired'
              when p_expires <= public.lg_today() + public.lg_expiry_days() then 'soon' else 'ok' end
$$;

-- Réglage : ajoute expiry_alert_days à la liste blanche
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
                 'expiry_alert_days');
  insert into public.app_config (key, value, updated_at) values ('nexus_logistics_cfg', v_clean, now())
  on conflict (key) do update set value = app_config.value || excluded.value, updated_at = now();
  perform public.lg_audit('config', 'app_config', 'nexus_logistics_cfg', v_clean);
  return jsonb_build_object('ok', true, 'config', (select value from public.app_config where key = 'nexus_logistics_cfg'));
end; $$;

-- 1. CHOIX DE L'EMPLACEMENT (FEFO) ----------------------------------------------------------
-- Vendable = quantité de l'emplacement moins les lots périmés.
create or replace function public.lg_loc_sellable(p_product uuid, p_location uuid) returns integer
language sql stable security definer set search_path = public as $$
  select greatest(coalesce((select qty from public.lg_product_locations where product_id = p_product and location_id = p_location), 0)
    - coalesce((select sum(qty) from public.lg_stock_lots where product_id = p_product and location_id = p_location
                   and expires_on < public.lg_today()), 0), 0)::int
$$;

-- L'emplacement où prélever : du vendable, le lot valide qui périme le plus tôt, puis le plus garni
create or replace function public.lg_pick_location_id(p_product uuid, p_hub uuid default null) returns uuid
language sql stable security definer set search_path = public as $$
  select l.id from public.lg_product_locations pl join public.lg_stock_locations l on l.id = pl.location_id
   where pl.product_id = p_product and l.active and (p_hub is null or l.hub_id = p_hub)
   order by (pl.qty > 0) desc, (public.lg_loc_sellable(pl.product_id, pl.location_id) > 0) desc,
            (select min(s.expires_on) from public.lg_stock_lots s where s.product_id = pl.product_id and s.location_id = pl.location_id
               and s.qty > 0 and s.expires_on >= public.lg_today()) nulls last,
            pl.qty desc, l.code
   limit 1
$$;

create or replace function public.lg_product_location(p_product uuid, p_hub uuid default null) returns text
language sql stable security definer set search_path = public as $$
  select code from public.lg_stock_locations where id = public.lg_pick_location_id(p_product, p_hub)
$$;

-- Le lot à prendre en premier dans un emplacement (consigne affichée au préparateur)
create or replace function public.lg_lot_hint(p_product uuid, p_location uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('lot', s.lot_code, 'expires_on', s.expires_on, 'state', public.lg_lot_state(s.expires_on))
    from public.lg_stock_lots s
   where s.product_id = p_product and s.location_id = p_location and s.qty > 0
     and coalesce(s.expires_on, 'infinity'::date) >= public.lg_today()
   order by s.expires_on nulls last, s.received_at limit 1
$$;

-- 2. RANGEMENT PAR LOT ----------------------------------------------------------------------
drop function if exists public.lg_put_away(text, text, integer, uuid);
create or replace function public.lg_put_away(p_product_code text, p_location_code text, p_qty integer, p_event uuid default null,
                                              p_lot text default null, p_expires_on date default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare pr public.products; loc public.lg_stock_locations; res jsonb; c text := upper(trim(p_product_code));
        v_lot text := nullif(upper(trim(coalesce(p_lot, ''))), ''); v_lot_id uuid;
begin
  if not public.lg_has_role(array['picker', 'dock_chief']) then raise exception 'forbidden'; end if;
  res := public.lg_idem_get(p_event); if res is not null then return res; end if;
  select * into pr from public.products where upper(barcode) = c or upper(sku) = c or 'NXI-' || upper(left(id::text, 8)) = c limit 1;
  if not found then return public.lg_idem_put(p_event, 'put_away', jsonb_build_object('ok', false, 'error', 'unknown_product')); end if;
  select * into loc from public.lg_stock_locations where code = upper(trim(p_location_code)) and active
   order by (hub_id = (select hub_id from public.lg_staff_roles where user_id = auth.uid() and hub_id is not null limit 1)) desc nulls last limit 1;
  if not found then return public.lg_idem_put(p_event, 'put_away', jsonb_build_object('ok', false, 'error', 'unknown_location')); end if;
  if p_qty is null or p_qty <= 0 then raise exception 'invalid_quantity'; end if;
  -- on ne range pas une marchandise déjà périmée : elle repart chez le vendeur
  if p_expires_on is not null and p_expires_on < public.lg_today() then
    return public.lg_idem_put(p_event, 'put_away', jsonb_build_object('ok', false, 'error', 'expired_lot'));
  end if;
  insert into public.lg_product_locations (product_id, location_id, qty) values (pr.id, loc.id, p_qty)
  on conflict (product_id, location_id) do update set qty = lg_product_locations.qty + excluded.qty, updated_at = now();
  if v_lot is not null or p_expires_on is not null then
    insert into public.lg_stock_lots (product_id, location_id, lot_code, expires_on, qty)
    values (pr.id, loc.id, v_lot, p_expires_on, p_qty)
    on conflict (product_id, location_id, coalesce(lot_code, ''), coalesce(expires_on, 'infinity'::date))
    do update set qty = lg_stock_lots.qty + excluded.qty, updated_at = now()
    returning id into v_lot_id;
    insert into public.lg_lot_moves (lot_id, kind, qty, by_user) values (v_lot_id, 'in', p_qty, auth.uid());
  end if;
  perform public.lg_audit('put_away', 'product', pr.id::text,
    jsonb_build_object('location', loc.code, 'qty', p_qty, 'lot', v_lot, 'expires_on', p_expires_on));
  return public.lg_idem_put(p_event, 'put_away', jsonb_build_object('ok', true, 'product', pr.name, 'location', loc.code,
    'qty', (select qty from public.lg_product_locations where product_id = pr.id and location_id = loc.id),
    'lot', v_lot, 'expires_on', p_expires_on, 'state', public.lg_lot_state(p_expires_on)));
end; $$;

-- 3. PRÉLÈVEMENT FEFO -----------------------------------------------------------------------
-- Les lots datés valides partent du plus proche de sa date ; puis le stock non loti ;
-- un lot périmé n'est consommé qu'en dernier recours (et le mouvement le dit).
create or replace function public.lg_trg_pick_location() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_loc uuid; v_hub uuid; v_need int; v_free int; s record; v_take int;
begin
  if new.qty_picked > old.qty_picked then
    v_need := new.qty_picked - old.qty_picked;
    select hub_id into v_hub from public.lg_pick_tasks where id = new.task_id;
    v_loc := public.lg_pick_location_id(new.product_id, v_hub);
    if v_loc is not null and exists (select 1 from public.lg_product_locations where product_id = new.product_id and location_id = v_loc and qty > 0) then
      -- stock non loti de l'emplacement
      select greatest(pl.qty - coalesce((select sum(qty) from public.lg_stock_lots where product_id = pl.product_id and location_id = pl.location_id), 0), 0)
        into v_free from public.lg_product_locations pl where pl.product_id = new.product_id and pl.location_id = v_loc;
      for s in select id, qty, expires_on from public.lg_stock_lots
                where product_id = new.product_id and location_id = v_loc and qty > 0
                order by case when expires_on < public.lg_today() then 1 else 0 end, expires_on nulls last, received_at for update loop
        exit when v_need <= 0;
        -- périmé : seulement si le non loti ne suffit pas
        if s.expires_on < public.lg_today() then
          v_need := v_need - least(v_free, v_need); v_free := 0;
          exit when v_need <= 0;
        end if;
        v_take := least(s.qty, v_need);
        update public.lg_stock_lots set qty = qty - v_take, updated_at = now() where id = s.id;
        insert into public.lg_lot_moves (lot_id, kind, qty, pick_line_id, reason, by_user)
        values (s.id, 'pick', -v_take, new.id, case when s.expires_on < public.lg_today() then 'expired_picked' end, auth.uid());
        v_need := v_need - v_take;
      end loop;
      update public.lg_product_locations set qty = greatest(qty - (new.qty_picked - old.qty_picked), 0), updated_at = now()
       where product_id = new.product_id and location_id = v_loc;
    end if;
  end if;
  return new;
end; $$;

-- 4. COHÉRENCE : un emplacement qui baisse (inventaire, rebut…) ne peut garder plus de lots que d'unités
-- Ordre de réduction : périmés d'abord, puis du plus ancien au plus récent.
create or replace function public.lg_trg_location_lots_clamp() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_over int; s record; v_take int;
begin
  if new.qty >= old.qty then return new; end if;
  select coalesce(sum(qty), 0) - new.qty into v_over from public.lg_stock_lots where product_id = new.product_id and location_id = new.location_id;
  if v_over <= 0 then return new; end if;
  for s in select id, qty from public.lg_stock_lots where product_id = new.product_id and location_id = new.location_id and qty > 0
            order by (expires_on < public.lg_today()) desc nulls last, expires_on nulls last, received_at for update loop
    exit when v_over <= 0;
    v_take := least(s.qty, v_over);
    update public.lg_stock_lots set qty = qty - v_take, updated_at = now() where id = s.id;
    insert into public.lg_lot_moves (lot_id, kind, qty, reason, by_user) values (s.id, 'adjust', -v_take, 'inventory', auth.uid());
    v_over := v_over - v_take;
  end loop;
  return new;
end; $$;
drop trigger if exists lg_product_locations_lots_clamp on public.lg_product_locations;
create trigger lg_product_locations_lots_clamp after update of qty on public.lg_product_locations
  for each row execute function public.lg_trg_location_lots_clamp();

-- 5. PÉREMPTION : liste, rebut ----------------------------------------------------------------
-- Lots périmés ou qui périment sous p_days jours (réglage expiry_alert_days par défaut).
-- Un vendeur voit les lots de ses produits.
create or replace function public.lg_lots_expiring(p_days integer default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_staff boolean := public.lg_has_role(array['picker', 'dock_chief', 'support']);
        v_days int := coalesce(p_days, public.lg_expiry_days());
begin
  if not v_staff and not exists (select 1 from public.profiles where id = auth.uid() and role = 'vendor') then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'product_id', p.id, 'product', p.name, 'barcode', p.barcode,
            'vendor', p.vendor_name, 'location', l.code, 'lot', s.lot_code, 'expires_on', s.expires_on, 'qty', s.qty,
            'days_left', s.expires_on - public.lg_today(), 'state', public.lg_lot_state(s.expires_on))
            order by s.expires_on, p.name), '[]')
    from public.lg_stock_lots s join public.products p on p.id = s.product_id join public.lg_stock_locations l on l.id = s.location_id
   where s.qty > 0 and s.expires_on <= public.lg_today() + v_days
     and (v_staff or p.vendor_id = auth.uid()));
end; $$;

create or replace function public.lg_lot_discard(p_lot uuid, p_qty integer, p_reason text, p_event uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.lg_stock_lots; res jsonb;
begin
  if not public.lg_has_role(array['dock_chief']) then raise exception 'forbidden'; end if;
  res := public.lg_idem_get(p_event); if res is not null then return res; end if;
  if nullif(trim(p_reason), '') is null then raise exception 'reason_required'; end if;
  select * into s from public.lg_stock_lots where id = p_lot for update;
  if not found then raise exception 'unknown_lot'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'invalid_quantity'; end if;
  if p_qty > s.qty then
    return public.lg_idem_put(p_event, 'lot_discard', jsonb_build_object('ok', false, 'error', 'qty_exceeds', 'available', s.qty));
  end if;
  update public.lg_stock_lots set qty = qty - p_qty, updated_at = now() where id = s.id;
  insert into public.lg_lot_moves (lot_id, kind, qty, reason, by_user) values (s.id, 'discard', -p_qty, trim(p_reason), auth.uid());
  update public.lg_product_locations set qty = greatest(qty - p_qty, 0), updated_at = now()
   where product_id = s.product_id and location_id = s.location_id;
  -- le stock affiché sur le site suit
  update public.products set stock = greatest(coalesce(stock, 0) - p_qty, 0), updated_at = now() where id = s.product_id;
  perform public.lg_audit('lot_discard', 'product', s.product_id::text,
    jsonb_build_object('lot', s.lot_code, 'expires_on', s.expires_on, 'qty', p_qty, 'reason', trim(p_reason)));
  return public.lg_idem_put(p_event, 'lot_discard', jsonb_build_object('ok', true, 'left', s.qty - p_qty));
end; $$;

-- 6. TRAÇABILITÉ : quelles commandes ont reçu ce lot ? (rappel de produit)
create or replace function public.lg_lot_trace(p_lot text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare q text := upper(trim(coalesce(p_lot, '')));
begin
  if not public.lg_has_role(array['dock_chief', 'support', 'accountant']) then raise exception 'forbidden'; end if;
  if length(q) < 2 then return '[]'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('lot_id', s.id, 'lot', s.lot_code, 'expires_on', s.expires_on, 'product', p.name,
            'location', l.code, 'in_stock', s.qty,
            'received', (select coalesce(sum(qty), 0) from public.lg_lot_moves where lot_id = s.id and kind = 'in'),
            'discarded', (select coalesce(-sum(qty), 0) from public.lg_lot_moves where lot_id = s.id and kind = 'discard'),
            'orders', (select coalesce(jsonb_agg(jsonb_build_object('order_id', o.id, 'order_short', upper(left(o.id::text, 8)),
                          'customer', o.buyer_name, 'phone', o.buyer_phone, 'zone', o.delivery_zone, 'status', o.status,
                          'delivered_at', o.delivered_at, 'qty', x.q, 'picked_at', x.at) order by x.at), '[]')
                         from (select pl.task_id, -sum(m.qty) q, max(m.at) at from public.lg_lot_moves m
                                 join public.lg_pick_lines pl on pl.id = m.pick_line_id
                                where m.lot_id = s.id and m.kind = 'pick' group by pl.task_id) x
                         join public.lg_pick_tasks t on t.id = x.task_id join public.orders o on o.id = t.order_id))
            order by s.expires_on nulls last, p.name), '[]')
    from public.lg_stock_lots s join public.products p on p.id = s.product_id join public.lg_stock_locations l on l.id = s.location_id
   where upper(s.lot_code) = q);
end; $$;

-- 7. LECTURES ENRICHIES : lots dans la recherche, les emplacements et le chemin de prélèvement
create or replace function public.lg_lots_of(p_product uuid, p_location uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'lot', s.lot_code, 'expires_on', s.expires_on, 'qty', s.qty,
           'state', public.lg_lot_state(s.expires_on)) order by s.expires_on nulls last), '[]')
    from public.lg_stock_lots s where s.product_id = p_product and s.location_id = p_location and s.qty > 0
$$;

create or replace function public.lg_product_find(p_q text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare q text := trim(coalesce(p_q, ''));
begin
  if not public.lg_has_role(array['picker', 'dock_chief', 'support']) then raise exception 'forbidden'; end if;
  if length(q) < 2 then return '[]'; end if;
  return (select coalesce(jsonb_agg(x), '[]') from (
    select jsonb_build_object('id', p.id, 'name', p.name, 'barcode', p.barcode, 'sku', p.sku, 'stock', p.stock, 'vendor', p.vendor_name,
           'locations', (select coalesce(jsonb_agg(jsonb_build_object('code', l.code, 'qty', pl.qty, 'lots', public.lg_lots_of(p.id, l.id))
                                                   order by pl.qty desc), '[]')
                           from public.lg_product_locations pl join public.lg_stock_locations l on l.id = pl.location_id
                          where pl.product_id = p.id and pl.qty > 0)) x
      from public.products p
     where upper(p.barcode) = upper(q) or upper(p.sku) = upper(q) or 'NXI-' || upper(left(p.id::text, 8)) = upper(q) or p.name ilike '%' || q || '%'
     order by p.name limit 20) s);
end; $$;

create or replace function public.lg_locations_list(p_hub uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['picker', 'dock_chief']) then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'code', l.code, 'kind', l.kind, 'label', l.label, 'active', l.active,
            'last_counted_at', l.last_counted_at,
            'contents', (select coalesce(jsonb_agg(jsonb_build_object('product_id', p.id, 'name', p.name, 'qty', pl.qty, 'barcode', p.barcode,
                                                                      'lots', public.lg_lots_of(p.id, l.id))
                            order by p.name), '[]') from public.lg_product_locations pl join public.products p on p.id = pl.product_id
                          where pl.location_id = l.id and pl.qty > 0)) order by public.lg_loc_key(l.code)), '[]')
    from public.lg_stock_locations l where p_hub is null or l.hub_id = p_hub);
end; $$;

create or replace function public.lg_pick_task_detail(p_task uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare t public.lg_pick_tasks; o public.orders;
begin
  if not (public.lg_can_pick(p_task) or public.lg_has_role(array['dispatcher', 'support'])) then raise exception 'forbidden'; end if;
  select * into t from public.lg_pick_tasks where id = p_task;
  if not found then raise exception 'unknown_task'; end if;
  select * into o from public.orders where id = t.order_id;
  return jsonb_build_object(
    'task', to_jsonb(t),
    'order', jsonb_build_object('id', o.id, 'short', upper(left(o.id::text, 4)), 'zone', o.delivery_zone,
                                'payment_method', o.payment_method, 'vendor_name', o.vendor_name),
    'lines', (select coalesce(jsonb_agg(x.j order by x.k, x.n), '[]') from (
                select jsonb_build_object(
                  'id', l.id, 'order_item_id', l.order_item_id, 'product_id', l.product_id,
                  'name', coalesce(oi.product_name, p.name), 'barcode', p.barcode, 'sku', p.sku,
                  'internal_code', 'NXI-' || upper(left(p.id::text, 8)),
                  'qty_ordered', l.qty_ordered, 'qty_picked', l.qty_picked, 'status', l.status,
                  'handling', p.handling, 'weight_g', p.weight_g, 'manual_entry', l.manual_entry,
                  'location', (select code from public.lg_stock_locations where id = x0.loc),
                  'lot', public.lg_lot_hint(l.product_id, x0.loc)) j,
                  public.lg_loc_key((select code from public.lg_stock_locations where id = x0.loc)) k, coalesce(oi.product_name, p.name) n
                  from public.lg_pick_lines l
                  join public.order_items oi on oi.id = l.order_item_id
                  left join public.products p on p.id = l.product_id
                  cross join lateral (select public.lg_pick_location_id(l.product_id, t.hub_id) loc) x0
                 where l.task_id = p_task) x),
    'packages', (select coalesce(jsonb_agg(jsonb_build_object('code', code, 'status', status, 'seq', seq_in_order,
                                                               'count', count_in_order, 'weight_g', weight_g) order by seq_in_order), '[]')
                   from public.lg_packages where pick_task_id = p_task));
end; $$;
