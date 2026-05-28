-- ============================================================================
--  Sprint 2 — OPS Master (BK tours) + workflow
--
--  Decision: one wide bk_tours table mirroring the current localStorage shape.
--  Starting fresh (current data was demo seed), so no data migration.
-- ============================================================================

-- ---------------------------------------------------------------------------
--  bk_tours — the BK tour tracker master record (wide table)
--  id keeps the app's existing text format (e.g. 'BK-2612').
-- ---------------------------------------------------------------------------
create table if not exists public.bk_tours (
  id           text primary key,
  code         text,
  dest         text,
  region       text,
  type         text,
  dep          text,
  ret          text,
  pax          int  default 0,
  tl           text,
  -- OPS
  "opsH"       text,
  "opsStatus"  text,
  "opsUpdate"  text,
  briefing     text,
  crisis       text,
  "opsNotes"   text,
  -- Visa
  "visaStatus" text,
  "visaRegion" text,
  vendor       text,
  "visaSubmit" text,
  "visaExp"    text,
  "visaNeed"   int default 0,
  "visaDone"   int default 0,
  "visaHold"   int default 0,
  -- Ticketing
  "tickStatus" text,
  "tickTotal"  int default 0,
  "tickDone"   int default 0,
  "laOnly"     int default 0,
  "tickNotes"  text,
  -- Rooming
  "roomStatus" text,
  "roomVendor" text,
  "roomConfirm" text,
  "roomNotes"  text,
  -- CS touchpoints
  "csH1"       text,
  "csH3"       text,
  "csH14"      text,
  "csH30"      text,
  "csNotes"    text,
  -- Audit
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  updated_by   uuid references auth.users(id),
  updated_at   timestamptz not null default now()
);
create index if not exists bk_tours_dep_idx on public.bk_tours(dep);
drop trigger if exists bk_tours_updated_at on public.bk_tours;
create trigger bk_tours_updated_at before update on public.bk_tours
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
--  Re-point ops_workflow / ops_logs to bk_tours (text id), since the original
--  schema referenced the UUID tours table (not used yet).
-- ---------------------------------------------------------------------------
alter table public.ops_workflow drop constraint if exists ops_workflow_pkey;
alter table public.ops_workflow drop constraint if exists ops_workflow_tour_id_fkey;
alter table public.ops_workflow drop column if exists tour_id;
alter table public.ops_workflow add column if not exists tour_id text;
alter table public.ops_workflow alter column tour_id set not null;
alter table public.ops_workflow add constraint ops_workflow_pkey primary key (tour_id);
alter table public.ops_workflow add constraint ops_workflow_tour_fk
  foreign key (tour_id) references public.bk_tours(id) on delete cascade;
-- rename financials → financial to match the app's wf.financial key
alter table public.ops_workflow rename column financials to financial;

alter table public.ops_logs drop constraint if exists ops_logs_tour_id_fkey;
alter table public.ops_logs drop column if exists tour_id;
alter table public.ops_logs add column if not exists tour_id text not null default '';
alter table public.ops_logs add constraint ops_logs_tour_fk
  foreign key (tour_id) references public.bk_tours(id) on delete cascade;
-- the app stores an author label + a preformatted date string
alter table public.ops_logs add column if not exists author text;
alter table public.ops_logs add column if not exists date_label text;
create index if not exists ops_logs_tour_idx2 on public.ops_logs(tour_id, created_at desc);

-- ---------------------------------------------------------------------------
--  Row Level Security for the new bk_tours table (authenticated = full access).
--  ops_workflow / ops_logs already had RLS enabled in schema.sql.
-- ---------------------------------------------------------------------------
alter table public.bk_tours enable row level security;
drop policy if exists "auth read"  on public.bk_tours;
drop policy if exists "auth write" on public.bk_tours;
create policy "auth read"  on public.bk_tours for select using (auth.role() = 'authenticated');
create policy "auth write" on public.bk_tours for all    using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- ---------------------------------------------------------------------------
--  Realtime
-- ---------------------------------------------------------------------------
do $$
begin alter publication supabase_realtime add table public.bk_tours;     exception when duplicate_object then null; end $$;
do $$
begin alter publication supabase_realtime add table public.ops_workflow; exception when duplicate_object then null; end $$;
do $$
begin alter publication supabase_realtime add table public.ops_logs;     exception when duplicate_object then null; end $$;

-- Verify
select 'bk_tours' as tbl, count(*) from public.bk_tours
union all select 'ops_workflow', count(*) from public.ops_workflow
union all select 'ops_logs', count(*) from public.ops_logs;
