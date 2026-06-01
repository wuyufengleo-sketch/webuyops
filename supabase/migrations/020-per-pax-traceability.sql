-- ============================================================================
--  Sprint 11 — final batch: per-pax ticket & visa留痕证据 + supporting columns
--
--    A. ticketing_items: 1 manifests row → N ticket rows (a pax can have
--       multiple segments / re-issues). Each row is a single ticket leg
--       with its own price + status + remark.
--    B. manifests visa columns: 1-1 since each person has at most one
--       visa per tour. Tracks whether the pax needs a visa, current
--       status, when it was submitted, and free-form notes.
--    C. bk_groups.no_group_alerted_at: dedup timestamp for the 24h
--       no-group nag reconciler (sprint 11 BK Group Phase 3).
--    D. balance_alert_state.resolved_at: lets CS / Finance close a
--       reconciled drift row from the new Balance Drift page so it stops
--       showing up in the active queue.
-- ============================================================================

-- A) Per-pax ticket items
create table if not exists public.ticketing_items (
  id            bigserial primary key,
  manifest_id   bigint,                       -- FK to manifests.id (kept loose — no constraint to avoid coupling on import order)
  bkg_no        text,                         -- denormalized for fast BK Detail render
  tour_code     text,                         -- denormalized for Ticketing Tracker per-tour view
  pax_name      text,                         -- denormalized snapshot at issue time
  segment       text,                         -- e.g. 'OUT', 'IN', 'CONNECT 1' — free-form
  ticket_no     text,                         -- airline ticket number or PNR
  vendor        text,
  price         numeric,                      -- IDR
  currency      text default 'IDR',
  status        text default 'NOT BOOKED',    -- NOT BOOKED / HELD / BOOKED / ISSUED / REISSUED / CANCELLED
  issue_date    date,
  remark        text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);
create index if not exists ticketing_items_manifest_idx on public.ticketing_items(manifest_id);
create index if not exists ticketing_items_bk_idx       on public.ticketing_items(bkg_no);
create index if not exists ticketing_items_tour_idx     on public.ticketing_items(tour_code);

drop trigger if exists ticketing_items_updated_at on public.ticketing_items;
create trigger ticketing_items_updated_at before update on public.ticketing_items
  for each row execute function public.set_updated_at();

alter table public.ticketing_items enable row level security;
drop policy if exists "auth read"  on public.ticketing_items;
drop policy if exists "auth write" on public.ticketing_items;
create policy "auth read"  on public.ticketing_items for select using (auth.role()='authenticated');
create policy "auth write" on public.ticketing_items for all    using (auth.role()='authenticated') with check (auth.role()='authenticated');

do $$ begin alter publication supabase_realtime add table public.ticketing_items; exception when duplicate_object then null; end $$;

-- B) Per-pax visa tracking on manifests
alter table public.manifests
  add column if not exists needs_visa      boolean,
  add column if not exists visa_status     text,
  add column if not exists visa_apply_date date,
  add column if not exists visa_remark     text;

-- C) BK Group Phase 3 alert dedup
alter table public.bk_groups
  add column if not exists no_group_alerted_at timestamptz;

-- D) Balance Drift "mark resolved"
alter table public.balance_alert_state
  add column if not exists resolved_at timestamptz;
