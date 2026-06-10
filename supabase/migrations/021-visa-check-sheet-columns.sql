-- 021 — Visa check sheet columns on manifest_passengers
-- Mirrors the team Google Sheet used for per-tour visa document completeness.

alter table public.manifest_passengers
  add column if not exists age text,
  add column if not exists passport_valid boolean,
  add column if not exists passport_softfile boolean,
  add column if not exists photo boolean,
  add column if not exists copy_ktp boolean,
  add column if not exists copy_kk boolean,
  add column if not exists copy_akta_lahir boolean,
  add column if not exists copy_akta_nikah boolean,
  add column if not exists rek_3_bulan_terakhir boolean,
  add column if not exists ref_bank boolean,
  add column if not exists copy_npwp boolean,
  add column if not exists copy_spt_terakhir boolean,
  add column if not exists sponsorship_letter boolean,
  add column if not exists additional boolean,
  add column if not exists lack_of_document text,
  add column if not exists information text,
  add column if not exists eligible boolean,
  add column if not exists document_entry_date date;

create index if not exists manifest_passengers_document_entry_date_idx
  on public.manifest_passengers (document_entry_date);
