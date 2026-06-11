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
const PPN_RATE = 0.11;  // 印尼 PPN/VAT 11%

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

// 紧凑写法：Rp14.999.000 → 14.99jt
const fmtJt = n => {
  if (!Number.isFinite(n) || n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return (n/1_000_000).toFixed(2).replace(/\.?0+$/,'') + 'jt';
  if (abs >= 1_000)     return (n/1_000).toFixed(0) + 'k';
  return String(Math.round(n));
};

// Expected standard sell-price per pax for a tour, broken down by component.
// Order of precedence per field:
//   1) pkg.<field> (set by sync-skybar from Sheet)
//   2) null  → component not entered in Sheet, can't compare
//
// `complete` flag: true ONLY when every cost component the Sheet uses is
// populated. The Sheet enrichment in _sheet-prices.js writes per-type fields
// keyed by tour_type_code, so a single missing type-template means visa/
// tipping/insurance come back null → num()→0 → expected drops by 1.5–3jt.
// If we still flag the booking as "below standard" the OPS team gets
// false-positive Lark alerts daily. So unless the Sheet covers all five
// components for this tour, treat the comparison as unknown.
function expectedBreakdownPerPax(pkg) {
  const b = {
    basic_price:        num(pkg.basic_price),
    visa_price:         num(pkg.visa_price),
    tipping:            num(pkg.tipping),
    insurance:          num(pkg.insurance),
    optional_mandatory: num(pkg.optional_mandatory),
  };
  const subtotal = b.basic_price + b.visa_price + b.tipping + b.insurance + b.optional_mandatory;
  // If Sheet has a TOTAL PRICE field captured (pkg.total_price), use it as
  // the subtotal — Product likely already summed it including any tweak.
  const sheet_total = num(pkg.total_price);
  const useSheetTotal = sheet_total > 0;
  const expected_subtotal = useSheetTotal ? sheet_total : subtotal;
  const expected_total = expected_subtotal * (1 + PPN_RATE);
  // Completeness: basic_price is mandatory (no tour without land cost),
  // visa+tipping+insurance must all be either set or all explicitly zero
  // (some lines are visa-free or no-tipping by design — but null=missing).
  // When sheet_total is set explicitly, that already includes everything →
  // treat as complete regardless of per-component values.
  const allComponentsPresent =
    pkg.basic_price != null && pkg.basic_price > 0 &&
    pkg.visa_price != null && pkg.tipping != null && pkg.insurance != null;
  const complete = useSheetTotal || allComponentsPresent;
  return {
    ...b,
    subtotal: expected_subtotal,
    ppn: expected_subtotal * PPN_RATE,
    total_with_ppn: expected_total,
    used_sheet_total: useSheetTotal,
    complete,
  };
}

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
  const allRecent = [];

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
    const total = num(o.total_amount);
    if (total <= 0) continue;
    const perPax = total / guests;

    const exp = expectedBreakdownPerPax(pkg);

    const baseRow = {
      bkg_no: o.bkg_no || ('BK' + String(o.order_id || '').padStart(6, '0')),
      salesman: o.salesman || '(unknown)',
      tour_code: pkg.tour_code || '?',
      tour_name: pkg.tour_name || '',
      departure_date: pkg.departure_date || null,
      guest_num: guests,
      total_amount: total,
      per_pax: Math.round(perPax),
      order_date: o.order_date || null,
      expected: exp,
    };

    if (exp.basic_price > 0) {
      withBasic++;
      if (!exp.complete) {
        // Sheet missing visa/tipping/insurance for this tour_type → expected
        // is artificially low. Do not flag; keep in allRecent so OPS knows.
        allRecent.push({ ...baseRow, status: 'incomplete_sheet', diff: null, pct_off: null });
      } else {
        // Compare actual per-pax to expected total-with-PPN
        const diff = exp.total_with_ppn - perPax;
        const pctOff = exp.total_with_ppn > 0 ? (diff / exp.total_with_ppn) * 100 : 0;
        // Tolerance: within 2% = match (normal rounding/promo), >2% short = low,
        // >2% extra = high.
        const status = Math.abs(pctOff) <= 2 ? 'match' : (pctOff > 0 ? 'low' : 'high');
        const row = { ...baseRow, diff: Math.round(diff), pct_off: pctOff, status };
        allRecent.push(row);
        if (status === 'low') flagged.push(row);
      }
    } else {
      allRecent.push({ ...baseRow, status: 'no_sheet', diff: null, pct_off: null });
    }
  }

  flagged.sort((a, b) => b.diff - a.diff);
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

// Signed amount formatter — "+Rp X" for revenue above standard, "-Rp X" for
// revenue below. Used so OPS can see at a glance whether each booking
// under-charged (red) or over-charged (green).
const fmtRpSigned = n => {
  if (!Number.isFinite(n) || n === 0) return 'Rp0';
  const sign = n > 0 ? '+' : '-';
  return sign + 'Rp' + Math.round(Math.abs(n)).toLocaleString('id-ID');
};
const fmtPctSigned = n => {
  if (!Number.isFinite(n)) return '0.0%';
  const sign = n > 0 ? '+' : (n < 0 ? '-' : '');
  return sign + Math.abs(n).toFixed(1) + '%';
};

// Ringkasan satu baris untuk Lark heartbeat (Bahasa Indonesia).
function priceWatchHeartbeatLine(result) {
  if (!result || !result.ok) {
    return `💰 price-watch: ❌ ${result && result.reason ? result.reason : 'skipped'}`;
  }
  if (!result.flagged.length) {
    return `💰 price-watch: ${result.scanned} booking baru 24 jam (${result.withBasic} ada harga sheet) — tidak ada di bawah standar ✅`;
  }
  return `🚨 price-watch: ${result.flagged.length} booking di bawah harga standar dalam 24 jam (${result.scanned} booking baru)`;
}

// Blok detail singkat (hanya saat ada offender). Maks 8 worst-offender.
function priceWatchDetailBlock(result, max = 8) {
  if (!result || !result.ok || !result.flagged.length) return '';
  const lines = result.flagged.slice(0, max).map(s => {
    const dep = s.departure_date ? String(s.departure_date).slice(0, 10) : '';
    const exp = s.expected || {};
    // Revenue impact = -(expected - actual) so under-priced shows as negative.
    const signedAmt = -s.diff;
    const signedPct = -s.pct_off;
    return `  · ${s.bkg_no} · ${s.salesman} · ${s.tour_code}${dep ? ' ' + dep : ''} · ${s.guest_num}pax · aktual ${fmtRp(s.per_pax)}/pax vs standar ${fmtRp(exp.total_with_ppn || 0)}/pax · ${fmtRpSigned(signedAmt)} (${fmtPctSigned(signedPct)})`;
  });
  if (result.flagged.length > max) lines.push(`  …+${result.flagged.length - max} booking lainnya`);
  return lines.join('\n');
}

// Full breakdown per BK — actual per-pax vs expected standard sell price
// (basic + visa + tipping + insurance + opt_mandatory + PPN 11%).
// Shows component-by-component expected and the diff to actual.
//   ✅ match    : within 2% of expected total
//   🚨 low      : per-pax < expected by > 2% (under-priced; salesperson cut corners)
//   ⬆ high     : per-pax > expected by > 2% (upsell)
//   ❓ no_sheet : basic_price missing in Sheet for this tour
// Rincian penuh per booking — harga aktual/pax vs standar (basic + visa +
// tipping + insurance + opt_mandatory + PPN 11%). Semua jumlah pakai
// tanda +/- supaya bisa dilihat sekilas:
//   -Rp ... = jual di bawah standar (revenue impact negatif)
//   +Rp ... = jual di atas standar (upsell, revenue impact positif)
//
//   ✅ sesuai     : dalam batas ±2% dari standar
//   🚨 kurang     : aktual < standar > 2%
//   ⬆ lebih      : aktual > standar > 2% (upsell)
//   ❓ tdk di sheet: basic_price belum ada di Sheet untuk tour ini
function priceWatchFullBlock(result, max = 60) {
  if (!result || !result.ok || !result.allRecent || !result.allRecent.length) return '';
  const ICON = { match: '✅', low: '🚨', high: '⬆', no_sheet: '❓' };
  const counts = { match: 0, low: 0, high: 0, no_sheet: 0 };
  for (const r of result.allRecent) counts[r.status] = (counts[r.status] || 0) + 1;
  const header =
    `📋 Booking 24 jam — aktual vs standar (basic + visa + tipping + insurance + opt_mandatory + PPN 11%):\n` +
    `   ✅${counts.match||0} sesuai · 🚨${counts.low||0} kurang · ⬆${counts.high||0} lebih · ❓${counts.no_sheet||0} tdk di sheet`;
  const lines = result.allRecent.slice(0, max).map(s => {
    const dep = s.departure_date ? String(s.departure_date).slice(0, 10) : '----------';
    const exp = s.expected || {};
    if (s.status === 'no_sheet') {
      return `  ❓ ${s.bkg_no} · ${s.salesman} · ${s.tour_code} ${dep} · ${s.guest_num}pax · aktual ${fmtRp(s.per_pax)}/pax (harga sheet utk tour ini belum ada)`;
    }
    const compPieces = [
      `basic ${fmtJt(exp.basic_price)}`,
      exp.visa_price ? `visa ${fmtJt(exp.visa_price)}` : null,
      exp.tipping ? `tip ${fmtJt(exp.tipping)}` : null,
      exp.insurance ? `ins ${fmtJt(exp.insurance)}` : null,
      exp.optional_mandatory ? `opt ${fmtJt(exp.optional_mandatory)}` : null,
      `PPN ${fmtJt(exp.ppn||0)}`,
    ].filter(Boolean).join(' + ');
    // Revenue impact = -(expected - actual): under-priced → negative, over → positive
    const signedAmt = s.diff != null ? -s.diff : null;
    const signedPct = s.pct_off != null ? -s.pct_off : null;
    const diffStr = signedAmt != null
      ? `${fmtRpSigned(signedAmt)} (${fmtPctSigned(signedPct)})`
      : '';
    return `  ${ICON[s.status]||'·'} ${s.bkg_no} · ${s.salesman} · ${s.tour_code} ${dep} · ${s.guest_num}pax
       aktual ${fmtRp(s.per_pax)}/pax  vs  standar ${fmtRp(exp.total_with_ppn)}/pax  · ${diffStr}
       rincian standar: ${compPieces}`;
  });
  if (result.allRecent.length > max) lines.push(`  …+${result.allRecent.length - max} booking lainnya (lihat OPS Work Queue)`);
  return [header, ...lines].join('\n');
}

module.exports = { detectLowPriceOrders, priceWatchHeartbeatLine, priceWatchDetailBlock, priceWatchFullBlock, expectedBreakdownPerPax, PPN_RATE };
