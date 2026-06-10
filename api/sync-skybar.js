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
const { reconcileWorkflow, reconcileWorkflowStatuses } = require('./_order-workflow');
const { reconcileVendorPayments, reconcileRefunds } = require('./_vendor-refund');
const { reconcileBalanceAlerts } = require('./_balance-alerts');
const { reconcileTlOutputAlerts } = require('./_tl-alerts');
const { reconcileTicketingAlerts, reconcileVisaAlerts } = require('./_ticketing-visa-alerts');
const { reconcileBkGroupAlerts } = require('./_bk-group-alerts');
const { reconcileTourPnl } = require('./_tour-pnl');
const { validateSyncHealth, healthHeartbeatBlock } = require('./_health');
const { detectLowPriceOrders, priceWatchHeartbeatLine, priceWatchDetailBlock, priceWatchFullBlock } = require('./_price-watch');

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

// Skybar's wt_order.deposit_amount is unpopulated (99.7% = 0) and
// balance_amount is unreliable. The real source of truth for received money
// is wt_order_payment_receipt.received_amount. We overwrite deposit_amount
// with the actual paid total, and recompute balance_amount = total - paid,
// so every downstream consumer (UI, ticketing alerts, balance recon) reads
// correct values without code changes.
const ORDER_SQL = `
  SELECT
    o.id                                                      AS order_id,
    o.tour_code_id                                            AS tour_id,
    o.bkg_no                                                  AS bkg_no,
    o.order_date                                              AS order_date,
    o.order_status                                            AS order_status,
    o.contact_name                                            AS contact_name,
    o.contact_no                                              AS contact_no,
    o.guest_num                                               AS guest_num,
    o.number_of_infant                                        AS infant,
    o.total_amount                                            AS total_amount,
    pr.first_payment_date                                     AS order_first_payment_date,
    COALESCE(pr.paid_total, 0)                                AS deposit_amount,
    o.total_amount - COALESCE(pr.paid_total, 0)               AS balance_amount,
    o.refund_amount                                           AS refund_amount,
    u.user_name                                               AS salesman,
    o.lead_source                                             AS lead_source
  FROM wt_order o
  JOIN wt_tour t      ON o.tour_code_id = t.id
  LEFT JOIN wt_user u ON o.salesman_id  = u.id
  LEFT JOIN (
    SELECT
      order_id,
      SUM(received_amount) AS paid_total,
      MIN(COALESCE(rept_date, DATE(create_on))) AS first_payment_date
    FROM wt_order_payment_receipt
    GROUP BY order_id
  ) pr ON pr.order_id = o.id
  WHERE o.deleted_status = 0
    AND t.deleted_status = 0
    AND t.departure_time >= DATE_SUB(NOW(), INTERVAL ${SCOPE_DAYS} DAY)`;

// Skybar's wt_order_passenger holds passport / DOB / photo for every guest
// across ALL tours (~10.5K rows). We mirror the full table on every run so
// the Visa drill-down has historical access too (per user's explicit choice).
// 60s Vercel maxDuration is more than enough: 10K rows in 500-batch upserts
// completes in ~5s.
const PASSENGER_SQL = `
  SELECT
    op.id                    AS sb_id,
    op.order_id              AS order_id,
    op.passenger_id          AS passenger_id,
    op.passenger_name        AS name,
    op.title                 AS title,
    op.passport_no           AS passport_no,
    op.gender                AS gender,
    op.birthday              AS birthday,
    op.nationality           AS nationality,
    op.issue_date            AS issue_date,
    op.expiry_date           AS expiry_date,
    op.passenger_phone       AS phone,
    op.room_type             AS room_type,
    op.photo_url             AS photo_url,
    op.upload_passport_time  AS upload_passport_time,
    op.passenger_status      AS passenger_status,
    op.passenger_remark      AS passenger_remark
  FROM wt_order_passenger op`;

function num(v) { return v == null ? null : Number(v); }
function int(v) { return v == null ? 0 : parseInt(v, 10) || 0; }
function dateOnly(v) { if (v == null) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString().slice(0, 10); }
function dt(v) { if (v == null) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString(); }

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

  // Health-check first: probes required tables + config keys in parallel.
  // We still run sync even if degraded (each reconciler catches its own
  // errors), but the heartbeat will lead with the failure so admin notices.
  let health = null;
  try { health = await validateSyncHealth(supabase); }
  catch (e) { health = { ok: false, error: String((e && e.message) || e) }; }

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
    let paxRows = [];
    let passengerSync = { skipped: 'not run' };
    const passengerTableProbe = await supabase.from('skybar_passengers').select('id').limit(1);
    if (passengerTableProbe.error) {
      passengerSync = { skipped: `skybar_passengers unavailable: ${passengerTableProbe.error.message}` };
    } else {
      try {
        [paxRows] = await conn.query(PASSENGER_SQL);
        passengerSync = { fetched: paxRows.length };
      } catch (e) {
        passengerSync = { error: `fetch passengers: ${String((e && e.message) || e)}` };
      }
    }

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
      // wt_order.bkg_no is empty in Skybar — derive the canonical "BK00xxxx"
      // booking number from the numeric id so it matches the CS Sheet, refund
      // dedup, and Lark digests.
      bkg_no: (r.bkg_no && String(r.bkg_no).trim()) || ('BK' + String(r.order_id).padStart(6, '0')),
      order_date: r.order_date,
      order_first_payment_date: r.order_first_payment_date || null,
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

    // Backward-compatible rollout: production package_orders may not have the
    // first-payment column until migration 023 is applied. Keep sync healthy
    // by omitting the field when the column is not present.
    const firstPaymentProbe = await supabase.from('package_orders').select('order_first_payment_date').limit(1);
    if (firstPaymentProbe.error) {
      for (const o of orders) delete o.order_first_payment_date;
    }

    async function upsertAll(table, rows) {
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const { error } = await supabase.from(table).upsert(chunk, { onConflict: 'id' });
        if (error) throw new Error(`[${table}] upsert failed: ${error.message}`);
      }
    }

    const passengers = paxRows.map(r => ({
      id: 'sbp-' + r.sb_id,
      order_id: Number(r.order_id),
      bkg_no: 'BK' + String(r.order_id).padStart(6, '0'),
      passenger_id: r.passenger_id == null ? null : Number(r.passenger_id),
      name: r.name,
      title: r.title,
      passport_no: r.passport_no,
      gender: r.gender,
      birthday: dateOnly(r.birthday),
      nationality: r.nationality,
      issue_date: dateOnly(r.issue_date),
      expiry_date: dateOnly(r.expiry_date),
      phone: r.phone,
      room_type: r.room_type,
      photo_url: r.photo_url,
      upload_passport_time: dt(r.upload_passport_time),
      passenger_status: r.passenger_status == null ? null : int(r.passenger_status),
      passenger_remark: r.passenger_remark,
      synced_at: runTs,
    }));

    await upsertAll('package_sales', packages);
    await upsertAll('package_orders', orders);
    let passengerTableReady = false;
    if (passengers.length) {
      try {
        await upsertAll('skybar_passengers', passengers);
        passengerTableReady = true;
        passengerSync = { ...passengerSync, upserted: passengers.length };
      } catch (e) {
        passengerSync = { ...passengerSync, error: `upsert skybar_passengers: ${String((e && e.message) || e)}` };
      }
    }

    // Cross-team order workflow board: detect new/changed orders, push Lark.
    // Wrapped so a failure here never breaks the core sync (board catches up next run).
    let workflow = null, workflowAutoStatus = null;
    try {
      workflow = await reconcileWorkflow(supabase, orders, packages);
    } catch (e) {
      workflow = { error: String((e && e.message) || e) };
    }
    // Phase 2: auto-derive *_status from upstream tables (only un-edited cells).
    try {
      workflowAutoStatus = await reconcileWorkflowStatuses(supabase);
    } catch (e) {
      workflowAutoStatus = { error: String((e && e.message) || e) };
    }

    // Vendor Payment / Refund Tracking auto-row + Lark digests (Sprint 8 batch 3).
    let vendorAlerts = null, refundAlerts = null, balanceAlerts = null;
    try { vendorAlerts = await reconcileVendorPayments(supabase, packages); }
    catch (e) { vendorAlerts = { error: String((e && e.message) || e) }; }
    try { refundAlerts = await reconcileRefunds(supabase, orders); }
    catch (e) { refundAlerts = { error: String((e && e.message) || e) }; }
    // Balance recon (Sheet ↔ Skybar) — silent-seed first run, weekly cooldown.
    try { balanceAlerts = await reconcileBalanceAlerts(supabase); }
    catch (e) { balanceAlerts = { error: String((e && e.message) || e) }; }
    // TL Output pre-departure reminders — H-14 / H-7 to lark_tl_url.
    let tlAlerts = null;
    try { tlAlerts = await reconcileTlOutputAlerts(supabase); }
    catch (e) { tlAlerts = { error: String((e && e.message) || e) }; }
    // Ticketing + Visa H-14 / H-7 reminders (Sprint 11 #A).
    let ticketingAlerts = null, visaAlerts = null;
    try { ticketingAlerts = await reconcileTicketingAlerts(supabase, packages, orders); }
    catch (e) { ticketingAlerts = { error: String((e && e.message) || e) }; }
    try { visaAlerts = await reconcileVisaAlerts(supabase); }
    catch (e) { visaAlerts = { error: String((e && e.message) || e) }; }
    // BK Group Phase 3 — daily 24h-no-group nag to CS.
    let bkGroupAlerts = null;
    try { bkGroupAlerts = await reconcileBkGroupAlerts(supabase); }
    catch (e) { bkGroupAlerts = { error: String((e && e.message) || e) }; }

    // Per-tour PnL ledger — refresh Skybar-side numbers (revenue / received /
    // pax / est_cost). Manual fields (land_cost / flight_cost / confirmed) are
    // preserved by the upsert. Migration 023 must be applied; if not, the
    // reconciler degrades gracefully.
    let tourPnl = null;
    try { tourPnl = await reconcileTourPnl(supabase, conn, packages, orders); }
    catch (e) { tourPnl = { error: String((e && e.message) || e) }; }

    // Prune rows that fell out of scope (cancelled / moved / past 30-day window):
    // delete anything not touched by this run (synced_at older than this run's stamp).
    const { error: delP } = await supabase.from('package_sales').delete().lt('synced_at', runTs);
    if (delP) throw new Error(`prune package_sales: ${delP.message}`);
    const { error: delO } = await supabase.from('package_orders').delete().lt('synced_at', runTs);
    if (delO) throw new Error(`prune package_orders: ${delO.message}`);
    if (passengerTableReady) {
      const { error: delPax } = await supabase.from('skybar_passengers').delete().lt('synced_at', runTs);
      if (delPax) passengerSync = { ...passengerSync, pruneError: delPax.message };
      else passengerSync = { ...passengerSync, pruned: true };
    }

    // Price-watch — flag any order created in the last 24h whose actual
    // per-pax price dipped below the Sheet's BASIC PRICE. Pure function on
    // packages+orders we already have; never throws.
    let priceWatch = null;
    try {
      priceWatch = detectLowPriceOrders({ packages, orders, windowHours: 24 });
    } catch (e) {
      priceWatch = { ok: false, reason: String((e && e.message) || e) };
    }

    // Heartbeat — posts a one-line summary to lark_admin_url every sync so
    // the team can tell at a glance whether the cron is alive even when no
    // business-channel digest fires. Skips silently if the key isn't set.
    let heartbeat = null;
    try {
      const { data: cfgRow } = await supabase.from('app_config').select('value').eq('key', 'lark_admin_url').maybeSingle();
      const url = cfgRow && cfgRow.value;
      if (url) {
        const fmtR = r => r && r.error ? `❌ ${r.error.slice(0,40)}` : r ? Object.entries(r).filter(([k])=>!/error/i.test(k)).map(([k,v])=>`${k}=${v}`).join(' ') : '-';
        const healthBlock = healthHeartbeatBlock(health);
        const headIcon = health && health.ok ? '✅' : '⚠️';
        const priceLine = priceWatchHeartbeatLine(priceWatch);
        const priceDetail = priceWatchDetailBlock(priceWatch);
        const priceFull   = priceWatchFullBlock(priceWatch, 60);
        const lines = [
          ...(healthBlock ? [healthBlock, ''] : []),
          `${headIcon} Webuy OPS sync · ${new Date().toISOString().replace('T',' ').slice(0,16)} UTC`,
          `📦 ${packages.length} tours · ${orders.length} orders · pax=${passengerSync.upserted || 0}/${passengers.length} · prices=${prices.ok?'ok':'skipped'}`,
          `📊 workflow: ${fmtR(workflow)}`,
          `🤖 auto-status: ${fmtR(workflowAutoStatus)}`,
          `💴 vendor: ${fmtR(vendorAlerts)} · refund: ${fmtR(refundAlerts)}`,
          `⚖️ balance: ${fmtR(balanceAlerts)} · tl: ${fmtR(tlAlerts)}`,
          `🎫 ticketing: ${fmtR(ticketingAlerts)} · 🛂 visa: ${fmtR(visaAlerts)}`,
          `📱 bk-groups: ${fmtR(bkGroupAlerts)}`,
          `💼 pnl: ${fmtR(tourPnl)}`,
          priceLine,
          ...(priceDetail ? [priceDetail] : []),
          ...(priceFull ? ['', priceFull] : []),
        ];
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msg_type: 'text', content: { text: lines.join('\n') } }) });
        heartbeat = { ok: r.ok, status: r.status };
      } else {
        heartbeat = { skipped: 'lark_admin_url not configured' };
      }
    } catch (e) {
      heartbeat = { error: String((e && e.message) || e) };
    }

    return res.status(200).json({
      ok: true,
      packages: packages.length,
      orders: orders.length,
      passengers: passengers.length,
      passengerSync,
      pricesApplied: prices.ok,
      workflow,
      workflowAutoStatus,
      vendorAlerts,
      refundAlerts,
      balanceAlerts,
      tlAlerts,
      ticketingAlerts,
      visaAlerts,
      bkGroupAlerts,
      tourPnl,
      priceWatch: priceWatch && priceWatch.ok
        ? { scanned: priceWatch.scanned, withBasic: priceWatch.withBasic, flaggedCount: priceWatch.flagged.length, flagged: priceWatch.flagged.slice(0, 50) }
        : priceWatch,
      heartbeat,
      health,
      ts: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message || e) });
  } finally {
    if (conn) try { await conn.end(); } catch (_) {}
  }
};
