// ============================================================================
//  Shared DB helpers for the server-side reconcilers / alerters.
//
//  selectAll() — paginate a PostgREST/Supabase read past the 1000-row cap.
//
//  PostgREST returns at most ~1000 rows per request unless .range() is used.
//  Several reconcilers read whole, ever-growing tables (vendor_payments,
//  refunds, ticketing, order_workflow, manifest_passengers, …) with a bare
//  .select() and treated the result as complete. Past 1000 rows that silently
//  truncates — corrupting dedup sets, re-inserting existing PKs (which then
//  throws and kills the feature permanently), or flapping alert state.
//
//  Usage:
//    const { data, error } = await selectAll(
//      () => supabase.from('vendor_payments').select('id, tourcode, status'),
//      { order: 'id' }
//    );
//
//  `makeQuery` MUST be a thunk that returns a FRESH filtered builder each call
//  (so .range() can be re-applied per page). Apply any .eq()/.not()/.gt()
//  filters inside the thunk. Returns the same { data, error } shape callers
//  already destructure; on error, data is null and iteration stops.
// ============================================================================

async function selectAll(makeQuery, { order = 'id', ascending = true, page = 1000 } = {}) {
  const out = [];
  let from = 0;
  for (;;) {
    let q = makeQuery();
    // Stable ordering is required: without ORDER BY, row order across separate
    // OFFSET pages is not guaranteed, so rows could be duplicated or skipped.
    if (order) q = q.order(order, { ascending });
    q = q.range(from, from + page - 1);
    const { data, error } = await q;
    if (error) return { data: null, error };
    if (!data || !data.length) break;
    out.push(...data);
    if (data.length < page) break;
    from += page;
  }
  return { data: out, error: null };
}

module.exports = { selectAll };
