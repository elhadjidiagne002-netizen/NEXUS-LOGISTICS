-- =====================================================================
-- NEXUS LOGISTICS — 02 · compléments du socle (phase 0)
-- Colonnes que le dossier liste au chapitre 08 mais que l'annexe A
-- n'écrit pas, outils partagés (réglages, journal, idempotence, file de
-- messages) et reprise des lignes de commande (point n° 3 du chapitre 02).
-- Rejouable. N'efface rien.
-- =====================================================================

-- 1. COLONNES COMPLÉMENTAIRES -------------------------------------------------
alter table public.orders
  add column if not exists cod_confirmed_at timestamptz,          -- confirmation préalable du paiement à la livraison
  add column if not exists cod_confirmed_via text,                -- whatsapp, appel, suivi, support
  add column if not exists delivery_zone text;                    -- zone retenue (delivery_zones.name)

alter table public.couriers
  add column if not exists license_expires_at date,
  add column if not exists cash_limit_fcfa    integer,             -- null = plafond général (réglage)
  add column if not exists pin_hash           text;

-- flotte élargie : on remplace la contrainte par un sur-ensemble (aucune ligne existante n'est rejetée)
alter table public.couriers drop constraint if exists couriers_vehicle_type_check;
alter table public.couriers add constraint couriers_vehicle_type_check
  check (vehicle_type in ('moto', 'vélo', 'voiture', 'pied', 'tricycle', 'fourgonnette', 'camion'));

alter table public.deliveries add column if not exists trip_stop_id uuid references public.lg_trip_stops(id);

alter table public.lg_pick_tasks add column if not exists last_activity_at timestamptz;
alter table public.lg_trips
  add column if not exists zones           text[] not null default '{}',  -- vide = toutes zones
  add column if not exists courier_signature_path text,
  add column if not exists cash_collected_fcfa integer not null default 0;

alter table public.lg_trip_stops add column if not exists call_attempted_at timestamptz;

-- 2. RÉGLAGES (rangés dans app_config, clé nexus_logistics_cfg) ----------------
create or replace function public.lg_cfg(p_key text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select value -> p_key from public.app_config where key = 'nexus_logistics_cfg'),
    jsonb_build_object(
      'eur_to_fcfa',        655.957,
      'max_attempts',       2,      -- présentations avant retour au vendeur
      'proof_radius_m',     300,    -- au-delà, livraison acceptée mais signalée
      'cash_limit_fcfa',    150000, -- plafond d'espèces porté par un chauffeur
      'pick_lock_minutes',  15,     -- libération d'une préparation inactive
      'tva_rate',           18,
      'detour_coef',        1.35,   -- distance à vol d'oiseau × coefficient
      'otp_ttl_hours',      48,
      'otp_attempts',       3,
      'heavy_kg',           15,
      'require_photo',      true,
      'staged_max_hours',   24,
      'stop_max_minutes',   15,
      'offline_max_minutes',20,
      'pay_per_package',    500,
      'pay_fixed_trip',     0,
      'bonus_zero_failure', 1000,
      'tracking_base_url',  'https://logistics.nexusmarket.sn/suivi/',
      'double_check_fcfa',  100000, -- valeur de commande au-delà de laquelle un second contrôle est exigé
      'bonus_on_time',      0,      -- prime par livraison à l'heure (0 = désactivée)
      'peak_days',          '[]'::jsonb
    ) -> p_key)
$$;

create or replace function public.lg_fcfa(p_eur numeric) returns integer
language sql stable set search_path = public as $$
  select round(coalesce(p_eur, 0) * (public.lg_cfg('eur_to_fcfa'))::text::numeric)::integer
$$;

-- 3. IDEMPOTENCE GÉNÉRIQUE ------------------------------------------------------
-- Chaque action de terrain porte un identifiant créé sur le téléphone. Une
-- action rejouée (après coupure réseau) renvoie le résultat déjà calculé.
create table if not exists public.lg_action_log (
  client_event_id uuid primary key,
  fn              text not null,
  actor_id        uuid,
  result          jsonb not null,
  created_at      timestamptz not null default now()
);
alter table public.lg_action_log enable row level security;

create or replace function public.lg_idem_get(p_event uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when p_event is null then null
              else (select result || jsonb_build_object('replayed', true)
                      from public.lg_action_log where client_event_id = p_event) end
$$;

create or replace function public.lg_idem_put(p_event uuid, p_fn text, p_result jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if p_event is not null then
    insert into public.lg_action_log (client_event_id, fn, actor_id, result)
    values (p_event, p_fn, auth.uid(), p_result) on conflict do nothing;
  end if;
  return p_result;
end; $$;

-- 4. JOURNAL D'AUDIT ET FILE DE MESSAGES ---------------------------------------
create or replace function public.lg_audit(p_action text, p_target_type text, p_target_id text, p_detail jsonb default '{}')
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_logs (actor_id, action, target_type, target_id, detail)
  values (auth.uid(), 'lg.' || p_action, p_target_type, p_target_id, coalesce(p_detail, '{}'));
end; $$;

-- Tous les messages logistiques passent par notification_outbox (reprises gérées).
-- Respecte les désinscriptions WhatsApp (wa_opt_outs) quand la table existe.
-- Modèles de messages (annexe B) : modifiables sans toucher au code. {variable} remplacée à l'envoi.
create table if not exists public.lg_message_templates (
  event_key  text primary key,
  label      text not null,
  position   smallint not null default 0,
  body_fr    text not null,
  body_wo    text,                 -- à faire rédiger par un locuteur wolof (pas de traduction automatique)
  active     boolean not null default true,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table public.lg_message_templates enable row level security;
insert into public.lg_message_templates (event_key, label, position, body_fr) values
 ('lg_cod_confirm', 'Confirmation (paiement à la livraison)', 1, 'Bonjour {prenom}, votre commande {commande} chez {vendeur} est enregistrée : {montant} F à payer à la livraison. Répondez OUI pour la confirmer, NON pour l''annuler.'),
 ('lg_order_confirmed', 'Commande confirmée', 2, 'Merci {prenom}. Commande {commande} confirmée, nous la préparons. Suivi : {lien}'),
 ('lg_stockout', 'Rupture', 3, '{prenom}, « {produit} » n''est plus disponible. Répondez 1 pour un remplacement, 2 pour être remboursé de cette ligne, 3 pour attendre son retour en stock.'),
 ('lg_prepared', 'Commande préparée', 4, '{prenom}, votre commande {commande} est prête ({colis} colis). Elle partira avec la prochaine tournée. Suivi : {lien}'),
 ('lg_out_for_delivery', 'En route', 5, 'Votre colis est en route avec {livreur}. Arrivée vers {heure}. Votre code de livraison : {code}. Ne le donnez qu''au livreur, à la remise du colis. Suivi : {lien}'),
 ('lg_approaching', 'À l''approche', 6, '{livreur} arrive dans environ {minutes} minutes. Montant à préparer : {montant} F.'),
 ('lg_delivered', 'Livré', 7, 'Colis remis à {heure}. Merci {prenom} ! Votre facture {facture} est disponible ici : {lien}. Comment s''est passée la livraison ? Répondez de 1 à 5.'),
 ('lg_failed', 'Échec de livraison', 8, 'Nous sommes passés à {heure} sans pouvoir vous remettre votre colis ({motif}). Répondez 1 pour une livraison demain, 2 pour choisir un autre jour, 3 pour être rappelé.'),
 ('lg_invoice_issued', 'Facture (paiement en ligne)', 9, 'Merci pour votre paiement, {prenom}. Votre facture {facture} : {lien}'),
 ('lg_return_scheduled', 'Reprise planifiée', 10, '{prenom}, un livreur passera reprendre votre article (commande {commande}). Préparez-le dans son emballage. Suivi : {lien}'),
 ('lg_evening_report', 'Rapport du soir (gérant)', 11, 'Rapport du soir : {livres} livrés, {echecs} échecs, 1re présentation {premiere_presentation} %, ponctualité {ponctualite} %, écart de caisse {especes} F, colis à quai depuis +24 h : {a_quai}.')
on conflict (event_key) do nothing;

-- Remplit un modèle : {variable} → valeur ; montants avec séparateur de milliers ; variable absente → vide
create or replace function public.lg_render_message(p_event text, p_vars jsonb, p_body text default null) returns text
language plpgsql stable security definer set search_path = public as $$
declare v_txt text; k text; v jsonb; val text;
begin
  v_txt := coalesce(p_body, (select body_fr from public.lg_message_templates where event_key = p_event));
  if v_txt is null then return null; end if;
  for k, v in select * from jsonb_each(coalesce(p_vars, '{}')) loop
    val := case when jsonb_typeof(v) = 'number' and k in ('montant', 'especes')
                then replace(to_char((v #>> '{}')::numeric, 'FM999G999G999'), ',', ' ')
                when jsonb_typeof(v) = 'null' then '' else v #>> '{}' end;
    v_txt := replace(v_txt, '{' || k || '}', coalesce(val, ''));
  end loop;
  return regexp_replace(v_txt, '\{[a-z_]+\}', '', 'g');
end; $$;

create or replace function public.lg_notify(p_event text, p_order uuid, p_vars jsonb default '{}')
returns uuid language plpgsql security definer set search_path = public as $$
declare
  o      public.orders;
  v_id   uuid;
  v_vars jsonb;
begin
  -- modèle désactivé par l'administrateur : on n'envoie rien
  if exists (select 1 from public.lg_message_templates where event_key = p_event and not active) then return null; end if;
  select * into o from public.orders where id = p_order;
  if not found or coalesce(o.buyer_phone, o.buyer_email) is null then return null; end if;
  v_vars := jsonb_build_object(
            'prenom',   split_part(coalesce(o.buyer_name, ''), ' ', 1),
            'commande', upper(left(o.id::text, 8)),
            'vendeur',  o.vendor_name,
            'montant',  coalesce(nullif(public.lg_order_due_fcfa(o.id), 0), public.lg_fcfa(o.total) + coalesce(o.delivery_fee_fcfa, 0)),
            'lien',     (public.lg_cfg('tracking_base_url') #>> '{}') || o.tracking_token
          ) || coalesce(p_vars, '{}');
  -- le texte final voyage avec le message : l'expéditeur WhatsApp n'a qu'à l'envoyer
  v_vars := v_vars || jsonb_build_object('texte', public.lg_render_message(p_event, v_vars));
  insert into public.notification_outbox (event_key, recipient, vars)
  values (p_event, jsonb_build_object('phone', o.buyer_phone, 'email', o.buyer_email, 'userId', o.buyer_id), v_vars)
  returning notification_outbox.id into v_id;
  return v_id;
end; $$;

-- 5. OUTILS -------------------------------------------------------------------
-- Code colis court, sans caractères ambigus (0/O, 1/I/L) : NXP-7K4M2Q
create or replace function public.lg_new_package_code() returns text
language plpgsql volatile set search_path = public as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  c text;
begin
  loop
    c := 'NXP-';
    for i in 1..6 loop
      c := c || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.lg_packages where code = c);
  end loop;
  return c;
end; $$;

-- Saisie de secours : « 7K4M2Q », « nxp7k4m2q » ou « NXP-7K4M2Q » désignent le même colis
create or replace function public.lg_norm_code(p_code text) returns text
language sql immutable as $$
  select 'NXP-' || right(regexp_replace(upper(coalesce(p_code, '')), '[^0-9A-Z]', '', 'g'), 6)
$$;

-- Distance en mètres (haversine)
create or replace function public.lg_distance_m(lat1 double precision, lng1 double precision,
                                                lat2 double precision, lng2 double precision)
returns integer language sql immutable as $$
  select case when lat1 is null or lng1 is null or lat2 is null or lng2 is null then null else
    round(2 * 6371000 * asin(sqrt(
      power(sin(radians(lat2 - lat1) / 2), 2) +
      cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2))))::integer end
$$;

create or replace function public.lg_my_courier_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.couriers where user_id = auth.uid() order by created_at limit 1
$$;

create or replace function public.lg_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
$$;

-- Zone d'une commande : zone choisie, sinon ville = nom de zone, sinon zone la plus proche du GPS
create or replace function public.lg_order_zone(p_order uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select z.name from public.orders o join public.delivery_zones z on z.name = o.delivery_zone where o.id = p_order),
    (select z.name from public.orders o join public.delivery_zones z
        on lower(z.name) = lower(trim(o.shipping_city)) where o.id = p_order limit 1),
    (select z.name from public.orders o, public.delivery_zones z
      where o.id = p_order and o.delivery_lat is not null
      order by public.lg_distance_m(o.delivery_lat, o.delivery_lng, z.lat, z.lng) limit 1))
$$;

-- 6. LIGNES DE COMMANDE : déplier orders.products (seule colonne remplie) -------
-- Les produits supprimés depuis la vente ne peuvent pas avoir de ligne (clé
-- étrangère RESTRICT) : ils sont comptés dans « skipped » et signalés.
create or replace function public.lg_sync_order_items(p_order uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o        public.orders;
  it       jsonb;
  pid      uuid;
  inserted int := 0;
  skipped  int := 0;
begin
  select * into o from public.orders where id = p_order;
  if not found then return jsonb_build_object('ok', false, 'error', 'unknown_order'); end if;
  if exists (select 1 from public.order_items where order_id = p_order) then
    return jsonb_build_object('ok', true, 'already', true);
  end if;
  for it in select * from jsonb_array_elements(
              case when jsonb_typeof(o.products) = 'array' and jsonb_array_length(o.products) > 0 then o.products
                   else coalesce(o.items, '[]') end)
  loop
    pid := null;
    begin pid := (it ->> 'id')::uuid; exception when others then pid := null; end;
    if pid is null or not exists (select 1 from public.products where id = pid) then
      skipped := skipped + 1;
      continue;
    end if;
    -- created_at = horloge réelle : garde l'ordre du panier (facture, bon de préparation)
    insert into public.order_items (order_id, product_id, quantity, unit_price, product_name, tva_rate, created_at)
    values (p_order, pid, greatest(coalesce((it ->> 'quantity')::int, 1), 1),
            coalesce((it ->> 'price')::numeric, 0),
            coalesce(it ->> 'name', (select name from public.products where id = pid)),
            (public.lg_cfg('tva_rate'))::text::numeric, clock_timestamp());
    inserted := inserted + 1;
  end loop;
  return jsonb_build_object('ok', true, 'inserted', inserted, 'skipped', skipped);
end; $$;

-- Reprise de toutes les commandes existantes (critère de sortie de la phase 0)
create or replace function public.lg_backfill_order_items() returns jsonb
language plpgsql security definer set search_path = public as $$
declare r record; res jsonb; n int := 0; ins int := 0; sk int := 0;
begin
  if auth.uid() is not null and not public.lg_is_admin() then raise exception 'forbidden'; end if;
  for r in select id from public.orders loop
    res := public.lg_sync_order_items(r.id);
    n := n + 1;
    ins := ins + coalesce((res ->> 'inserted')::int, 0);
    sk  := sk  + coalesce((res ->> 'skipped')::int, 0);
  end loop;
  return jsonb_build_object('orders', n, 'lines_inserted', ins, 'lines_skipped', sk);
end; $$;

-- Toute nouvelle commande crée ses lignes. Ne bloque JAMAIS l'enregistrement
-- d'une commande du site : une erreur est journalisée, pas propagée.
create or replace function public.lg_trg_order_items() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    perform public.lg_sync_order_items(new.id);
  exception when others then
    insert into public.audit_logs (action, target_type, target_id, detail)
    values ('lg.sync_order_items_failed', 'order', new.id::text, jsonb_build_object('error', sqlerrm));
  end;
  return null;
end; $$;
drop trigger if exists lg_order_items_sync on public.orders;
create trigger lg_order_items_sync after insert on public.orders
  for each row execute function public.lg_trg_order_items();

-- 7. RÉFÉRENTIEL DES MOTIFS D'ÉCHEC (annexe C) ---------------------------------
create table if not exists public.lg_failure_reasons (
  code          text primary key,
  label         text not null,
  next_action   text not null,
  counts_attempt boolean not null default true,  -- « accès impossible » ne compte pas
  requires_call boolean not null default false,
  to_vendor     boolean not null default false,  -- retour vendeur direct
  opens_incident boolean not null default false,
  position      smallint not null default 0
);
insert into public.lg_failure_reasons (code, label, next_action, counts_attempt, requires_call, to_vendor, opens_incident, position) values
  ('absent',        'Client absent',            'Nouvelle présentation, après appel.',                 true,  true,  false, false, 1),
  ('unreachable',   'Client injoignable',       'Nouvelle présentation après contact réussi.',         true,  true,  false, false, 2),
  ('address',       'Adresse introuvable',      'Demande de position, puis nouvelle présentation.',    true,  true,  false, false, 3),
  ('refused',       'Refus du colis',           'Retour vendeur, incident ouvert.',                    true,  false, true,  true,  4),
  ('no_money',      'Pas d''argent disponible', 'Nouvelle présentation ou paiement mobile.',           true,  false, false, false, 5),
  ('postponed',     'Report demandé',           'Nouveau créneau choisi par le client.',               true,  false, false, false, 6),
  ('damaged',       'Colis abîmé à l''arrivée', 'Retour au hub, incident, remplacement.',              false, false, false, true,  7),
  ('wrong_product', 'Mauvais produit',          'Retour au hub, incident préparation.',                false, false, false, true,  8),
  ('no_access',     'Accès impossible',         'Inondation, route coupée : report sans compter la tentative.', false, false, false, false, 9),
  ('breakdown',     'Panne ou accident',        'Réaffectation à un autre voyage.',                    false, false, false, true,  10)
on conflict (code) do nothing;
alter table public.lg_failure_reasons enable row level security;
drop policy if exists lg_failure_reasons_read on public.lg_failure_reasons;
create policy lg_failure_reasons_read on public.lg_failure_reasons for select to authenticated using (true);

-- 8. ALERTES DE LA TOUR DE CONTRÔLE --------------------------------------------
create table if not exists public.lg_alerts (
  id          bigint generated always as identity primary key,
  kind        text not null check (kind in ('late', 'long_stop', 'failure', 'not_scanned', 'cash_gap',
                                            'driver_offline', 'far_delivery', 'stale_package', 'doc_expiring',
                                            'cash_limit', 'sos', 'overload')),
  severity    text not null default 'warning' check (severity in ('info', 'warning', 'critical')),
  trip_id     uuid references public.lg_trips(id),
  stop_id     uuid references public.lg_trip_stops(id),
  package_id  uuid references public.lg_packages(id),
  message     text not null,
  dedupe_key  text unique,                       -- une seule alerte ouverte par situation
  created_at  timestamptz not null default now(),
  acked_by    uuid references public.profiles(id),
  acked_at    timestamptz
);
create index if not exists lg_alerts_open_idx on public.lg_alerts (created_at desc) where acked_at is null;
alter table public.lg_alerts enable row level security;
drop policy if exists lg_alerts_staff_read on public.lg_alerts;
create policy lg_alerts_staff_read on public.lg_alerts for select to authenticated
  using (public.lg_has_role(array['dock_chief', 'dispatcher', 'cashier', 'support']));

create or replace function public.lg_raise_alert(p_kind text, p_severity text, p_message text,
  p_trip uuid default null, p_stop uuid default null, p_package uuid default null, p_dedupe text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.lg_alerts (kind, severity, message, trip_id, stop_id, package_id, dedupe_key)
  values (p_kind, p_severity, p_message, p_trip, p_stop, p_package, p_dedupe)
  on conflict (dedupe_key) do nothing;
end; $$;
