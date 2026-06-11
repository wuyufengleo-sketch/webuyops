// ============================================================================
//  GET /api/balance-recon — 收尾款 Sheet ↔ Skybar package_orders 对账
//
//  Fetches the CS Balance tracker Sheet (public xlsx export), aggregates the
//  4 "Dept <Month> 2026" monthly tabs, dedupes by Booking Number (last seen
//  wins so the most-recently-updated entry takes priority), joins with the
//  Supabase package_orders mirror by bkg_no, computes per-row deltas, and
//  returns a structured diff. The frontend Balance tab calls this and renders
//  side-by-side with red highlights on mismatches.
//
//  Auth: same as sync-skybar — Vercel cron / x-sync-secret / supabase user token.
//  No DB writes; this endpoint is pure read-and-compare.
// ============================================================================

const { createClient } = require('@supabase/supabase-js');
const XLSX = require('xlsx');
const { selectAll } = require('./_db-util');

const SHEET_ID = '1iwNinVw4wYx62JxdiR7wKYn5vADEoIHjhOkxosHQud4';
const MONTH_TAB_RE = /^Dept\s+/i;          // pick only "Dept <Month> <Year>" tabs

const txt = v => String(v == null ? '' : v).trim().replace(/[\r\n]+/g, ' ');
const num = v => { const s = String(v == null ? '' : v).replace(/[^\d.\-]/g, ''); if (!s) return null; const n = parseFloat(s); return isNaN(n) ? null : n; };
function isoDate(v) {
  if (typeof v === 'number' && isFinite(v) && v > 0) {
    const d = XLSX.SSF.parse_date_code(v);
    if (d && d.y) return `${String(d.y)}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
  }
  return txt(v);
}
const norm = s => String(s == null ? '' : s).trim().toUpperCase();

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

async function loadSheetRows() {
  const r = await fetch(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=xlsx`, { redirect: 'follow' });
  if (!r.ok) throw new Error(`sheet HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.slice(0, 2).toString() !== 'PK') throw new Error('not xlsx (sheet not shared publicly?)');
  const wb = XLSX.read(buf, { type: 'buffer' });

  const byBk = new Map();
  const usedTabs = [];
  for (const tab of wb.SheetNames) {
    if (!MONTH_TAB_RE.test(tab)) continue;
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[tab], { header: 1, blankrows: false, defval: '' });
    if (rows.length < 2) continue;
    const H = rows[0].map(norm);
    const idx = lbl => H.indexOf(lbl);
    const i = {
      bk:    idx('BOOKING NUMBER'),
      tc:    idx('TC'),
      pkg:   idx('PACKAGE'),
      country: idx('COUNTRY'),
      code:  idx('TOURCODE'),
      dept:  idx('DEPT DATE'),
      pax:   idx('PAX'),
      total: idx('TOTAL PRICE'),
      paid:  idx('TOTAL PAYMENT'),
      under: idx('UNDERPAYMENT GS'),
      duedp: idx('DUE DATE MIN DP'),
      status:idx('STATUS MIN. DP'),
      group: H.findIndex(h => h.startsWith('STATUS GR')),
      note:  H.findIndex(h => h.startsWith('HANDLE BY') || h === 'NOTE'),
    };
    if (i.bk < 0) continue;
    usedTabs.push(tab);
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const bk = txt(row[i.bk]);
      if (!bk || !bk.toUpperCase().startsWith('BK')) continue;   // skip "Total" / blank
      byBk.set(bk.toUpperCase(), {
        bk, tab,
        tc: i.tc >= 0 ? txt(row[i.tc]) : '',
        pkg: i.pkg >= 0 ? txt(row[i.pkg]) : '',
        country: i.country >= 0 ? txt(row[i.country]) : '',
        tourcode: i.code >= 0 ? txt(row[i.code]) : '',
        dept_date: i.dept >= 0 ? isoDate(row[i.dept]) : '',
        pax: i.pax >= 0 ? num(row[i.pax]) : null,
        total_price: i.total >= 0 ? num(row[i.total]) : null,
        total_payment: i.paid >= 0 ? num(row[i.paid]) : null,
        underpayment: i.under >= 0 ? num(row[i.under]) : null,
        due_dp: i.duedp >= 0 ? isoDate(row[i.duedp]) : '',
        status_dp: i.status >= 0 ? txt(row[i.status]) : '',
        status_group: i.group >= 0 ? txt(row[i.group]) : '',
        cs_note: i.note >= 0 ? txt(row[i.note]) : '',
      });
    }
  }
  return { rows: [...byBk.values()], usedTabs };
}

// Build the full reconciliation: fetch sheet + load matching Skybar orders +
// load any open Skybar balance not in the sheet (orphans) → return structured
// diffs + summary. Reusable by both the HTTP handler and the daily cron alerter.
async function runReconciliation(supabase) {
  const { rows: sheetRows, usedTabs } = await loadSheetRows();
  const bks = sheetRows.map(r => r.bk).filter(Boolean);
  const orderMap = new Map();
  for (let i = 0; i < bks.length; i += 500) {
    const { data, error } = await supabase
      .from('package_orders')
      .select('id, bkg_no, tour_id, total_amount, balance_amount, deposit_amount, refund_amount, order_status, salesman')
      .in('bkg_no', bks.slice(i, i + 500));
    if (error) throw new Error('package_orders read: ' + error.message);
    for (const o of data || []) orderMap.set(norm(o.bkg_no), o);
  }
  const { data: openOrders, error: openErr } = await selectAll(
    () => supabase
      .from('package_orders')
      .select('bkg_no, tour_id, total_amount, balance_amount, salesman, order_status')
      .gt('balance_amount', 0)
      .not('bkg_no', 'is', null),
    { order: 'bkg_no' });
  if (openErr) throw new Error('open package_orders read: ' + openErr.message);
  const sheetBkSet = new Set(sheetRows.map(r => norm(r.bk)));

  const diffs = sheetRows.map(s => {
    const o = orderMap.get(norm(s.bk));
    const sb_total = o ? Number(o.total_amount) : null;
    const sb_balance = o ? Number(o.balance_amount) : null;
    const total_diff = (s.total_price != null && sb_total != null) ? (Number(s.total_price) - sb_total) : null;
    const balance_diff = (s.underpayment != null && sb_balance != null) ? (Number(s.underpayment) - sb_balance) : null;
    let flag = 'ok';
    if (!o) flag = 'sheet_only';
    else if ((total_diff != null && Math.abs(total_diff) > 1) || (balance_diff != null && Math.abs(balance_diff) > 1)) flag = 'mismatch';
    return {
      bk: s.bk, tab: s.tab, tc: s.tc, tourcode: s.tourcode, country: s.country, dept_date: s.dept_date,
      sheet_total: s.total_price, sheet_paid: s.total_payment, sheet_balance: s.underpayment,
      sheet_status: s.status_group || s.status_dp, sheet_note: s.cs_note,
      sb_total, sb_balance, sb_paid: o ? (Number(o.total_amount) - Number(o.balance_amount)) : null,
      sb_status: o ? o.order_status : null, sb_salesman: o ? o.salesman : null,
      total_diff, balance_diff, flag,
    };
  });
  const skybar_only = (openOrders || []).filter(o => o.bkg_no && !sheetBkSet.has(norm(o.bkg_no))).map(o => ({
    bk: o.bkg_no, sb_total: Number(o.total_amount), sb_balance: Number(o.balance_amount),
    sb_salesman: o.salesman, sb_status: o.order_status, flag: 'skybar_only',
  }));
  const summary = {
    sheet_rows: sheetRows.length,
    matched: diffs.filter(d => d.flag === 'ok').length,
    mismatched: diffs.filter(d => d.flag === 'mismatch').length,
    sheet_only: diffs.filter(d => d.flag === 'sheet_only').length,
    skybar_only: skybar_only.length,
    used_tabs: usedTabs,
  };
  return { summary, diffs, skybar_only };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Supabase env vars missing' });
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  if (!(await authorize(req, supabase))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const result = await runReconciliation(supabase);
    return res.status(200).json({ ok: true, ...result, ts: new Date().toISOString() });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};

module.exports.runReconciliation = runReconciliation;
