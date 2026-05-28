-- ============================================================================
--  Sprint 3 — CS / Sales / Private / Manifest
--  Wide tables mirroring the current localStorage record shapes.
--  The original idealized tables (sales_inquiries, private_tours, cs_cases,
--  manifest_passengers) from schema.sql are dropped & recreated to match the
--  real field names used by the app. All start empty (demo data dropped).
-- ============================================================================

drop table if exists public.sales_inquiries     cascade;
drop table if exists public.private_tours        cascade;
drop table if exists public.cs_cases             cascade;
drop table if exists public.cs_records           cascade;
drop table if exists public.cs_complaints        cascade;
drop table if exists public.manifest_passengers  cascade;

-- ── Sales inquiries ────────────────────────────────────────────────
create table public.sales_inquiries (
  id text primary key,
  date text, client text, region text, type text,
  pax int default 0, tc text, "reqDep" text,
  value numeric(16,2) default 0,
  quot text, fu1 text, fu2 text, fu3 text,
  status text, bk text, reason text, remarks text,
  created_by uuid references auth.users(id), created_at timestamptz default now(),
  updated_by uuid references auth.users(id), updated_at timestamptz default now()
);

-- ── Private tours (wide) ───────────────────────────────────────────
create table public.private_tours (
  id text primary key,
  "dateReq" text, "dateOffered" text, tc text, customer text, contact text,
  source text, dest text, pkg text, dep text, pax text, budget text, hotel text,
  dietary text, flight text, "needTL" text, stage text, "lastContact" text,
  "nextFU" text, rae text, status text, reason text, remarks text, urgent text,
  "specialReq" text, "detailReq" text, "opsQuotation" text, "opsStatus" text,
  sla2rae text, sla2tc text, sla4rae text, sla4tc text, sla6rae text, sla6tc text,
  "itinInitial" text, "itinReal1" text, "itinReal2" text, "itinReal3" text, "itinReal4" text,
  "itinRev1" text, "itinRev2" text, "itinRev3" text, "itinRev4" text, "itinRev5" text, "itinRev6" text,
  "opsUpdate" text,
  created_by uuid references auth.users(id), created_at timestamptz default now(),
  updated_by uuid references auth.users(id), updated_at timestamptz default now()
);

-- ── CS records ─────────────────────────────────────────────────────
create table public.cs_records (
  id text primary key,
  tour text, dep text, tl text, tlphone text, walink text, notes text,
  wa text default '0', flag text default '0', gv text default '0',
  pax text default '0', room text default '0',
  created_by uuid references auth.users(id), created_at timestamptz default now(),
  updated_by uuid references auth.users(id), updated_at timestamptz default now()
);

-- ── CS complaints ──────────────────────────────────────────────────
create table public.cs_complaints (
  id text primary key,
  tour text, "desc" text, severity text, date text, status text,
  created_by uuid references auth.users(id), created_at timestamptz default now()
);

-- ── Manifest passengers (wide) ─────────────────────────────────────
create table public.manifest_passengers (
  id text primary key,
  no text, name text, passport text, expiry text, dob text,
  bk text, sales text, title text, room text,
  created_by uuid references auth.users(id), created_at timestamptz default now(),
  updated_by uuid references auth.users(id), updated_at timestamptz default now()
);

-- ── updated_at triggers ────────────────────────────────────────────
do $$
declare t text;
begin
  for t in select unnest(array['sales_inquiries','private_tours','cs_records','manifest_passengers']) loop
    execute format('drop trigger if exists %I_updated_at on public.%I', t, t);
    execute format('create trigger %I_updated_at before update on public.%I for each row execute function public.set_updated_at()', t, t);
  end loop;
end $$;

-- ── RLS (authenticated = full access) ──────────────────────────────
do $$
declare t text;
begin
  for t in select unnest(array['sales_inquiries','private_tours','cs_records','cs_complaints','manifest_passengers']) loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "auth read"  on public.%I', t);
    execute format('drop policy if exists "auth write" on public.%I', t);
    execute format('create policy "auth read"  on public.%I for select using (auth.role()=''authenticated'')', t);
    execute format('create policy "auth write" on public.%I for all    using (auth.role()=''authenticated'') with check (auth.role()=''authenticated'')', t);
  end loop;
end $$;

-- ── Realtime ───────────────────────────────────────────────────────
do $$
declare t text;
begin
  for t in select unnest(array['sales_inquiries','private_tours','cs_records','cs_complaints','manifest_passengers']) loop
    begin execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null; end;
  end loop;
end $$;

select 'sales' tbl, count(*) from public.sales_inquiries
union all select 'private', count(*) from public.private_tours
union all select 'cs', count(*) from public.cs_records
union all select 'complaints', count(*) from public.cs_complaints
union all select 'manifest', count(*) from public.manifest_passengers;
