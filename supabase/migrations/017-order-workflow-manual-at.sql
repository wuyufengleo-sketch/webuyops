-- ============================================================================
--  Sprint 11 — order_workflow auto-status reconciler (Phase 1)
--
--  Adds 4 *_status_manual_at columns so the sync-time reconciler knows which
--  cells have been hand-edited by a teammate and must NOT be overwritten by
--  the auto-derivation rules:
--
--    • ticketing_status  ← BOOKED/ISSUED in public.ticketing → 'Done'
--    • document_status   ← all pax for the BK have a passport in public.manifests → 'Done'
--    • cs_status         ← BK has a WhatsApp group registered (bk_groups.wa_link) → 'Done'
--    • ops_status        ← all vendor_payments rows for the tour are DONE/PAID → 'Done'
--
--  Frontend owfSetStatus() writes <field>_manual_at = now() whenever a user
--  flips a select. The reconciler then only touches fields whose manual_at
--  IS NULL (i.e. never been hand-edited). Single-direction: only promotes to
--  'Done' — never auto-reverts (avoids ratchet during partial states).
-- ============================================================================

alter table public.order_workflow
  add column if not exists ticketing_status_manual_at timestamptz,
  add column if not exists document_status_manual_at  timestamptz,
  add column if not exists cs_status_manual_at        timestamptz,
  add column if not exists ops_status_manual_at       timestamptz;
