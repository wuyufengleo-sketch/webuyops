-- Add banner/spanduk checklist fields to CS TL Output.
alter table if exists public.tl_outputs
  add column if not exists banner_status text,
  add column if not exists banner_text text;
