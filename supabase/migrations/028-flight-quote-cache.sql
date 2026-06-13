-- ============================================================================
--  Flight Search — price report cache.
--
--  /api/flight-quotes fans out one round-trip crawl per (route, date, pax,
--  cabin, currency) combo against Google Flights. To avoid re-crawling the
--  same combo when staff re-click the same search the same day, each combo's
--  parsed quotes are cached here keyed by a deterministic cache_key. The
--  endpoint treats rows older than 12h as stale (TTL is enforced in code, not
--  by the DB) and ?refresh=1 bypasses the read entirely.
--
--  This is a pure performance/cost cache — safe to TRUNCATE at any time; the
--  endpoint just re-crawls on the next request.
-- ============================================================================

create table if not exists public.flight_quote_cache (
  cache_key   text primary key,             -- outFrom|outTo|dep|retFrom|retTo|ret|pax|cabin|cur|provider
  quotes      jsonb not null,               -- normalized flight quote array (fare/airline/stops/durationMin/segments)
  fetched_at  timestamptz not null default now()
);

-- Lets a cleanup job prune stale rows efficiently (optional; TTL is in code).
create index if not exists flight_quote_cache_fetched_at_idx
  on public.flight_quote_cache (fetched_at);

-- Only the service_role (used by the serverless endpoint) touches this table.
-- No browser/anon access — keep RLS on with no policies so PostgREST denies
-- direct client reads/writes.
alter table public.flight_quote_cache enable row level security;
