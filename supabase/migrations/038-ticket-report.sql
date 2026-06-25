-- ============================================================================
--  Flight Search — Ticket Report (daily flight-price snapshots + trend).
--
--  A daily cron (/api/ticket-report, 00:00 WIB) finds every BOOKED tour
--  (package_sales.pax_total > 0) departing in the next 30 days, prices the
--  best-value round-trip / open-jaw flight from CGK via Google Flights, and
--  writes one snapshot row per (run_date, tour_code). Re-running the same day
--  upserts. Keeping every run_date builds the price-history trend.
--
--  Reads: browser (authenticated) renders the report + trend chart directly.
--  Writes: service_role only (the cron) — it bypasses RLS.
-- ============================================================================

create table if not exists public.flight_price_snapshots (
  id             bigint generated always as identity primary key,
  run_date       date        not null,            -- the daily run, in WIB
  tour_code      text        not null,            -- Skybar package_sales.tour_code
  tour_type      text,                            -- matched catalog WB base code
  product_name   text,
  departure_date date        not null,
  return_date    date,
  origin         text        not null default 'CGK',
  arr_iata       text,                            -- outbound destination (entry)
  dep_iata       text,                            -- return-from airport (exit)
  open_jaw       boolean     not null default false,
  pax            int,
  seat_left      int,
  currency       text        not null default 'IDR',
  fare           numeric,                         -- best-value per-pax fare (null = no price)
  airline        text,
  stops          int,
  duration_min   int,
  status         text        not null default 'ok', -- ok | no_route | crawl_failed
  google_url     text,
  created_at     timestamptz not null default now(),
  unique (run_date, tour_code)
);

create index if not exists flight_price_snapshots_run_idx
  on public.flight_price_snapshots (run_date desc);
create index if not exists flight_price_snapshots_tour_idx
  on public.flight_price_snapshots (tour_code, departure_date);

-- Browser reads the report with the anon/authenticated key → needs a SELECT
-- policy. The cron writes with service_role, which bypasses RLS entirely, so
-- no insert/update policy is required (and none is granted to clients).
alter table public.flight_price_snapshots enable row level security;

drop policy if exists flight_price_snapshots_read on public.flight_price_snapshots;
create policy flight_price_snapshots_read
  on public.flight_price_snapshots
  for select
  to authenticated
  using (true);

-- Convenience view: the most recent snapshot per tour (what the report table
-- shows). The trend chart queries the base table filtered by tour_code.
create or replace view public.flight_price_latest as
select s.*
from public.flight_price_snapshots s
join (
  select tour_code, max(run_date) as max_run
  from public.flight_price_snapshots
  group by tour_code
) m on m.tour_code = s.tour_code and m.max_run = s.run_date;
