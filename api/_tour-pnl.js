// Per-tour PnL reconciler (Sprint 12 — 2026-06-03).
//
// For every tour in the current sync scope, upsert a row in `tour_pnl` with
// Skybar-sourced revenue / received / pax / departure_date, plus the Skybar
// estimated-cost snapshot (per-tour override → per-type template fallback).
//
// Manual fields (land_cost, flight_cost, confirmed_depart, etc.) are NEVER
// touched here — those are entered via the UI's "Confirm Departure" modal.
//
// Idempotent: re-running the sync just refreshes the Skybar-side numbers.
// The DB column `id = 'pnl-<tour_id>'` is the natural conflict key.

const EST_COLS = [
  'air_ticket', 'land_tour', 'tl_cost', 'pkg_cost_nettt',
];

function num(v) { return v == null ? null : Number(v); }

async function loadEstimatedCosts(conn) {
  // tour-level overrides
  const [tourRows] = await conn.query(
    'SELECT tour_id, air_ticket, land_tour, tl_cost, pkg_cost_nettt FROM wt_tour_estimated_cost'
  );
  const byTour = new Map();
  for (const r of tourRows) byTour.set(Number(r.tour_id), r);

  // tour-type templates (joined back to wt_tour via tour_type_id)
  const [typeRows] = await conn.query(`
    SELECT t.id AS tour_id, c.air_ticket, c.land_tour, c.tl_cost, c.pkg_cost_nettt
    FROM wt_type_estimated_cost c
    JOIN wt_tour t ON t.tour_type_id = c.tour_type_id
    WHERE t.deleted_status = 0
  `);
  const byTypeTour = new Map();
  for (const r of typeRows) byTypeTour.set(Number(r.tour_id), r);

  return { byTour, byTypeTour };
}

async function reconcileTourPnl(supabase, conn, packages, orders) {
  // Probe table existence — degrade gracefully if migration 023 hasn't run.
  const probe = await supabase.from('tour_pnl').select('id').limit(1);
  if (probe.error) {
    return { skipped: `tour_pnl unavailable: ${probe.error.message}` };
  }

  // Received-total per tour_id (Skybar's actual paid receipts, which sync-skybar
  // already wrote into package_orders.deposit_amount via the new ORDER_SQL).
  const receivedByTour = new Map();
  for (const o of orders || []) {
    const tid = Number(o.tour_id);
    if (!tid) continue;
    receivedByTour.set(tid, (receivedByTour.get(tid) || 0) + (Number(o.deposit_amount) || 0));
  }

  // Skybar estimated-cost snapshots — tour override wins over type template.
  let est = { byTour: new Map(), byTypeTour: new Map() };
  try { est = await loadEstimatedCosts(conn); }
  catch (e) { return { error: `load estimated cost: ${String((e && e.message) || e)}` }; }

  // Pull existing rows so we preserve manual fields (land_cost / flight_cost /
  // confirmed_depart, etc.) — upsert PATCHES, not replaces, but we still want
  // to know whether the row exists to decide insert-vs-update behaviour.
  const ids = packages.map(p => 'pnl-' + p.tour_id);
  const existing = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data, error } = await supabase.from('tour_pnl').select('id').in('id', chunk);
    if (error) return { error: `read existing: ${error.message}` };
    for (const r of data || []) existing.set(r.id, true);
  }

  const rows = packages.map(p => {
    const id = 'pnl-' + p.tour_id;
    const tid = Number(p.tour_id);
    const e = est.byTour.get(tid) || est.byTypeTour.get(tid) || {};
    return {
      id,
      tour_id: tid,
      tour_code: p.tour_code,
      tour_name: p.tour_name,
      departure_date: typeof p.departure_date === 'string'
        ? p.departure_date.slice(0, 10)
        : (p.departure_date ? new Date(p.departure_date).toISOString().slice(0, 10) : null),
      region: p.region || p.area_name || null,
      pax_total: Number(p.pax_total || 0),
      revenue_total: num(p.revenue),
      received_total: receivedByTour.get(tid) || 0,
      est_air_ticket:    num(e.air_ticket),
      est_land_tour:     num(e.land_tour),
      est_tl_cost:       num(e.tl_cost),
      est_pkg_cost_nett: num(e.pkg_cost_nettt),
    };
  });

  let upserted = 0, errors = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const { error } = await supabase.from('tour_pnl').upsert(chunk, { onConflict: 'id' });
    if (error) { errors++; console.error('[tour_pnl] upsert chunk failed:', error.message); }
    else upserted += chunk.length;
  }

  return {
    upserted,
    errors,
    inserted: rows.length - existing.size,
    refreshed: existing.size,
  };
}

module.exports = { reconcileTourPnl };
