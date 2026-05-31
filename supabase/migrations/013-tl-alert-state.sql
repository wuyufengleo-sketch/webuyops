-- ============================================================================
--  Sprint 9 follow-up — TL Output pre-departure Lark reminders
--
--  Tracks H-14 / H-7 reminder firings per BK tour, so the daily cron only ever
--  sends ONE H-14 and ONE H-7 ping per tour to the TL Lark group, regardless
--  of how many times the cron runs (or the silent-seed pass on first run).
--
--  Run in the Supabase SQL Editor before deploying.
-- ============================================================================

create table if not exists public.tl_alert_state (
  tour_id text primary key,
  tl_name text,
  h14_alerted_at timestamptz,
  h7_alerted_at  timestamptz,
  updated_at timestamptz default now()
);
