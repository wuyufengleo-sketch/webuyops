-- ============================================================================
--  Sprint 1 — Ticketing table adjustments
--
--  Reason: the original schema FK-referenced public.tours(id) which is not
--  populated yet (that's Sprint 4). For now we key ticketing by `tour_code`
--  (citext) so it can be wired up immediately. Sprint 4 will introduce the
--  FK back to tours.id once tours are imported.
-- ============================================================================

-- Drop old structure
alter table public.ticketing drop constraint if exists ticketing_pkey;
alter table public.ticketing drop constraint if exists ticketing_tour_id_fkey;
alter table public.ticketing drop column if exists tour_id;

-- New PK column
alter table public.ticketing add column if not exists tour_code citext;
update public.ticketing set tour_code = lower(tour_code) where tour_code is not null;
alter table public.ticketing alter column tour_code set not null;
alter table public.ticketing add constraint ticketing_pkey primary key (tour_code);

-- Add seat column (used by existing UI)
alter table public.ticketing add column if not exists seat text;

-- Widen status to cover PARTIAL (was in localStorage but not original enum)
alter table public.ticketing drop constraint if exists ticketing_status_check;
alter table public.ticketing add constraint ticketing_status_check
  check (status in ('NOT BOOKED','HELD','PARTIAL','BOOKED','ISSUED','REISSUED','CANCELLED'));

-- ---------------------------------------------------------------------------
--  Enable Realtime for ticketing so concurrent edits propagate live.
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.ticketing;
