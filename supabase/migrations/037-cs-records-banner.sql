-- Add Banner / Spanduk readiness to CS checklist records.
alter table public.cs_records
  add column if not exists banner text default '0';
