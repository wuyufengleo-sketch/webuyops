-- ============================================================================
--  Sprint 8 (batch 2) — Vendor Payment + Refund Tracking
--
--  Two new wide tables backing two new top-level pages. Data is migrated from
--  Google Sheets (Payment Vendor / Refund List) for now; Skybar auto-row
--  creation + Lark alerts come in a later step.
--
--  Run in the Supabase SQL Editor before the import scripts.
-- ============================================================================

-- ── Vendor payments (one row per tour-code invoice, grouped by region tab) ──
create table if not exists public.vendor_payments (
  id text primary key,
  region text,                       -- = source tab (BEIJING, KOREA, VISA, …)
  tourcode text,
  invoice_amount numeric(18,2),
  currency text,                     -- RMB / USD / '' (from the column header)
  dept_date text,
  total_pax text,                    -- kept as text ("14+1", "22 + 1 inf")
  lark_no text,
  payment_date text,
  status text,
  remarks text,
  created_by uuid references auth.users(id), created_at timestamptz default now(),
  updated_by uuid references auth.users(id), updated_at timestamptz default now()
);

-- ── Refund tracking (REFUND WEBUY CUST main tab) ────────────────────────────
create table if not exists public.refunds (
  id text primary key,
  tc text,
  form_date text,
  bk text,
  cust_name text,
  amount numeric(18,2),
  reason text,
  submit_date text,
  due_date text,
  over_due int,                      -- working days overdue (negative = not yet due)
  status text,
  remarks text,
  created_by uuid references auth.users(id), created_at timestamptz default now(),
  updated_by uuid references auth.users(id), updated_at timestamptz default now()
);

create index if not exists vendor_payments_region_idx on public.vendor_payments (region);
create index if not exists refunds_status_idx on public.refunds (status);

-- ── updated_at triggers ────────────────────────────────────────────
do $$
declare t text;
begin
  for t in select unnest(array['vendor_payments','refunds']) loop
    execute format('drop trigger if exists %I_updated_at on public.%I', t, t);
    execute format('create trigger %I_updated_at before update on public.%I for each row execute function public.set_updated_at()', t, t);
  end loop;
end $$;

-- ── RLS (authenticated = full access) ──────────────────────────────
do $$
declare t text;
begin
  for t in select unnest(array['vendor_payments','refunds']) loop
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
  for t in select unnest(array['vendor_payments','refunds']) loop
    begin execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null; end;
  end loop;
end $$;

select 'vendor_payments' tbl, count(*) from public.vendor_payments
union all select 'refunds', count(*) from public.refunds;
