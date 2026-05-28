-- ============================================================================
--  Webuy OPS Center — Supabase schema (v1)
--  Run this once in: Supabase Dashboard → SQL Editor → New query → Paste → Run
--  Idempotent: safe to re-run; uses IF NOT EXISTS / CREATE OR REPLACE.
-- ============================================================================

-- ---------------------------------------------------------------------------
--  Extensions
-- ---------------------------------------------------------------------------
create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "citext";     -- case-insensitive text


-- ---------------------------------------------------------------------------
--  Helper: trigger that auto-updates `updated_at` on every UPDATE
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  new.updated_by = auth.uid();
  return new;
end $$;


-- ---------------------------------------------------------------------------
--  profiles — extends auth.users with name / role / department
--  One row per Supabase Auth user. Inserted via trigger on signup.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    citext unique not null,
  name        text not null,
  role        text not null check (role in ('admin','ops','visa','ticketing','cs','sales')),
  department  text,
  created_at  timestamptz not null default now()
);
comment on table public.profiles is 'Per-user profile, role and department. PK matches auth.users.id.';


-- ---------------------------------------------------------------------------
--  tours — master tour list (the single source of truth — replaces Visa Sheet)
-- ---------------------------------------------------------------------------
create table if not exists public.tours (
  id              uuid primary key default gen_random_uuid(),
  code            citext unique not null,                  -- e.g. "TGR250901"
  tour_name       text not null,
  departure_date  date not null,
  from_city       text,                                    -- "JKT", "SUB", etc.
  destination     text,                                    -- "JAPAN", "EUROPE", etc.
  tour_leader     text,
  vendor          text,
  total_pax       int  not null default 0 check (total_pax >= 0),
  group_pax       int  not null default 0,
  indiv_pax       int  not null default 0,
  hold_pax        int  not null default 0,
  remark          text,
  created_by      uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  updated_by      uuid references auth.users(id),
  updated_at      timestamptz not null default now()
);
create index if not exists tours_dep_idx on public.tours(departure_date);
drop trigger if exists tours_updated_at on public.tours;
create trigger tours_updated_at before update on public.tours
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
--  visa_progress — one row per tour, tracks visa workflow status
-- ---------------------------------------------------------------------------
create table if not exists public.visa_progress (
  tour_id      uuid primary key references public.tours(id) on delete cascade,
  status       text not null default 'STILL NOT CLOSE'
               check (status in ('STILL NOT CLOSE','SUBMITTED','UNDER REVIEW','PREPARE DONE','DELIVERY','DONE')),
  checklist    jsonb default '{}'::jsonb,
  prepare_done_at  timestamptz,
  delivery_at  timestamptz,
  done_at      timestamptz,
  updated_by   uuid references auth.users(id),
  updated_at   timestamptz not null default now()
);
drop trigger if exists visa_progress_updated_at on public.visa_progress;
create trigger visa_progress_updated_at before update on public.visa_progress
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
--  ticketing — one row per tour
-- ---------------------------------------------------------------------------
create table if not exists public.ticketing (
  tour_id     uuid primary key references public.tours(id) on delete cascade,
  status      text not null default 'NOT BOOKED'
              check (status in ('NOT BOOKED','HELD','BOOKED','ISSUED','REISSUED','CANCELLED')),
  vendor      text,
  pnr         text,
  issue_date  date,
  price       numeric(14,2) default 0,
  notes       text,
  updated_by  uuid references auth.users(id),
  updated_at  timestamptz not null default now()
);
drop trigger if exists ticketing_updated_at on public.ticketing;
create trigger ticketing_updated_at before update on public.ticketing
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
--  ops_workflow — workflow stage + checklist + financials per tour
-- ---------------------------------------------------------------------------
create table if not exists public.ops_workflow (
  tour_id      uuid primary key references public.tours(id) on delete cascade,
  stage        text not null default 'NEW',
  checklist    jsonb default '{}'::jsonb,
  financials   jsonb default '{}'::jsonb,
  updated_by   uuid references auth.users(id),
  updated_at   timestamptz not null default now()
);
drop trigger if exists ops_workflow_updated_at on public.ops_workflow;
create trigger ops_workflow_updated_at before update on public.ops_workflow
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
--  ops_logs — append-only activity log per tour (one row per entry)
-- ---------------------------------------------------------------------------
create table if not exists public.ops_logs (
  id          uuid primary key default gen_random_uuid(),
  tour_id     uuid not null references public.tours(id) on delete cascade,
  body        text not null,
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now()
);
create index if not exists ops_logs_tour_idx on public.ops_logs(tour_id, created_at desc);


-- ---------------------------------------------------------------------------
--  cs_cases — customer service cases (with SLA tracking)
-- ---------------------------------------------------------------------------
create table if not exists public.cs_cases (
  id            uuid primary key default gen_random_uuid(),
  tour_id       uuid references public.tours(id) on delete set null,
  customer_name text not null,
  channel       text,
  status        text not null default 'OPEN'
                check (status in ('OPEN','IN PROGRESS','PENDING CUSTOMER','RESOLVED','CLOSED')),
  sla_due_at    timestamptz,
  description   text,
  complaints    jsonb default '[]'::jsonb,
  notes         text,
  assigned_to   uuid references auth.users(id),
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  updated_by    uuid references auth.users(id),
  updated_at    timestamptz not null default now()
);
drop trigger if exists cs_cases_updated_at on public.cs_cases;
create trigger cs_cases_updated_at before update on public.cs_cases
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
--  sales_inquiries — top-of-funnel leads
-- ---------------------------------------------------------------------------
create table if not exists public.sales_inquiries (
  id            uuid primary key default gen_random_uuid(),
  customer      text not null,
  source        text,
  destination   text,
  pax           int default 0,
  est_value     numeric(14,2) default 0,
  stage         text not null default 'NEW'
                check (stage in ('NEW','CONTACTED','QUOTED','NEGOTIATING','CONFIRMED','LOST')),
  notes         text,
  assigned_to   uuid references auth.users(id),
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  updated_by    uuid references auth.users(id),
  updated_at    timestamptz not null default now()
);
drop trigger if exists sales_inquiries_updated_at on public.sales_inquiries;
create trigger sales_inquiries_updated_at before update on public.sales_inquiries
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
--  private_tours — custom / private tour requests
-- ---------------------------------------------------------------------------
create table if not exists public.private_tours (
  id              uuid primary key default gen_random_uuid(),
  customer        text not null,
  destination     text,
  departure_date  date,
  pax             int default 0,
  stage           text not null default 'INQUIRY'
                  check (stage in ('INQUIRY','PLANNING','QUOTED','CONFIRMED','DEPARTED','COMPLETED','CANCELLED')),
  itin_url        text,
  notes           text,
  assigned_to     uuid references auth.users(id),
  created_by      uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  updated_by      uuid references auth.users(id),
  updated_at      timestamptz not null default now()
);
drop trigger if exists private_tours_updated_at on public.private_tours;
create trigger private_tours_updated_at before update on public.private_tours
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
--  manifest_passengers — PAX manifest per tour
-- ---------------------------------------------------------------------------
create table if not exists public.manifest_passengers (
  id              uuid primary key default gen_random_uuid(),
  tour_id         uuid not null references public.tours(id) on delete cascade,
  full_name       text not null,
  passport_no     text,
  passport_expiry date,
  nationality     text,
  dob             date,
  room_type       text,
  dietary         text,
  notes           text,
  created_by      uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  updated_by      uuid references auth.users(id),
  updated_at      timestamptz not null default now()
);
create index if not exists manifest_tour_idx on public.manifest_passengers(tour_id);
drop trigger if exists manifest_passengers_updated_at on public.manifest_passengers;
create trigger manifest_passengers_updated_at before update on public.manifest_passengers
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
--  flights — flight schedule per tour
-- ---------------------------------------------------------------------------
create table if not exists public.flights (
  id           uuid primary key default gen_random_uuid(),
  tour_id      uuid not null references public.tours(id) on delete cascade,
  flight_no    text not null,
  carrier      text,
  dep_airport  text,
  arr_airport  text,
  dep_time     timestamptz,
  arr_time     timestamptz,
  vendor       text,
  notes        text,
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  updated_by   uuid references auth.users(id),
  updated_at   timestamptz not null default now()
);
create index if not exists flights_tour_idx on public.flights(tour_id, dep_time);
drop trigger if exists flights_updated_at on public.flights;
create trigger flights_updated_at before update on public.flights
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
--  photos — file references; actual files live in Storage bucket `tour-photos`
-- ---------------------------------------------------------------------------
create table if not exists public.photos (
  id           uuid primary key default gen_random_uuid(),
  tour_id      uuid references public.tours(id) on delete cascade,
  module       text not null,                      -- 'visa', 'manifest', etc.
  storage_path text not null,                      -- key inside the bucket
  filename     text,
  size_bytes   bigint,
  mime_type    text,
  uploaded_by  uuid references auth.users(id),
  uploaded_at  timestamptz not null default now()
);
create index if not exists photos_tour_idx on public.photos(tour_id, module);


-- ---------------------------------------------------------------------------
--  app_config — team-shared key/value config (replaces per-user localStorage)
--  Used for: lark webhook URLs, default Apps Script URL, etc.
-- ---------------------------------------------------------------------------
create table if not exists public.app_config (
  key         text primary key,
  value       text,
  updated_by  uuid references auth.users(id),
  updated_at  timestamptz not null default now()
);
drop trigger if exists app_config_updated_at on public.app_config;
create trigger app_config_updated_at before update on public.app_config
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
--  audit_log — generic audit trail (who changed what, when)
-- ---------------------------------------------------------------------------
create table if not exists public.audit_log (
  id          bigserial primary key,
  table_name  text not null,
  record_id   text not null,
  action      text not null check (action in ('INSERT','UPDATE','DELETE')),
  diff        jsonb,
  actor       uuid references auth.users(id),
  at          timestamptz not null default now()
);
create index if not exists audit_table_idx on public.audit_log(table_name, at desc);


-- ===========================================================================
--  Row Level Security
--  v1 policy: any authenticated user can read+write everything.
--  Tighten later by role using profiles.role.
-- ===========================================================================
alter table public.profiles            enable row level security;
alter table public.tours               enable row level security;
alter table public.visa_progress       enable row level security;
alter table public.ticketing           enable row level security;
alter table public.ops_workflow        enable row level security;
alter table public.ops_logs            enable row level security;
alter table public.cs_cases            enable row level security;
alter table public.sales_inquiries     enable row level security;
alter table public.private_tours       enable row level security;
alter table public.manifest_passengers enable row level security;
alter table public.flights             enable row level security;
alter table public.photos              enable row level security;
alter table public.app_config          enable row level security;
alter table public.audit_log           enable row level security;

-- Permissive v1 policies — replace later with role-based ones
do $$
declare t text;
begin
  for t in select unnest(array[
    'profiles','tours','visa_progress','ticketing','ops_workflow','ops_logs',
    'cs_cases','sales_inquiries','private_tours','manifest_passengers',
    'flights','photos','app_config','audit_log'
  ]) loop
    execute format('drop policy if exists "auth read"  on public.%I', t);
    execute format('drop policy if exists "auth write" on public.%I', t);
    execute format('create policy "auth read"  on public.%I for select using (auth.role() = ''authenticated'')', t);
    execute format('create policy "auth write" on public.%I for all    using (auth.role() = ''authenticated'') with check (auth.role() = ''authenticated'')', t);
  end loop;
end $$;


-- ===========================================================================
--  Auto-create a profile row whenever a new auth user is created
--  (Reads username/name/role from raw_user_meta_data passed at signup time)
-- ===========================================================================
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'role', 'ops')
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
