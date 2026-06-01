-- ============================================================================
--  Sprint — Itinerary Quote generator
--
--  Sales/OPS upload a land-operator confirmation (.docx); a 2-step Vercel
--  pipeline (api/quote-generate -> api/quote-render) turns it into a
--  WeBuy-branded customer itinerary .docx + a public HTML preview link.
--
--  This migration:
--    1. itinerary_quotes  — one row per generated quote (job + result)
--    2. Storage buckets    quote-src (private uploads) / quote-out (public docx)
-- ============================================================================

create table if not exists public.itinerary_quotes (
  id          uuid primary key default gen_random_uuid(),
  created_by  uuid,                                  -- auth.users id of the staff
  source_path text,                                  -- path in quote-src bucket
  status      text default 'pending',                -- pending|generated|done|error
  content     jsonb,                                 -- the structured itinerary
  docx_url    text,                                  -- public URL of the .docx
  title       text generated always as (content->'trip'->>'title') stored,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

do $$ begin
  drop trigger if exists itinerary_quotes_updated_at on public.itinerary_quotes;
  create trigger itinerary_quotes_updated_at before update on public.itinerary_quotes
    for each row execute function public.set_updated_at();
end $$;

alter table public.itinerary_quotes enable row level security;
drop policy if exists "auth read"  on public.itinerary_quotes;
drop policy if exists "auth write" on public.itinerary_quotes;
create policy "auth read"  on public.itinerary_quotes for select using (auth.role() = 'authenticated');
create policy "auth write" on public.itinerary_quotes for all    using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

do $$ begin alter publication supabase_realtime add table public.itinerary_quotes; exception when duplicate_object then null; end $$;

-- ── Storage buckets ─────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public) values ('quote-src', 'quote-src', false) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('quote-out', 'quote-out', true)  on conflict (id) do nothing;

-- quote-src: only authenticated staff may upload/read their source files
drop policy if exists "quote-src auth" on storage.objects;
create policy "quote-src auth" on storage.objects for all to authenticated
  using (bucket_id = 'quote-src') with check (bucket_id = 'quote-src');

-- quote-out: public read (the customer download link), authenticated write
drop policy if exists "quote-out public read" on storage.objects;
create policy "quote-out public read" on storage.objects for select using (bucket_id = 'quote-out');
drop policy if exists "quote-out auth write" on storage.objects;
create policy "quote-out auth write" on storage.objects for insert to authenticated with check (bucket_id = 'quote-out');
