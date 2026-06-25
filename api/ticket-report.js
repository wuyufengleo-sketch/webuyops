// ============================================================================
//  POST /api/ticket-report — daily flight-price report for upcoming tours.
//
//  Runs at 00:00 WIB (Vercel cron, 17:00 UTC). Finds every BOOKED tour
//  (package_sales.pax_total > 0) departing within the next 30 days, maps its
//  tour_code to the airport catalog (docs/tour-types.json), prices the best
//  value round-trip / open-jaw flight from CGK on Google Flights, and writes
//  one snapshot row per (run_date, tour_code) into flight_price_snapshots.
//
//  Re-running the same day upserts (idempotent). Every run_date is kept, which
//  is what the Ticket Report's price-trend chart reads back.
//
//  Auth: Bearer CRON_SECRET (Vercel cron) · x-sync-secret (manual/local) ·
//        or a logged-in user's Supabase JWT (the admin "Run now" button).
//
//  Pricing reuses _flight-crawl.googleRoundTrip + the flight-quotes value
//  score, and shares the 12h flight_quote_cache so same-day re-runs are cheap.
// ============================================================================

const { createClient } = require('@supabase/supabase-js');
const { googleRoundTrip } = require('./_flight-crawl.js');
const CATALOG = require('../docs/tour-types.json');

const HOME = 'CGK';
const WINDOW_DAYS = 30;       // price tours departing within the next month
const CONCURRENCY = 5;        // parallel crawls (each ~ up to 12s)
const BUDGET_MS = 270000;     // wall-clock budget; return partial before the 300s cap
const CACHE_TTL_MS = 12 * 3600 * 1000;
const DAYS_FALLBACK = 6;      // trip length when the catalog has none
const W = { stopPct: 0.06, hourPct: 0.015 };   // value-score weights (match flight-quotes)

const up = v => String(v == null ? '' : v).trim().toUpperCase();
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// "now" shifted to WIB (UTC+7) so the run_date and the 30-day window are local.
const wibToday = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

// ── airport catalog: tour_code → { arr, dep, open_jaw, days } ────────────────
const CATALOG_CODES = (CATALOG.tour_types || [])
  .filter(c => c.tour_type && c.arr_iata)
  .map(c => ({ code: up(c.tour_type), arr: c.arr_iata, dep: c.dep_iata, open_jaw: !!c.open_jaw, days: c.days }))
  .sort((a, b) => b.code.length - a.code.length);   // longest prefix wins

function matchAirports(tourCode) {
  let c = up(tourCode).replace(/\s+/g, '').replace(/^\d+/, '');   // drop leading month digits
  for (const e of CATALOG_CODES) {
    if (c.startsWith(e.code) || up(tourCode).includes(e.code)) return e;
  }
  return null;
}

// ── value score: cheapest fare, lightly penalised for stops + slowness ───────
function bestQuote(quotes) {
  if (!quotes || !quotes.length) return null;
  const minFare = Math.min(...quotes.map(q => q.fare));
  const minDur = Math.min(...quotes.map(q => q.durationMin || Infinity));
  let best = null;
  for (const q of quotes) {
    const stopPen = (q.stops || 0) * W.stopPct * minFare;
    const durPen = q.durationMin && minDur !== Infinity ? ((q.durationMin - minDur) / 60) * W.hourPct * minFare : 0;
    const score = q.fare + stopPen + durPen;
    if (!best || score < best.score) best = { ...q, score };
  }
  return best;
}

// ── 12h cache shared with /api/flight-quotes (keyed per route+date combo) ─────
function cacheKey(o) {
  return `${o.outFrom}|${o.outTo}|${o.depDate}|${o.retFrom}|${o.retTo}|${o.retDate}|1|economy|IDR|google`;
}
async function pricedRoute(supabase, route) {
  const key = cacheKey(route);
  let quotes = null, cached = false;
  try {
    const { data } = await supabase.from('flight_quote_cache').select('quotes, fetched_at').eq('cache_key', key).maybeSingle();
    if (data && (Date.now() - new Date(data.fetched_at).getTime()) < CACHE_TTL_MS) { quotes = data.quotes; cached = true; }
  } catch (_) {}
  if (!quotes) {
    const r = await googleRoundTrip({ ...route, pax: 1, cabin: 'economy', currency: 'IDR', timeoutMs: 12000, retries: 2 });
    if (!r.ok) return { ok: false, reason: r.reason, url: r.url };
    quotes = r.quotes;
    try {
      await supabase.from('flight_quote_cache').upsert({ cache_key: key, quotes, fetched_at: new Date().toISOString() });
    } catch (_) {}
  }
  const best = bestQuote(quotes);
  if (!best) return { ok: false, reason: 'no quotes' };
  return { ok: true, cached, best, url: route.googleUrl };
}

async function authorize(req, supabase) {
  const cronSecret = process.env.CRON_SECRET;
  const syncSecret = process.env.SYNC_SECRET;
  const auth = req.headers['authorization'] || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (cronSecret && bearer && bearer === cronSecret) return true;
  if (syncSecret && req.headers['x-sync-secret'] === syncSecret) return true;
  if (bearer) {
    const { data, error } = await supabase.auth.getUser(bearer);
    if (!error && data && data.user) return true;
  }
  return false;
}

// run an async mapper over items with a fixed concurrency + wall-clock budget
async function pool(items, limit, deadline, worker) {
  const out = new Array(items.length);
  let i = 0;
  async function run() {
    while (i < items.length) {
      const idx = i++;
      if (Date.now() > deadline) { out[idx] = { skipped: true }; continue; }
      out[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const started = Date.now();
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Supabase env vars missing' });
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  if (!(await authorize(req, supabase))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const runDate = wibToday();
  const windowEnd = addDays(runDate, WINDOW_DAYS);

  // booked tours departing in [today, today+30d], not cancelled/delisted
  const { data: tours, error } = await supabase
    .from('package_sales')
    .select('tour_code, tour_type, departure_date, pax_total, seat_left, tr_status, tour_status')
    .gt('pax_total', 0)
    .gte('departure_date', runDate)
    .lte('departure_date', windowEnd + 'T23:59:59')
    .order('departure_date', { ascending: true });
  if (error) return res.status(500).json({ error: 'package_sales query failed: ' + error.message });

  const active = (tours || []).filter(t => t.tour_code && t.tr_status !== 3 && (t.tour_status == null || t.tour_status === 0));
  // de-dup to one row per tour_code (closest departure) — the snapshot key
  const byCode = new Map();
  for (const t of active) if (!byCode.has(t.tour_code)) byCode.set(t.tour_code, t);
  const list = [...byCode.values()];

  const deadline = started + BUDGET_MS;
  const results = await pool(list, CONCURRENCY, deadline, async (t) => {
    const depDate = String(t.departure_date).slice(0, 10);
    const ap = matchAirports(t.tour_code);
    // Uniform row shape (every key present) — PostgREST bulk-upsert keys off the
    // first row, so heterogeneous objects would silently drop columns.
    const row = {
      run_date: runDate, tour_code: t.tour_code, tour_type: ap ? ap.code : null,
      product_name: t.tour_type || null, departure_date: depDate, return_date: null,
      origin: HOME, arr_iata: null, dep_iata: null, open_jaw: false,
      pax: t.pax_total, seat_left: t.seat_left, currency: 'IDR',
      fare: null, airline: null, stops: null, duration_min: null,
      status: 'ok', google_url: null,
    };
    if (!ap) { row.status = 'no_route'; return row; }
    const days = ap.days || DAYS_FALLBACK;
    row.return_date = addDays(depDate, Math.max(1, days - 1));
    row.arr_iata = ap.arr; row.dep_iata = ap.dep || ap.arr; row.open_jaw = ap.open_jaw;
    const r = await pricedRoute(supabase, {
      outFrom: HOME, outTo: ap.arr, depDate,
      retFrom: ap.dep || ap.arr, retTo: HOME, retDate: row.return_date,
    });
    if (!r.ok) { row.status = 'crawl_failed'; return row; }
    row.fare = r.best.fare; row.airline = r.best.airline || null;
    row.stops = r.best.stops ?? null; row.duration_min = r.best.durationMin ?? null;
    return row;
  });

  const rows = results.filter(r => r && !r.skipped);
  let priced = 0, noRoute = 0, failed = 0;
  for (const r of rows) {
    if (r.status === 'ok') priced++; else if (r.status === 'no_route') noRoute++; else failed++;
  }
  if (rows.length) {
    const { error: upErr } = await supabase
      .from('flight_price_snapshots')
      .upsert(rows, { onConflict: 'run_date,tour_code' });
    if (upErr) return res.status(500).json({ error: 'snapshot upsert failed: ' + upErr.message, run_date: runDate });
  }

  return res.status(200).json({
    ok: true, run_date: runDate, window_end: windowEnd,
    found: list.length, written: rows.length,
    priced, no_route: noRoute, failed,
    skipped: results.filter(r => r && r.skipped).length,
    ms: Date.now() - started,
  });
};
