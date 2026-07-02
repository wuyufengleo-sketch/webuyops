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
const { reconcileTicketingStatus } = require('./_ticketing-reconcile');
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
    op.passenger_remark      AS passenger_remark,
    op.meal                  AS meal
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
    // 'total_price' is NOT yet a column in package_sales (no DB DDL access to add it),
    // so we don't push it to the upsert payload. It stays on the in-memory `packages`
    // objects used by priceWatch for the OPS comparison block.
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
        const tc = norm(r.tour_code);
        // Lookup with fallback chain on a code-keyed map:
        //   1) exact tc
        //   2) tc with trailing "/26" stripped
        //   3) family stem (strip leading 2-digit month + trailing day digits)
        // So per-departure code 09WBFUNSHA02 can fall back to family WBFUNSHA
        // when Product hasn't entered prices for that specific departure yet.
        const codeFallback = (which) => {
          let v = which.get(tc) ?? null;
          if (v == null) v = which.get(tc.replace(/\/\d{2}$/, '')) ?? null;
          if (v == null) {
            const stem = tc.replace(/^\d{2}/, '').replace(/\/\d{2}$/, '').replace(/\d+$/, '');
            if (stem && stem.length >= 4) v = which.get(stem) ?? null;
          }
          return v;
        };
        // Build per-package basic/total via this precedence:
        //   1) Sheet tab keyed by TOUR CODE (byCode + code fallback chain)
        //   2) Sheet tab keyed by TOUR TYPE (fixed.basic_price / fixed.total_price)
        // That way tours whose tab uses TOUR TYPE (CHINA & JAPAN 2026,
        // FLASH TRIP WEBUY, CAHAYA ISLAMI) still get a basic/total price.
        const recByCode = prices.byCode
          ? (prices.byCode.get(tc)
             || prices.byCode.get(tc.replace(/\/\d{2}$/, ''))
             || (() => { const s = tc.replace(/^\d{2}/, '').replace(/\/\d{2}$/, '').replace(/\d+$/, ''); return s && s.length >= 4 ? prices.byCode.get(s) : null; })())
          : null;
        pkg.basic_price =
            (recByCode && recByCode.basic_price != null) ? recByCode.basic_price
          : (codeFallback(prices.byCodeBasic))
          ?? (fixed.basic_price ?? null);
        pkg.total_price =
            (recByCode && recByCode.total_price != null) ? recByCode.total_price
          : (fixed.total_price ?? null);
        // Layer the type-keyed add-ons last (visa/tipping/insurance/opt etc).
        for (const [f, v] of Object.entries(fixed)) {
          if (f === 'basic_price' || f === 'total_price') continue; // already handled
          pkg[f] = v;
        }
      }
      return pkg;
    });

    const orders = ordRows.map(r => ({
      id: 'ord-' + r.order_id,
      order_id: Number(r.order_id),
      tour_id: Number(r.tour_id),
      // ALWAYS derive the canonical "BK00xxxx" booking number from order_id,
      // ignoring Skybar's wt_order.bkg_no even when it has a value. Why:
      // skybar_passengers / ticketing_items / refunds / order_workflow all
      // derive their bkg_no from order_id with a fixed 6-digit pad. If we
      // accept Skybar's raw value here (which is empty 99.7% of the time but
      // occasionally non-empty with inconsistent padding), package_orders.bkg_no
      // will diverge from the rest of the schema and every BK→pax / BK→ticket
      // JOIN will silently miss. One source of truth wins.
      bkg_no: 'BK' + String(r.order_id).padStart(6, '0'),
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

    // Backward-compatible rollout: production package_sales may not have the
    // total_price / single_entry_visa columns until migration 029 is applied.
    // Without this guard, upserting these unknown columns makes PostgREST throw
    // (PGRST204) and kills the entire sync. Probe once; if absent, strip them
    // from the DB payload — they still live on the in-memory `packages` objects
    // that priceWatch uses for the OPS comparison block.
    const sheetPriceProbe = await supabase.from('package_sales').select('total_price, single_entry_visa').limit(1);
    if (sheetPriceProbe.error) {
      for (const p of packages) { delete p.total_price; delete p.single_entry_visa; }
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

    // Per-tour ticketing status reconcile — recompute every tour's row in
    // `ticketing` from ticketing_items so OPS doesn't need to click Confirm
    // Insert in the Sync Probe just to refresh stale "NOT BOOKED" badges.
    let ticketingStatus = null;
    try { ticketingStatus = await reconcileTicketingStatus(supabase); }
    catch (e) { ticketingStatus = { error: String((e && e.message) || e) }; }

    // Reconcile manifest_passengers against skybar_passengers (the Skybear hotel
    // rooming list) at the passenger level — NOT just seeding empty tours.
    //   • missing pax (in Skybear, not in manifest) → INSERT
    //   • matched pax → refresh Skybear-owned fields only (name/passport/dob/
    //     expiry/room/title); OP overlay columns (needs_visa, is_tour_leader,
    //     visa_* and the visa-checklist columns) are never in the payload, so an
    //     upsert leaves them untouched.
    //   • pax we previously seeded that vanished from Skybear → MARK
    //     not_in_skybar=true (never hard-delete; OP-added rows are left alone).
    // Matching key: our stable id ('mft-' || skybar id), else normalized
    // passport, else name+dob. Only in-scope BKs (those with an order this run)
    // are reconciled; a BK with no Skybear pax is never touched.
    let manifestSeed = null;
    try {
      const PAGE = 1000;
      // Does the mark column exist yet? (migration 042) — degrade gracefully.
      const flagProbe = await supabase.from('manifest_passengers').select('not_in_skybar').limit(1);
      const hasFlagCol = !flagProbe.error;
      const mftCols = 'id,bk,passport,name,dob,expiry,room,title,no' + (hasFlagCol ? ',not_in_skybar' : '');

      let allMft = [], mftFrom = 0;
      for (let s = 0; s < 40; s++) {
        const { data } = await supabase.from('manifest_passengers').select(mftCols).range(mftFrom, mftFrom + PAGE - 1);
        if (!data || !data.length) break;
        allMft.push(...data);
        if (data.length < PAGE) break;
        mftFrom += PAGE;
      }
      const tourCodeByTourId = new Map(packages.map(p => [p.tour_id, p.tour_code]));
      const ordersByBk = new Map(orders.map(o => [String(o.bkg_no || '').toUpperCase(), o]));

      let allSky = [], skyFrom = 0;
      for (let s = 0; s < 40; s++) {
        const { data } = await supabase.from('skybar_passengers').select('id,passenger_id,bkg_no,name,title,passport_no,birthday,expiry_date,room_type').range(skyFrom, skyFrom + PAGE - 1);
        if (!data || !data.length) break;
        allSky.push(...data);
        if (data.length < PAGE) break;
        skyFrom += PAGE;
      }

      const normPass = v => String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '');
      const normName = v => String(v == null ? '' : v).toUpperCase().replace(/\s+/g, ' ').trim();
      const ndKey    = (name, dob) => normName(name) + '|' + String(dob || '');
      const isSeededId = id => /^mft-(sky-|sbp-)/.test(String(id || ''));
      const SKY_FIELDS = ['title', 'name', 'passport', 'dob', 'expiry', 'room', 'tour_label'];

      const existingByBk = new Map();
      for (const m of allMft) {
        const bk = String(m.bk || '').toUpperCase();
        if (!bk) continue;
        if (!existingByBk.has(bk)) existingByBk.set(bk, []);
        existingByBk.get(bk).push(m);
      }
      const skyByBk = new Map();
      for (const p of allSky) {
        const bk = String(p.bkg_no || '').toUpperCase();
        if (!bk) continue;
        if (!skyByBk.has(bk)) skyByBk.set(bk, []);
        skyByBk.get(bk).push(p);
      }

      const upsertRows = [];        // inserts + changed updates
      const markRemovedIds = [];    // seeded rows that vanished from Skybear
      const touchedTours = new Set();
      let inserted = 0, updated = 0;

      for (const [bk, paxList] of skyByBk) {
        const ord = ordersByBk.get(bk);
        if (!ord) continue;                                   // out of scope this run
        const tourCode = tourCodeByTourId.get(ord.tour_id) || '';
        if (!tourCode) continue;

        const existing = existingByBk.get(bk) || [];
        const byId   = new Map(existing.map(r => [String(r.id), r]));
        const byPass = new Map();
        const byND   = new Map();
        for (const r of existing) {
          const p = normPass(r.passport); if (p && !byPass.has(p)) byPass.set(p, r);
          const nd = ndKey(r.name, r.dob); if (normName(r.name) && !byND.has(nd)) byND.set(nd, r);
        }
        const matchedIds = new Set();
        let ordinal = existing.length;

        for (const s of paxList) {
          const stableId = 'mft-' + s.id;
          const p = normPass(s.passport_no);
          const nd = ndKey(s.name, s.birthday);
          let row = byId.get(stableId) || (p && byPass.get(p)) || (normName(s.name) && byND.get(nd)) || null;

          const skyVals = {
            tour_label: tourCode,
            title: s.title || '',
            name: s.name || '',
            bk: bk,
            passport: s.passport_no || '',
            dob: s.birthday || '',
            expiry: s.expiry_date || '',
            room: s.room_type || '',
          };

          if (row) {
            matchedIds.add(String(row.id));
            const changed = SKY_FIELDS.some(k => String(row[k] == null ? '' : row[k]) !== String(skyVals[k]));
            const wasMarked = hasFlagCol && row.not_in_skybar === true;
            if (changed || wasMarked) {
              upsertRows.push({ id: row.id, ...skyVals, ...(hasFlagCol ? { not_in_skybar: false } : {}) });
              updated++;
              touchedTours.add(tourCode);
            }
          } else {
            upsertRows.push({ id: stableId, no: String(++ordinal), ...skyVals, ...(hasFlagCol ? { not_in_skybar: false } : {}) });
            inserted++;
            touchedTours.add(tourCode);
          }
        }

        // Rows we previously seeded that are no longer in Skybear → mark, don't delete.
        if (hasFlagCol) {
          for (const r of existing) {
            if (matchedIds.has(String(r.id))) continue;
            if (!isSeededId(r.id)) continue;              // never touch OP-added rows
            if (r.not_in_skybar === true) continue;       // already flagged
            markRemovedIds.push(r.id);
            touchedTours.add(tourCode);
          }
        }
      }

      if (upsertRows.length) await upsertAll('manifest_passengers', upsertRows);
      let marked = 0;
      if (hasFlagCol && markRemovedIds.length) {
        for (let i = 0; i < markRemovedIds.length; i += 500) {
          const chunk = markRemovedIds.slice(i, i + 500);
          const { error } = await supabase.from('manifest_passengers').update({ not_in_skybar: true }).in('id', chunk);
          if (error) throw new Error(`mark not_in_skybar: ${error.message}`);
          marked += chunk.length;
        }
      }
      manifestSeed = { inserted, updated, marked, tours: touchedTours.size, flagCol: hasFlagCol };
    } catch (e) {
      manifestSeed = { error: String((e && e.message) || e) };
    }

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
          `📦 ${packages.length} tours · ${orders.length} orders · pax=${passengerSync.upserted || 0}/${passengers.length} · manifest=${manifestSeed && !manifestSeed.error ? `+${manifestSeed.inserted||0}/~${manifestSeed.updated||0}/⚑${manifestSeed.marked||0}` : (manifestSeed && manifestSeed.error ? 'err' : '-')} · prices=${prices.ok?'ok':'skipped'}`,
          `📊 workflow: ${fmtR(workflow)}`,
          `🤖 auto-status: ${fmtR(workflowAutoStatus)}`,
          `💴 vendor: ${fmtR(vendorAlerts)} · refund: ${fmtR(refundAlerts)}`,
          `⚖️ balance: ${fmtR(balanceAlerts)} · tl: ${fmtR(tlAlerts)}`,
          `🎫 ticketing: ${fmtR(ticketingAlerts)} · 🛂 visa: ${fmtR(visaAlerts)}`,
          `📱 bk-groups: ${fmtR(bkGroupAlerts)}`,
          `💼 pnl: ${fmtR(tourPnl)} · 🎟️ tkt-status: ${fmtR(ticketingStatus)}`,
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
      manifestSeed,
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
      ticketingStatus,
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
