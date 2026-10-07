-- =====================================================================
-- NEXUS LOGISTICS — 03 · Module 01 Préparation (P1)
-- File de préparation, confirmation du paiement à la livraison, verrou,
-- scan produit, rupture, colisage, mise à quai, données d'étiquette.
-- Modèle de transition : rôle → rejeu → verrou → conditions → écriture → journal.
-- =====================================================================

-- Qui peut préparer : le préparateur (modèle B) ou le vendeur lui-même (modèle A)
create or replace function public.lg_can_pick(p_task uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.lg_has_role(array['picker', 'dock_chief'])
      or exists (select 1 from public.lg_pick_tasks t where t.id = p_task and t.vendor_id = auth.uid())
$$;

-- 1. ENTRÉE EN PRÉPARATION -----------------------------------------------------
-- Une commande entre en préparation quand elle est payée, ou, en paiement à
-- la livraison, quand le client l'a confirmée. Une tâche par commande.
create or replace function public.lg_release_order(p_order uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o      public.orders;
  t_id   uuid;
  n      int;
begin
  select * into o from public.orders where id = p_order for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'unknown_order'); end if;
  if o.status = 'cancelled' then return jsonb_build_object('ok', false, 'error', 'order_cancelled'); end if;
  if exists (select 1 from public.lg_pick_tasks where order_id = p_order and status <> 'cancelled') then
    return jsonb_build_object('ok', true, 'already', true);
  end if;
  if not (coalesce(o.payment_status, '') = 'paid'
          or (o.payment_method = 'cod' and o.cod_confirmed_at is not null)) then
    return jsonb_build_object('ok', false, 'error', 'not_ready');
  end if;

  perform public.lg_sync_order_items(p_order);

  insert into public.lg_pick_tasks (order_id, hub_id, vendor_id, cutoff_at)
  values (p_order, o.hub_id, o.vendor_id,
          coalesce(o.promised_at - interval '3 hours', greatest(o.created_at, now()) + interval '24 hours'))
  returning id into t_id;

  insert into public.lg_pick_lines (task_id, order_item_id, product_id, qty_ordered)
  select t_id, oi.id, oi.product_id, oi.quantity
    from public.order_items oi join public.products p on p.id = oi.product_id
   where oi.order_id = p_order and coalesce(p.is_shippable, true) and oi.line_status <> 'cancelled';
  get diagnostics n = row_count;

  if n = 0 then
    -- rien à transporter (formation, immobilier…) : pas de préparation
    delete from public.lg_pick_tasks where id = t_id;
    return jsonb_build_object('ok', false, 'error', 'nothing_shippable');
  end if;

  if o.delivery_zone is null then
    update public.orders set delivery_zone = public.lg_order_zone(p_order) where id = p_order;
  end if;
  return jsonb_build_object('ok', true, 'task_id', t_id, 'lines', n);
end; $$;

-- 2. CONFIRMATION DU PAIEMENT À LA LIVRAISON ------------------------------------
create or replace function public.lg_confirm_cod_internal(p_order uuid, p_via text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o public.orders;
begin
  select * into o from public.orders where id = p_order for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'unknown_order'); end if;
  if o.payment_method <> 'cod' then return jsonb_build_object('ok', false, 'error', 'not_cod'); end if;
  if o.status = 'cancelled' then return jsonb_build_object('ok', false, 'error', 'order_cancelled'); end if;
  if o.buyer_phone is not null and exists (
       select 1 from public.numeros_bannis b
        where right(regexp_replace(b.numero, '\D', '', 'g'), 9) = right(regexp_replace(o.buyer_phone, '\D', '', 'g'), 9)) then
    perform public.lg_audit('cod_confirm_refused_banned', 'order', p_order::text, jsonb_build_object('via', p_via));
    return jsonb_build_object('ok', false, 'error', 'banned_number');
  end if;
  if o.cod_confirmed_at is null then
    update public.orders set cod_confirmed_at = now(), cod_confirmed_via = p_via, updated_at = now() where id = p_order;
    perform public.lg_notify('lg_order_confirmed', p_order, '{}');
  end if;
  return public.lg_release_order(p_order) || jsonb_build_object('confirmed', true);
end; $$;

-- par le service client (appel) ou le répartiteur
create or replace function public.lg_confirm_cod(p_order uuid, p_via text default 'appel') returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['support', 'dispatcher']) then raise exception 'forbidden'; end if;
  perform public.lg_audit('cod_confirm', 'order', p_order::text, jsonb_build_object('via', p_via));
  return public.lg_confirm_cod_internal(p_order, p_via);
end; $$;

-- Annulation par le client (« NON » au message de confirmation) ou le support
create or replace function public.lg_cancel_unconfirmed(p_order uuid, p_reason text default 'Non confirmée par le client')
returns jsonb language plpgsql security definer set search_path = public as $$
declare o public.orders;
begin
  if auth.uid() is not null and not public.lg_has_role(array['support', 'dispatcher']) then raise exception 'forbidden'; end if;
  select * into o from public.orders where id = p_order for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'unknown_order'); end if;
  if exists (select 1 from public.lg_packages where order_id = p_order and status not in ('created', 'packed', 'staged', 'cancelled')) then
    return jsonb_build_object('ok', false, 'error', 'already_shipped');
  end if;
  update public.orders set status = 'cancelled', cancelled_at = now(), cancel_reason = p_reason, updated_at = now() where id = p_order;
  update public.lg_pick_tasks set status = 'cancelled' where order_id = p_order and status <> 'cancelled';
  update public.lg_packages set status = 'cancelled', updated_at = now() where order_id = p_order and status in ('created', 'packed', 'staged');
  perform public.lg_audit('order_cancel', 'order', p_order::text, jsonb_build_object('reason', p_reason));
  return jsonb_build_object('ok', true);
end; $$;

-- Déclencheurs sur orders : jamais bloquants pour le site.
create or replace function public.lg_trg_order_items() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    perform public.lg_sync_order_items(new.id);
    if new.payment_method = 'cod' and new.cod_confirmed_at is null and new.status <> 'cancelled' then
      perform public.lg_notify('lg_cod_confirm', new.id, '{}');
    end if;
    perform public.lg_release_order(new.id);
  exception when others then
    insert into public.audit_logs (action, target_type, target_id, detail)
    values ('lg.order_insert_hook_failed', 'order', new.id::text, jsonb_build_object('error', sqlerrm));
  end;
  return null;
end; $$;

create or replace function public.lg_trg_order_ready() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    perform public.lg_release_order(new.id);
  exception when others then
    insert into public.audit_logs (action, target_type, target_id, detail)
    values ('lg.order_release_failed', 'order', new.id::text, jsonb_build_object('error', sqlerrm));
  end;
  return null;
end; $$;
drop trigger if exists lg_order_ready on public.orders;
create trigger lg_order_ready after update of payment_status, cod_confirmed_at on public.orders
  for each row when (new.payment_status is distinct from old.payment_status
                     or new.cod_confirmed_at is distinct from old.cod_confirmed_at)
  execute function public.lg_trg_order_ready();

-- 3. FILE ET DÉTAIL ---------------------------------------------------------------
create or replace function public.lg_pick_queue(p_hub uuid default null) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(q order by q.cutoff_at nulls last, q.zone), '[]') from (
    select t.id, t.order_id, upper(left(t.order_id::text, 4)) as order_short, t.status, t.cutoff_at,
           o.delivery_zone as zone, o.vendor_name, o.payment_method,
           (select count(*) from public.lg_pick_lines l where l.task_id = t.id) as lines,
           (select coalesce(sum(qty_ordered), 0) from public.lg_pick_lines l where l.task_id = t.id) as units,
           t.picker_id, (select name from public.profiles where id = t.picker_id) as picker_name,
           (t.picker_id is not null and t.picker_id <> auth.uid()
              and t.last_activity_at > now() - make_interval(mins => (public.lg_cfg('pick_lock_minutes'))::text::int)) as locked
      from public.lg_pick_tasks t join public.orders o on o.id = t.order_id
     where t.status in ('todo', 'picking')
       and (p_hub is null or t.hub_id = p_hub)
       and (public.lg_has_role(array['picker', 'dock_chief', 'dispatcher']) or t.vendor_id = auth.uid())
  ) q
$$;

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
    'lines', (select coalesce(jsonb_agg(jsonb_build_object(
                 'id', l.id, 'order_item_id', l.order_item_id, 'product_id', l.product_id,
                 'name', coalesce(oi.product_name, p.name), 'barcode', p.barcode, 'sku', p.sku,
                 'internal_code', 'NXI-' || upper(left(p.id::text, 8)),
                 'qty_ordered', l.qty_ordered, 'qty_picked', l.qty_picked, 'status', l.status,
                 'handling', p.handling, 'weight_g', p.weight_g, 'manual_entry', l.manual_entry
               ) order by coalesce(oi.product_name, p.name)), '[]')
                from public.lg_pick_lines l
                join public.order_items oi on oi.id = l.order_item_id
                left join public.products p on p.id = l.product_id
               where l.task_id = p_task),
    'packages', (select coalesce(jsonb_agg(jsonb_build_object('code', code, 'status', status, 'seq', seq_in_order,
                                                               'count', count_in_order, 'weight_g', weight_g) order by seq_in_order), '[]')
                   from public.lg_packages where pick_task_id = p_task));
end; $$;

-- 4. PRISE EN CHARGE (verrou) -------------------------------------------------------
create or replace function public.lg_pick_take(p_task uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.lg_pick_tasks;
begin
  if not public.lg_can_pick(p_task) then raise exception 'forbidden'; end if;
  select * into t from public.lg_pick_tasks where id = p_task for update;
  if not found then raise exception 'unknown_task'; end if;
  if t.status not in ('todo', 'picking') then raise exception 'task_not_open:%', t.status; end if;
  if t.picker_id is not null and t.picker_id <> auth.uid()
     and t.last_activity_at > now() - make_interval(mins => (public.lg_cfg('pick_lock_minutes'))::text::int) then
    raise exception 'task_locked';
  end if;
  update public.lg_pick_tasks
     set picker_id = auth.uid(), status = 'picking', started_at = coalesce(started_at, now()), last_activity_at = now()
   where id = p_task;
  update public.orders set status = 'processing', processing_at = coalesce(processing_at, now()), updated_at = now()
   where id = t.order_id and status in ('pending', 'pending_payment');
  return jsonb_build_object('ok', true);
end; $$;

create or replace function public.lg_pick_release(p_task uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  update public.lg_pick_tasks set picker_id = null, last_activity_at = null
   where id = p_task and status in ('todo', 'picking')
     and (picker_id = auth.uid() or public.lg_has_role(array['dock_chief']));
  return jsonb_build_object('ok', found);
end; $$;

-- 5. SCAN D'UN PRODUIT ---------------------------------------------------------------
-- p_code : code-barres fabricant, référence vendeur, ou code interne NXI-XXXXXXXX.
-- p_line : obligatoire pour une confirmation manuelle (produit sans code).
create or replace function public.lg_pick_scan(p_task uuid, p_code text, p_event uuid,
                                               p_manual boolean default false, p_line uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t   public.lg_pick_tasks;
  l   public.lg_pick_lines;
  c   text := upper(trim(coalesce(p_code, '')));
  res jsonb;
  pname text;
begin
  res := public.lg_idem_get(p_event); if res is not null then return res; end if;
  if not public.lg_can_pick(p_task) then raise exception 'forbidden'; end if;
  select * into t from public.lg_pick_tasks where id = p_task for update;
  if not found or t.status <> 'picking' then raise exception 'task_not_picking'; end if;
  if t.picker_id is distinct from auth.uid() then raise exception 'not_your_task'; end if;

  if p_manual then
    select * into l from public.lg_pick_lines where id = p_line and task_id = p_task for update;
  else
    select l2.* into l
      from public.lg_pick_lines l2 join public.products p on p.id = l2.product_id
     where l2.task_id = p_task
       and (upper(p.barcode) = c or upper(p.sku) = c or 'NXI-' || upper(left(p.id::text, 8)) = c)
     order by (l2.qty_picked < l2.qty_ordered) desc, l2.id
     limit 1 for update of l2;
  end if;

  if l.id is null then
    select name into pname from public.products
     where upper(barcode) = c or upper(sku) = c or 'NXI-' || upper(left(id::text, 8)) = c limit 1;
    return public.lg_idem_put(p_event, 'pick_scan',
      jsonb_build_object('ok', false, 'error', 'unexpected_product', 'product', pname));
  end if;
  if l.qty_picked >= l.qty_ordered then
    return public.lg_idem_put(p_event, 'pick_scan',
      jsonb_build_object('ok', false, 'error', 'line_complete', 'line_id', l.id));
  end if;

  update public.lg_pick_lines
     set qty_picked = qty_picked + 1,
         status = case when qty_picked + 1 >= qty_ordered then 'picked' else 'pending' end,
         manual_entry = manual_entry or p_manual,
         picked_at = now()
   where id = l.id returning * into l;
  update public.order_items set picked_qty = l.qty_picked,
         line_status = case when l.status = 'picked' then 'picked' else line_status end
   where id = l.order_item_id;
  update public.lg_pick_tasks set last_activity_at = now() where id = p_task;
  if p_manual then
    perform public.lg_audit('pick_manual_confirm', 'pick_line', l.id::text, jsonb_build_object('task', p_task));
  end if;

  return public.lg_idem_put(p_event, 'pick_scan', jsonb_build_object(
    'ok', true, 'line_id', l.id, 'qty_picked', l.qty_picked, 'qty_ordered', l.qty_ordered,
    'line_done', l.status = 'picked',
    'task_done', not exists (select 1 from public.lg_pick_lines where task_id = p_task and status = 'pending')));
end; $$;

-- 6. RUPTURE -------------------------------------------------------------------------
-- p_qty_found : quantité réellement trouvée en rayon pour cette ligne (0 = rupture totale).
-- Le stock affiché du produit est remis à zéro : le rayon est vide.
create or replace function public.lg_pick_short(p_task uuid, p_line uuid, p_qty_found integer, p_event uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t   public.lg_pick_tasks;
  l   public.lg_pick_lines;
  res jsonb;
  pname text;
begin
  res := public.lg_idem_get(p_event); if res is not null then return res; end if;
  if not public.lg_can_pick(p_task) then raise exception 'forbidden'; end if;
  select * into t from public.lg_pick_tasks where id = p_task for update;
  if not found or t.status <> 'picking' then raise exception 'task_not_picking'; end if;
  select * into l from public.lg_pick_lines where id = p_line and task_id = p_task for update;
  if not found then raise exception 'unknown_line'; end if;
  if p_qty_found < 0 or p_qty_found >= l.qty_ordered then raise exception 'invalid_quantity'; end if;

  update public.lg_pick_lines set qty_picked = p_qty_found, status = 'short', picked_at = now() where id = p_line;
  update public.order_items set picked_qty = p_qty_found, line_status = 'short' where id = l.order_item_id;
  update public.products set stock = 0, updated_at = now() where id = l.product_id and coalesce(stock, 0) > 0;
  update public.lg_pick_tasks set last_activity_at = now() where id = p_task;

  select coalesce(oi.product_name, p.name) into pname
    from public.order_items oi left join public.products p on p.id = oi.product_id where oi.id = l.order_item_id;
  perform public.lg_notify('lg_stockout', t.order_id,
    jsonb_build_object('produit', pname, 'manquant', l.qty_ordered - p_qty_found, 'line_id', l.order_item_id));
  perform public.lg_audit('pick_short', 'pick_line', p_line::text,
    jsonb_build_object('ordered', l.qty_ordered, 'found', p_qty_found));

  return public.lg_idem_put(p_event, 'pick_short', jsonb_build_object(
    'ok', true, 'line_id', p_line, 'missing', l.qty_ordered - p_qty_found,
    'task_done', not exists (select 1 from public.lg_pick_lines where task_id = p_task and status = 'pending')));
end; $$;

-- 7. COLISAGE ------------------------------------------------------------------------
-- p_packages : [{weight_g, length_cm, width_cm, height_cm, handling:[…], items:[{order_item_id, quantity}]}]
-- Un seul colis sans « items » = tout ce qui a été prélevé.
create or replace function public.lg_pack(p_task uuid, p_packages jsonb, p_event uuid,
                                          p_device_at timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t      public.lg_pick_tasks;
  o      public.orders;
  pk     jsonb;
  it     jsonb;
  n      int;
  i      int := 0;
  v_id   uuid;
  v_code text;
  codes  jsonb := '[]';
  res    jsonb;
  v_zone text;
  v_hand text[];
begin
  res := public.lg_idem_get(p_event); if res is not null then return res; end if;
  if not public.lg_can_pick(p_task) then raise exception 'forbidden'; end if;
  select * into t from public.lg_pick_tasks where id = p_task for update;
  if not found or t.status <> 'picking' then raise exception 'task_not_picking'; end if;
  if exists (select 1 from public.lg_pick_lines where task_id = p_task and status = 'pending') then
    raise exception 'lines_pending';
  end if;
  if not exists (select 1 from public.lg_pick_lines where task_id = p_task and qty_picked > 0) then
    raise exception 'nothing_to_pack';
  end if;
  n := jsonb_array_length(coalesce(p_packages, '[]'));
  if n < 1 or n > 20 then raise exception 'invalid_package_count'; end if;
  select * into o from public.orders where id = t.order_id for update;
  if o.status = 'cancelled' then raise exception 'order_cancelled'; end if;
  v_zone := coalesce(o.delivery_zone, public.lg_order_zone(o.id));

  for pk in select * from jsonb_array_elements(p_packages) loop
    i := i + 1;
    if coalesce((pk ->> 'weight_g')::int, 0) <= 0 then raise exception 'weight_required'; end if;
    v_code := public.lg_new_package_code();
    -- mentions : celles saisies + celles des fiches produit du colis
    select coalesce(array_agg(distinct h), '{}') into v_hand from (
      select jsonb_array_elements_text(coalesce(pk -> 'handling', '[]')) h
      union
      select unnest(p.handling) from public.lg_pick_lines l join public.products p on p.id = l.product_id
       where l.task_id = p_task and l.qty_picked > 0
         and (pk -> 'items' is null or l.order_item_id::text in (
              select x ->> 'order_item_id' from jsonb_array_elements(pk -> 'items') x))
    ) s where h is not null and h <> '';
    if (pk ->> 'weight_g')::int >= (public.lg_cfg('heavy_kg'))::text::int * 1000 and not ('lourd' = any (v_hand)) then
      v_hand := array_append(v_hand, 'lourd');
    end if;

    insert into public.lg_packages (code, order_id, pick_task_id, hub_id, seq_in_order, count_in_order,
                                    weight_g, length_cm, width_cm, height_cm, handling, zone, status,
                                    holder_type, holder_id)
    values (v_code, t.order_id, p_task, t.hub_id, i, n,
            (pk ->> 'weight_g')::int, (pk ->> 'length_cm')::numeric, (pk ->> 'width_cm')::numeric,
            (pk ->> 'height_cm')::numeric, v_hand, v_zone, 'packed',
            case when t.hub_id is null then 'vendor' else 'hub' end,
            case when t.hub_id is null then t.vendor_id else t.hub_id end)
    returning id into v_id;

    if pk -> 'items' is null then
      if n > 1 then raise exception 'items_required_for_multi_package'; end if;
      insert into public.lg_package_items (package_id, order_item_id, quantity)
      select v_id, order_item_id, qty_picked from public.lg_pick_lines where task_id = p_task and qty_picked > 0;
    else
      for it in select * from jsonb_array_elements(pk -> 'items') loop
        insert into public.lg_package_items (package_id, order_item_id, quantity)
        values (v_id, (it ->> 'order_item_id')::uuid, (it ->> 'quantity')::int)
        on conflict (package_id, order_item_id) do update set quantity = lg_package_items.quantity + excluded.quantity;
      end loop;
    end if;

    insert into public.lg_scan_events (client_event_id, package_id, event, actor_id, hub_id, device_at, meta)
    values (case when i = 1 then p_event else gen_random_uuid() end, v_id, 'pack', auth.uid(), t.hub_id,
            coalesce(p_device_at, now()), jsonb_build_object('task', p_task));
    codes := codes || jsonb_build_object('id', v_id, 'code', v_code, 'seq', i, 'count', n);
  end loop;

  -- chaque unité prélevée doit se trouver dans exactement un colis
  if exists (
    select 1 from public.lg_pick_lines l
      left join (select pi.order_item_id, sum(pi.quantity) q
                   from public.lg_package_items pi join public.lg_packages p on p.id = pi.package_id
                  where p.pick_task_id = p_task group by 1) s on s.order_item_id = l.order_item_id
     where l.task_id = p_task and coalesce(s.q, 0) <> l.qty_picked) then
    raise exception 'package_contents_mismatch';
  end if;

  update public.lg_pick_tasks set status = 'packed', done_at = now(), last_activity_at = now() where id = p_task;
  update public.orders set status = 'processing', processing_at = coalesce(processing_at, now()), updated_at = now()
   where id = t.order_id and status in ('pending', 'pending_payment');
  perform public.lg_notify('lg_prepared', t.order_id, jsonb_build_object('colis', n));

  return public.lg_idem_put(p_event, 'pack', jsonb_build_object('ok', true, 'packages', codes, 'zone', v_zone));
end; $$;

-- 8. MISE À QUAI ---------------------------------------------------------------------
-- Accepte aussi un colis revenu au hub (nouvelle présentation).
create or replace function public.lg_stage(p_code text, p_event uuid, p_device_at timestamptz default now(),
                                           p_manual boolean default false, p_hub uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  p   public.lg_packages;
  o   public.orders;
  res jsonb;
  v_max int := (public.lg_cfg('max_attempts'))::text::int;
begin
  res := public.lg_idem_get(p_event); if res is not null then return res; end if;
  -- au hub, le préparateur ou le chef de quai pose le colis dans SON lieu ; chez un vendeur
  -- (modèle A) le colis reste chez lui, « prêt à collecter »
  p_hub := coalesce(p_hub, (select hub_id from public.lg_staff_roles where user_id = auth.uid() and active
                              and role in ('picker', 'dock_chief') and hub_id is not null limit 1));
  select * into p from public.lg_packages where code = public.lg_norm_code(p_code) for update;
  if not found then return public.lg_idem_put(p_event, 'stage', jsonb_build_object('ok', false, 'error', 'unknown_package')); end if;
  if not (public.lg_has_role(array['picker', 'dock_chief']) or public.lg_can_pick(p.pick_task_id)) then
    raise exception 'forbidden';
  end if;
  if p.status = 'staged' then
    return public.lg_idem_put(p_event, 'stage', jsonb_build_object('ok', true, 'already', true, 'zone', p.zone, 'code', p.code));
  end if;
  if p.status not in ('packed', 'returned_hub') then
    return public.lg_idem_put(p_event, 'stage', jsonb_build_object('ok', false, 'error', 'bad_status', 'status', p.status));
  end if;
  -- double contrôle exigé au-delà du seuil de valeur, par une autre personne que le préparateur
  if p.check_required and p.checked_at is null then
    return public.lg_idem_put(p_event, 'stage', jsonb_build_object('ok', false, 'error', 'double_check_required', 'code', p.code));
  end if;
  if p.status = 'returned_hub' and p.attempts >= v_max then
    return public.lg_idem_put(p_event, 'stage', jsonb_build_object('ok', false, 'error', 'max_attempts_reached'));
  end if;
  select * into o from public.orders where id = p.order_id;
  if o.status = 'cancelled' or o.has_dispute then
    return public.lg_idem_put(p_event, 'stage', jsonb_build_object('ok', false, 'error', 'order_blocked'));
  end if;
  if o.payment_method = 'cod' and coalesce(o.payment_status, '') <> 'paid' and o.cod_confirmed_at is null then
    return public.lg_idem_put(p_event, 'stage', jsonb_build_object('ok', false, 'error', 'cod_not_confirmed'));
  end if;

  update public.lg_packages
     set status = 'staged', hub_id = coalesce(p_hub, hub_id),
         holder_type = case when coalesce(p_hub, hub_id) is null then holder_type else 'hub' end,
         holder_id   = case when coalesce(p_hub, hub_id) is null then holder_id else coalesce(p_hub, hub_id) end,
         updated_at = now()
   where id = p.id;
  insert into public.lg_scan_events (client_event_id, package_id, event, actor_id, hub_id, manual_entry, device_at)
  values (coalesce(p_event, gen_random_uuid()), p.id, 'stage', auth.uid(), coalesce(p_hub, p.hub_id), p_manual, coalesce(p_device_at, now()));

  update public.lg_pick_tasks set status = 'staged'
   where id = p.pick_task_id and status = 'packed'
     and not exists (select 1 from public.lg_packages where pick_task_id = p.pick_task_id and status = 'packed');

  return public.lg_idem_put(p_event, 'stage', jsonb_build_object(
    'ok', true, 'code', p.code, 'zone', p.zone, 'order_complete',
    not exists (select 1 from public.lg_packages where order_id = p.order_id and status in ('created', 'packed'))));
end; $$;

-- 9. ÉTIQUETTE (annexe C) : rien de personnel, ni nom, ni téléphone, ni montant ------
create or replace function public.lg_labels(p_task uuid default null, p_code text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not (public.lg_has_role(array['picker', 'dock_chief', 'dispatcher'])
          or (p_task is not null and public.lg_can_pick(p_task))) then
    raise exception 'forbidden';
  end if;
  if p_code is not null then
    perform public.lg_audit('label_reprint', 'package', public.lg_norm_code(p_code), '{}');
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'code', p.code, 'zone', coalesce(p.zone, 'SANS ZONE'), 'seq', p.seq_in_order, 'count', p.count_in_order,
      'order_short', upper(left(p.order_id::text, 4)), 'quarter', coalesce(o.landmark, o.shipping_city),
      'weight_g', p.weight_g, 'handling', p.handling,
      'cod', o.payment_method = 'cod' and coalesce(o.payment_status, '') <> 'paid',
      'packed_at', p.created_at, 'hub', h.name
    ) order by p.order_id, p.seq_in_order), '[]')
    from public.lg_packages p join public.orders o on o.id = p.order_id
    left join public.lg_hubs h on h.id = p.hub_id
   where (p_task is not null and p.pick_task_id = p_task)
      or (p_code is not null and p.code = public.lg_norm_code(p_code)));
end; $$;

-- 10. COMMANDES EN ATTENTE DE CONFIRMATION (service client : « sans réponse, appel ») ----
create or replace function public.lg_cod_pending() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['support', 'dispatcher']) then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'order_id', o.id, 'order_short', upper(left(o.id::text, 8)), 'customer', o.buyer_name, 'phone', o.buyer_phone,
      'zone', coalesce(o.delivery_zone, o.shipping_city), 'amount_fcfa', public.lg_order_due_fcfa(o.id), 'created_at', o.created_at,
      'tracking_url', (public.lg_cfg('tracking_base_url') #>> '{}') || o.tracking_token,
      'hours_waiting', round(extract(epoch from now() - o.created_at) / 3600, 1),
      'previous_orders', (select count(*) from public.orders o2 where public.lg_phone_key(o2.buyer_phone) = public.lg_phone_key(o.buyer_phone)
                            and o2.id <> o.id and o2.status = 'delivered'),
      'previous_refusals', (select count(*) from public.lg_trip_stops s join public.orders o3 on o3.id = s.order_id
                              where public.lg_phone_key(o3.buyer_phone) = public.lg_phone_key(o.buyer_phone) and s.failure_reason = 'refused'))
      order by o.created_at), '[]')
    from public.orders o
   where o.payment_method = 'cod' and o.cod_confirmed_at is null and o.status in ('pending', 'pending_payment', 'processing')
     and coalesce(o.payment_status, '') <> 'paid');
end; $$;
