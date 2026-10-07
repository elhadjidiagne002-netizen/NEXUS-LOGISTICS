-- =====================================================================
-- NEXUS LOGISTICS — cycle 4 · Module 11 Stock et entrepôt + préparation par vague (01, P2)
-- =====================================================================

create table if not exists public.lg_stock_locations (
  id         uuid primary key default gen_random_uuid(),
  hub_id     uuid not null references public.lg_hubs(id),
  code       text not null,                       -- ex. A-03-2 : allée A, étagère 03, niveau 2
  kind       text not null default 'shelf' check (kind in ('shelf', 'floor', 'cold', 'bulk')),
  label      text,
  active     boolean not null default true,
  last_counted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (hub_id, code)
);
create table if not exists public.lg_product_locations (
  product_id  uuid not null references public.products(id) on delete cascade,
  location_id uuid not null references public.lg_stock_locations(id) on delete cascade,
  qty         integer not null default 0 check (qty >= 0),
  updated_at  timestamptz not null default now(),
  primary key (product_id, location_id)
);
create table if not exists public.lg_inventory_counts (
  id          bigint generated always as identity primary key,
  location_id uuid not null references public.lg_stock_locations(id),
  product_id  uuid not null references public.products(id),
  expected    integer not null,
  counted     integer not null check (counted >= 0),
  gap         integer generated always as (counted - expected) stored,
  reason      text,
  counted_by  uuid references public.profiles(id),
  counted_at  timestamptz not null default now()
);
create table if not exists public.lg_waves (
  id         uuid primary key default gen_random_uuid(),
  number     integer not null unique default public.lg_next_counter('WAVE'),
  hub_id     uuid references public.lg_hubs(id),
  picker_id  uuid references public.profiles(id),
  status     text not null default 'picking' check (status in ('picking', 'done', 'cancelled')),
  created_at timestamptz not null default now(),
  done_at    timestamptz
);
alter table public.lg_pick_tasks add column if not exists wave_id uuid references public.lg_waves(id);
alter table public.lg_pick_tasks add column if not exists wave_bin smallint;   -- n° du bac dans la vague

alter table public.lg_stock_locations   enable row level security;
alter table public.lg_product_locations enable row level security;
alter table public.lg_inventory_counts  enable row level security;
alter table public.lg_waves             enable row level security;

-- Tri naturel d'un code d'emplacement (A-2 avant A-10)
create or replace function public.lg_loc_key(p_code text) returns text language sql immutable as $$
  select coalesce(string_agg(case when m[1] ~ '^\d+$' then lpad(m[1], 6, '0') else m[1] end, '-'), 'ZZZZZZ')
    from regexp_matches(coalesce(p_code, ''), '(\d+|[^\d\-]+)', 'g') as m
$$;

-- Emplacement d'un produit dans un hub : celui qui en contient le plus
create or replace function public.lg_product_location(p_product uuid, p_hub uuid default null) returns text
language sql stable security definer set search_path = public as $$
  select l.code from public.lg_product_locations pl join public.lg_stock_locations l on l.id = pl.location_id
   where pl.product_id = p_product and l.active and (p_hub is null or l.hub_id = p_hub)
   order by (pl.qty > 0) desc, pl.qty desc, l.code limit 1
$$;

-- 1. EMPLACEMENTS ---------------------------------------------------------------------------
create or replace function public.lg_location_upsert(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_hub uuid;
begin
  if not public.lg_has_role(array['dock_chief']) then raise exception 'forbidden'; end if;
  v_hub := coalesce((p ->> 'hub_id')::uuid, (select hub_id from public.lg_staff_roles where user_id = auth.uid() and hub_id is not null limit 1),
                    (select id from public.lg_hubs where active order by created_at limit 1));
  insert into public.lg_stock_locations (hub_id, code, kind, label, active)
  values (v_hub, upper(trim(p ->> 'code')), coalesce(p ->> 'kind', 'shelf'), p ->> 'label', coalesce((p ->> 'active')::boolean, true))
  on conflict (hub_id, code) do update set kind = excluded.kind, label = excluded.label, active = excluded.active
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end; $$;

create or replace function public.lg_locations_list(p_hub uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['picker', 'dock_chief']) then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'code', l.code, 'kind', l.kind, 'label', l.label, 'active', l.active,
            'last_counted_at', l.last_counted_at,
            'contents', (select coalesce(jsonb_agg(jsonb_build_object('product_id', p.id, 'name', p.name, 'qty', pl.qty, 'barcode', p.barcode)
                            order by p.name), '[]') from public.lg_product_locations pl join public.products p on p.id = pl.product_id
                          where pl.location_id = l.id and pl.qty > 0)) order by public.lg_loc_key(l.code)), '[]')
    from public.lg_stock_locations l where p_hub is null or l.hub_id = p_hub);
end; $$;

-- Rangement : « ce produit, tant d'unités, à cet emplacement » (réception de marchandise)
create or replace function public.lg_put_away(p_product_code text, p_location_code text, p_qty integer, p_event uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare pr public.products; loc public.lg_stock_locations; res jsonb; c text := upper(trim(p_product_code));
begin
  if not public.lg_has_role(array['picker', 'dock_chief']) then raise exception 'forbidden'; end if;
  res := public.lg_idem_get(p_event); if res is not null then return res; end if;
  select * into pr from public.products where upper(barcode) = c or upper(sku) = c or 'NXI-' || upper(left(id::text, 8)) = c limit 1;
  if not found then return public.lg_idem_put(p_event, 'put_away', jsonb_build_object('ok', false, 'error', 'unknown_product')); end if;
  select * into loc from public.lg_stock_locations where code = upper(trim(p_location_code)) and active
   order by (hub_id = (select hub_id from public.lg_staff_roles where user_id = auth.uid() and hub_id is not null limit 1)) desc nulls last limit 1;
  if not found then return public.lg_idem_put(p_event, 'put_away', jsonb_build_object('ok', false, 'error', 'unknown_location')); end if;
  if p_qty is null or p_qty <= 0 then raise exception 'invalid_quantity'; end if;
  insert into public.lg_product_locations (product_id, location_id, qty) values (pr.id, loc.id, p_qty)
  on conflict (product_id, location_id) do update set qty = lg_product_locations.qty + excluded.qty, updated_at = now();
  perform public.lg_audit('put_away', 'product', pr.id::text, jsonb_build_object('location', loc.code, 'qty', p_qty));
  return public.lg_idem_put(p_event, 'put_away', jsonb_build_object('ok', true, 'product', pr.name, 'location', loc.code,
    'qty', (select qty from public.lg_product_locations where product_id = pr.id and location_id = loc.id)));
end; $$;

-- Où est ce produit ? (code ou nom)
create or replace function public.lg_product_find(p_q text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare q text := trim(coalesce(p_q, ''));
begin
  if not public.lg_has_role(array['picker', 'dock_chief', 'support']) then raise exception 'forbidden'; end if;
  if length(q) < 2 then return '[]'; end if;
  return (select coalesce(jsonb_agg(x), '[]') from (
    select jsonb_build_object('id', p.id, 'name', p.name, 'barcode', p.barcode, 'sku', p.sku, 'stock', p.stock, 'vendor', p.vendor_name,
           'locations', (select coalesce(jsonb_agg(jsonb_build_object('code', l.code, 'qty', pl.qty) order by pl.qty desc), '[]')
                           from public.lg_product_locations pl join public.lg_stock_locations l on l.id = pl.location_id
                          where pl.product_id = p.id and pl.qty > 0)) x
      from public.products p
     where upper(p.barcode) = upper(q) or upper(p.sku) = upper(q) or 'NXI-' || upper(left(p.id::text, 8)) = upper(q) or p.name ilike '%' || q || '%'
     order by p.name limit 20) s);
end; $$;

-- 2. CHEMIN DE PRÉLÈVEMENT : le détail d'une préparation donne l'emplacement et trie par rayon
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
                  'location', public.lg_product_location(l.product_id, t.hub_id)) j,
                  public.lg_loc_key(public.lg_product_location(l.product_id, t.hub_id)) k, coalesce(oi.product_name, p.name) n
                  from public.lg_pick_lines l
                  join public.order_items oi on oi.id = l.order_item_id
                  left join public.products p on p.id = l.product_id
                 where l.task_id = p_task) x),
    'packages', (select coalesce(jsonb_agg(jsonb_build_object('code', code, 'status', status, 'seq', seq_in_order,
                                                               'count', count_in_order, 'weight_g', weight_g) order by seq_in_order), '[]')
                   from public.lg_packages where pick_task_id = p_task));
end; $$;

-- Le prélèvement décrémente l'emplacement le plus garni du produit (stock confié, modèle C)
create or replace function public.lg_trg_pick_location() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_loc uuid; v_hub uuid;
begin
  if new.qty_picked > old.qty_picked then
    select hub_id into v_hub from public.lg_pick_tasks where id = new.task_id;
    select pl.location_id into v_loc from public.lg_product_locations pl join public.lg_stock_locations l on l.id = pl.location_id
     where pl.product_id = new.product_id and pl.qty > 0 and (v_hub is null or l.hub_id = v_hub) order by pl.qty desc limit 1;
    if v_loc is not null then
      update public.lg_product_locations set qty = greatest(qty - (new.qty_picked - old.qty_picked), 0), updated_at = now()
       where product_id = new.product_id and location_id = v_loc;
    end if;
  end if;
  return new;
end; $$;
drop trigger if exists lg_pick_lines_location on public.lg_pick_lines;
create trigger lg_pick_lines_location after update of qty_picked on public.lg_pick_lines
  for each row execute function public.lg_trg_pick_location();

-- 3. PRÉPARATION PAR VAGUE ------------------------------------------------------------------
create or replace function public.lg_wave_create(p_tasks uuid[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare w public.lg_waves; t record; i int := 0;
begin
  if not public.lg_has_role(array['picker', 'dock_chief']) then raise exception 'forbidden'; end if;
  if cardinality(p_tasks) < 2 or cardinality(p_tasks) > 12 then raise exception 'wave_size'; end if;
  insert into public.lg_waves (hub_id, picker_id)
  values ((select hub_id from public.lg_pick_tasks where id = p_tasks[1]), auth.uid()) returning * into w;
  for t in select * from public.lg_pick_tasks where id = any (p_tasks) order by cutoff_at nulls last for update loop
    if t.status not in ('todo', 'picking') then raise exception 'task_not_open:%', t.status; end if;
    if t.picker_id is not null and t.picker_id <> auth.uid()
       and t.last_activity_at > now() - make_interval(mins => (public.lg_cfg('pick_lock_minutes'))::text::int) then
      raise exception 'task_locked';
    end if;
    i := i + 1;
    update public.lg_pick_tasks set wave_id = w.id, wave_bin = i, picker_id = auth.uid(), status = 'picking',
           started_at = coalesce(started_at, now()), last_activity_at = now() where id = t.id;
    update public.orders set status = 'processing', processing_at = coalesce(processing_at, now()), updated_at = now()
     where id = t.order_id and status in ('pending', 'pending_payment');
  end loop;
  if i <> cardinality(p_tasks) then raise exception 'unknown_task'; end if;
  return jsonb_build_object('ok', true, 'wave_id', w.id, 'number', w.number, 'bins', i);
end; $$;

-- Liste de prélèvement groupée par produit, dans l'ordre des rayons, avec la répartition par bac
create or replace function public.lg_wave_detail(p_wave uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare w public.lg_waves;
begin
  if not public.lg_has_role(array['picker', 'dock_chief']) then raise exception 'forbidden'; end if;
  select * into w from public.lg_waves where id = p_wave;
  if not found then raise exception 'unknown_wave'; end if;
  return jsonb_build_object('wave', to_jsonb(w),
    'bins', (select coalesce(jsonb_agg(jsonb_build_object('bin', t.wave_bin, 'task_id', t.id, 'order_short', upper(left(t.order_id::text, 4)),
              'zone', o.delivery_zone, 'status', t.status,
              'done', not exists (select 1 from public.lg_pick_lines l where l.task_id = t.id and l.status = 'pending'),
              'picked', (select coalesce(sum(qty_picked), 0) from public.lg_pick_lines where task_id = t.id),
              'ordered', (select coalesce(sum(qty_ordered), 0) from public.lg_pick_lines where task_id = t.id)) order by t.wave_bin), '[]')
              from public.lg_pick_tasks t join public.orders o on o.id = t.order_id where t.wave_id = p_wave),
    'products', (select coalesce(jsonb_agg(x.j order by x.k, x.n), '[]') from (
              select jsonb_build_object('product_id', l.product_id, 'name', coalesce(max(oi.product_name), max(p.name)), 'barcode', max(p.barcode),
                       'location', public.lg_product_location(l.product_id, w.hub_id),
                       'ordered', sum(l.qty_ordered), 'picked', sum(l.qty_picked),
                       'split', jsonb_agg(jsonb_build_object('bin', t.wave_bin, 'qty', l.qty_ordered, 'picked', l.qty_picked, 'line_id', l.id,
                                                             'task_id', t.id, 'status', l.status) order by t.wave_bin)) j,
                     public.lg_loc_key(public.lg_product_location(l.product_id, w.hub_id)) k, coalesce(max(oi.product_name), max(p.name)) n
                from public.lg_pick_lines l join public.lg_pick_tasks t on t.id = l.task_id
                join public.order_items oi on oi.id = l.order_item_id left join public.products p on p.id = l.product_id
               where t.wave_id = p_wave group by l.product_id) x));
end; $$;

-- Scan dans une vague : le produit va dans le bac de la commande la plus urgente qui en attend
create or replace function public.lg_wave_scan(p_wave uuid, p_code text, p_event uuid, p_manual boolean default false,
                                               p_product uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c text := upper(trim(coalesce(p_code, ''))); v_task uuid; v_bin int; r jsonb; res jsonb; pid uuid;
begin
  res := public.lg_idem_get(p_event); if res is not null then return res; end if;
  if not public.lg_has_role(array['picker', 'dock_chief']) then raise exception 'forbidden'; end if;
  pid := coalesce(p_product, (select id from public.products where upper(barcode) = c or upper(sku) = c
                                 or 'NXI-' || upper(left(id::text, 8)) = c limit 1));
  select t.id, t.wave_bin into v_task, v_bin
    from public.lg_pick_lines l join public.lg_pick_tasks t on t.id = l.task_id
   where t.wave_id = p_wave and l.product_id = pid and l.status = 'pending' and l.qty_picked < l.qty_ordered
   order by t.cutoff_at nulls last, t.wave_bin limit 1;
  if v_task is null then
    return public.lg_idem_put(p_event, 'wave_scan', jsonb_build_object('ok', false,
      'error', case when pid is null or not exists (select 1 from public.lg_pick_lines l join public.lg_pick_tasks t on t.id = l.task_id
                                                     where t.wave_id = p_wave and l.product_id = pid) then 'unexpected_product' else 'line_complete' end));
  end if;
  if p_manual then
    r := public.lg_pick_scan(v_task, '', null, true,
           (select l.id from public.lg_pick_lines l where l.task_id = v_task and l.product_id = pid and l.status = 'pending' limit 1));
  else
    r := public.lg_pick_scan(v_task, c, null, false, null);
  end if;
  return public.lg_idem_put(p_event, 'wave_scan', r || jsonb_build_object('bin', v_bin, 'task_id', v_task,
    'wave_done', not exists (select 1 from public.lg_pick_lines l join public.lg_pick_tasks t on t.id = l.task_id
                              where t.wave_id = p_wave and l.status = 'pending')));
end; $$;

create or replace function public.lg_my_waves() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'number', w.number, 'created_at', w.created_at,
           'bins', (select count(*) from public.lg_pick_tasks where wave_id = w.id),
           'open', (select count(*) from public.lg_pick_tasks where wave_id = w.id and status = 'picking')) order by w.created_at desc), '[]')
    from public.lg_waves w
   where w.picker_id = auth.uid() and w.status = 'picking'
     and exists (select 1 from public.lg_pick_tasks t where t.wave_id = w.id and t.status = 'picking')
$$;

-- 4. INVENTAIRE TOURNANT --------------------------------------------------------------------
-- Chaque jour : les emplacements comptés il y a le plus longtemps d'abord
create or replace function public.lg_inventory_today(p_limit integer default 8) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['picker', 'dock_chief']) then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'code', l.code, 'last_counted_at', l.last_counted_at,
            'contents', (select coalesce(jsonb_agg(jsonb_build_object('product_id', p.id, 'name', p.name, 'barcode', p.barcode, 'expected', pl.qty)
                            order by p.name), '[]') from public.lg_product_locations pl join public.products p on p.id = pl.product_id
                          where pl.location_id = l.id)) order by l.last_counted_at nulls first, public.lg_loc_key(l.code)), '[]')
    from (select * from public.lg_stock_locations where active
            and exists (select 1 from public.lg_product_locations where location_id = lg_stock_locations.id)
          order by last_counted_at nulls first limit coalesce(p_limit, 8)) l);
end; $$;

create or replace function public.lg_inventory_count(p_location uuid, p_counts jsonb, p_event uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare it jsonb; v_exp int; v_gap int; total_gap int := 0; n int := 0; res jsonb;
begin
  if not public.lg_has_role(array['picker', 'dock_chief']) then raise exception 'forbidden'; end if;
  res := public.lg_idem_get(p_event); if res is not null then return res; end if;
  -- p_counts : [{product_id, counted, reason?}]
  for it in select * from jsonb_array_elements(coalesce(p_counts, '[]')) loop
    select coalesce(qty, 0) into v_exp from public.lg_product_locations where location_id = p_location and product_id = (it ->> 'product_id')::uuid;
    v_exp := coalesce(v_exp, 0);
    insert into public.lg_inventory_counts (location_id, product_id, expected, counted, reason, counted_by)
    values (p_location, (it ->> 'product_id')::uuid, v_exp, (it ->> 'counted')::int, it ->> 'reason', auth.uid());
    v_gap := (it ->> 'counted')::int - v_exp;
    if v_gap <> 0 then
      insert into public.lg_product_locations (product_id, location_id, qty) values ((it ->> 'product_id')::uuid, p_location, (it ->> 'counted')::int)
      on conflict (product_id, location_id) do update set qty = excluded.qty, updated_at = now();
      -- le stock affiché sur le site suit le comptage
      update public.products set stock = greatest(coalesce(stock, 0) + v_gap, 0), updated_at = now() where id = (it ->> 'product_id')::uuid;
      total_gap := total_gap + abs(v_gap);
    end if;
    n := n + 1;
  end loop;
  update public.lg_stock_locations set last_counted_at = now() where id = p_location;
  if total_gap > 0 then
    perform public.lg_audit('inventory_gap', 'location', p_location::text, jsonb_build_object('gap_units', total_gap));
  end if;
  return public.lg_idem_put(p_event, 'inventory', jsonb_build_object('ok', true, 'lines', n, 'gap_units', total_gap));
end; $$;

create or replace function public.lg_inventory_history(p_days integer default 30) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['dock_chief', 'accountant']) then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('at', c.counted_at, 'location', l.code, 'product', p.name, 'expected', c.expected,
            'counted', c.counted, 'gap', c.gap, 'reason', c.reason, 'by', pr.name) order by c.counted_at desc), '[]')
    from public.lg_inventory_counts c join public.lg_stock_locations l on l.id = c.location_id join public.products p on p.id = c.product_id
    left join public.profiles pr on pr.id = c.counted_by
   where c.counted_at > now() - make_interval(days => coalesce(p_days, 30)) and c.gap <> 0);
end; $$;
