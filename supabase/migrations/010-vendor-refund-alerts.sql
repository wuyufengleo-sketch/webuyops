-- ============================================================================
--  Sprint 8 (batch 3) — Skybar auto-row creation + Lark alert throttling
--
--  Adds an `alerted_at` column to vendor_payments and refunds so the sync's
--  reconcilers can fire a Lark digest at most once per 7 days per row (and
--  silently seed the existing backlog on first run).
--
--  Run in the Supabase SQL Editor before deploying the new sync code.
-- ============================================================================

alter table public.vendor_payments add column if not exists alerted_at timestamptz;
alter table public.refunds         add column if not exists alerted_at timestamptz;
