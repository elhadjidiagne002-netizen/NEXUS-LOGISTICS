-- =====================================================================
-- NEXUS LOGISTICS — Droits d'accès : TOUJOURS la dernière migration (nom en 2999…), à rejouer après toute autre
-- Supabase donne EXECUTE à PUBLIC **et**, par ALTER DEFAULT PRIVILEGES, des
-- GRANT explicites à anon et authenticated sur toute fonction créée dans
-- public (CLAUDE.md NEXUS §13). On ferme donc TOUT, puis on ouvre par liste.
-- Vérification : select proname, proacl from pg_proc where proname like 'lg\_%';
-- =====================================================================

-- Corrections manuelles réservées au comptable (les fonctions internes restent fermées)
create or replace function public.lg_issue_invoice_manual(p_order uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['accountant']) then raise exception 'forbidden'; end if;
  return public.lg_issue_invoice(p_order);
end; $$;

create or replace function public.lg_credit_note_manual(p_invoice uuid, p_lines jsonb, p_reason text,
                                                        p_amount_fcfa integer default null) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.lg_has_role(array['accountant']) then raise exception 'forbidden'; end if;
  if nullif(trim(p_reason), '') is null then raise exception 'reason_required'; end if;
  return public.lg_credit_note(p_invoice, p_lines, p_reason, p_amount_fcfa);
end; $$;

-- 1. Fonctions : tout fermer ------------------------------------------------------------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname like 'lg\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

-- 2. Ouvert aux personnes connectées (chaque fonction contrôle elle-même le rôle)
do $$
declare
  f record;
  allowed text[] := array[
    -- utilitaires purs et contrôle de rôle (utilisé par les règles RLS)
    'lg_has_role', 'lg_is_admin', 'lg_my_courier_id', 'lg_fcfa', 'lg_norm_code', 'lg_distance_m', 'lg_words_fr', 'lg_phone_key',
    -- session
    'lg_me',
    -- préparation
    'lg_pick_queue', 'lg_pick_task_detail', 'lg_pick_take', 'lg_pick_release', 'lg_pick_scan', 'lg_pick_short', 'lg_pack',
    'lg_stage', 'lg_labels', 'lg_confirm_cod', 'lg_cod_pending', 'lg_cancel_unconfirmed', 'lg_backfill_order_items',
    -- voyages et chargement
    'lg_trip_create', 'lg_trip_cancel', 'lg_trip_add_order', 'lg_trip_remove_stop', 'lg_trip_reorder', 'lg_load_package',
    'lg_unload_package', 'lg_trip_loading_view', 'lg_trip_seal', 'lg_trip_gauge_of', 'lg_trip_summary', 'lg_trips_list',
    'lg_staged_packages', 'lg_couriers_list', 'lg_transfer_stop', 'lg_take_transfer', 'lg_pickups_pending', 'lg_trip_add_pickup',
    'lg_returns_pending', 'lg_trip_add_return', 'lg_collect', 'lg_receive', 'lg_cash_drop',
    'lg_templates_list', 'lg_template_save', 'lg_preview_message', 'lg_outbox_recent', 'lg_autoplan_run', 'lg_double_check',
    'lg_location_upsert', 'lg_locations_list', 'lg_put_away', 'lg_product_find', 'lg_wave_create', 'lg_wave_detail', 'lg_wave_scan',
    'lg_forecast', 'lg_anomalies', 'lg_leaderboard', 'lg_return_inspect', 'lg_returns_to_inspect',
    'lg_my_waves', 'lg_inventory_today', 'lg_inventory_count', 'lg_inventory_history', 'lg_product_location',
    'lg_lots_expiring', 'lg_lot_discard', 'lg_lot_trace', 'lg_pick_productivity',
    'lg_return_causes', 'lg_return_cause_save', 'lg_return_classify', 'lg_return_stats',
    'lg_vendor_commitment_set', 'lg_my_commitment', 'lg_vendor_commitments_list',
    'lg_surcharges_list', 'lg_surcharge_save', 'lg_surcharge_declare',
    'lg_dock_upsert', 'lg_dock_checkin', 'lg_dock_assign', 'lg_dock_board', 'lg_trip_dock',
    'lg_kpis_by_axis', 'lg_costs',
    -- chauffeur
    'lg_trip_start', 'lg_my_day', 'lg_stop_call', 'lg_stop_arrive', 'lg_deliver', 'lg_fail', 'lg_trip_finish',
    'lg_driver_ping', 'lg_sos', 'lg_add_expense', 'lg_vehicle_check',
    -- retours, caisse, incidents
    'lg_return_hub', 'lg_return_vendor', 'lg_remit_cash', 'lg_cash_desk', 'lg_open_incident', 'lg_resolve_incident',
    'lg_incidents_list', 'lg_package_card',
    -- facturation
    'lg_invoice_get', 'lg_invoices_list', 'lg_accounting_export', 'lg_resolve_short', 'lg_issue_invoice_manual', 'lg_credit_note_manual',
    -- service client
    'lg_requests_list', 'lg_request_done',
    -- pilotage
    'lg_dashboard', 'lg_ack_alert', 'lg_suggest_trips', 'lg_autoplan', 'lg_trip_track', 'lg_kpis', 'lg_fleet',
    -- vendeurs
    'lg_vendor_overview', 'lg_product_logistics', 'lg_products_to_complete',
    -- administration
    'lg_find_users', 'lg_staff_list', 'lg_grant_role', 'lg_revoke_role', 'lg_upsert_hub', 'lg_upsert_vehicle', 'lg_add_document',
    'lg_log_maintenance', 'lg_set_vehicle_status', 'lg_pricing', 'lg_upsert_rate_card', 'lg_set_zone', 'lg_create_slots',
    'lg_upsert_pay_rule', 'lg_set_config',
    -- aussi utiles connectés : page de suivi, devis
    'lg_track', 'lg_track_confirm', 'lg_track_set_location', 'lg_track_rate', 'lg_track_request', 'lg_track_invoice',
    'lg_track_book_slot', 'lg_quote', 'lg_slots_available', 'lg_track_third_party'];
  public_fns text[] := array['lg_track_third_party', 'lg_track', 'lg_track_confirm', 'lg_track_set_location', 'lg_track_rate', 'lg_track_request',
                             'lg_track_invoice', 'lg_track_book_slot', 'lg_quote', 'lg_slots_available'];
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname = any (allowed) loop
    execute format('grant execute on function %s to authenticated', f.sig);
    -- 3. Ouvert aux visiteurs anonymes : page de suivi (lien secret) et devis au panier
    if f.proname = any (public_fns) then
      execute format('grant execute on function %s to anon', f.sig);
    end if;
  end loop;
end $$;

-- 4. Tables : aucune écriture directe par les apps, aucune lecture anonyme ----------------
do $$
declare t record;
begin
  for t in select c.oid::regclass as tbl from pg_class c
            where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
              and (c.relname like 'lg\_%' or c.relname = 'invoice_lines') loop
    execute format('revoke insert, update, delete, truncate on %s from anon, authenticated', t.tbl);
    execute format('revoke select on %s from anon', t.tbl);
    execute format('alter table %s enable row level security', t.tbl);
  end loop;
end $$;
-- lecture directe pour le temps réel (positions, voyages, alertes) : la RLS filtre
grant select on public.lg_trips, public.lg_trip_stops, public.lg_packages, public.lg_alerts, public.lg_failure_reasons
  to authenticated;
