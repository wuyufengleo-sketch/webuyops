// Shared Google-Sheet price loader for the Package Sales enrichment.
//
// Returns split maps so callers can apply the agreed semantics:
//   • basic_price (= twin fare) varies per departure  → keyed by TOUR CODE
//   • all other price fields are fixed per product     → keyed by TOUR TYPE
//
// On ANY fetch/parse failure returns { ok:false } (never throws), so the
// hourly sync can skip enrichment without wiping previously-imported prices.

const SHEET_ID = '13hziRYTYWULZXjKEprOhLbPqPokc15rR';
const MIN_AMOUNT = 1000;                       // 金额合理性下限（滤除截断/误读）
const SKIP_TAB = /2024|2025|UNUSED/i;          // 旧/未用标签
const GROUP_TITLE = /^(CHINA|KOREA|JAPAN|EUROPE|TURKEY|TURKIYE|VIETNAM|AURORA|USA|AUSTRALIA|ASIA|SOUTH EAST ASIA)$/;

// 逐出发团（按 TOUR CODE）字段
const CODE_FIELDS = { 'BASIC PRICE': 'basic_price' };
// 按产品（TOUR TYPE）固定字段
const TYPE_FIELDS = {
  'VISA': 'visa_price', 'DBL ENTRY VISA': 'dbl_entry_visa', 'TIPPING': 'tipping',
  'INSURANCE': 'insurance', 'OPTIONAL MANDATORY': 'optional_mandatory',
  'SINGLE SUPPLEMENT': 'single_supplement', 'INFANT': 'infant_price',
  'CHLD NO BED': 'child_no_bed', 'CHILD NO BED': 'child_no_bed',
  'DETAILS ITINERARY': 'itinerary',
};

const norm = s => String(s == null ? '' : s).trim().toUpperCase().replace(/\s+/g, ' ');
const money = v => {
  const s = String(v == null ? '' : v).replace(/[^\d.]/g, '');
  if (!s) return null;
  const n = Math.round(parseFloat(s));
  return isNaN(n) ? null : n;
};
const validKey = k => k && k.length >= 3 && !k.includes('PACKAGE') && !GROUP_TITLE.test(k);

async function loadSheetPrices() {
  try {
    const r = await fetch(
      `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=xlsx`,
      { redirect: 'follow' }
    );
    if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.slice(0, 2).toString() !== 'PK') return { ok: false, reason: 'not xlsx (sharing/private?)' };

    const XLSX = require('xlsx');
    const wb = XLSX.read(buf, { type: 'buffer' });

    const byCodeBasic = new Map();   // tour_code → basic_price
    const byType = new Map();        // type_code → {fixed fields}
    const usedTabs = [];

    for (const name of wb.SheetNames) {
      if (SKIP_TAB.test(name)) continue;
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, defval: '' });
      let hdr = -1;
      for (let i = 0; i < Math.min(10, rows.length); i++) {
        const j = rows[i].join('|').toUpperCase();
        if (j.includes('PACKAGE NAME') && (j.includes('TOUR TYPE') || j.includes('PRICE'))) { hdr = i; break; }
      }
      if (hdr < 0) continue;
      const H = rows[hdr].map(norm);
      const idxType = H.findIndex(h => h === 'TOUR TYPE');
      const idxCode = H.findIndex(h => h === 'TOUR CODE');
      if (idxType < 0 && idxCode < 0) continue;

      const codeCol = {}; for (const [label, field] of Object.entries(CODE_FIELDS)) { const ci = H.findIndex(h => h === label); if (ci >= 0) codeCol[field] = ci; }
      const typeCol = {}; for (const [label, field] of Object.entries(TYPE_FIELDS)) { const ci = H.findIndex(h => h === label); if (ci >= 0) typeCol[field] = ci; }
      usedTabs.push(name);

      for (let i = hdr + 1; i < rows.length; i++) {
        const tc = idxCode >= 0 ? norm(rows[i][idxCode]) : '';
        const ty = idxType >= 0 ? norm(rows[i][idxType]) : '';

        // 逐团 basic（按 TOUR CODE，首个有效优先）
        if (validKey(tc) && !byCodeBasic.has(tc) && codeCol.basic_price != null) {
          const n = money(rows[i][codeCol.basic_price]);
          if (n != null && n >= MIN_AMOUNT) byCodeBasic.set(tc, n);
        }

        // 固定项（按 TOUR TYPE，首个有效优先）
        if (validKey(ty) && !byType.has(ty)) {
          const rec = {};
          for (const [field, ci] of Object.entries(typeCol)) {
            if (field === 'itinerary') { const t = String(rows[i][ci] || '').trim(); if (t) rec.itinerary = t; }
            else { const n = money(rows[i][ci]); if (n != null && n >= MIN_AMOUNT) rec[field] = n; }
          }
          if (Object.keys(rec).length) byType.set(ty, rec);
        }
      }
    }

    return { ok: true, byCodeBasic, byType, usedTabs };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

module.exports = { loadSheetPrices, TYPE_FIELDS, CODE_FIELDS };
