-- ============================================================================
--  042 — Manifest ↔ Skybear rooming-list mirror flag
--
--  api/sync-skybar.js now reconciles manifest_passengers against
--  skybar_passengers (the Skybear hotel rooming list) at the passenger level:
--  it inserts missing pax and refreshes Skybear-owned fields on matched pax.
--  When a pax we previously seeded disappears from Skybear we MARK it here
--  instead of hard-deleting (OP-added rows are never touched) so OP can review.
--
--  not_in_skybar = true  → this row is no longer present in the Skybear rooming
--  list. Default false; the sync clears it back to false the moment the pax
--  reappears in Skybear.
-- ============================================================================

alter table public.manifest_passengers
  add column if not exists not_in_skybar boolean not null default false;

create index if not exists manifest_passengers_not_in_skybar_idx
  on public.manifest_passengers (not_in_skybar) where not_in_skybar;
