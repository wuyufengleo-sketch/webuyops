-- ============================================================================
--  Sprint 5 — Photos to Storage + shared Lark config + cleanup
-- ============================================================================

-- ── photos: key by ref_code (visa tour code etc.) instead of unused tours FK ──
alter table public.photos drop constraint if exists photos_tour_id_fkey;
alter table public.photos drop column if exists tour_id;
alter table public.photos add column if not exists ref_code   text;
alter table public.photos add column if not exists photo_type text;  -- doc_ready / visa_received / submission / other
create index if not exists photos_ref_idx on public.photos(ref_code);

-- photos already has RLS (auth read/write) from schema.sql; ensure it's on.
alter table public.photos enable row level security;
drop policy if exists "auth read"  on public.photos;
drop policy if exists "auth write" on public.photos;
create policy "auth read"  on public.photos for select using (auth.role()='authenticated');
create policy "auth write" on public.photos for all    using (auth.role()='authenticated') with check (auth.role()='authenticated');

-- app_config already exists (key/value) with RLS from schema.sql.

-- ── Ensure the storage bucket + policies exist (idempotent) ──────────
insert into storage.buckets (id, name, public)
values ('tour-photos','tour-photos', false)
on conflict (id) do nothing;

drop policy if exists "tour-photos auth read"  on storage.objects;
drop policy if exists "tour-photos auth write" on storage.objects;
create policy "tour-photos auth read"  on storage.objects for select to authenticated using (bucket_id='tour-photos');
create policy "tour-photos auth write" on storage.objects for all    to authenticated using (bucket_id='tour-photos') with check (bucket_id='tour-photos');

-- Realtime for photos + app_config
do $$ begin alter publication supabase_realtime add table public.photos;     exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.app_config; exception when duplicate_object then null; end $$;

select 'photos' tbl, count(*) from public.photos
union all select 'app_config', count(*) from public.app_config;
