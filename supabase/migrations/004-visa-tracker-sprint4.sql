-- ============================================================================
--  Sprint 4 — Visa Tracker off Google Sheets
--  visa_tours mirrors the VISA_DATA record shape. Data is imported once from
--  the Apps Script via an in-app button, then edited in the app directly.
-- ============================================================================

create table if not exists public.visa_tours (
  id      text primary key,
  code    text,
  dep     text,
  month   text,
  tour    text,
  "from"  text,
  tl      text,
  pax     int default 0,
  "group" int default 0,
  indiv   int default 0,
  hold    int default 0,
  vendor  text,
  status  text default 'STILL NOT CLOSE',
  remark  text,
  created_by uuid references auth.users(id), created_at timestamptz default now(),
  updated_by uuid references auth.users(id), updated_at timestamptz default now()
);
create index if not exists visa_tours_dep_idx on public.visa_tours(dep);

drop trigger if exists visa_tours_updated_at on public.visa_tours;
create trigger visa_tours_updated_at before update on public.visa_tours
  for each row execute function public.set_updated_at();

-- RLS (authenticated = full access)
alter table public.visa_tours enable row level security;
drop policy if exists "auth read"  on public.visa_tours;
drop policy if exists "auth write" on public.visa_tours;
create policy "auth read"  on public.visa_tours for select using (auth.role()='authenticated');
create policy "auth write" on public.visa_tours for all    using (auth.role()='authenticated') with check (auth.role()='authenticated');

-- Realtime
do $$ begin alter publication supabase_realtime add table public.visa_tours; exception when duplicate_object then null; end $$;

select count(*) as visa_rows from public.visa_tours;
