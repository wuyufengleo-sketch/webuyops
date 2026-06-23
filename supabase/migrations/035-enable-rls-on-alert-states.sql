-- 035 — Enable RLS on the three *_alert_state throttle tables.
--
-- Audit gap from 2026-06-22 health check: tl_alert_state / ticketing_alert_state /
-- visa_alert_state were created in 013 and 018 with row-level security DISABLED
-- (the catch-all in 026 listed balance_alert_state but missed these three).
--
-- Without RLS, any authenticated user can call PostgREST and:
--   * select h14/h7 timestamps to learn who got alerted when, or
--   * update / delete rows to suppress the next H-14/H-7 cron alert, or to
--     repeatedly re-fire alerts by clearing the throttle timestamp.
--
-- This migration:
--   1) enables RLS on all three tables,
--   2) drops any pre-existing policy (idempotent — safe to re-run),
--   3) installs a `read_all_authenticated` SELECT policy so the in-app dashboards
--      can still display alert state, and
--   4) installs NO write policy. The cron jobs talk to these tables with the
--      service_role key (see api/_tl-alerts.js / api/_ticketing-visa-alerts.js),
--      and service_role bypasses RLS by default, so writes continue to work
--      from the cron path only.

do $$
declare
  t text;
  rec record;
  alert_tables text[] := array[
    'tl_alert_state',
    'ticketing_alert_state',
    'visa_alert_state'
  ];
begin
  foreach t in array alert_tables loop
    if not exists (
      select 1 from pg_class
      where relname = t and relnamespace = 'public'::regnamespace
    ) then
      continue;
    end if;

    execute format('alter table public.%I enable row level security', t);

    for rec in
      select polname from pg_policy where polrelid = ('public.'||t)::regclass
    loop
      execute format('drop policy if exists %I on public.%I', rec.polname, t);
    end loop;

    execute format(
      $f$create policy "read_all_authenticated" on public.%I for select using (auth.role() = 'authenticated')$f$,
      t
    );
  end loop;
end $$;
