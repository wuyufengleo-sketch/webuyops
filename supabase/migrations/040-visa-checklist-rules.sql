-- ============================================================================
--  Visa checklist rules by country + visa process type
--
--  Source: /Users/leo/Desktop/WEBUY Visa New.pdf
--  Purpose: CS confirmation links can suggest the correct customer document
--  checklist by visa country and process, instead of only GROUP/INDIVIDUAL.
-- ============================================================================

create table if not exists public.visa_checklist_rules (
  id            bigserial primary key,
  country       text not null,
  country_key   text not null,
  aliases       text[] not null default '{}',
  visa_type     text not null default 'GENERAL',
  required_docs jsonb not null default '[]'::jsonb,
  notes         text,
  source_title  text not null default 'WEBUY Visa New.pdf',
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint visa_checklist_rules_required_docs_array check (jsonb_typeof(required_docs) = 'array'),
  constraint visa_checklist_rules_unique unique (country_key, visa_type)
);

create index if not exists visa_checklist_rules_country_idx on public.visa_checklist_rules(country_key);
create index if not exists visa_checklist_rules_active_idx  on public.visa_checklist_rules(active);

drop trigger if exists visa_checklist_rules_updated_at on public.visa_checklist_rules;
create trigger visa_checklist_rules_updated_at before update on public.visa_checklist_rules
  for each row execute function public.set_updated_at();

alter table public.visa_checklist_rules enable row level security;
drop policy if exists "visa_checklist_rules_read" on public.visa_checklist_rules;
drop policy if exists "visa_checklist_rules_write" on public.visa_checklist_rules;
create policy "visa_checklist_rules_read" on public.visa_checklist_rules
  for select to authenticated using (true);
create policy "visa_checklist_rules_write" on public.visa_checklist_rules
  for all to authenticated using (true) with check (true);

grant select, insert, update, delete on public.visa_checklist_rules to authenticated;
grant usage, select on sequence public.visa_checklist_rules_id_seq to authenticated;

alter table public.payment_confirmations
  add column if not exists visa_process_type text;

-- Helper shape for required_docs:
-- [{ "key": "passport", "label": "Passport + Passport Lama ..." }]
insert into public.visa_checklist_rules (country, country_key, aliases, visa_type, required_docs, notes)
values
('Australia','australia',array['AUSTRALIA','AUS'], 'GENERAL', $$[
  {"key":"passport","label":"Passport + Passport Lama (berlaku 6 bulan dari tanggal kepulangan di Indonesia)"},
  {"key":"photo","label":"Foto 4x6 background putih, terbaru 1 lembar"},
  {"key":"sponsorship_letter","label":"Surat Sponsor dari perusahaan tempat bekerja"},
  {"key":"rek_3_bulan_terakhir","label":"Bukti Keuangan Pribadi 3 bulan terakhir (buku tabungan, rekening koran atau E-statement lengkap dengan nomor rekening dan nama pemilik rekening)"},
  {"key":"copy_ktp","label":"Copy KTP"},
  {"key":"copy_kk","label":"Copy KK"},
  {"key":"copy_akta_nikah","label":"Copy Akte Nikah (jika sudah menikah)"},
  {"key":"copy_akta_lahir","label":"Copy Akte Lahir Anak (jika anak-anak ikut)"},
  {"key":"student_card_school_letter","label":"Copy Kartu Pelajar / Surat Keterangan Sekolah (jika anak-anak ikut)"}
]$$::jsonb, 'Semua file diberikan soft copy, discan/foto dengan jelas.'),
('Australia','australia',array['AUSTRALIA','AUS'], 'BUSINESS', $$[
  {"key":"passport","label":"Passport + Passport Lama (berlaku 6 bulan dari tanggal kepulangan di Indonesia)"},
  {"key":"photo","label":"Foto 4x6 background putih, terbaru 1 lembar"},
  {"key":"sponsorship_letter","label":"Surat Sponsor dari perusahaan tempat bekerja"},
  {"key":"rek_3_bulan_terakhir","label":"Bukti Keuangan Pribadi 3 bulan terakhir (buku tabungan, rekening koran atau E-statement lengkap dengan nomor rekening dan nama pemilik rekening)"},
  {"key":"copy_ktp","label":"Copy KTP"},
  {"key":"copy_kk","label":"Copy KK"},
  {"key":"copy_akta_nikah","label":"Copy Akte Nikah (jika sudah menikah)"},
  {"key":"copy_akta_lahir","label":"Copy Akte Lahir Anak (jika anak-anak ikut)"},
  {"key":"student_card_school_letter","label":"Copy Kartu Pelajar / Surat Keterangan Sekolah (jika anak-anak ikut)"},
  {"key":"invitation_letter","label":"Invitation Letter dari pengundang di Australia"}
]$$::jsonb, 'Semua file diberikan soft copy, discan/foto dengan jelas.'),
('Korea Selatan','korea_selatan',array['KOREA','KOREA SELATAN','SOUTH KOREA','KOR'], 'GENERAL', $$[
  {"key":"passport","label":"Passport + Passport Lama (berlaku 6 bulan dari tanggal kepulangan di Indonesia)"},
  {"key":"photo","label":"Foto 3,5x4,5 background putih, terbaru 2 lembar"},
  {"key":"sponsorship_letter","label":"Surat Sponsor dari perusahaan tempat bekerja"},
  {"key":"rek_3_bulan_terakhir","label":"Bukti Keuangan Pribadi 3 bulan terakhir + bulan berjalan (rekening koran asli dari bank dan dicap per halaman)"},
  {"key":"copy_ktp","label":"Copy KTP"},
  {"key":"copy_kk","label":"Copy KK"},
  {"key":"copy_akta_nikah","label":"Copy Akte Nikah (jika sudah menikah)"},
  {"key":"copy_akta_lahir","label":"Copy Akte Lahir Anak (jika anak-anak ikut)"},
  {"key":"student_card_school_letter","label":"Copy Kartu Pelajar & Surat Keterangan Sekolah (jika anak-anak ikut)"},
  {"key":"copy_spt_terakhir","label":"SPT terakhir"},
  {"key":"ref_bank","label":"Surat Referensi Bank"},
  {"key":"copy_npwp","label":"Copy NPWP"},
  {"key":"form_data_diri","label":"Form data diri (individual visa)"}
]$$::jsonb, null),
('France','france',array['FRANCE','PRANCIS','PARIS'], 'GENERAL', $$[
  {"key":"passport","label":"Passport + Passport Lama (berlaku 6 bulan dari tanggal kepulangan di Indonesia)"},
  {"key":"photo","label":"Foto 3,5x4,5 background putih, terbaru 2 lembar, proporsi wajah 75%"},
  {"key":"sponsorship_letter","label":"Surat Sponsor dari perusahaan tempat bekerja (sebutkan gaji per bulan atau lampirkan slip gaji 3 bulan terakhir)"},
  {"key":"rek_3_bulan_terakhir","label":"Bukti Keuangan Pribadi 3 bulan terakhir dilegalisir per halaman (buku tabungan, rekening koran atau E-statement lengkap dengan nomor rekening dan nama pemilik rekening)"},
  {"key":"ref_bank","label":"Referensi Bank"},
  {"key":"copy_ktp","label":"Copy KTP"},
  {"key":"copy_kk","label":"Copy KK"},
  {"key":"copy_akta_nikah","label":"Copy Akte Nikah (jika sudah menikah)"},
  {"key":"copy_akta_lahir","label":"Copy Akte Lahir Anak (jika anak-anak ikut)"},
  {"key":"student_card_school_letter","label":"Copy Kartu Pelajar & Surat Keterangan Sekolah (jika anak-anak ikut)"},
  {"key":"ticket","label":"Ticket"},
  {"key":"hotel","label":"Hotel"},
  {"key":"travel_insurance","label":"Travel Insurance"}
]$$::jsonb, null),
('USA','usa',array['USA','US','AMERICA','UNITED STATES'], 'DROP BOX', $$[
  {"key":"passport","label":"Passport + Passport Lama (ada visa USA dengan expired kurang dari 48 bulan)"},
  {"key":"photo","label":"Foto 5x5 background putih, terbaru 2 lembar"},
  {"key":"copy_ktp","label":"Copy KTP"},
  {"key":"copy_kk","label":"Copy KK"}
]$$::jsonb, null),
('USA','usa',array['USA','US','AMERICA','UNITED STATES'], 'PROSES BARU', $$[
  {"key":"passport","label":"Passport + Passport Lama (berlaku 6 bulan dari tanggal kepulangan di Indonesia)"},
  {"key":"photo","label":"Foto 5x5 background putih, terbaru 2 lembar"},
  {"key":"sponsorship_letter","label":"Surat Sponsor dari perusahaan tempat bekerja"},
  {"key":"rek_3_bulan_terakhir","label":"Bukti Keuangan Pribadi 3 bulan terakhir (buku tabungan, rekening koran atau E-statement lengkap dengan nomor rekening dan nama pemilik rekening)"},
  {"key":"copy_ktp","label":"Copy KTP"},
  {"key":"copy_kk","label":"Copy KK"},
  {"key":"copy_akta_nikah","label":"Copy Akte Nikah (jika sudah menikah)"},
  {"key":"copy_akta_lahir","label":"Copy Akte Lahir Anak (jika anak-anak ikut)"},
  {"key":"student_card_school_letter","label":"Copy Kartu Pelajar / Surat Keterangan Sekolah (jika anak-anak ikut)"}
]$$::jsonb, null),
('Italy','italy',array['ITALY','ITALIA'], 'GENERAL', $$[
  {"key":"passport","label":"Passport + Passport Lama (berlaku 6 bulan dari tanggal kepulangan di Indonesia)"},
  {"key":"photo","label":"Foto 3,5x4,5 background putih, terbaru 2 lembar, proporsi wajah 75%"},
  {"key":"sponsorship_letter","label":"Surat Sponsor dari perusahaan tempat bekerja"},
  {"key":"siup","label":"Copy SIUP"},
  {"key":"rek_3_bulan_terakhir","label":"Bukti Keuangan Pribadi 3 bulan terakhir (buku tabungan, rekening koran atau E-statement lengkap dengan nomor rekening dan nama pemilik rekening)"},
  {"key":"copy_ktp","label":"Copy KTP"},
  {"key":"copy_kk","label":"Copy KK"},
  {"key":"copy_akta_nikah","label":"Copy Akte Nikah (jika sudah menikah)"},
  {"key":"copy_akta_lahir","label":"Copy Akte Lahir Anak (jika anak-anak ikut)"},
  {"key":"student_card_school_letter","label":"Copy Kartu Pelajar & Surat Keterangan Sekolah (jika anak-anak ikut)"},
  {"key":"ref_bank","label":"Surat Referensi Bank"},
  {"key":"ticket","label":"Ticket"},
  {"key":"hotel","label":"Hotel"},
  {"key":"travel_insurance","label":"Travel Insurance"}
]$$::jsonb, null),
('The Rest Of Schengen','schengen_other',array['SCHENGEN','EUROPE','EUROPA','EU'], 'GENERAL', $$[
  {"key":"passport","label":"Passport + Passport Lama (berlaku 6 bulan dari tanggal kepulangan di Indonesia)"},
  {"key":"photo","label":"Foto 3,5x4,5 background putih, terbaru 2 lembar, proporsi wajah 75%"},
  {"key":"sponsorship_letter","label":"Surat Sponsor dari perusahaan tempat bekerja"},
  {"key":"rek_3_bulan_terakhir","label":"Bukti Keuangan Pribadi 3 bulan terakhir (buku tabungan, rekening koran atau E-statement lengkap dengan nomor rekening dan nama pemilik rekening)"},
  {"key":"copy_ktp","label":"Copy KTP"},
  {"key":"copy_kk","label":"Copy KK"},
  {"key":"copy_akta_nikah","label":"Copy Akte Nikah (jika sudah menikah)"},
  {"key":"copy_akta_lahir","label":"Copy Akte Lahir Anak (jika anak-anak ikut)"},
  {"key":"student_card_school_letter","label":"Copy Kartu Pelajar & Surat Keterangan Sekolah (jika anak-anak ikut)"},
  {"key":"ticket","label":"Ticket"},
  {"key":"hotel","label":"Hotel"},
  {"key":"travel_insurance","label":"Travel Insurance"}
]$$::jsonb, null),
('Canada','canada',array['CANADA','KANADA'], 'GENERAL', $$[
  {"key":"passport","label":"Passport + Passport Lama (berlaku 6 bulan dari tanggal kepulangan di Indonesia)"},
  {"key":"photo","label":"Foto 4x6 background putih, terbaru 1 lembar"},
  {"key":"sponsorship_letter","label":"Surat Sponsor dari perusahaan tempat bekerja"},
  {"key":"rek_3_bulan_terakhir","label":"Bukti Keuangan Pribadi 3 bulan terakhir (buku tabungan, rekening koran atau E-statement lengkap dengan nomor rekening dan nama pemilik rekening)"},
  {"key":"copy_ktp","label":"Copy KTP"},
  {"key":"copy_kk","label":"Copy KK"},
  {"key":"copy_akta_nikah","label":"Copy Akte Nikah (jika sudah menikah)"},
  {"key":"copy_akta_lahir","label":"Copy Akte Lahir Anak (jika anak-anak ikut)"},
  {"key":"student_card_school_letter","label":"Copy Kartu Pelajar & Surat Keterangan Sekolah (jika anak-anak ikut)"}
]$$::jsonb, 'Semua file diberikan soft copy, discan/foto dengan jelas.'),
('Canada','canada',array['CANADA','KANADA'], 'BUSINESS', $$[
  {"key":"passport","label":"Passport + Passport Lama (berlaku 6 bulan dari tanggal kepulangan di Indonesia)"},
  {"key":"photo","label":"Foto 4x6 background putih, terbaru 1 lembar"},
  {"key":"sponsorship_letter","label":"Surat Sponsor dari perusahaan tempat bekerja"},
  {"key":"rek_3_bulan_terakhir","label":"Bukti Keuangan Pribadi 3 bulan terakhir (buku tabungan, rekening koran atau E-statement lengkap dengan nomor rekening dan nama pemilik rekening)"},
  {"key":"copy_ktp","label":"Copy KTP"},
  {"key":"copy_kk","label":"Copy KK"},
  {"key":"copy_akta_nikah","label":"Copy Akte Nikah (jika sudah menikah)"},
  {"key":"copy_akta_lahir","label":"Copy Akte Lahir Anak (jika anak-anak ikut)"},
  {"key":"student_card_school_letter","label":"Copy Kartu Pelajar & Surat Keterangan Sekolah (jika anak-anak ikut)"},
  {"key":"invitation_letter","label":"Invitation Letter dari pengundang di Canada"}
]$$::jsonb, 'Semua file diberikan soft copy, discan/foto dengan jelas.'),
('United Kingdom','united_kingdom',array['UNITED KINGDOM','UK','ENGLAND','BRITAIN'], 'GENERAL', $$[
  {"key":"passport","label":"Passport + Passport Lama (berlaku 6 bulan dari tanggal kepulangan di Indonesia)"},
  {"key":"sponsorship_letter","label":"Surat Sponsor dari perusahaan tempat bekerja"},
  {"key":"rek_3_bulan_terakhir","label":"Bukti Keuangan Pribadi 3 bulan terakhir (buku tabungan, rekening koran atau E-statement lengkap dengan nomor rekening dan nama pemilik rekening)"},
  {"key":"copy_ktp","label":"Copy KTP"},
  {"key":"copy_kk","label":"Copy KK"},
  {"key":"copy_akta_nikah","label":"Copy Akte Nikah (jika sudah menikah)"},
  {"key":"copy_akta_lahir","label":"Copy Akte Lahir Anak (jika anak-anak ikut)"},
  {"key":"student_card_school_letter","label":"Copy Kartu Pelajar & Surat Keterangan Sekolah (jika anak-anak ikut)"}
]$$::jsonb, 'KK, Akte Nikah dan Akte Lahir jika diperlukan akan diterjemahkan ke Bahasa Inggris.'),
('United Kingdom','united_kingdom',array['UNITED KINGDOM','UK','ENGLAND','BRITAIN'], 'BUSINESS', $$[
  {"key":"passport","label":"Passport + Passport Lama (berlaku 6 bulan dari tanggal kepulangan di Indonesia)"},
  {"key":"sponsorship_letter","label":"Surat Sponsor dari perusahaan tempat bekerja"},
  {"key":"rek_3_bulan_terakhir","label":"Bukti Keuangan Pribadi 3 bulan terakhir (buku tabungan, rekening koran atau E-statement lengkap dengan nomor rekening dan nama pemilik rekening)"},
  {"key":"copy_ktp","label":"Copy KTP"},
  {"key":"copy_kk","label":"Copy KK"},
  {"key":"copy_akta_nikah","label":"Copy Akte Nikah (jika sudah menikah)"},
  {"key":"copy_akta_lahir","label":"Copy Akte Lahir Anak (jika anak-anak ikut)"},
  {"key":"student_card_school_letter","label":"Copy Kartu Pelajar & Surat Keterangan Sekolah (jika anak-anak ikut)"},
  {"key":"invitation_letter","label":"Invitation Letter dari pengundang di UK"}
]$$::jsonb, 'KK, Akte Nikah dan Akte Lahir jika diperlukan akan diterjemahkan ke Bahasa Inggris.'),
('New Zealand','new_zealand',array['NEW ZEALAND','NZ','SELANDIA BARU'], 'GENERAL', $$[
  {"key":"passport","label":"Passport + Passport Lama (berlaku 6 bulan dari tanggal kepulangan di Indonesia)"},
  {"key":"photo","label":"Foto 4x6 background putih, terbaru 1 lembar"},
  {"key":"sponsorship_letter","label":"Surat Sponsor dari perusahaan tempat bekerja"},
  {"key":"rek_3_bulan_terakhir","label":"Bukti Keuangan Pribadi 3 bulan terakhir (buku tabungan, rekening koran atau E-statement lengkap dengan nomor rekening dan nama pemilik rekening)"},
  {"key":"copy_ktp","label":"Copy KTP"},
  {"key":"copy_kk","label":"Copy KK"},
  {"key":"copy_akta_nikah","label":"Copy Akte Nikah (jika sudah menikah)"},
  {"key":"copy_akta_lahir","label":"Copy Akte Lahir Anak (jika anak-anak ikut)"},
  {"key":"student_card_school_letter","label":"Copy Kartu Pelajar & Surat Keterangan Sekolah (jika anak-anak ikut)"}
]$$::jsonb, null),
('Jepang','jepang',array['JEPANG','JAPAN','JP'], 'GENERAL', $$[
  {"key":"passport","label":"Passport + Passport Lama (berlaku 6 bulan dari tanggal kepulangan di Indonesia)"},
  {"key":"photo","label":"Foto 3,5x4,5 background putih, terbaru 2 lembar"},
  {"key":"sponsorship_letter","label":"Surat Sponsor dari perusahaan tempat bekerja"},
  {"key":"rek_3_bulan_terakhir","label":"Bukti Keuangan Pribadi 3 bulan terakhir (buku tabungan, rekening koran atau E-statement lengkap dengan nomor rekening dan nama pemilik rekening)"},
  {"key":"copy_ktp","label":"Copy KTP"},
  {"key":"copy_kk","label":"Copy KK"},
  {"key":"copy_akta_nikah","label":"Copy Akte Nikah (jika sudah menikah)"},
  {"key":"copy_akta_lahir","label":"Copy Akte Lahir Anak (jika anak-anak ikut)"},
  {"key":"student_card_school_letter","label":"Copy Kartu Pelajar & Surat Keterangan Sekolah (jika anak-anak ikut)"}
]$$::jsonb, null),
('Taiwan','taiwan',array['TAIWAN','TPE'], 'GENERAL', $$[
  {"key":"passport","label":"Passport + Passport Lama (berlaku 6 bulan dari tanggal kepulangan di Indonesia)"},
  {"key":"photo","label":"Foto 3,5x4,5 background putih, terbaru 2 lembar"},
  {"key":"sponsorship_letter","label":"Surat Sponsor dari perusahaan tempat bekerja"},
  {"key":"rek_3_bulan_terakhir","label":"Bukti Keuangan Pribadi 3 bulan terakhir (buku tabungan, rekening koran atau E-statement lengkap dengan nomor rekening dan nama pemilik rekening)"},
  {"key":"copy_ktp","label":"Copy KTP"},
  {"key":"copy_kk","label":"Copy KK"},
  {"key":"copy_akta_nikah","label":"Copy Akte Nikah (jika sudah menikah)"},
  {"key":"copy_akta_lahir","label":"Copy Akte Lahir Anak (jika anak-anak ikut)"},
  {"key":"student_card_school_letter","label":"Copy Kartu Pelajar & Surat Keterangan Sekolah (jika anak-anak ikut)"}
]$$::jsonb, null),
('Uni Arab Emirates','uni_arab_emirates',array['UNI ARAB EMIRATES','UAE','UNITED ARAB EMIRATES','DUBAI'], 'BY EK', $$[
  {"key":"passport_scan_color","label":"Scan berwarna halaman depan Passport (berlaku 6 bulan dari tanggal kepulangan di Indonesia)"},
  {"key":"photo","label":"Scan Foto 3,5x4,5 background putih, terbaru"},
  {"key":"copy_akta_lahir","label":"Untuk anak-anak lampirkan akte lahir anak"},
  {"key":"issued_ticket","label":"Tiket yang sudah di-issued"}
]$$::jsonb, null),
('Uni Arab Emirates','uni_arab_emirates',array['UNI ARAB EMIRATES','UAE','UNITED ARAB EMIRATES','DUBAI'], 'BY NON EK', $$[
  {"key":"passport_scan_color","label":"Scan berwarna halaman depan Passport (berlaku 6 bulan dari tanggal kepulangan di Indonesia)"},
  {"key":"photo","label":"Scan Foto 3,5x4,5 background putih, terbaru"},
  {"key":"copy_akta_lahir","label":"Untuk anak-anak lampirkan akte lahir anak"},
  {"key":"ticket","label":"Tiket"},
  {"key":"travel_insurance","label":"Travel Insurance"},
  {"key":"copy_kk","label":"Copy KK"}
]$$::jsonb, null),
('Afrika Selatan','afrika_selatan',array['AFRIKA SELATAN','SOUTH AFRICA'], 'GENERAL', $$[
  {"key":"passport","label":"Paspor ASLI"},
  {"key":"sponsorship_letter","label":"Surat sponsor perusahaan"},
  {"key":"siup","label":"SIUP (jika ada)"},
  {"key":"rek_3_bulan_terakhir","label":"Rekening koran 3 bulan terakhir yang harus dilegalisir bank di tiap lembar halaman (ASLI)"},
  {"key":"copy_ktp","label":"Copy KTP"},
  {"key":"copy_kk","label":"Copy KK"},
  {"key":"copy_akta_nikah","label":"Copy Akte nikah"},
  {"key":"booking_ticket","label":"Bookingan tiket"},
  {"key":"booking_hotel","label":"Bookingan hotel"},
  {"key":"photo","label":"Foto ukuran 4x6 background putih 2 lembar berwarna terbaru"},
  {"key":"salary_bank_note","label":"Untuk yang bekerja, rekening aktif yang dilampirkan harus rekening tempat gaji bulanan disetor"}
]$$::jsonb, null),
('China','china',array['CHINA','CINA','PRC'], 'INDIVIDUAL VISA', $$[
  {"key":"passport","label":"Passport Asli"},
  {"key":"photo","label":"Foto 3,5x4,5 background putih softfile + fisik 2 lembar"},
  {"key":"copy_ktp","label":"Copy KTP"},
  {"key":"copy_kk","label":"Copy KK"},
  {"key":"copy_akta_nikah","label":"Copy Akte Nikah (jika sudah menikah)"},
  {"key":"copy_akta_lahir","label":"Copy Akta lahir (untuk anak apabila ikut)"},
  {"key":"form_data_diri","label":"Form data diri (individual visa)"}
]$$::jsonb, null),
('Vietnam/Thailand','vietnam_thailand',array['VIETNAM','THAILAND','VIETNAM/THAILAND'], 'GENERAL', $$[
  {"key":"passport","label":"Paspor Asli"},
  {"key":"copy_ktp","label":"Copy KTP"}
]$$::jsonb, null)
on conflict (country_key, visa_type) do update set
  country = excluded.country,
  aliases = excluded.aliases,
  required_docs = excluded.required_docs,
  notes = excluded.notes,
  source_title = excluded.source_title,
  active = true,
  updated_at = now();

select count(*) as visa_checklist_rules_rows from public.visa_checklist_rules;
