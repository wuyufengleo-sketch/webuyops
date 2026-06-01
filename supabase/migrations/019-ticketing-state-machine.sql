-- ============================================================================
--  Sprint 11 #A v2 — Ticketing state-machine reminders
--
--  Replaces the simple H-14 / H-7 trigger with three semantic states (see
--  api/_ticketing-visa-alerts.js for the full state machine):
--
--    READY_TO_TICKET   — pax ≥ region_min AND total_deposit ≥ pax × per_pax_min
--                        → notify Ticketing once: "tour confirmed, book now"
--    CHASE_DEPOSIT     — pax ≥ region_min BUT deposit short
--                        → notify Sales once: "tour formed, X juta still owed"
--    PEAK_URGENT       — tour falls in a peak_periods window AND dep ≤ 30
--                        AND pax ≥ region_min
--                        → notify Ticketing with PEAK tag earlier than H-14
--
--  H-14 / H-7 fallback alerts (the original sprint 11 #A) still fire on top
--  for any tour that didn't get caught by the semantic triggers, so nothing
--  ever silently slides past departure.
-- ============================================================================

-- 1) Peak periods — manually curated calendar of Indonesian school breaks,
--    Eid, public holidays, long weekends, etc. Departures falling inside
--    any window get the PEAK_URGENT state.
create table if not exists public.peak_periods (
  id          bigserial primary key,
  start_date  date    not null,
  end_date    date    not null,
  reason      text    not null,           -- e.g. 'Eid 2026', 'School break Jun 2026'
  intensity   int     default 1,          -- 1=mild, 2=moderate, 3=high (reserved)
  notes       text,
  created_at  timestamptz default now()
);
create index if not exists peak_periods_window_idx on public.peak_periods(start_date, end_date);

alter table public.peak_periods enable row level security;
drop policy if exists "auth read"  on public.peak_periods;
drop policy if exists "auth write" on public.peak_periods;
create policy "auth read"  on public.peak_periods for select using (auth.role()='authenticated');
create policy "auth write" on public.peak_periods for all    using (auth.role()='authenticated') with check (auth.role()='authenticated');

-- 2) New per-state alerted_at columns on the existing state table so each
--    semantic trigger fires exactly once per tour.
alter table public.ticketing_alert_state
  add column if not exists ready_alerted_at         timestamptz,
  add column if not exists deposit_chase_alerted_at timestamptz,
  add column if not exists peak_alerted_at          timestamptz;
