-- 023 — Per-tour PnL ledger
--
-- One row per tour_id. Sync-skybar fills in Skybar-sourced fields (revenue,
-- received, pax). UI fills in manual cost fields (land_cost, flight_cost)
-- via the "Confirm Departure" modal on Package Sales / Tour 360°.
--
-- gross_margin = revenue_total - land_cost - flight_cost - other_cost
--
-- "Confirmed Departure" is a boolean flag that locks the PnL snapshot — used
-- by OPS to signal the tour will run AND finance has been reviewed.

create table if not exists public.tour_pnl (
  id              text primary key,                 -- 'pnl-' || tour_id
  tour_id         bigint not null unique,           -- FK package_sales.tour_id
  tour_code       text,                             -- denormalized
  tour_name       text,
  departure_date  date,
  region          text,

  -- Skybar-sourced (synced from sync-skybar.js)
  pax_total       int,
  revenue_total   numeric,                          -- sum of valid wt_order.total_amount
  received_total  numeric,                          -- sum of wt_order_payment_receipt.received_amount

  -- Manual costs (entered via Confirm Departure modal)
  land_cost           numeric,
  land_cost_vendor    text,
  land_cost_note      text,
  flight_cost         numeric,
  flight_cost_vendor  text,
  flight_cost_note    text,
  other_cost          numeric,
  other_cost_note     text,

  -- Skybar estimated cost snapshot (read-only reference from wt_tour_estimated_cost)
  est_air_ticket     numeric,
  est_land_tour      numeric,
  est_tl_cost        numeric,
  est_pkg_cost_nett  numeric,

  -- Confirmation flag
  confirmed_depart   boolean not null default false,
  confirmed_at       timestamptz,
  confirmed_by       text,

  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists tour_pnl_tour_code_idx       on public.tour_pnl (tour_code);
create index if not exists tour_pnl_departure_idx       on public.tour_pnl (departure_date);
create index if not exists tour_pnl_confirmed_idx       on public.tour_pnl (confirmed_depart);

-- ── updated_at trigger ─────────────────────────────────────────────
drop trigger if exists tour_pnl_updated_at on public.tour_pnl;
create trigger tour_pnl_updated_at before update on public.tour_pnl
  for each row execute function public.set_updated_at();

-- ── RLS (authenticated users get full access, like other operational tables) ──
alter table public.tour_pnl enable row level security;
drop policy if exists "tour_pnl read"  on public.tour_pnl;
drop policy if exists "tour_pnl write" on public.tour_pnl;
create policy "tour_pnl read"  on public.tour_pnl for select using (auth.role()='authenticated');
create policy "tour_pnl write" on public.tour_pnl for all    using (auth.role()='authenticated') with check (auth.role()='authenticated');

-- ── Realtime ──
do $$
begin
  begin alter publication supabase_realtime add table public.tour_pnl;
  exception when duplicate_object then null; end;
end $$;
