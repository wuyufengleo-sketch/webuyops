-- ============================================================================
--  Phase 3 — customer self-upload visa docs: sync STC uploads back into OPS
--
--  stc_traveller_links maps an OPS passenger (manifest_id / bkg_no / pax_name)
--  to the Smart Travel Card (STC) traveller_id + tour_id it was pushed to
--  under (Phase 2, OPS -> STC). Populated whenever OPS pushes a visa
--  requirement to STC; read by api/visa-doc-ingest.js to resolve an inbound
--  upload (STC -> OPS) back to the right manifest_passengers row.
-- ============================================================================

create table if not exists public.stc_traveller_links (
  id              bigserial primary key,
  manifest_id     bigint,                -- denormalized, same loose typing as visa_documents.manifest_id
  tour_code       text not null,
  bkg_no          text,
  pax_name        text,
  stc_tour_id     bigint not null,
  stc_traveller_id bigint not null,
  created_at      timestamptz not null default now()
);

create unique index if not exists stc_traveller_links_traveller_unique on public.stc_traveller_links(stc_traveller_id);
create index if not exists stc_traveller_links_manifest_idx on public.stc_traveller_links(manifest_id);
create index if not exists stc_traveller_links_tour_code_idx on public.stc_traveller_links(tour_code);

alter table public.stc_traveller_links enable row level security;
drop policy if exists "auth read stc_traveller_links" on public.stc_traveller_links;
drop policy if exists "auth write stc_traveller_links" on public.stc_traveller_links;
create policy "auth read stc_traveller_links"  on public.stc_traveller_links for select using (auth.role() = 'authenticated');
create policy "auth write stc_traveller_links" on public.stc_traveller_links for all    using (auth.role() = 'authenticated');

-- Track where a visa_documents row came from + keep the original customer
-- upload URL for audit (the file itself is copied into Supabase Storage so
-- the existing Visa-page preview code needs no changes).
alter table public.visa_documents add column if not exists source text not null default 'cs';
alter table public.visa_documents add column if not exists external_url text;

-- Per-pax STC upload links, persisted so CS can revisit the confirmpay page
-- later and re-copy them without re-provisioning. [{paxName, url, error}]
alter table public.payment_confirmations add column if not exists stc_links jsonb;
