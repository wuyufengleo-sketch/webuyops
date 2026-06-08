const fs = require('fs');
const os = require('os');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const VALID_ORDER_STATUS = new Set([1, 2, 3, 4, 8, 9]);
const DEFAULT_LIMIT = 700;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
}

function serviceClient() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function requireUser(supabase, req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

function dataPlatformUrl() {
  if (process.env.WEBUY_DATA_MCP_URL) return process.env.WEBUY_DATA_MCP_URL;
  if (process.env.WEBUY_DATA_MCP_TOKEN) {
    return `https://webuy-data-platform.onrender.com/mcp?token=${process.env.WEBUY_DATA_MCP_TOKEN}`;
  }

  // Local developer convenience only. Production must use env vars.
  if (process.env.VERCEL) return '';
  try {
    const cfg = fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8');
    const m = cfg.match(/https:\/\/webuy-data-platform\.onrender\.com\/mcp\?token=[^"\]\s]+/);
    return m ? m[0] : '';
  } catch {
    return '';
  }
}

function parseSseJson(body) {
  const lines = String(body || '').split(/\r?\n/).filter(line => line.startsWith('data: ')).map(line => line.slice(6));
  return JSON.parse(lines.length ? lines.join('\n') : body);
}

async function callMcpTool(name, args) {
  const url = dataPlatformUrl();
  if (!url) throw new Error('WEBUY_DATA_MCP_URL or WEBUY_DATA_MCP_TOKEN not set');

  const payload = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: { name, arguments: args || {} },
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`data platform HTTP ${r.status}: ${text.slice(0, 220)}`);
  const obj = parseSseJson(text);
  if (obj.error) throw new Error(obj.error.message || JSON.stringify(obj.error));
  const content = obj.result?.content?.[0]?.text || obj.result?.result || obj.result;
  return typeof content === 'string' ? JSON.parse(content) : content;
}

function todayStr() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString().slice(0, 10);
}

function n(v) {
  const x = Number(v || 0);
  return Number.isFinite(x) ? x : 0;
}

function keyTourId(v) {
  return v == null || v === '' ? '' : String(Number(v));
}

function normCode(v) {
  return String(v || '').trim().toUpperCase();
}

function localBk(orderId, bkgNo) {
  const raw = String(bkgNo || '').trim();
  if (raw) return raw.toUpperCase();
  return orderId ? `BK${String(orderId).padStart(6, '0')}` : '';
}

async function loadLocal(supabase) {
  const today = todayStr();
  const [pkgRes, orderRes] = await Promise.all([
    supabase.from('package_sales')
      .select('tour_id,tour_code,tour_name,departure_date,pax_total,sold_seat,revenue,synced_at')
      .gte('departure_date', today)
      .gt('pax_total', 0),
    supabase.from('package_orders')
      .select('order_id,tour_id,bkg_no,guest_num,infant,total_amount,deposit_amount,balance_amount,order_status'),
  ]);
  if (pkgRes.error) throw new Error(`package_sales: ${pkgRes.error.message}`);
  if (orderRes.error) throw new Error(`package_orders: ${orderRes.error.message}`);

  const ordersByTour = new Map();
  for (const o of orderRes.data || []) {
    if (!VALID_ORDER_STATUS.has(Number(o.order_status))) continue;
    if (!o.tour_id || n(o.guest_num) <= 0) continue;
    const k = keyTourId(o.tour_id);
    if (!ordersByTour.has(k)) ordersByTour.set(k, []);
    ordersByTour.get(k).push(o);
  }

  return (pkgRes.data || []).map(p => {
    const orders = ordersByTour.get(keyTourId(p.tour_id)) || [];
    const pax = orders.reduce((s, o) => s + n(o.guest_num), 0);
    const revenue = orders.reduce((s, o) => s + n(o.total_amount), 0);
    const paid = orders.reduce((s, o) => s + n(o.deposit_amount), 0);
    const balance = orders.reduce((s, o) => s + n(o.balance_amount), 0);
    return {
      source: 'ops',
      tour_id: Number(p.tour_id),
      tour_code: normCode(p.tour_code),
      tour_name: p.tour_name || '',
      departure_date: String(p.departure_date || '').slice(0, 10),
      order_count: orders.length,
      pax_total: n(p.pax_total),
      order_pax: pax,
      revenue: revenue || n(p.revenue),
      paid,
      balance,
      bks: orders.map(o => localBk(o.order_id, o.bkg_no)).filter(Boolean).slice(0, 6),
      synced_at: p.synced_at || '',
    };
  });
}

async function loadPlatform(limit) {
  const rowLimit = Math.max(50, Math.min(Number(limit) || DEFAULT_LIMIT, 1500));
  const sql = `
WITH valid_orders AS (
  SELECT
    o.order_id,
    COALESCE(NULLIF(o.payload->>'bkg_no',''), 'BK' || LPAD(o.order_id::text, 6, '0')) AS bkg_no,
    o.tour_code,
    NULLIF(o.payload->>'tour_name','') AS tour_name,
    (o.payload->>'tour_code_id')::bigint AS tour_id,
    LEFT(o.payload->>'departure_date', 10) AS departure_date,
    COALESCE((o.payload->>'guest_num')::numeric, 0) AS guest_num,
    COALESCE((o.payload->>'total_amount')::numeric, 0) AS total_amount,
    o.order_status,
    o.order_status_mapped
  FROM curated.orders o
  WHERE o.business_entity = 'wbt_id'
    AND o.order_status IN (1,2,3,4,8,9)
    AND LEFT(o.payload->>'departure_date', 10) >= TO_CHAR(current_date, 'YYYY-MM-DD')
),
receipt AS (
  SELECT order_id, SUM(received_amount) AS paid_amount
  FROM curated.id_order_payment_receipts
  GROUP BY order_id
),
agg AS (
  SELECT
    v.tour_id,
    v.tour_code,
    MIN(v.tour_name) AS tour_name,
    v.departure_date,
    COUNT(*) AS order_count,
    SUM(v.guest_num) AS pax,
    SUM(v.total_amount) AS revenue,
    SUM(COALESCE(r.paid_amount, 0)) AS paid,
    SUM(GREATEST(v.total_amount - COALESCE(r.paid_amount, 0), 0)) AS balance,
    COUNT(*) FILTER (WHERE r.paid_amount IS NULL) AS orders_without_receipts,
    ARRAY_AGG(v.bkg_no ORDER BY v.order_id) FILTER (WHERE v.bkg_no IS NOT NULL) AS bks
  FROM valid_orders v
  LEFT JOIN receipt r ON r.order_id = v.order_id
  GROUP BY v.tour_id, v.tour_code, v.departure_date
  HAVING SUM(v.guest_num) > 0
)
SELECT *
FROM agg
ORDER BY departure_date, tour_code
LIMIT ${rowLimit}`;

  const mcpRows = await callMcpTool('run_sql', { sql });
  const rows = (mcpRows.rows || []).map(r => ({
    source: 'data_platform',
    tour_id: Number(r.tour_id),
    tour_code: normCode(r.tour_code),
    tour_name: r.tour_name || '',
    departure_date: String(r.departure_date || '').slice(0, 10),
    order_count: n(r.order_count),
    pax: n(r.pax),
    revenue: n(r.revenue),
    paid: n(r.paid),
    balance: n(r.balance),
    orders_without_receipts: n(r.orders_without_receipts),
    bks: Array.isArray(r.bks) ? r.bks.slice(0, 6) : [],
  }));

  let departureCountdownRows = null;
  try {
    const probe = await callMcpTool('run_sql', {
      sql: 'SELECT COUNT(*)::int AS rows FROM semantic.departure_countdown',
    });
    departureCountdownRows = Number(probe.rows?.[0]?.rows || 0);
  } catch {
    departureCountdownRows = null;
  }

  return { rows, departureCountdownRows, raw: { row_count: mcpRows.row_count, truncated: mcpRows.truncated, elapsed_ms: mcpRows.elapsed_ms } };
}

function rowKey(r) {
  return keyTourId(r.tour_id) || `${normCode(r.tour_code)}|${String(r.departure_date || '').slice(0, 10)}`;
}

function compare(localRows, platformRows) {
  const localByKey = new Map(localRows.map(r => [rowKey(r), r]));
  const platformByKey = new Map(platformRows.map(r => [rowKey(r), r]));
  const keys = [...new Set([...localByKey.keys(), ...platformByKey.keys()])];
  const rows = [];

  for (const k of keys) {
    const l = localByKey.get(k) || null;
    const p = platformByKey.get(k) || null;
    const issues = [];
    if (!l) issues.push({ type: 'missing_ops', label: 'Missing in website DB' });
    if (!p) issues.push({ type: 'missing_platform', label: 'Missing in data platform' });
    if (l && p) {
      const paxDiff = n(l.order_pax || l.pax_total) - n(p.pax);
      const orderDiff = n(l.order_count) - n(p.order_count);
      const revenueDiff = n(l.revenue) - n(p.revenue);
      const paidDiff = n(l.paid) - n(p.paid);
      const balanceDiff = n(l.balance) - n(p.balance);
      if (String(l.departure_date || '') !== String(p.departure_date || '')) issues.push({ type: 'date', label: 'Departure date mismatch' });
      if (Math.abs(paxDiff) > 0) issues.push({ type: 'pax', label: `Pax diff ${paxDiff}` });
      if (Math.abs(orderDiff) > 0) issues.push({ type: 'orders', label: `Order diff ${orderDiff}` });
      if (Math.abs(revenueDiff) > 1) issues.push({ type: 'revenue', label: `Revenue diff ${Math.round(revenueDiff).toLocaleString('en-US')}` });
      if (Math.abs(paidDiff) > 1) issues.push({ type: 'paid', label: `Paid diff ${Math.round(paidDiff).toLocaleString('en-US')}` });
      if (Math.abs(balanceDiff) > 1) issues.push({ type: 'balance', label: `Balance diff ${Math.round(balanceDiff).toLocaleString('en-US')}` });
      if (n(p.orders_without_receipts) > 0) issues.push({ type: 'receipt_gap', label: `${p.orders_without_receipts} order no receipt` });
    }
    rows.push({
      key: k,
      tour_id: l?.tour_id || p?.tour_id || null,
      tour_code: l?.tour_code || p?.tour_code || '',
      tour_name: l?.tour_name || p?.tour_name || '',
      departure_date: l?.departure_date || p?.departure_date || '',
      ops: l,
      platform: p,
      issues,
    });
  }
  rows.sort((a, b) => String(a.departure_date).localeCompare(String(b.departure_date)) || String(a.tour_code).localeCompare(String(b.tour_code)));
  return rows;
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const supabase = serviceClient();
    const user = await requireUser(supabase, req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const limit = req.query?.limit || DEFAULT_LIMIT;
    const [localRows, platform] = await Promise.all([
      loadLocal(supabase),
      loadPlatform(limit),
    ]);
    const compared = compare(localRows, platform.rows);
    const issueRows = compared.filter(r => r.issues.length);

    return res.status(200).json({
      generated_at: new Date().toISOString(),
      scope: 'future Indonesian Skybear tours, valid orders only, pax > 0',
      warnings: [
        platform.departureCountdownRows === 0 ? 'semantic.departure_countdown currently returns 0 rows; comparison uses curated.orders payload + id_order_payment_receipts instead.' : null,
      ].filter(Boolean),
      totals: {
        ops_rows: localRows.length,
        platform_rows: platform.rows.length,
        compared_rows: compared.length,
        issue_rows: issueRows.length,
        missing_in_ops: compared.filter(r => r.issues.some(i => i.type === 'missing_ops')).length,
        missing_in_platform: compared.filter(r => r.issues.some(i => i.type === 'missing_platform')).length,
        pax_mismatch: compared.filter(r => r.issues.some(i => i.type === 'pax')).length,
        amount_mismatch: compared.filter(r => r.issues.some(i => ['revenue', 'paid', 'balance'].includes(i.type))).length,
        receipt_gap_rows: compared.filter(r => r.issues.some(i => i.type === 'receipt_gap')).length,
        departure_countdown_rows: platform.departureCountdownRows,
      },
      rows: compared,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
