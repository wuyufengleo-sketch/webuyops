-- ============================================================================
--  Sprint 6 — Package Sales (Skybar MySQL direct sync)
--
--  Two read-only mirror tables populated by the /api/sync-skybar serverless
--  function (it reads the Skybar production MySQL `webuy_tourt` DB and upserts
--  here using the service_role key, which bypasses RLS). The browser only
--  READS these tables, so authenticated users get a SELECT policy but NO write
--  policy — all writes come from the sync job.
--
--  Scope synced: wt_tour.departure_time >= NOW() - 30 days.
-- ============================================================================

-- ── package_sales — one row per Skybar wt_tour (a single package departure) ──
drop table if exists public.package_sales cascade;
create table public.package_sales (
  id            text primary key,          -- 'wt-'||tour_id
  tour_id       bigint not null,
  tour_code     text,
  tour_name     text,
  tour_type     text,
  area_name     text,
  region        text,
  departure_date timestamptz,
  return_date    timestamptz,
  travel_days    int,
  total_seat     int default 0,            -- wt_tour.inventory_num
  sold_seat      int default 0,            -- wt_tour.sales_num
  seat_left      int default 0,            -- total_seat - sold_seat
  order_count    int default 0,            -- COUNT(wt_order)
  pax_total      int default 0,            -- SUM(wt_order.guest_num)
  infant_total   int default 0,            -- SUM(wt_order.number_of_infant)
  revenue        numeric(18,2) default 0,  -- SUM(wt_order.total_amount)
  query_price    numeric(18,2),            -- wt_tour.query_price (list price)
  tr_status      int,                      -- 0 Pending / 1 Confirmed / 2 Departed / 3 Canceled
  closed_status  int,                      -- 0 open / 1 closed
  tour_status    int,                      -- 0 normal / 1 delisted
  -- enrichment (nullable; reserved for a later Google-Sheet import)
  basic_price       numeric(18,2),
  visa_price        numeric(18,2),
  dbl_entry_visa    numeric(18,2),
  tipping           numeric(18,2),
  insurance         numeric(18,2),
  optional_mandatory numeric(18,2),
  single_supplement numeric(18,2),
  child_no_bed      numeric(18,2),
  infant_price      numeric(18,2),
  itinerary         text,
  terms             text,
  synced_at      timestamptz not null default now()
);
create index package_sales_dep_idx  on public.package_sales(departure_date);
create index package_sales_code_idx on public.package_sales(tour_code);

-- ── package_orders — one row per Skybar wt_order (drill-down detail) ─────────
drop table if exists public.package_orders cascade;
create table public.package_orders (
  id             text primary key,         -- 'ord-'||order_id
  order_id       bigint not null,
  tour_id        bigint not null,          -- links to package_sales.tour_id
  bkg_no         text,
  order_date     timestamptz,
  order_status   int,                      -- 1 draft / 2 unpaid / 3 paying / 4 paid
  contact_name   text,
  contact_no     text,
  guest_num      int default 0,
  infant         int default 0,
  total_amount   numeric(18,2) default 0,
  deposit_amount numeric(18,2) default 0,
  balance_amount numeric(18,2) default 0,
  refund_amount  numeric(18,2) default 0,
  salesman       text,
  lead_source    text,
  synced_at      timestamptz not null default now()
);
create index package_orders_tour_idx on public.package_orders(tour_id);
create index package_orders_date_idx on public.package_orders(order_date desc);

-- ── RLS: authenticated may READ; writes only via service_role (bypasses RLS) ─
do $$
declare t text;
begin
  for t in select unnest(array['package_sales','package_orders']) loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "auth read" on public.%I', t);
    execute format('create policy "auth read" on public.%I for select using (auth.role()=''authenticated'')', t);
  end loop;
end $$;

-- ── Realtime ────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  for t in select unnest(array['package_sales','package_orders']) loop
    begin execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null; end;
  end loop;
end $$;

select 'package_sales' tbl, count(*) from public.package_sales
union all select 'package_orders', count(*) from public.package_orders;
