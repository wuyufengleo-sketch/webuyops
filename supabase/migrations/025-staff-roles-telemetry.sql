-- 025 — Staff roles expansion + telemetry table + write-scope RLS
--
-- Sprint 13 (2026-06-09)
--
-- Adds 'doc' (documents / manifest team) and 'pm' (product managers) to the
-- profiles.role enum.
-- Tightens RLS so every authenticated user can read every table, but write
-- access is gated by their role to the tables their team owns. admin keeps
-- full write everywhere.
-- Adds public.user_events for per-user telemetry (search, feature usage,
-- errors, time-on-page) — read by admin Telemetry page, written by client.

-- ---------------------------------------------------------------------------
-- 1) Expand profiles.role enum to include 'doc' and 'pm'
-- ---------------------------------------------------------------------------
do $$
declare con record;
begin
  for con in
    select oid, conname from pg_constraint
    where conrelid = 'public.profiles'::regclass and contype = 'c'
  loop
    if pg_get_constraintdef(con.oid) ilike '%role%' then
      execute format('alter table public.profiles drop constraint %I', con.conname);
    end if;
  end loop;
end $$;

alter table public.profiles
  add constraint profiles_role_check
  check (role in ('admin','ops','visa','ticketing','cs','sales','doc','pm'));

alter table public.profiles
  add column if not exists force_password_change boolean not null default false;

-- ---------------------------------------------------------------------------
-- 2) Helper: current user's role (reads profiles.role for auth.uid())
--    SECURITY DEFINER so the helper itself can read profiles even when the
--    caller doesn't pass RLS — avoids infinite recursion in policies.
-- ---------------------------------------------------------------------------
create or replace function public.auth_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select role from public.profiles where id = auth.uid()), 'unknown');
$$;
grant execute on function public.auth_role() to authenticated, anon;

-- ---------------------------------------------------------------------------
-- 3) Tighten RLS: everyone reads all; writes gated by role
--    Map of role → tables they can INSERT/UPDATE/DELETE on:
--      admin    → all (always)
--      ops      → tours, ops_workflow, ops_logs, order_workflow, app_config
--      ticketing→ ticketing, ticketing_items, flights
--      visa     → visa_tours, visa_progress, photos, app_config
--      cs       → cs_records, cs_complaints, cs_cases, ops_logs
--      doc      → manifest_passengers, photos
--      pm       → sales_inquiries, private_tours, itinerary_quote, package_sales
--      sales    → sales_inquiries, private_tours
--    Everyone can write user_events (their own row only).
-- ---------------------------------------------------------------------------

-- Pull down old permissive policies on the tables we care about, then redefine.
do $$
declare
  rec record;
  policy_name text;
  table_list text[] := array[
    'profiles','tours','visa_progress','visa_tours','ticketing','ticketing_items',
    'ops_workflow','ops_logs','cs_cases','cs_records','cs_complaints',
    'sales_inquiries','private_tours','manifest_passengers','flights','photos',
    'app_config','audit_log','order_workflow','package_sales','package_orders',
    'tour_pnl','vendor_payments','refunds','tl_outputs','bk_groups',
    'staff_contacts','itinerary_quote','skybar_passengers'
  ];
  t text;
begin
  foreach t in array table_list loop
    if not exists (select 1 from pg_class where relname = t and relnamespace = 'public'::regnamespace) then
      continue;
    end if;
    execute format('alter table public.%I enable row level security', t);
    for rec in
      select polname from pg_policy where polrelid = ('public.'||t)::regclass
    loop
      execute format('drop policy if exists %I on public.%I', rec.polname, t);
    end loop;
    -- Permissive read for any authenticated user
    execute format($f$create policy "read_all_authenticated" on public.%I for select using (auth.role() = 'authenticated')$f$, t);
  end loop;
end $$;

-- Write policy generator
do $$
declare
  mapping record;
begin
  for mapping in
    select * from (values
      ('tours',               array['admin','ops']),
      ('ops_workflow',        array['admin','ops']),
      ('ops_logs',            array['admin','ops','cs']),
      ('order_workflow',      array['admin','ops']),
      ('app_config',          array['admin','ops','visa']),
      ('ticketing',           array['admin','ticketing']),
      ('ticketing_items',     array['admin','ticketing']),
      ('flights',             array['admin','ticketing']),
      ('visa_tours',          array['admin','visa']),
      ('visa_progress',       array['admin','visa']),
      ('cs_records',          array['admin','cs']),
      ('cs_complaints',       array['admin','cs']),
      ('cs_cases',            array['admin','cs']),
      ('manifest_passengers', array['admin','doc','visa']),
      ('photos',              array['admin','doc','visa']),
      ('sales_inquiries',     array['admin','pm','sales']),
      ('private_tours',       array['admin','pm','sales']),
      ('itinerary_quote',     array['admin','pm']),
      ('package_sales',       array['admin','pm','ops']),
      ('package_orders',      array['admin','pm','ops']),
      ('tour_pnl',            array['admin','ops']),
      ('vendor_payments',     array['admin','ops']),
      ('refunds',             array['admin','ops','cs']),
      ('tl_outputs',          array['admin','ops']),
      ('bk_groups',           array['admin','cs']),
      ('staff_contacts',      array['admin','ops']),
      ('skybar_passengers',   array['admin','doc']),
      ('audit_log',           array['admin'])
    ) as v(tbl, roles)
  loop
    if not exists (select 1 from pg_class where relname = mapping.tbl and relnamespace = 'public'::regnamespace) then
      continue;
    end if;
    execute format(
      $f$create policy "write_by_role" on public.%I for all using (public.auth_role() = any (%L)) with check (public.auth_role() = any (%L))$f$,
      mapping.tbl, mapping.roles, mapping.roles
    );
  end loop;
end $$;

-- Profiles: any authenticated user can read; only admin can write (+ self can update own row)
drop policy if exists "profiles_self_update" on public.profiles;
create policy "profiles_self_update" on public.profiles for update
  using (id = auth.uid() or public.auth_role() = 'admin')
  with check (id = auth.uid() or public.auth_role() = 'admin');
drop policy if exists "profiles_admin_insert" on public.profiles;
create policy "profiles_admin_insert" on public.profiles for insert
  with check (public.auth_role() = 'admin');
drop policy if exists "profiles_admin_delete" on public.profiles;
create policy "profiles_admin_delete" on public.profiles for delete
  using (public.auth_role() = 'admin');

-- ---------------------------------------------------------------------------
-- 4) user_events — telemetry firehose
-- ---------------------------------------------------------------------------
create table if not exists public.user_events (
  id           bigserial primary key,
  user_id      uuid references auth.users(id) on delete set null,
  username     text,                                     -- denormalized at write time
  role         text,                                     -- denormalized at write time
  event_type   text not null,                            -- 'page_view','search','click','modal','error','session_end'
  page         text,
  action       text,                                     -- e.g. button id / nav item
  query        text,                                     -- search term, when event_type='search'
  payload      jsonb,                                    -- free-form details
  duration_ms  int,                                      -- for page_view / session_end
  error_msg    text,
  user_agent   text,
  created_at   timestamptz not null default now()
);
create index if not exists user_events_user_at_idx on public.user_events(user_id, created_at desc);
create index if not exists user_events_type_at_idx on public.user_events(event_type, created_at desc);
create index if not exists user_events_page_at_idx on public.user_events(page, created_at desc);

alter table public.user_events enable row level security;

drop policy if exists "user_events_self_insert" on public.user_events;
create policy "user_events_self_insert" on public.user_events for insert
  with check (user_id = auth.uid() or auth.role() = 'authenticated');

drop policy if exists "user_events_admin_read" on public.user_events;
create policy "user_events_admin_read" on public.user_events for select
  using (public.auth_role() = 'admin' or user_id = auth.uid());

drop policy if exists "user_events_admin_delete" on public.user_events;
create policy "user_events_admin_delete" on public.user_events for delete
  using (public.auth_role() = 'admin');

-- ---------------------------------------------------------------------------
-- 5) Convenience view for the admin Telemetry page
-- ---------------------------------------------------------------------------
create or replace view public.user_events_daily as
select
  date_trunc('day', created_at)::date as day,
  coalesce(username, 'unknown')        as username,
  coalesce(role, 'unknown')            as role,
  event_type,
  page,
  count(*)                              as events,
  count(distinct date_trunc('hour', created_at)) as active_hours,
  sum(coalesce(duration_ms,0))          as total_ms
from public.user_events
group by 1,2,3,4,5;

grant select on public.user_events_daily to authenticated;
