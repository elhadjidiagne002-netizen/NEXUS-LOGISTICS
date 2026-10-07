-- =====================================================================
-- NEXUS LOGISTICS — 05 · Module 02 Facturation (P1 + export P2)
-- Facture émise automatiquement (paiement confirmé, ou encaissement à la
-- livraison), jamais modifiée : toute correction passe par un AVOIR lié,
-- numéroté dans sa propre séquence (AV-AAAA-000001). Montants en FCFA entiers
-- sur la facture ; les prix catalogue (EUR) sont convertis × 655,957.
-- =====================================================================

-- Séquence continue par préfixe et par année (table invoice_sequences existante)
create or replace function public.lg_next_seq(p_prefix text) returns integer
language plpgsql security definer set search_path = public as $$
declare v_year smallint := extract(year from now() at time zone 'Africa/Dakar')::smallint; v_seq int;
begin
  perform pg_advisory_xact_lock(hashtext('lg_seq:' || p_prefix || v_year));
  update public.invoice_sequences set last_seq = last_seq + 1
   where prefix = p_prefix and year = v_year returning last_seq into v_seq;
  if v_seq is null then
    insert into public.invoice_sequences (prefix, year, last_seq) values (p_prefix, v_year, 1);
    v_seq := 1;
  end if;
  return v_seq;
end; $$;

-- Montant en lettres (français, règles de 1990 non appliquées : « quatre-vingts », « cent » variables)
create or replace function public.lg_words_fr(p_n bigint) returns text
language plpgsql immutable as $$
declare
  u text[] := array['zéro','un','deux','trois','quatre','cinq','six','sept','huit','neuf','dix','onze','douze',
                    'treize','quatorze','quinze','seize'];
  dz text[] := array['','dix','vingt','trente','quarante','cinquante','soixante','soixante','quatre-vingt','quatre-vingt'];
  r text := '';
  n bigint := abs(p_n);
  function_result text;
begin
  if n = 0 then return 'zéro'; end if;
  if n >= 1000000000 then
    r := r || case when n / 1000000000 = 1 then 'un milliard' else public.lg_words_fr(n / 1000000000) || ' milliards' end;
    n := n % 1000000000; if n > 0 then r := r || ' '; end if;
  end if;
  if n >= 1000000 then
    r := r || case when n / 1000000 = 1 then 'un million' else public.lg_words_fr(n / 1000000) || ' millions' end;
    n := n % 1000000; if n > 0 then r := r || ' '; end if;
  end if;
  if n >= 1000 then
    r := r || case when n / 1000 = 1 then 'mille' else regexp_replace(public.lg_words_fr(n / 1000), '(cent|vingt)s$', '\1') || ' mille' end;
    -- « quatre-vingt mille », « deux cent mille » : pas de pluriel devant mille
    n := n % 1000; if n > 0 then r := r || ' '; end if;
  end if;
  if n >= 100 then
    r := r || case when n / 100 = 1 then 'cent' else u[(n / 100)::int + 1] || ' cent' end;
    if n % 100 = 0 and n / 100 > 1 then r := r || 's'; end if;
    n := n % 100; if n > 0 then r := r || ' '; end if;
  end if;
  if n > 0 then
    if n <= 16 then
      r := r || u[n::int + 1];
    elsif n < 20 then
      r := r || 'dix-' || u[(n - 10)::int + 1];
    else
      declare d int := (n / 10)::int; e int := (n % 10)::int; begin
        if d in (7, 9) then
          r := r || dz[d + 1] || case when d = 7 and e = 1 then ' et ' else '-' end ||
               case when e + 10 <= 16 then u[e + 10 + 1] else 'dix-' || u[e + 1] end;
        else
          r := r || dz[d + 1] ||
               case when e = 0 then case when d = 8 then 's' else '' end
                    when e = 1 and d <> 8 then ' et un'
                    else '-' || u[e + 1] end;
        end if;
      end;
    end if;
  end if;
  return r;
end; $$;

-- Instantané des parties : figé au moment de l'émission
create or replace function public.lg_invoice_parties(p_order uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'issuer_mode', coalesce(public.lg_cfg('invoice_issuer') #>> '{}', 'vendor_via_nexus'),
    'seller', jsonb_build_object('name', coalesce(v.company_name, v.shop_name, o.vendor_name, v.name),
                                 'ninea', v.ninea, 'rc', v.rc, 'address', v.address, 'phone', v.phone,
                                 'vat_registered', v.ninea is not null),
    'platform', jsonb_build_object('name', 'NEXUS Market', 'address', 'Dakar, Sénégal', 'site', 'nexusmarket.sn'),
    'customer', jsonb_build_object('name', o.buyer_name, 'phone', o.buyer_phone, 'email', o.buyer_email,
                                   'address', concat_ws(', ', nullif(o.buyer_address, ''), o.delivery_zone, o.shipping_city)))
  from public.orders o left join public.profiles v on v.id = o.vendor_id where o.id = p_order
$$;

-- FACTURE CLIENT --------------------------------------------------------------------------
create or replace function public.lg_issue_invoice(p_order uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o        public.orders;
  v_inv    public.invoices;
  v_id     uuid;
  v_num    text;
  v_rate   numeric := (public.lg_cfg('tva_rate'))::text::numeric;
  pos      int := 0;
  li       record;
  v_full   int := 0;
  v_prod   int := 0;
  v_disc   int;
  v_ht     numeric := 0;
  v_ttc    int := 0;
  v_comm   numeric;
  v_crate  numeric;
  v_ref    text;
begin
  select * into v_inv from public.invoices where order_id = p_order and type = 'buyer' and credit_of is null
   order by created_at limit 1;
  if found then return jsonb_build_object('ok', true, 'already', true, 'id', v_inv.id, 'number', v_inv.invoice_number); end if;
  select * into o from public.orders where id = p_order for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'unknown_order'); end if;
  if not (coalesce(o.payment_status, '') = 'paid' or o.status = 'delivered') then
    return jsonb_build_object('ok', false, 'error', 'not_paid');
  end if;
  perform public.lg_sync_order_items(p_order);

  -- Numérotation continue SANS TROU, par année (chapitre 11) : table invoice_sequences sous verrou,
  -- annulée avec la transaction. generate_invoice_number (séquence Postgres) perd un numéro à chaque
  -- transaction annulée : constaté en démo (FAC-…-000004 puis 000034). Non utilisé ici.
  v_num := 'FAC-' || to_char(now() at time zone 'Africa/Dakar', 'YYYY') || '-' || lpad(public.lg_next_seq('FAC')::text, 6, '0');
  insert into public.invoices (invoice_number, type, order_id, buyer_id, vendor_id, status, metadata, issued_at)
  values (v_num, 'buyer', p_order, o.buyer_id, o.vendor_id, 'paid', '{}', now())
  returning id into v_id;

  for li in
    select oi.id, coalesce(oi.product_name, p.name, 'Article') as label, oi.tva_rate,
           public.lg_fcfa(oi.unit_price) as ttc_unit, oi.quantity,
           case when oi.line_status = 'cancelled' then 0
                when oi.line_status = 'short' then oi.picked_qty
                else oi.quantity end as qty
      from public.order_items oi left join public.products p on p.id = oi.product_id
     where oi.order_id = p_order order by oi.created_at, oi.id
  loop
    v_full := v_full + li.ttc_unit * li.quantity;
    continue when li.qty <= 0;
    pos := pos + 1;
    insert into public.invoice_lines (invoice_id, position, kind, order_item_id, label, quantity, unit_price_ht, tva_rate)
    values (v_id, pos, 'product', li.id, li.label, li.qty, round(li.ttc_unit / (1 + li.tva_rate / 100), 2), li.tva_rate);
    v_prod := v_prod + li.ttc_unit * li.qty;
  end loop;

  -- remise (code promo) : écart entre le prix catalogue et le total payé
  v_disc := v_full - public.lg_fcfa(o.total);
  if v_disc > 1 and pos > 0 then
    -- au prorata de ce qui est réellement facturé
    v_disc := round(v_disc::numeric * v_prod / greatest(v_full, 1));
    pos := pos + 1;
    insert into public.invoice_lines (invoice_id, position, kind, label, quantity, unit_price_ht, tva_rate)
    values (v_id, pos, 'discount', 'Remise' || coalesce(' (' || o.coupon_code || ')', ''), 1,
            -round(v_disc / (1 + v_rate / 100), 2), v_rate);
    v_prod := v_prod - v_disc;
  else
    v_disc := 0;
  end if;

  if coalesce(o.delivery_fee_fcfa, 0) > 0 then
    pos := pos + 1;
    insert into public.invoice_lines (invoice_id, position, kind, label, quantity, unit_price_ht, tva_rate)
    values (v_id, pos, 'delivery', 'Livraison' || coalesce(' — ' || o.delivery_zone, ''), 1,
            round(o.delivery_fee_fcfa / (1 + v_rate / 100), 2), v_rate);
  end if;

  v_ttc := v_prod + coalesce(o.delivery_fee_fcfa, 0);
  select coalesce(sum(total_ht), 0) into v_ht from public.invoice_lines where invoice_id = v_id;
  select coalesce(commission_rate, 15) into v_crate from public.profiles where id = o.vendor_id;
  v_comm := round(v_prod * coalesce(v_crate, 15) / 100);
  v_ref := coalesce(o.mobile_money_ref, (select string_agg(distinct cc.method || coalesce(':' || cc.payment_ref, ''), ', ')
                                           from public.lg_cod_collections cc where cc.order_id = p_order));

  update public.invoices set
    amount_ht = round(v_ht, 2), tva = round(v_ttc - v_ht, 2), amount_ttc = v_ttc,
    commission = v_comm, net_vendor = v_prod - v_comm,
    metadata = public.lg_invoice_parties(p_order) || jsonb_build_object(
      'currency', 'XOF', 'kind', 'invoice', 'order_short', upper(left(p_order::text, 8)),
      'payment_method', o.payment_method, 'payment_ref', v_ref,
      'amount_words', initcap(left(public.lg_words_fr(v_ttc), 1)) || substr(public.lg_words_fr(v_ttc), 2) || ' francs CFA',
      'discount_fcfa', v_disc)
  where id = v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'number', v_num, 'ttc', v_ttc);
end; $$;

-- AVOIR ---------------------------------------------------------------------------------
-- p_lines : [{order_item_id, quantity}] ; ou p_amount_fcfa pour un geste commercial global
create or replace function public.lg_credit_note(p_invoice uuid, p_lines jsonb, p_reason text,
                                                 p_amount_fcfa integer default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  inv    public.invoices;
  v_id   uuid;
  v_num  text;
  pos    int := 0;
  li     jsonb;
  oi     public.order_items;
  v_ttc  int := 0;
  v_ht   numeric;
  v_unit int;
  v_rate numeric := (public.lg_cfg('tva_rate'))::text::numeric;
  v_already int;
begin
  select * into inv from public.invoices where id = p_invoice for update;
  if not found or inv.credit_of is not null then raise exception 'unknown_invoice'; end if;
  v_num := 'AV-' || to_char(now() at time zone 'Africa/Dakar', 'YYYY') || '-' || lpad(public.lg_next_seq('AV')::text, 6, '0');
  insert into public.invoices (invoice_number, type, order_id, buyer_id, vendor_id, status, credit_of, metadata, issued_at)
  values (v_num, 'buyer', inv.order_id, inv.buyer_id, inv.vendor_id, 'refunded', p_invoice, '{}', now())
  returning id into v_id;

  if p_amount_fcfa is not null then
    pos := 1;
    insert into public.invoice_lines (invoice_id, position, kind, label, quantity, unit_price_ht, tva_rate)
    values (v_id, 1, 'fee', coalesce(p_reason, 'Geste commercial'), 1, -round(p_amount_fcfa / (1 + v_rate / 100), 2), v_rate);
    v_ttc := p_amount_fcfa;
  else
    for li in select * from jsonb_array_elements(coalesce(p_lines, '[]')) loop
      select * into oi from public.order_items where id = (li ->> 'order_item_id')::uuid and order_id = inv.order_id;
      if not found then raise exception 'unknown_line'; end if;
      -- jamais plus que ce qui a été facturé moins ce qui a déjà été crédité
      select coalesce(sum(il.quantity), 0) into v_already from public.invoice_lines il join public.invoices c on c.id = il.invoice_id
       where c.credit_of = p_invoice and il.order_item_id = oi.id;
      if (li ->> 'quantity')::int + v_already >
         coalesce((select quantity from public.invoice_lines where invoice_id = p_invoice and order_item_id = oi.id), 0) then
        raise exception 'credit_exceeds_invoice';
      end if;
      v_unit := public.lg_fcfa(oi.unit_price);
      pos := pos + 1;
      insert into public.invoice_lines (invoice_id, position, kind, order_item_id, label, quantity, unit_price_ht, tva_rate)
      values (v_id, pos, 'product', oi.id, coalesce(oi.product_name, 'Article') || ' — ' || coalesce(p_reason, 'avoir'),
              (li ->> 'quantity')::int, -round(v_unit / (1 + oi.tva_rate / 100), 2), oi.tva_rate);
      v_ttc := v_ttc + v_unit * (li ->> 'quantity')::int;
    end loop;
  end if;
  if pos = 0 then raise exception 'empty_credit_note'; end if;
  select sum(total_ht) into v_ht from public.invoice_lines where invoice_id = v_id;
  update public.invoices set amount_ht = round(v_ht, 2), amount_ttc = -v_ttc, tva = round(-v_ttc - v_ht, 2),
         metadata = public.lg_invoice_parties(inv.order_id) || jsonb_build_object(
           'currency', 'XOF', 'kind', 'credit_note', 'credit_of_number', inv.invoice_number, 'reason', p_reason,
           'amount_words', 'Moins ' || public.lg_words_fr(v_ttc) || ' francs CFA')
   where id = v_id;
  update public.invoices set status = case when (select coalesce(sum(amount_ttc), 0) from public.invoices
                                                   where id = p_invoice or credit_of = p_invoice) <= 0 then 'refunded' else status end,
         updated_at = now() where id = p_invoice;
  perform public.lg_audit('credit_note', 'invoice', v_num, jsonb_build_object('of', inv.invoice_number, 'ttc', v_ttc));
  return jsonb_build_object('ok', true, 'id', v_id, 'number', v_num, 'ttc', -v_ttc);
end; $$;

-- Avoir automatique pour le contenu d'un colis retourné au vendeur (si une facture existe)
create or replace function public.lg_credit_package(p_package uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_inv uuid; v_lines jsonb;
begin
  select i.id into v_inv from public.invoices i join public.lg_packages p on p.order_id = i.order_id
   where p.id = p_package and i.type = 'buyer' and i.credit_of is null limit 1;
  if v_inv is null then return jsonb_build_object('ok', true, 'none', true); end if;
  select jsonb_agg(jsonb_build_object('order_item_id', pi.order_item_id, 'quantity', pi.quantity)) into v_lines
    from public.lg_package_items pi
   where pi.package_id = p_package
     and exists (select 1 from public.invoice_lines il where il.invoice_id = v_inv and il.order_item_id = pi.order_item_id);
  if v_lines is null then return jsonb_build_object('ok', true, 'none', true); end if;
  return public.lg_credit_note(v_inv, v_lines, p_reason);
end; $$;

-- Choix du client après une rupture (annexe B, message 3) : 1 remplacement, 2 remboursement, 3 attente
create or replace function public.lg_resolve_short(p_order_item uuid, p_choice text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare oi public.order_items; v_inv uuid; v_res jsonb := '{}';
begin
  if not public.lg_has_role(array['support', 'dispatcher']) then raise exception 'forbidden'; end if;
  select * into oi from public.order_items where id = p_order_item;
  if not found or oi.line_status <> 'short' then raise exception 'not_short'; end if;
  if p_choice = 'refund' then
    select id into v_inv from public.invoices where order_id = oi.order_id and type = 'buyer' and credit_of is null limit 1;
    if v_inv is not null and exists (select 1 from public.invoice_lines where invoice_id = v_inv and order_item_id = oi.id
                                        and quantity > oi.picked_qty) then
      v_res := public.lg_credit_note(v_inv, jsonb_build_array(jsonb_build_object('order_item_id', oi.id,
                 'quantity', (select quantity from public.invoice_lines where invoice_id = v_inv and order_item_id = oi.id) - oi.picked_qty)),
                 'Rupture : remboursement');
    end if;
  elsif p_choice not in ('replace', 'wait') then
    raise exception 'invalid_choice';
  end if;
  perform public.lg_audit('short_resolution', 'order_item', p_order_item::text, jsonb_build_object('choice', p_choice));
  return jsonb_build_object('ok', true, 'choice', p_choice, 'credit_note', v_res ->> 'number');
end; $$;

-- Émission + message, sans jamais lever : appelée par les déclencheurs de orders
create or replace function public.lg_invoice_safe(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_inv jsonb;
begin
  v_inv := public.lg_issue_invoice(p_order);
  if (v_inv ->> 'ok')::boolean and not coalesce((v_inv ->> 'already')::boolean, false) then
    perform public.lg_notify('lg_invoice_issued', p_order, jsonb_build_object('facture', v_inv ->> 'number'));
  end if;
exception when others then
  insert into public.audit_logs (action, target_type, target_id, detail)
  values ('lg.invoice_failed', 'order', p_order::text, jsonb_build_object('error', sqlerrm));
end; $$;

-- Facture émise dès que le paiement en ligne est confirmé (le paiement à la livraison
-- est facturé à l'encaissement, dans lg_deliver)
create or replace function public.lg_trg_order_ready() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_inv jsonb;
begin
  begin
    perform public.lg_release_order(new.id);
  exception when others then
    insert into public.audit_logs (action, target_type, target_id, detail)
    values ('lg.order_ready_hook_failed', 'order', new.id::text, jsonb_build_object('error', sqlerrm));
  end;
  -- bloc séparé : une facture en échec n'empêche pas la préparation
  if new.payment_status = 'paid' and old.payment_status is distinct from 'paid' and coalesce(new.payment_method, '') <> 'cod' then
    perform public.lg_invoice_safe(new.id);
  end if;
  return null;
end; $$;

-- LECTURE ----------------------------------------------------------------------------------
create or replace function public.lg_invoice_doc(p_invoice uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(i) || jsonb_build_object(
    'lines', (select coalesce(jsonb_agg(jsonb_build_object('position', position, 'kind', kind, 'order_item_id', order_item_id, 'label', label, 'quantity', quantity,
                'unit_price_ht', unit_price_ht, 'tva_rate', tva_rate, 'total_ht', total_ht,
                'total_ttc', round(total_ht * (1 + tva_rate / 100))) order by position), '[]')
              from public.invoice_lines where invoice_id = i.id),
    'credits', (select coalesce(jsonb_agg(jsonb_build_object('number', invoice_number, 'ttc', amount_ttc, 'at', issued_at)), '[]')
                from public.invoices where credit_of = i.id))
  from public.invoices i where i.id = p_invoice
$$;

create or replace function public.lg_invoice_get(p_invoice uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare i public.invoices;
begin
  select * into i from public.invoices where id = p_invoice;
  if not found then raise exception 'unknown_invoice'; end if;
  if not (public.lg_has_role(array['accountant', 'support']) or coalesce(i.vendor_id = auth.uid(), false) or coalesce(i.buyer_id = auth.uid(), false)) then
    raise exception 'forbidden';
  end if;
  return public.lg_invoice_doc(p_invoice);
end; $$;

create or replace function public.lg_invoices_list(p_from date default null, p_to date default null, p_q text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.lg_has_role(array['accountant', 'support']) or exists (select 1 from public.profiles where id = auth.uid() and role = 'vendor')) then
    raise exception 'forbidden';
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'id', i.id, 'number', i.invoice_number, 'kind', case when i.credit_of is null then 'invoice' else 'credit_note' end,
      'order_short', upper(left(i.order_id::text, 8)), 'customer', i.metadata #>> '{customer,name}',
      'seller', i.metadata #>> '{seller,name}', 'ttc', i.amount_ttc, 'ht', i.amount_ht, 'tva', i.tva,
      'status', i.status, 'issued_at', coalesce(i.issued_at, i.created_at),
      'payment_method', i.metadata ->> 'payment_method', 'sent_whatsapp_at', i.sent_whatsapp_at) order by coalesce(i.issued_at, i.created_at) desc), '[]')
    from public.invoices i
   where i.metadata ? 'currency'   -- factures produites par la logistique
     and (p_from is null or coalesce(i.issued_at, i.created_at) >= p_from)
     and (p_to is null or coalesce(i.issued_at, i.created_at) < p_to + 1)
     and (p_q is null or i.invoice_number ilike '%' || p_q || '%' or i.metadata #>> '{customer,name}' ilike '%' || p_q || '%')
     and (public.lg_has_role(array['accountant', 'support']) or i.vendor_id = auth.uid())
   limit 500);
end; $$;

-- Export comptable : journal des ventes, TVA collectée, encaissements par mode
create or replace function public.lg_accounting_export(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['accountant']) then raise exception 'forbidden'; end if;
  return jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'sales_journal', (select coalesce(jsonb_agg(jsonb_build_object(
        'date', to_char(coalesce(i.issued_at, i.created_at) at time zone 'Africa/Dakar', 'YYYY-MM-DD'),
        'numero', i.invoice_number, 'type', case when i.credit_of is null then 'Facture' else 'Avoir' end,
        'commande', upper(left(i.order_id::text, 8)), 'client', i.metadata #>> '{customer,name}',
        'vendeur', i.metadata #>> '{seller,name}', 'ninea_vendeur', i.metadata #>> '{seller,ninea}',
        'ht', i.amount_ht, 'tva', i.tva, 'ttc', i.amount_ttc, 'commission', i.commission,
        'mode', i.metadata ->> 'payment_method') order by i.issued_at, i.invoice_number), '[]')
      from public.invoices i
     where i.metadata ? 'currency' and coalesce(i.issued_at, i.created_at) >= p_from and coalesce(i.issued_at, i.created_at) < p_to + 1),
    'vat_by_rate', (select coalesce(jsonb_agg(jsonb_build_object('taux', tva_rate, 'base_ht', ht, 'tva', round(ht * tva_rate / 100, 2))), '[]')
      from (select il.tva_rate, sum(il.total_ht) ht from public.invoice_lines il join public.invoices i on i.id = il.invoice_id
             where i.metadata ? 'currency' and coalesce(i.issued_at, i.created_at) >= p_from and coalesce(i.issued_at, i.created_at) < p_to + 1
             group by il.tva_rate) s),
    'collections_by_method', (select coalesce(jsonb_agg(jsonb_build_object('mode', method, 'montant', amt, 'nombre', n)), '[]')
      from (select method, sum(amount_collected_fcfa) amt, count(*) n from public.lg_cod_collections
             where collected_at >= p_from and collected_at < p_to + 1 group by method) s));
end; $$;

-- MONTANT DÛ PAR LE CLIENT ------------------------------------------------------------------
-- Ce qui sera réellement livré (ruptures et retours exclus), remise au prorata, + livraison.
-- C'est le montant affiché au chauffeur et celui de la facture : les deux ne peuvent diverger.
create or replace function public.lg_order_due_fcfa(p_order uuid) returns integer
language sql stable security definer set search_path = public as $$
  with o as (select * from public.orders where id = p_order),
       l as (select sum(public.lg_fcfa(oi.unit_price) * oi.quantity) as full_amt,
                    sum(public.lg_fcfa(oi.unit_price) * case when oi.line_status = 'cancelled' then 0
                                                             when oi.line_status = 'short' then oi.picked_qty
                                                             else oi.quantity end) as eff
               from public.order_items oi where oi.order_id = p_order)
  select case when o.payment_method <> 'cod' or coalesce(o.payment_status, '') = 'paid' then 0
              when l.full_amt is null then public.lg_fcfa(o.total) + coalesce(o.delivery_fee_fcfa, 0)
              else (l.eff - case when l.full_amt - public.lg_fcfa(o.total) > 1
                                 then round((l.full_amt - public.lg_fcfa(o.total))::numeric * l.eff / greatest(l.full_amt, 1))
                                 else 0 end)::int
                   + coalesce(o.delivery_fee_fcfa, 0) end
    from o, l
$$;

create or replace function public.lg_trg_order_items() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_inv jsonb;
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
  if new.payment_status = 'paid' and coalesce(new.payment_method, '') <> 'cod' then
    perform public.lg_invoice_safe(new.id);
  end if;
  return null;
end; $$;
