// ============================================================================
//  POST /api/sync-skybar — Skybar (Indonesia) production MySQL → Supabase sync
//
//  Reads the Skybar `webuy_tourt` DB (read-only account), aggregates per-package
//  sales (wt_tour + wt_order) and order detail, then upserts into the Supabase
//  `package_sales` / `package_orders` tables using the service_role key.
//
//  Scope: wt_tour.departure_time >= NOW() - 30 days.
//
//  Auth (any one of):
//    • Vercel Cron  — Authorization: Bearer <CRON_SECRET>
//    • Manual/local — x-sync-secret: <SYNC_SECRET>
//    • Logged-in UI — Authorization: Bearer <supabase user access_token>
//
//  Secrets live ONLY in env vars (Vercel + local .env), never in the repo or
//  the browser bundle.
// ============================================================================

const mysql = require('mysql2/promise');
const { createClient } = require('@supabase/supabase-js');
const { loadSheetPrices, TYPE_FIELDS } = require('./_sheet-prices');

const SCOPE_DAYS = 30;

// 有效订单（计入 Booked/汇总）的 order_status：
//   1待完善 2未收款 3收款中 4已收款 8超额收款 9已关闭
// 排除：5已转团 6退款中 7已退款 10已取消
const VALID = 'o.order_status IN (1,2,3,4,8,9)';

const PACKAGE_SQL = `
  SELECT
    t.id                              AS tour_id,
    t.tour_code                       AS tour_code,
    t.tour_name                       AS tour_name,
    tt.type_name                      AS tour_type,
    tt.type_code                      AS type_code,
    a.area_name                       AS area_name,
    t.departure_time                  AS departure_date,
    t.return_time                     AS return_date,
    t.travel_days                     AS travel_days,
    t.inventory_num                   AS total_seat,
    t.query_price                     AS query_price,
    t.tr_status                       AS tr_status,
    t.closed_status                   AS closed_status,
    t.tour_status                     AS tour_status,
    COALESCE(SUM(CASE WHEN ${VALID} THEN 1 ELSE 0 END),0)                            AS order_count,
    COALESCE(SUM(CASE WHEN ${VALID} THEN o.guest_num + o.number_of_infant ELSE 0 END),0) AS sold_seat,
    COALESCE(SUM(CASE WHEN ${VALID} THEN o.guest_num ELSE 0 END),0)                  AS pax_total,
    COALESCE(SUM(CASE WHEN ${VALID} THEN o.number_of_infant ELSE 0 END),0)           AS infant_total,
    COALESCE(SUM(CASE WHEN ${VALID} THEN o.total_amount ELSE 0 END),0)               AS revenue
  FROM wt_tour t
  LEFT JOIN wt_order     o  ON o.tour_code_id = t.id AND o.deleted_status = 0
  LEFT JOIN wt_tour_type tt ON t.tour_type_id = tt.id
  LEFT JOIN wt_area      a  ON t.area_id      = a.id
  WHERE t.deleted_status = 0
    AND t.departure_time >= DATE_SUB(NOW(), INTERVAL ${SCOPE_DAYS} DAY)
  GROUP BY t.id`;

const ORDER_SQL = `
  SELECT
    o.id                AS order_id,
    o.tour_code_id      AS tour_id,
    o.bkg_no            AS bkg_no,
    o.order_date        AS order_date,
    o.order_status      AS order_status,
    o.contact_name      AS contact_name,
    o.contact_no        AS contact_no,
    o.guest_num         AS guest_num,
    o.number_of_infant  AS infant,
    o.total_amount      AS total_amount,
    o.deposit_amount    AS deposit_amount,
    o.balance_amount    AS balance_amount,
    o.refund_amount     AS refund_amount,
    u.user_name         AS salesman,
    o.lead_source       AS lead_source
  FROM wt_order o
  JOIN wt_tour t      ON o.tour_code_id = t.id
  LEFT JOIN wt_user u ON o.salesman_id  = u.id
  WHERE o.deleted_status = 0
    AND t.deleted_status = 0
    AND t.departure_time >= DATE_SUB(NOW(), INTERVAL ${SCOPE_DAYS} DAY)`;

function num(v) { return v == null ? null : Number(v); }
function int(v) { return v == null ? 0 : parseInt(v, 10) || 0; }

async function authorize(req, supabase) {
  const cronSecret = process.env.CRON_SECRET;
  const syncSecret = process.env.SYNC_SECRET;
  const auth = req.headers['authorization'] || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';

  if (cronSecret && bearer && bearer === cronSecret) return true;           // Vercel cron
  if (syncSecret && req.headers['x-sync-secret'] === syncSecret) return true; // manual/local
  if (bearer) {                                                              // logged-in UI
    const { data, error } = await supabase.auth.getUser(bearer);
    if (!error && data && data.user) return true;
  }
  return false;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
          SKYBAR_MYSQL_HOST, SKYBAR_MYSQL_PORT, SKYBAR_MYSQL_USER,
          SKYBAR_MYSQL_PASS, SKYBAR_MYSQL_DB } = process.env;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Supabase env vars missing' });
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (!(await authorize(req, supabase))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let conn;
  try {
    conn = await mysql.createConnection({
      host: SKYBAR_MYSQL_HOST,
      port: Number(SKYBAR_MYSQL_PORT) || 3306,
      user: SKYBAR_MYSQL_USER,
      password: SKYBAR_MYSQL_PASS,
      database: SKYBAR_MYSQL_DB || 'webuy_tourt',
      connectTimeout: 15000,
    });

    const [pkgRows] = await conn.query(PACKAGE_SQL);
    const [ordRows] = await conn.query(ORDER_SQL);

    const runTs = new Date().toISOString();

    // Google-Sheet 价格拆分：成功才合并；失败则整体跳过（保留既有 enrichment，不清空）。
    const prices = await loadSheetPrices();
    const ENRICH = ['basic_price', ...new Set(Object.values(TYPE_FIELDS))];
    const norm = s => String(s == null ? '' : s).trim().toUpperCase().replace(/\s+/g, ' ');

    const packages = pkgRows.map(r => {
      const total = int(r.total_seat), sold = int(r.sold_seat);
      const pkg = {
        id: 'wt-' + r.tour_id,
        tour_id: Number(r.tour_id),
        tour_code: r.tour_code,
        tour_name: r.tour_name,
        tour_type: r.tour_type,
        area_name: r.area_name,
        region: r.area_name,
        departure_date: r.departure_date,
        return_date: r.return_date,
        travel_days: int(r.travel_days),
        total_seat: total,
        sold_seat: sold,
        seat_left: total - sold,
        order_count: int(r.order_count),
        pax_total: int(r.pax_total),
        infant_total: int(r.infant_total),
        revenue: num(r.revenue),
        query_price: num(r.query_price),
        tr_status: r.tr_status == null ? null : int(r.tr_status),
        closed_status: r.closed_status == null ? null : int(r.closed_status),
        tour_status: r.tour_status == null ? null : int(r.tour_status),
        synced_at: runTs,
      };
      if (prices.ok) {
        // 统一附加全部 enrichment 键（无匹配则 null），保证批内 payload 列一致。
        const fixed = prices.byType.get(norm(r.type_code)) || {};
        for (const f of ENRICH) pkg[f] = null;
        pkg.basic_price = prices.byCodeBasic.get(norm(r.tour_code)) ?? null;
        for (const [f, v] of Object.entries(fixed)) pkg[f] = v;
      }
      return pkg;
    });

    const orders = ordRows.map(r => ({
      id: 'ord-' + r.order_id,
      order_id: Number(r.order_id),
      tour_id: Number(r.tour_id),
      bkg_no: r.bkg_no || null,
      order_date: r.order_date,
      order_status: r.order_status == null ? null : int(r.order_status),
      contact_name: r.contact_name,
      contact_no: r.contact_no,
      guest_num: int(r.guest_num),
      infant: int(r.infant),
      total_amount: num(r.total_amount),
      deposit_amount: num(r.deposit_amount),
      balance_amount: num(r.balance_amount),
      refund_amount: num(r.refund_amount),
      salesman: r.salesman,
      lead_source: r.lead_source,
      synced_at: runTs,
    }));

    async function upsertAll(table, rows) {
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const { error } = await supabase.from(table).upsert(chunk, { onConflict: 'id' });
        if (error) throw new Error(`[${table}] upsert failed: ${error.message}`);
      }
    }

    await upsertAll('package_sales', packages);
    await upsertAll('package_orders', orders);

    // Prune rows that fell out of scope (cancelled / moved / past 30-day window):
    // delete anything not touched by this run (synced_at older than this run's stamp).
    const { error: delP } = await supabase.from('package_sales').delete().lt('synced_at', runTs);
    if (delP) throw new Error(`prune package_sales: ${delP.message}`);
    const { error: delO } = await supabase.from('package_orders').delete().lt('synced_at', runTs);
    if (delO) throw new Error(`prune package_orders: ${delO.message}`);

    return res.status(200).json({
      ok: true,
      packages: packages.length,
      orders: orders.length,
      pricesApplied: prices.ok,
      ts: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message || e) });
  } finally {
    if (conn) try { await conn.end(); } catch (_) {}
  }
};
