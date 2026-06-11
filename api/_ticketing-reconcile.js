// ============================================================================
//  Ticketing per-tour status reconciler.
//
//  Before this module existed, the `ticketing` table (one row per tour_code
//  with summary status, PNRs, vendors, avg price) was ONLY written by the
//  OPS person clicking "Confirm Insert" in the Sync Probe modal. If nobody
//  clicked confirm for weeks, the ticketing page showed stale "NOT BOOKED"
//  rows even though `ticketing_items` had fresh ISSUED rows underneath.
//
//  This reconciler runs at the end of every sync-skybar cron: it groups
//  ticketing_items by tour_code and upserts an authoritative summary row
//  into `ticketing`, so the tour-level board is never more than 24h stale.
//
//  Status rule (same as buildTicketingTourSummaryRows in app.html — keep
//  in sync if you change one):
//    all items ISSUED|REISSUED   → ISSUED
//    some items ISSUED|REISSUED  → PARTIAL
//    some items BOOKED           → BOOKED
//    otherwise                   → NOT BOOKED
//
//  Pure-ish: never throws. Returns { ok, totalTours, updated, error? }.
// ============================================================================

async function reconcileTicketingStatus(supabase) {
  try {
    // Pull every item in the system. ticketing_items is per-pax-per-segment
    // so the row count is roughly pax_count × avg_segments_per_tour. Even
    // 50K rows fits comfortably in one PostgREST page; we use a generous
    // limit + pagination to stay safe.
    const items = [];
    const PAGE = 1000;
    let from = 0;
    for (;;) {
      const { data, error } = await supabase
        .from('ticketing_items')
        .select('tour_code, ticket_no, vendor, price, status, issue_date')
        .range(from, from + PAGE - 1);
      if (error) return { ok: false, error: 'read ticketing_items: ' + error.message };
      if (!data || !data.length) break;
      items.push(...data);
      if (data.length < PAGE) break;
      from += PAGE;
    }
    if (!items.length) return { ok: true, totalTours: 0, updated: 0, note: 'no ticketing_items' };

    // Group by tour_code (already stored upper-cased by the sync probe; we
    // trust the writer but trim defensively).
    const byTour = new Map();
    for (const r of items) {
      const tc = String(r.tour_code || '').trim();
      if (!tc) continue;
      if (!byTour.has(tc)) byTour.set(tc, {
        tour_code: tc,
        total: 0, issued: 0, booked: 0, notBooked: 0,
        pnrs: new Set(), vendors: new Set(),
        prices: [], issueDates: [],
      });
      const g = byTour.get(tc);
      const st = String(r.status || '').toUpperCase();
      g.total++;
      if (/^(ISSUED|REISSUED)$/.test(st)) g.issued++;
      else if (st === 'BOOKED') g.booked++;
      else g.notBooked++;
      if (r.ticket_no) g.pnrs.add(String(r.ticket_no).trim());
      if (r.vendor) g.vendors.add(String(r.vendor).trim());
      if (Number(r.price || 0) > 0) g.prices.push(Number(r.price));
      if (r.issue_date) g.issueDates.push(r.issue_date);
    }

    const rows = [...byTour.values()].map(g => {
      const status = g.total && g.issued === g.total ? 'ISSUED'
        : g.issued > 0 ? 'PARTIAL'
        : g.booked > 0 ? 'BOOKED'
        : 'NOT BOOKED';
      const pnrs = [...g.pnrs];
      const vendors = [...g.vendors];
      const issueDates = g.issueDates.filter(Boolean).sort();
      return {
        tour_code: g.tour_code,
        status,
        pnr: pnrs.slice(0, 4).join(', ') || null,
        vendor: vendors.slice(0, 3).join(', ') || null,
        price: g.prices.length ? Math.round(g.prices.reduce((s, n) => s + n, 0) / g.prices.length) : 0,
        issue_date: issueDates[0] || null,
        notes: `Auto recomputed from ticketing_items: ${g.issued}/${g.total} issued${pnrs.length ? ` · ${pnrs.length} PNR` : ''}`,
      };
    });

    if (!rows.length) return { ok: true, totalTours: 0, updated: 0 };

    // Upsert in chunks. Tour count is usually <1000 so one batch is plenty.
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error } = await supabase.from('ticketing').upsert(chunk, { onConflict: 'tour_code' });
      if (error) return { ok: false, error: 'upsert ticketing: ' + error.message };
    }

    return {
      ok: true,
      totalTours: rows.length,
      updated: rows.length,
      statusDist: rows.reduce((d, r) => (d[r.status] = (d[r.status] || 0) + 1, d), {}),
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = { reconcileTicketingStatus };
