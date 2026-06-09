// ============================================================================
//  Price-watch — flag sales that went below the Sheet's BASIC PRICE.
//
//  Inputs are the same `packages` + `orders` shapes already built in
//  sync-skybar.js. We do NOT re-fetch the Google Sheet — `_sheet-prices.js`
//  has already enriched packages with `basic_price` (keyed by TOUR CODE) so
//  this module just runs the comparison and renders a Lark text block.
//
//  Rule (matches the user's explicit answer):
//    actual_per_pax = total_amount / guest_num
//    if actual_per_pax < pkg.basic_price  →  flagged
//  Only counts orders created in the trailing 24h window (since the cron
//  runs once per day) so the same booking isn't reported forever, and only
//  VALID order_status (1,2,3,4,8,9 — same set sync-skybar already uses).
//
//  Pure function. Never throws (returns { ok:false, reason } on failure) so
//  it can't break the rest of the sync.
// ============================================================================

const VALID_STATUS = new Set([1, 2, 3, 4, 8, 9]);

const num = v => {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/[^\d.\-]/g, ''));
  return isNaN(n) ? 0 : n;
};

const fmtRp = n => {
  if (!Number.isFinite(n)) return '-';
  return 'Rp' + Math.round(n).toLocaleString('id-ID');
};

function detectLowPriceOrders({ packages, orders, windowHours = 24, nowMs = Date.now() }) {
  if (!Array.isArray(packages) || !Array.isArray(orders)) {
    return { ok: false, reason: 'invalid inputs' };
  }
  const byTour = new Map();
  for (const p of packages) {
    if (p && p.tour_id != null) byTour.set(Number(p.tour_id), p);
  }
  const cutoffMs = nowMs - windowHours * 3600 * 1000;

  let scanned = 0;
  let withBasic = 0;
  const flagged = [];
  const allRecent = [];  // every 24h BK with breakdown (for full OPS heartbeat block)

  for (const o of orders) {
    if (!o) continue;
    scanned++;
    if (o.order_status == null || !VALID_STATUS.has(Number(o.order_status))) continue;
    const guests = Number(o.guest_num || 0);
    if (guests < 1) continue;

    const orderTs = o.order_date ? new Date(o.order_date).getTime() : NaN;
    if (!Number.isFinite(orderTs) || orderTs < cutoffMs) continue;

    const pkg = byTour.get(Number(o.tour_id));
    if (!pkg) continue;
    const basic = num(pkg.basic_price);
    const total = num(o.total_amount);
    if (total <= 0) continue;
    const perPax = total / guests;

    const baseRow = {
      bkg_no: o.bkg_no || ('BK' + String(o.order_id || '').padStart(6, '0')),
      salesman: o.salesman || '(unknown)',
      tour_code: pkg.tour_code || '?',
      tour_name: pkg.tour_name || '',
      departure_date: pkg.departure_date || null,
      guest_num: guests,
      total_amount: total,
      per_pax: Math.round(perPax),
      basic_price: basic > 0 ? basic : null,
      order_date: o.order_date || null,
    };

    if (basic > 0) {
      withBasic++;
      const diff = basic - perPax;
      const pctOff = (diff / basic) * 100;
      const row = { ...baseRow, diff: Math.round(diff), pct_off: pctOff };
      // status: 'low' = below sheet basic, 'match' = within 1% either side, 'high' = above
      row.status = Math.abs(pctOff) <= 1 ? 'match' : (pctOff > 0 ? 'low' : 'high');
      allRecent.push(row);
      if (row.status === 'low') flagged.push(row);
    } else {
      // No Sheet basic available for this tour code — can't compare.
      allRecent.push({ ...baseRow, status: 'no_sheet', diff: null, pct_off: null });
    }
  }

  flagged.sort((a, b) => b.diff - a.diff);
  // Order full breakdown by departure date so OPS can read it in tour-batch order.
  allRecent.sort((a, b) => String(a.departure_date||'').localeCompare(String(b.departure_date||''))
                      || String(a.bkg_no).localeCompare(String(b.bkg_no)));
  return {
    ok: true,
    scanned,
    withBasic,
    windowHours,
    cutoffISO: new Date(cutoffMs).toISOString(),
    flagged,
    allRecent,
  };
}

// One-line summary for the Lark heartbeat block.
function priceWatchHeartbeatLine(result) {
  if (!result || !result.ok) {
    return `💰 price-watch: ❌ ${result && result.reason ? result.reason : 'skipped'}`;
  }
  if (!result.flagged.length) {
    return `💰 price-watch: 24h 新单 ${result.scanned}（有底价的 ${result.withBasic}），无低于 BASIC PRICE`;
  }
  return `🚨 price-watch: ${result.flagged.length} 单 actual < BASIC PRICE（24h 新单 ${result.scanned}）`;
}

// Optional detailed block for the heartbeat (only when there ARE offenders).
// Trimmed to 8 worst-offenders so the Lark message doesn't blow up.
function priceWatchDetailBlock(result, max = 8) {
  if (!result || !result.ok || !result.flagged.length) return '';
  const lines = result.flagged.slice(0, max).map(s => {
    const dep = s.departure_date ? String(s.departure_date).slice(0, 10) : '';
    return `  · ${s.bkg_no} · ${s.salesman} · ${s.tour_code}${dep ? ' ' + dep : ''} · ${s.guest_num}pax · per-pax ${fmtRp(s.per_pax)} < basic ${fmtRp(s.basic_price)} (差 ${fmtRp(s.diff)} / ${s.pct_off.toFixed(1)}%)`;
  });
  if (result.flagged.length > max) lines.push(`  …还有 ${result.flagged.length - max} 单`);
  return lines.join('\n');
}

// Full breakdown of every 24h new BK — actual per-pax dealing price vs the
// Sheet's BASIC PRICE per tour code. OPS reads this to confirm every booking
// matches the Sheet's date-based price, not just to spot exceptions.
//   ✅ match  : within 1% of sheet basic
//   🚨 low    : per-pax < basic
//   ⬆ high    : per-pax > basic (upsell — info only)
//   ❓ no sheet: tour_code missing in the sheet → can't compare
function priceWatchFullBlock(result, max = 60) {
  if (!result || !result.ok || !result.allRecent || !result.allRecent.length) return '';
  const ICON = { match: '✅', low: '🚨', high: '⬆', no_sheet: '❓' };
  const counts = { match: 0, low: 0, high: 0, no_sheet: 0 };
  for (const r of result.allRecent) counts[r.status] = (counts[r.status] || 0) + 1;
  const header = `📋 24h BK 成交价 vs Sheet basic price (按出发日排):  ✅${counts.match||0} match · 🚨${counts.low||0} low · ⬆${counts.high||0} high · ❓${counts.no_sheet||0} no-sheet`;
  const lines = result.allRecent.slice(0, max).map(s => {
    const dep = s.departure_date ? String(s.departure_date).slice(0, 10) : '----------';
    const basicStr = s.basic_price != null ? fmtRp(s.basic_price) : '—';
    const diffStr = s.diff != null
      ? ` (差 ${s.diff >= 0 ? '-' : '+'}${fmtRp(Math.abs(s.diff))} / ${(s.pct_off||0).toFixed(1)}%)`
      : ' (sheet 无此 tour code)';
    return `  ${ICON[s.status]||'·'} ${s.bkg_no} · ${s.salesman} · ${s.tour_code} ${dep} · ${s.guest_num}pax · 成交 ${fmtRp(s.per_pax)} vs basic ${basicStr}${diffStr}`;
  });
  if (result.allRecent.length > max) lines.push(`  …还有 ${result.allRecent.length - max} 单（详情请查 OPS 网站 Work Queue）`);
  return [header, ...lines].join('\n');
}

module.exports = { detectLowPriceOrders, priceWatchHeartbeatLine, priceWatchDetailBlock, priceWatchFullBlock };
