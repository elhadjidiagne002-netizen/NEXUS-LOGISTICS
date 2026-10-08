-- =====================================================================
-- NEXUS LOGISTICS — cycle 16 · Relevé de reversement des vendeurs (module 08, P2)
-- « Montant net après commission et frais, à partir des commandes livrées et
-- rapprochées. » Relevé INDICATIF, en lecture seule : le versement réel reste
-- dans payout_requests (flux NEXUS existant). Rien n'est écrit ici.
--   valeur des produits livrés (ruptures et lignes annulées exclues, remise au prorata,
--   sans les frais de livraison qui reviennent à NEXUS)
-- − commission (profiles.commission_rate, 15 % par défaut)
-- − frais de retour à la charge du vendeur (cycle 8, lg_return_charges)
-- Une commande payée à la livraison n'est « reversable » qu'une fois son voyage rapproché
-- (espèces comptées) ; avant, elle figure « en attente de rapprochement ».
-- =====================================================================

-- Valeur des produits effectivement livrés d'une commande, en F CFA
create or replace function public.lg_order_goods_fcfa(p_order uuid) returns integer
language sql stable security definer set search_path = public as $$
  with o as (select * from public.orders where id = p_order),
       l as (select sum(public.lg_fcfa(oi.unit_price) * oi.quantity) full_amt,
                    sum(public.lg_fcfa(oi.unit_price) * case when oi.line_status = 'cancelled' then 0
                                                             when oi.line_status = 'short' then oi.picked_qty
                                                             else oi.quantity end) eff
               from public.order_items oi where oi.order_id = p_order)
  select case when l.full_amt is null then public.lg_fcfa(o.total)
              else (l.eff - case when l.full_amt - public.lg_fcfa(o.total) > 1
                                 then round((l.full_amt - public.lg_fcfa(o.total))::numeric * l.eff / greatest(l.full_amt, 1))
                                 else 0 end)::int end
    from o, l
$$;

-- Payée en ligne ; en espèces, seulement quand le voyage de livraison est rapproché (versées
-- et comptées) — payment_status passe à « paid » dès l'encaissement par le chauffeur, trop tôt.
create or replace function public.lg_order_settled(p_order uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case when o.payment_method <> 'cod' then coalesce(o.payment_status = 'paid', false) else exists (select 1 from public.lg_packages p join public.lg_trip_packages tp on tp.package_id = p.id and tp.outcome = 'delivered'
                   join public.lg_trips t on t.id = tp.trip_id where p.order_id = o.id and t.status = 'reconciled') end
    from public.orders o where o.id = p_order
$$;

create or replace function public.lg_vendor_statement(p_from date, p_to date, p_vendor uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_vendor uuid; v_rate numeric; v_name text;
        v_from timestamptz := p_from::timestamp at time zone 'Africa/Dakar';
        v_to   timestamptz := (p_to + 1)::timestamp at time zone 'Africa/Dakar';
begin
  if p_vendor is not null and public.lg_has_role(array['accountant']) then
    v_vendor := p_vendor;
  elsif exists (select 1 from public.profiles where id = auth.uid() and role = 'vendor') and not public.lg_device_blocked() then
    v_vendor := auth.uid();                -- un vendeur ne voit que son relevé, quel que soit p_vendor
  elsif public.lg_has_role(array['accountant']) then
    raise exception 'vendor_required';
  else
    raise exception 'forbidden';
  end if;
  select coalesce(commission_rate, 15), coalesce(shop_name, name) into v_rate, v_name from public.profiles where id = v_vendor;
  if not found then raise exception 'unknown_vendor'; end if;
  return (with ord as (
      select o.id, upper(left(o.id::text, 8)) short, o.delivered_at, o.payment_method, o.buyer_name,
             public.lg_order_goods_fcfa(o.id) goods, public.lg_order_settled(o.id) settled
        from public.orders o
       where o.vendor_id = v_vendor and o.status = 'delivered' and o.delivered_at >= v_from and o.delivered_at < v_to),
    ord2 as (select *, round(goods * v_rate / 100)::int commission from ord),
    ded as (select rc.amount_fcfa, rc.classified_at, c.label, p.code
              from public.lg_return_charges rc join public.lg_return_causes c on c.code = rc.cause
              join public.lg_packages p on p.id = rc.package_id
             where rc.vendor_id = v_vendor and rc.payer = 'vendor' and rc.amount_fcfa > 0
               and rc.classified_at >= v_from and rc.classified_at < v_to)
    select jsonb_build_object('vendor_id', v_vendor, 'vendor', v_name, 'commission_rate', v_rate, 'from', p_from, 'to', p_to,
      'orders', (select coalesce(jsonb_agg(jsonb_build_object('order_id', id, 'short', short, 'delivered_at', delivered_at,
                   'payment_method', payment_method, 'customer', buyer_name, 'goods_fcfa', goods, 'commission_fcfa', commission,
                   'net_fcfa', goods - commission, 'settled', settled) order by delivered_at), '[]') from ord2),
      'deductions', (select coalesce(jsonb_agg(jsonb_build_object('package', code, 'cause', label, 'amount_fcfa', amount_fcfa,
                       'at', classified_at) order by classified_at), '[]') from ded),
      'totals', jsonb_build_object(
          'orders', (select count(*) from ord2),
          'goods_fcfa', (select coalesce(sum(goods), 0) from ord2),
          'commission_fcfa', (select coalesce(sum(commission), 0) from ord2),
          'deductions_fcfa', (select coalesce(sum(amount_fcfa), 0) from ded),
          -- reversable : commandes réglées, moins toutes les retenues de la période
          'net_payable_fcfa', (select coalesce(sum(goods - commission) filter (where settled), 0) from ord2)
                              - (select coalesce(sum(amount_fcfa), 0) from ded),
          'pending_fcfa', (select coalesce(sum(goods - commission) filter (where not settled), 0) from ord2),
          'pending_orders', (select count(*) filter (where not settled) from ord2))));
end; $$;

-- Synthèse pour le comptable : tous les vendeurs livrés sur la période
create or replace function public.lg_vendor_statements(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['accountant']) then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(public.lg_vendor_statement(p_from, p_to, v.vendor_id) -> 'totals'
            || jsonb_build_object('vendor_id', v.vendor_id, 'vendor', (select coalesce(shop_name, name) from public.profiles where id = v.vendor_id))
            order by v.vendor_id), '[]')
    from (select distinct vendor_id from public.orders
           where vendor_id is not null and status = 'delivered'
             and delivered_at >= p_from::timestamp at time zone 'Africa/Dakar'
             and delivered_at < (p_to + 1)::timestamp at time zone 'Africa/Dakar'
          union
          select distinct vendor_id from public.lg_return_charges
           where vendor_id is not null and payer = 'vendor' and amount_fcfa > 0
             and classified_at >= p_from::timestamp at time zone 'Africa/Dakar'
             and classified_at < (p_to + 1)::timestamp at time zone 'Africa/Dakar') v
   where exists (select 1 from public.profiles where id = v.vendor_id));
end; $$;
