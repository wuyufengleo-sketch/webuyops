-- 028 — Fix the set_updated_at() trigger crashing on tables without updated_by
--
-- The shared BEFORE UPDATE trigger function set_updated_at() (schema.sql)
-- assigns `new.updated_by = auth.uid()`. Five tables were created WITHOUT an
-- updated_by column but still attach this trigger:
--
--   • bk_groups        (migration 015)
--   • staff_contacts   (migration 016)
--   • itinerary_quotes (migration 017)
--   • ticketing_items  (migration 020)
--   • tour_pnl         (migration 024)
--
-- In PL/pgSQL, assigning to a NEW field that doesn't exist raises
--   record "new" has no field "updated_by"
-- so EVERY update / upsert-that-resolves-to-update on those tables fails.
-- This broke the quote pipeline status transitions, per-cell ticketing edits,
-- and the bk_groups / tour_pnl reconcilers.
--
-- Fix in two layers:
--   1. Add the missing updated_by column to those five tables, so they match
--      every other audited table in the schema.
--   2. Harden set_updated_at() so a future table missing the column degrades
--      gracefully (skips the stamp) instead of erroring the whole UPDATE.

-- 1. Backfill the missing audit column (idempotent).
alter table public.bk_groups        add column if not exists updated_by uuid references auth.users(id);
alter table public.staff_contacts   add column if not exists updated_by uuid references auth.users(id);
alter table public.itinerary_quotes add column if not exists updated_by uuid references auth.users(id);
alter table public.ticketing_items  add column if not exists updated_by uuid references auth.users(id);
alter table public.tour_pnl         add column if not exists updated_by uuid references auth.users(id);

-- 2. Make the trigger tolerant of tables that lack updated_by.
--    The inner block catches the undefined_column error (SQLSTATE 42703) so the
--    updated_at stamp always succeeds even if updated_by is absent.
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  begin
    new.updated_by = auth.uid();
  exception when undefined_column then
    -- table has no updated_by column; skip the stamp rather than failing.
    null;
  end;
  return new;
end $$;
