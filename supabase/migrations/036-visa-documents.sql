-- ============================================================================
--  Sprint 13 — Visa document automation
--
--  visa_documents: per-pax per-document metadata + review workflow.
--  Each row = one file uploaded by CS (passport scan, KTP copy, etc.).
--  DOC team reviews (approve / reject) inline; approved files feed the
--  one-click ZIP export for the visa agent submission.
--
--  Storage: reuses existing 'tour-photos' bucket under path
--    visa-docs/{tour_code}/{pax_name}/{doc_type}_{timestamp}.ext
-- ============================================================================

create table if not exists public.visa_documents (
  id              bigserial primary key,
  manifest_id     bigint,                       -- FK manifest_passengers.id
  tour_code       text not null,                -- denormalized for per-tour queries
  bkg_no          text,                         -- denormalized BK number
  pax_name        text,                         -- snapshot at upload time
  doc_type        text not null,                -- passport / photo / copy_ktp / copy_kk / copy_akta_lahir / copy_akta_nikah / rek_3_bulan_terakhir / ref_bank / copy_npwp / copy_spt_terakhir / sponsorship_letter / additional / other
  storage_path    text not null,                -- path inside 'tour-photos' bucket
  file_name       text,                         -- original filename
  file_size       int,                          -- bytes
  mime_type       text,                         -- image/jpeg, application/pdf, etc.
  review_status   text not null default 'pending',  -- pending / approved / rejected
  review_note     text,                         -- DOC rejection reason
  reviewed_by     uuid references auth.users(id),
  reviewed_at     timestamptz,
  uploaded_by     uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists visa_documents_manifest_idx  on public.visa_documents (manifest_id);
create index if not exists visa_documents_tour_idx      on public.visa_documents (tour_code);
create index if not exists visa_documents_bk_idx        on public.visa_documents (bkg_no);
create index if not exists visa_documents_type_idx      on public.visa_documents (doc_type);
create index if not exists visa_documents_review_idx    on public.visa_documents (review_status);

drop trigger if exists visa_documents_updated_at on public.visa_documents;
create trigger visa_documents_updated_at before update on public.visa_documents
  for each row execute function public.set_updated_at();

-- RLS: authenticated users can read and write
alter table public.visa_documents enable row level security;
drop policy if exists "visa_documents_read"  on public.visa_documents;
drop policy if exists "visa_documents_write" on public.visa_documents;
create policy "visa_documents_read"  on public.visa_documents for select using (auth.role()='authenticated');
create policy "visa_documents_write" on public.visa_documents for all    using (auth.role()='authenticated') with check (auth.role()='authenticated');

-- Realtime
do $$ begin alter publication supabase_realtime add table public.visa_documents; exception when duplicate_object then null; end $$;

-- ── Per-pax visa payment tracking on manifest_passengers ──────────
alter table public.manifest_passengers
  add column if not exists visa_payment_amount  numeric,
  add column if not exists visa_payment_note    text,
  add column if not exists visa_payment_photo   text;     -- storage path for receipt photo

select count(*) as visa_documents_rows from public.visa_documents;
