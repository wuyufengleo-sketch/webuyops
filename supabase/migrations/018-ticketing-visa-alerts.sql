-- ============================================================================
--  Sprint 11 #A — Ticketing + Visa H-14 / H-7 reminder state
--
--  Tracks per-tour reminder firings for the two new sync reconcilers
--  (reconcileTicketingAlerts / reconcileVisaAlerts in api/_ticketing-visa-alerts.js).
--  Same pattern as tl_alert_state (migration 013): keyed PK + two timestamp
--  columns so we only ever send one H-14 ping and one H-7 ping per tour, no
--  matter how many times the daily cron runs.
--
--  First-run "silent seed": the reconciler upserts every then-pending tour with
--  fake alerted_at on its first call (gated by app_config.sprint11_ticketing_seeded
--  / sprint11_visa_seeded) so cron day 1 doesn't blast hundreds of backlog
--  alerts. Real alerting begins on day 2 onward.
-- ============================================================================

create table if not exists public.ticketing_alert_state (
  tour_code text primary key,
  h14_alerted_at timestamptz,
  h7_alerted_at  timestamptz,
  updated_at timestamptz default now()
);

create table if not exists public.visa_alert_state (
  visa_id text primary key,                  -- = visa_tours.id
  h14_alerted_at timestamptz,
  h7_alerted_at  timestamptz,
  updated_at timestamptz default now()
);
