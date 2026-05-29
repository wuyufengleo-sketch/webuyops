-- ============================================================================
--  Sprint 7 — Order Workflow (cross-team collaboration board)
--
--  One row per Skybar BKG order (= package_orders.id), holding the 4 teams'
--  task statuses. Kept SEPARATE from the read-only package_orders mirror so the
--  hourly/daily Skybar sync (which upserts + prunes package_orders) never wipes
--  team progress. The sync's reconcileWorkflow() keeps this table in step:
--  creates rows for new orders, refreshes denormalized display fields, and
--  pushes Lark notifications to each team on new / changed orders.
--
--  Display fields (tour_code, pax, …) are denormalized here so the board needs
--  no client-side join.
-- ============================================================================

create table if not exists public.order_workflow (
  id              text primary key,          -- = package_orders.id ('ord-'||order_id)
  tour_id         bigint,
  bkg_no          text,
  tour_code       text,
  tour_name       text,
  departure_date  timestamptz,
  pax             int default 0,
  -- 4 team task statuses (Pending / In Progress / Done)
  ticketing_status text default 'Pending',    -- 查/订机票
  document_status  text default 'Pending',    -- 整理文件/护照 + Manifest
  cs_status        text default 'Pending',    -- 追踪客人 + 收集上传个人信息
  ops_status       text default 'Pending',    -- 总协调 + 地接定团
  ticketing_note   text,
  document_note    text,
  cs_note          text,
  ops_note         text,
  -- change-detection + notification bookkeeping (managed by the sync)
  fingerprint      text,
  notified         boolean default false,
  created_by       uuid references auth.users(id),
  created_at       timestamptz not null default now(),
  updated_by       uuid references auth.users(id),
  updated_at       timestamptz not null default now()
);
create index if not exists order_workflow_dep_idx  on public.order_workflow(departure_date);
create index if not exists order_workflow_tour_idx on public.order_workflow(tour_id);

drop trigger if exists order_workflow_updated_at on public.order_workflow;
create trigger order_workflow_updated_at before update on public.order_workflow
  for each row execute function public.set_updated_at();

-- ── RLS: authenticated may read AND write (teams update their own status cells);
--    the sync writes via service_role which bypasses RLS. ─────────────────────
alter table public.order_workflow enable row level security;
drop policy if exists "auth read"  on public.order_workflow;
drop policy if exists "auth write" on public.order_workflow;
create policy "auth read"  on public.order_workflow for select using (auth.role() = 'authenticated');
create policy "auth write" on public.order_workflow for all    using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- ── Realtime ────────────────────────────────────────────────────────────────
do $$ begin alter publication supabase_realtime add table public.order_workflow; exception when duplicate_object then null; end $$;

select 'order_workflow' tbl, count(*) from public.order_workflow;
