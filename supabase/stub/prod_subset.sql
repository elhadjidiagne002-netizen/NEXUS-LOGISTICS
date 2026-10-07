-- =====================================================================
-- Miroir MINIMAL des tables NEXUS Market utilisées par la logistique.
-- Sert UNIQUEMENT aux tests locaux (PGlite) et au mode démo du navigateur.
-- Colonnes, types et contraintes relevés en lecture seule sur la prod
-- le 7 octobre 2026. Ne JAMAIS exécuter ce fichier sur la base réelle.
-- =====================================================================
create extension if not exists pgcrypto;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;

create schema if not exists auth;
-- Supabase : auth.uid() lit le JWT. Ici : un réglage de session.
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid
$$;

create table if not exists public.profiles (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  name        text not null,
  role        text not null default 'buyer',
  status      text default 'active',
  phone       text,
  company_name text, shop_name text, address text, ninea text, rc text,
  whatsapp_number text, commission_rate numeric default 15.00,
  current_lat double precision, current_lng double precision, location_updated_at timestamptz,
  created_at  timestamptz default now()
);

create or replace function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
$$;

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text, category text, price numeric, stock integer, vendor_id uuid, vendor_name text,
  active boolean default true, low_stock_threshold integer,
  is_animal boolean, is_rental boolean, is_realestate boolean, is_educational boolean,
  updated_at timestamptz default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'pending'
    check (status in ('pending', 'pending_payment', 'processing', 'in_transit', 'delivered', 'cancelled')),
  payment_status text default 'pending',
  payment_method text,
  products jsonb, items jsonb not null default '[]',
  total numeric, subtotal numeric,
  buyer_id uuid references public.profiles(id), buyer_name text, buyer_phone text, buyer_email text,
  buyer_address text, shipping_city text,
  vendor_id uuid, vendor_name text,
  has_dispute boolean not null default false,
  coupon_code text, mobile_money_ref text,
  paid_at timestamptz, processing_at timestamptz, in_transit_at timestamptz, delivered_at timestamptz,
  cancelled_at timestamptz, cancel_reason text,
  delivery_photo_url text, delivery_confirmed_at timestamptz, delivery_confirmed_by text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  unit_price numeric not null,
  created_at timestamptz default now()
);

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_number text not null unique,
  type text not null check (type in ('buyer', 'vendor', 'admin')),
  order_id uuid references public.orders(id) on delete set null,
  buyer_id uuid, vendor_id uuid,
  amount_ht numeric not null default 0, tva numeric not null default 0, amount_ttc numeric not null default 0,
  commission numeric not null default 0, net_vendor numeric not null default 0,
  status text not null default 'issued' check (status in ('draft', 'issued', 'paid', 'cancelled', 'refunded')),
  metadata jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.invoice_sequences (
  prefix text not null, year smallint not null, last_seq integer not null default 0,
  primary key (prefix, year)
);
create sequence if not exists public.invoice_seq_buyer;
create sequence if not exists public.invoice_seq_vendor;
create sequence if not exists public.invoice_seq_admin;
create or replace function public.generate_invoice_number(p_type text) returns text
language plpgsql security definer set search_path = public as $$
declare prefix text; seq_val bigint; yr text;
begin
  yr := to_char(now(), 'YYYY');
  case p_type
    when 'buyer'  then prefix := 'FAC';  seq_val := nextval('invoice_seq_buyer');
    when 'vendor' then prefix := 'VEND'; seq_val := nextval('invoice_seq_vendor');
    else               prefix := 'ADM';  seq_val := nextval('invoice_seq_admin');
  end case;
  return prefix || '-' || yr || '-' || lpad(seq_val::text, 6, '0');
end; $$;

create table if not exists public.couriers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid, name text not null, phone text not null,
  vehicle_type text not null default 'moto' check (vehicle_type in ('moto', 'vélo', 'voiture', 'pied')),
  vehicle_plate text, zones text[] not null default array['Dakar'],
  status text not null default 'pending' check (status in ('pending', 'active', 'suspended', 'offline')),
  is_available boolean not null default true,
  deliveries_done integer not null default 0,
  rating_avg numeric not null default 5.0, rating_count integer not null default 0,
  total_earned numeric not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.courier_earnings (
  id uuid primary key default gen_random_uuid(),
  courier_id uuid not null references public.couriers(id) on delete cascade,
  delivery_id uuid,
  amount integer not null,
  type text not null default 'delivery' check (type in ('delivery', 'bonus', 'payout')),
  status text not null default 'pending' check (status in ('pending', 'paid')),
  paid_at timestamptz, payment_ref text,
  created_at timestamptz not null default now()
);

create table if not exists public.deliveries (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders(id),
  courier_id uuid, status text not null default 'searching',
  created_at timestamptz default now()
);

create table if not exists public.delivery_zones (
  name text primary key, lat double precision not null, lng double precision not null, city text
);

create table if not exists public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  event_key text not null, recipient jsonb not null default '{}', vars jsonb not null default '{}',
  email_status text not null default 'pending', whatsapp_status text not null default 'pending',
  status text not null default 'pending', attempts integer not null default 0, max_attempts integer not null default 5,
  next_retry_at timestamptz not null default now(), last_error text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.app_config (
  id uuid primary key default gen_random_uuid(),
  key text not null unique, value jsonb not null default '{}',
  updated_by uuid, updated_at timestamptz default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id), actor_name text,
  action text not null, target_type text, target_id text, detail jsonb,
  created_at timestamptz default now()
);

create table if not exists public.disputes (
  id uuid primary key default gen_random_uuid(),
  order_id uuid, buyer_name text not null, vendor_name text not null,
  reason text not null, description text not null, status text default 'open',
  created_at timestamptz default now()
);

create table if not exists public.return_requests (
  id uuid primary key default gen_random_uuid(),
  order_id uuid, buyer_name text not null, vendor_name text not null,
  category text not null, description text not null, status text default 'pending',
  created_at timestamptz default now()
);

create table if not exists public.numeros_bannis (
  numero text, saisi text, raison text, banni_le timestamptz default now()
);

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
