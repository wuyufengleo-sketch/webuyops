-- ============================================================================
--  Sprint 9 follow-up — Balance reconciliation alert throttling
--
--  Tracks which BK numbers have been Lark-alerted (mismatch / Skybar-only) and
--  when, so the daily cron only pings CS about NEW or RE-OPENED issues — never
--  re-spams the same 68 mismatches every day.
--
--  Run in the Supabase SQL Editor before deploying.
-- ============================================================================

create table if not exists public.balance_alert_state (
  bk text primary key,
  flag text,                       -- 'mismatch' | 'skybar_only' (only alert-worthy flags tracked)
  sb_balance numeric(18,2),
  sheet_balance numeric(18,2),
  alerted_at timestamptz default now(),
  updated_at timestamptz default now()
);
