-- 026 — Rewrite RLS from front-end audit (Sprint 13 follow-up)
--
-- The post-mortem from real staff testing showed:
--   * doc team (lodan/martina/nisa) actually does Visa work → needs write access
--     to visa_tours / visa_progress / app_config (visa_check_ext) / manifest_passengers.
--   * ticketing team needs to flip TL flag + needs_visa on manifest_passengers when
--     entering tickets per pax.
--   * cs team needs balance_alert_state / bk_groups / refunds / order_workflow
--     beyond just cs_records / cs_complaints.
--   * pm team needs package_sales + tour_pnl (they confirm departures).
--   * ops_logs is a shared log — any team should be able to append.
--
-- This migration nukes every policy on the listed tables and reinstates a clean
-- pair (read_all_authenticated SELECT + write_by_role ALL) per the audit.

-- ---------------------------------------------------------------------------
-- 1) Wipe + rebuild read-all SELECT policy on every table we care about
-- ---------------------------------------------------------------------------
do $$
declare
  rec record;
  t text;
  table_list text[] := array[
    'profiles','tours','bk_tours','visa_progress','visa_tours','ticketing','ticketing_items',
    'ops_workflow','ops_logs','cs_cases','cs_records','cs_complaints',
    'sales_inquiries','private_tours','manifest_passengers','flights','photos',
    'app_config','audit_log','order_workflow','package_sales','package_orders',
    'tour_pnl','vendor_payments','refunds','tl_outputs','bk_groups',
    'staff_contacts','itinerary_quote','itinerary_quotes','skybar_passengers',
    'balance_alert_state','peak_periods'
  ];
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
    execute format($f$create policy "read_all_authenticated" on public.%I for select using (auth.role() = 'authenticated')$f$, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2) Write policies — derived from front-end audit (who actually writes what)
-- ---------------------------------------------------------------------------
do $$
declare mapping record;
begin
  for mapping in
    select * from (values
      -- Core OPS-owned
      ('tours',               array['admin','ops']),
      ('bk_tours',            array['admin','ops']),
      ('ops_workflow',        array['admin','ops','cs']),
      ('order_workflow',      array['admin','ops','cs']),
      ('ops_logs',            array['admin','ops','cs','ticketing','visa','doc','pm','sales']),  -- shared log
      ('app_config',          array['admin','ops','visa','doc']),
      ('staff_contacts',      array['admin','ops']),
      ('vendor_payments',     array['admin','ops']),
      ('tl_outputs',          array['admin','ops']),
      ('peak_periods',        array['admin','ops']),

      -- Ticketing
      ('ticketing',           array['admin','ticketing','ops']),
      ('ticketing_items',     array['admin','ticketing','ops']),
      ('flights',             array['admin','ticketing','ops']),

      -- Visa (doc team is the de-facto visa team in production)
      ('visa_tours',          array['admin','visa','doc','ops']),
      ('visa_progress',       array['admin','visa','doc','ops']),

      -- CS
      ('cs_records',          array['admin','cs','ops']),
      ('cs_complaints',       array['admin','cs','ops']),
      ('cs_cases',            array['admin','cs','ops']),
      ('refunds',             array['admin','cs','ops']),
      ('balance_alert_state', array['admin','cs','ops']),
      ('bk_groups',           array['admin','cs','ops']),

      -- Documents / manifest — many teams touch this
      --   doc: full document workflow
      --   visa: needs_visa / visa_status / visa_remark per pax
      --   ticketing: is_tour_leader flag while entering tickets per pax
      --   cs: occasionally updates remarks on customer escalation
      --   ops: oversight
      ('manifest_passengers', array['admin','doc','visa','ticketing','cs','ops']),
      ('photos',              array['admin','doc','visa','ops']),
      ('skybar_passengers',   array['admin','doc','ops']),

      -- Product / sales
      ('sales_inquiries',     array['admin','pm','sales','ops']),
      ('private_tours',       array['admin','pm','sales','ops']),
      ('itinerary_quote',     array['admin','pm','sales']),
      ('itinerary_quotes',    array['admin','pm','sales']),
      ('package_sales',       array['admin','pm','ops']),
      ('package_orders',      array['admin','pm','ops']),
      ('tour_pnl',            array['admin','pm','ops']),

      -- Admin-only
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

-- ---------------------------------------------------------------------------
-- 3) Profiles: keep self-update + admin manage
-- ---------------------------------------------------------------------------
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
-- 4) user_events: re-create the telemetry policies that were dropped above
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_class where relname = 'user_events' and relnamespace = 'public'::regnamespace) then
    execute 'alter table public.user_events enable row level security';
    execute 'drop policy if exists "user_events_self_insert" on public.user_events';
    execute $f$create policy "user_events_self_insert" on public.user_events for insert with check (user_id = auth.uid() or auth.role() = 'authenticated')$f$;
    execute 'drop policy if exists "user_events_admin_read" on public.user_events';
    execute $f$create policy "user_events_admin_read" on public.user_events for select using (public.auth_role() = 'admin' or user_id = auth.uid())$f$;
    execute 'drop policy if exists "user_events_admin_delete" on public.user_events';
    execute $f$create policy "user_events_admin_delete" on public.user_events for delete using (public.auth_role() = 'admin')$f$;
  end if;
end $$;
