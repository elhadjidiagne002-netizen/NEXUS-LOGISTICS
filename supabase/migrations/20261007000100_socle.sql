-- =====================================================================
-- NEXUS LOGISTICS — 01 · socle (annexe A du dossier v2.0, rendu rejouable)
-- À exécuter d'abord sur une branche de test Supabase, jamais directement
-- en production. Le script n'efface et ne modifie aucune donnée existante.
-- =====================================================================

-- 1. PRODUITS : ce qu'il faut pour scanner, peser et tarifer ---------------
alter table public.products
  add column if not exists sku          text,
  add column if not exists barcode      text,
  add column if not exists weight_g     integer check (weight_g is null or weight_g > 0),
  add column if not exists length_cm    numeric(6,1),
  add column if not exists width_cm     numeric(6,1),
  add column if not exists height_cm    numeric(6,1),
  add column if not exists handling     text[]  not null default '{}',
  add column if not exists is_shippable boolean not null default true;

-- 255 fiches concernées. Vérifier d'abord que les déclencheurs posés sur products
-- (alertes de stock, notifications) ne réagissent pas à cette mise à jour.
update public.products set is_shippable = false
 where coalesce(is_realestate, false) or coalesce(is_educational, false) or coalesce(is_rental, false);

create index if not exists products_barcode_idx on public.products (barcode) where barcode is not null;
create unique index if not exists products_vendor_sku_uidx on public.products (vendor_id, sku) where sku is not null;

-- 2. COMMANDES, LIGNES, FACTURES : colonnes complémentaires -----------------
alter table public.orders
  add column if not exists tracking_token    uuid not null default gen_random_uuid(),
  add column if not exists delivery_lat      double precision,
  add column if not exists delivery_lng      double precision,
  add column if not exists landmark          text,
  add column if not exists delivery_fee_fcfa integer not null default 0,
  add column if not exists promised_at       timestamptz,
  add column if not exists hub_id            uuid;
create unique index if not exists orders_tracking_token_uidx on public.orders (tracking_token);

alter table public.order_items
  add column if not exists product_name text,
  add column if not exists tva_rate     numeric(5,2) not null default 18.00,
  add column if not exists picked_qty   integer not null default 0,
  add column if not exists line_status  text not null default 'pending'
    check (line_status in ('pending', 'picked', 'short', 'substituted', 'cancelled'));

alter table public.invoices
  add column if not exists credit_of        uuid references public.invoices(id),
  add column if not exists pdf_path         text,
  add column if not exists issued_at        timestamptz,
  add column if not exists sent_whatsapp_at timestamptz;

create table if not exists public.invoice_lines (
  id            uuid primary key default gen_random_uuid(),
  invoice_id    uuid not null references public.invoices(id) on delete cascade,
  position      smallint not null,
  kind          text not null default 'product' check (kind in ('product', 'delivery', 'discount', 'fee')),
  order_item_id uuid references public.order_items(id),
  label         text not null,
  quantity      integer not null default 1 check (quantity > 0),
  unit_price_ht numeric(12,2) not null,
  tva_rate      numeric(5,2) not null default 18.00,
  total_ht      numeric(14,2) generated always as (quantity * unit_price_ht) stored,
  unique (invoice_id, position)
);

-- 3. LIEUX ET RÔLES ---------------------------------------------------------
create table if not exists public.lg_hubs (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  kind       text not null default 'hub' check (kind in ('hub', 'quai', 'point_relais')),
  address    text,
  lat        double precision,
  lng        double precision,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.lg_staff_roles (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  role       text not null check (role in ('picker', 'dock_chief', 'dispatcher', 'cashier', 'accountant', 'support')),
  hub_id     uuid references public.lg_hubs(id),
  active     boolean not null default true,
  granted_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);

create or replace function public.lg_has_role(p_roles text[])
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
      or exists (select 1 from public.lg_staff_roles r
                  where r.user_id = auth.uid() and r.active and r.role = any (p_roles));
$$;

-- 4. VÉHICULES ---------------------------------------------------------------
create table if not exists public.lg_vehicles (
  id                 uuid primary key default gen_random_uuid(),
  plate              text not null unique,
  kind               text not null check (kind in ('vélo', 'moto', 'tricycle', 'voiture', 'fourgonnette', 'camion')),
  label              text,
  capacity_kg        numeric(8,1) not null check (capacity_kg > 0),
  capacity_l         numeric(10,1),
  max_packages       integer,
  equipment          text[] not null default '{}',
  ownership          text not null default 'interne' check (ownership in ('interne', 'partenaire', 'independant')),
  hub_id             uuid references public.lg_hubs(id),
  default_courier_id uuid references public.couriers(id),
  status             text not null default 'available' check (status in ('available', 'on_trip', 'maintenance', 'retired')),
  odometer_km        integer,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- 5. PRÉPARATION -------------------------------------------------------------
create table if not exists public.lg_pick_tasks (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references public.orders(id),
  hub_id     uuid references public.lg_hubs(id),
  vendor_id  uuid references public.profiles(id),
  status     text not null default 'todo' check (status in ('todo', 'picking', 'packed', 'staged', 'cancelled')),
  picker_id  uuid references public.profiles(id),
  cutoff_at  timestamptz,
  started_at timestamptz,
  done_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists lg_pick_tasks_queue_idx on public.lg_pick_tasks (status, cutoff_at);

create table if not exists public.lg_pick_lines (
  id                    uuid primary key default gen_random_uuid(),
  task_id               uuid not null references public.lg_pick_tasks(id) on delete cascade,
  order_item_id         uuid not null references public.order_items(id),
  product_id            uuid references public.products(id),
  qty_ordered           integer not null check (qty_ordered > 0),
  qty_picked            integer not null default 0 check (qty_picked >= 0),
  status                text not null default 'pending' check (status in ('pending', 'picked', 'short', 'substituted')),
  substitute_product_id uuid references public.products(id),
  manual_entry          boolean not null default false,
  picked_at             timestamptz,
  check (qty_picked <= qty_ordered)
);

-- 6. VOYAGES ET ARRÊTS -------------------------------------------------------
create sequence if not exists public.lg_trip_number_seq;

create table if not exists public.lg_trips (
  id                uuid primary key default gen_random_uuid(),
  number            integer not null unique default nextval('public.lg_trip_number_seq'),
  kind              text not null default 'delivery' check (kind in ('delivery', 'pickup', 'mixed', 'transfer')),
  label             text,
  hub_id            uuid references public.lg_hubs(id),
  vehicle_id        uuid not null references public.lg_vehicles(id),
  courier_id        uuid references public.couriers(id),
  planned_departure timestamptz,
  status            text not null default 'draft'
    check (status in ('draft', 'planned', 'loading', 'sealed', 'in_progress', 'completed', 'reconciled', 'cancelled')),
  load_weight_g     integer not null default 0,
  load_volume_l     numeric(10,2) not null default 0,
  load_count        integer not null default 0,
  cod_expected_fcfa integer not null default 0,
  distance_km       numeric(7,1),
  sealed_by         uuid references public.profiles(id),
  sealed_at         timestamptz,
  started_at        timestamptz,
  ended_at          timestamptz,
  created_by        uuid references public.profiles(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists lg_trips_courier_idx on public.lg_trips (courier_id, status);

create table if not exists public.lg_trip_stops (
  id             uuid primary key default gen_random_uuid(),
  trip_id        uuid not null references public.lg_trips(id) on delete cascade,
  seq            smallint not null,
  kind           text not null default 'delivery' check (kind in ('delivery', 'pickup', 'return')),
  order_id       uuid references public.orders(id),
  delivery_id    uuid references public.deliveries(id),
  contact_name   text,
  contact_phone  text,
  address        text,
  landmark       text,
  lat            double precision,
  lng            double precision,
  window_start   timestamptz,
  window_end     timestamptz,
  eta            timestamptz,
  cod_due_fcfa   integer not null default 0 check (cod_due_fcfa >= 0),
  status         text not null default 'pending' check (status in ('pending', 'en_route', 'arrived', 'delivered', 'failed', 'skipped')),
  failure_reason text,
  arrived_at     timestamptz,
  completed_at   timestamptz,
  -- différée : permet de réordonner les arrêts dans une seule transaction
  unique (trip_id, seq) deferrable initially deferred
);

-- 7. COLIS -------------------------------------------------------------------
create table if not exists public.lg_packages (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique,                 -- ex. NXP-7K4M2Q, imprimé en QR
  order_id       uuid not null references public.orders(id),
  pick_task_id   uuid references public.lg_pick_tasks(id),
  hub_id         uuid references public.lg_hubs(id),
  seq_in_order   smallint not null default 1,
  count_in_order smallint not null default 1,
  weight_g       integer check (weight_g is null or weight_g > 0),
  length_cm      numeric(6,1),
  width_cm       numeric(6,1),
  height_cm      numeric(6,1),
  volume_l       numeric(10,2) generated always as (length_cm * width_cm * height_cm / 1000.0) stored,
  handling       text[] not null default '{}',         -- fragile, lourd, liquide, alimentaire, froid, vivant
  zone           text references public.delivery_zones(name),
  status         text not null default 'created'
    check (status in ('created', 'packed', 'staged', 'loaded', 'out_for_delivery', 'delivered',
                      'failed', 'returned_hub', 'returned_vendor', 'lost', 'damaged', 'cancelled')),
  holder_type    text not null default 'hub' check (holder_type in ('vendor', 'hub', 'driver', 'customer')),
  holder_id      uuid,
  attempts       smallint not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists lg_packages_order_idx on public.lg_packages (order_id);
create index if not exists lg_packages_status_zone_idx on public.lg_packages (status, zone);

create table if not exists public.lg_package_items (
  package_id    uuid not null references public.lg_packages(id) on delete cascade,
  order_item_id uuid not null references public.order_items(id),
  quantity      integer not null check (quantity > 0),
  primary key (package_id, order_item_id)
);

create table if not exists public.lg_trip_packages (
  trip_id    uuid not null references public.lg_trips(id) on delete cascade,
  package_id uuid not null references public.lg_packages(id),
  stop_id    uuid references public.lg_trip_stops(id),
  load_zone  text check (load_zone in ('fond', 'milieu', 'porte', 'caisson')),
  load_seq   smallint,
  loaded_at  timestamptz,
  loaded_by  uuid references public.profiles(id),
  outcome    text check (outcome in ('delivered', 'failed', 'returned', 'removed')),
  primary key (trip_id, package_id)
);
-- un colis ne peut se trouver que dans un seul voyage en cours
create unique index if not exists lg_trip_packages_active_uidx
  on public.lg_trip_packages (package_id) where outcome is null;

-- 8. JOURNAL DE SCANS (ajout seul) ------------------------------------------
create table if not exists public.lg_scan_events (
  id              bigint generated always as identity primary key,
  client_event_id uuid not null unique,                -- rejouer un envoi hors ligne ne crée pas de doublon
  package_id      uuid not null references public.lg_packages(id),
  event           text not null check (event in ('pack', 'stage', 'load', 'unload', 'deliver', 'fail',
                                                 'return_hub', 'return_vendor', 'receive', 'inventory', 'damage')),
  actor_id        uuid not null references public.profiles(id),
  trip_id         uuid references public.lg_trips(id),
  hub_id          uuid references public.lg_hubs(id),
  lat             double precision,
  lng             double precision,
  manual_entry    boolean not null default false,
  device_at       timestamptz not null,
  server_at       timestamptz not null default now(),
  meta            jsonb not null default '{}'
);
create index if not exists lg_scan_events_package_idx on public.lg_scan_events (package_id, server_at);

create or replace function public.lg_forbid_change() returns trigger language plpgsql as $$
begin
  raise exception 'lg_scan_events est un journal : ajout seul';
end;
$$;
drop trigger if exists lg_scan_events_append_only on public.lg_scan_events;
create trigger lg_scan_events_append_only
  before update or delete on public.lg_scan_events
  for each row execute function public.lg_forbid_change();

-- 9. PREUVES, CODES DE LIVRAISON, CAISSE -------------------------------------
create table if not exists public.lg_proofs (
  id             uuid primary key default gen_random_uuid(),
  stop_id        uuid not null references public.lg_trip_stops(id) on delete cascade,
  kind           text not null check (kind in ('otp', 'signature', 'photo', 'failure_photo')),
  file_path      text,                                 -- espace de stockage privé « lg-proofs »
  recipient_name text,
  lat            double precision,
  lng            double precision,
  distance_m     integer,                              -- écart avec l'adresse prévue
  created_by     uuid not null references public.profiles(id),
  created_at     timestamptz not null default now()
);

create table if not exists public.lg_delivery_codes (
  order_id      uuid primary key references public.orders(id) on delete cascade,
  code_hash     text not null,                         -- crypt(code, gen_salt('bf')) via pgcrypto
  attempts_left smallint not null default 3,
  expires_at    timestamptz not null,
  verified_at   timestamptz
);

create table if not exists public.lg_cod_collections (
  id                    uuid primary key default gen_random_uuid(),
  stop_id               uuid not null references public.lg_trip_stops(id),
  order_id              uuid not null references public.orders(id),
  courier_id            uuid not null references public.couriers(id),
  amount_due_fcfa       integer not null check (amount_due_fcfa >= 0),
  amount_collected_fcfa integer not null check (amount_collected_fcfa >= 0),
  method                text not null check (method in ('cash', 'wave', 'orange_money')),
  payment_ref           text,
  collected_at          timestamptz not null default now(),
  unique (stop_id, method)
);

create table if not exists public.lg_cash_remittances (
  id            uuid primary key default gen_random_uuid(),
  trip_id       uuid not null unique references public.lg_trips(id),
  courier_id    uuid not null references public.couriers(id),
  expected_fcfa integer not null,
  remitted_fcfa integer not null,
  gap_fcfa      integer generated always as (remitted_fcfa - expected_fcfa) stored,
  cashier_id    uuid not null references public.profiles(id),
  note          text,
  validated_at  timestamptz not null default now()
);

-- 10. SÉCURITÉ : tout fermer, puis ouvrir rôle par rôle ----------------------
alter table public.invoice_lines       enable row level security;
alter table public.lg_hubs             enable row level security;
alter table public.lg_staff_roles      enable row level security;
alter table public.lg_vehicles         enable row level security;
alter table public.lg_pick_tasks       enable row level security;
alter table public.lg_pick_lines       enable row level security;
alter table public.lg_trips            enable row level security;
alter table public.lg_trip_stops       enable row level security;
alter table public.lg_packages         enable row level security;
alter table public.lg_package_items    enable row level security;
alter table public.lg_trip_packages    enable row level security;
alter table public.lg_scan_events      enable row level security;
alter table public.lg_proofs           enable row level security;
alter table public.lg_delivery_codes   enable row level security;
alter table public.lg_cod_collections  enable row level security;
alter table public.lg_cash_remittances enable row level security;

-- Lecture seule par les apps ; aucune règle d'écriture : toute écriture passe par une fonction.
-- Rendu rejouable : chaque policy est d'abord supprimée si elle existe.
drop policy if exists lg_trips_staff_read on public.lg_trips;
create policy lg_trips_staff_read on public.lg_trips for select to authenticated
  using (public.lg_has_role(array['dock_chief', 'dispatcher', 'cashier', 'accountant', 'support']));

drop policy if exists lg_trips_driver_read on public.lg_trips;
create policy lg_trips_driver_read on public.lg_trips for select to authenticated
  using (exists (select 1 from public.couriers c where c.id = lg_trips.courier_id and c.user_id = auth.uid()));

drop policy if exists lg_trip_stops_driver_read on public.lg_trip_stops;
create policy lg_trip_stops_driver_read on public.lg_trip_stops for select to authenticated
  using (exists (select 1 from public.lg_trips t join public.couriers c on c.id = t.courier_id
                  where t.id = lg_trip_stops.trip_id and c.user_id = auth.uid()));

drop policy if exists lg_packages_staff_read on public.lg_packages;
create policy lg_packages_staff_read on public.lg_packages for select to authenticated
  using (public.lg_has_role(array['picker', 'dock_chief', 'dispatcher', 'support']));

drop policy if exists lg_packages_vendor_read on public.lg_packages;
create policy lg_packages_vendor_read on public.lg_packages for select to authenticated
  using (exists (select 1 from public.orders o where o.id = lg_packages.order_id and o.vendor_id = auth.uid()));

