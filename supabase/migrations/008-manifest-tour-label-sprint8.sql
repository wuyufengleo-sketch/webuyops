-- ============================================================================
--  Sprint 8 (batch 1) — Manifest tour grouping
--
--  The Manifest & Roomlist Google Sheet keeps one TAB per departing tour group
--  (tab name = group name + date, e.g. "6 DEC SHANGHAI"). To migrate those 242
--  tabs into the single manifest_passengers table we add a tour_label column so
--  every passenger row still knows which group it belongs to. The Manifest page
--  then filters / groups by tour_label.
--
--  Run this in the Supabase SQL Editor before running
--  supabase/import-manifest.mjs (DDL can't go through the REST/service-role key).
-- ============================================================================

alter table public.manifest_passengers
  add column if not exists tour_label text;

create index if not exists manifest_passengers_tour_label_idx
  on public.manifest_passengers (tour_label);

-- private_tours needs no schema change for batch 1 — its wide column set already
-- covers every field in the List Private Req sheet.
