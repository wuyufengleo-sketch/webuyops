// ============================================================================
//  POST /api/confirm-poll — near-real-time CS payment-confirmation trigger
//
//  Phase A of the "customer self-upload visa docs" project (see
//  docs/visa-doc-collection-project.md).
//
//  WHAT: Sales confirming an order in Skybear = the order's wt_order.order_status
//  reaching 3 (PARTIAL_PAID, deposit in) or 4 (FULL_PAID). Skybear has no
//  separate "cfm" field, so the paid-status transition IS the signal. OPS reads
//  Skybear directly over the read-only MySQL account, so we can detect this in
//  near-real-time instead of waiting for the daily full sync.
//
//  This endpoint, run every ~5 min by a GitHub Actions cron, scans upcoming
//  paid orders and auto-creates a PENDING payment_confirmations row for each one
//  that NEWLY reached paid status, then pings the CS Lark group with the
//  per-order confirmation links. CS opens each link, confirms destination /
//  package / pax / visa type, and the rest of the flow continues from there.
//
//  Seeding: the first ever run records the current backlog of paid orders as
//  "seen" WITHOUT creating confirmations or notifying — otherwise the initial
//  hundreds of already-paid orders would blast CS. Only orders that become paid
//  AFTER seeding generate a confirmation. (Same philosophy as _order-workflow.)
//
//  Auth (any one of):
//    • GitHub Actions / cron — x-sync-secret: <SYNC_SECRET>
//    • Vercel Cron           — Authorization: Bearer <CRON_SECRET>
//    • Logged-in UI          — Authorization: Bearer <supabase user access_token>
// ============================================================================

const mysql = require('mysql2/promise');
const { createClient } = require('@supabase/supabase-js');
const { selectAll } = require('./_db-util');

const PAID = '(3,4)';            // order_status: 3 PARTIAL_PAID, 4 FULL_PAID
const SEED_KEY = 'confirm_poll_seeded';
const SEEN_KEY = 'confirm_poll_seen_bkgs';

// Paid, upcoming orders + the tour fields a confirmation row needs. Mirrors the
// bkg_no derivation used by the main sync ('BK' + 6-digit order_id) so a row
// created here is identical to one created by the manual DP-Collection button.
const POLL_SQL = `
  SELECT
    o.id            AS order_id,
    o.tour_code_id  AS tour_id,
    t.tour_code     AS tour_code,
    t.tour_name     AS tour_name,
    t.departure_time AS departure_date,
    a.area_name     AS area_name,
    o.contact_name  AS contact_name,
    o.guest_num     AS guest_num,
    o.number_of_infant AS infant,
    o.order_status  AS order_status
  FROM wt_order o
  JOIN wt_tour t      ON o.tour_code_id = t.id
  LEFT JOIN wt_area a ON t.area_id      = a.id
  WHERE o.deleted_status = 0
    AND t.deleted_status = 0
    AND o.order_status IN ${PAID}
    AND t.departure_time >= CURDATE()`;

const bkgOf = (orderId) => 'BK' + String(orderId).padStart(6, '0');
const dateOnly = (v) => { if (v == null) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString().slice(0, 10); };
const dayMonth = (d) => { try { return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }); } catch { return '-'; } };

async function postLark(url, text) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msg_type: 'text', content: { text } }) });
    return r.ok;
  } catch { return false; }
}

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

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
          SKYBAR_MYSQL_HOST, SKYBAR_MYSQL_PORT, SKYBAR_MYSQL_USER,
          SKYBAR_MYSQL_PASS, SKYBAR_MYSQL_DB } = process.env;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'supabase_env_missing' });
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (!(await authorize(req, supabase))) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!SKYBAR_MYSQL_HOST) {
    return res.status(500).json({ error: 'skybar_env_missing' });
  }

  const appBase = (process.env.APP_BASE_URL || 'https://webuy-ops.vercel.app/app.html').replace(/#.*$/, '');

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

    const [rows] = await conn.query(POLL_SQL);
    const paid = (rows || []).map(r => ({
      order_id: r.order_id,
      bkg_no: bkgOf(r.order_id),
      tour_code: r.tour_code || null,
      tour_name: r.tour_name || null,
      departure_date: dateOnly(r.departure_date),
      destination: r.area_name || null,
      contact_name: r.contact_name || null,
      pax: (Number(r.guest_num) || 0) + (Number(r.infant) || 0),
    }));
    const paidBkgs = paid.map(p => p.bkg_no);

    // ---- seen-set + seed guard -------------------------------------------
    const { data: seedCfg } = await supabase.from('app_config').select('value').eq('key', SEED_KEY).maybeSingle();
    const seeded = !!(seedCfg && seedCfg.value);

    const { data: seenCfg } = await supabase.from('app_config').select('value').eq('key', SEEN_KEY).maybeSingle();
    let seen;
    try { seen = new Set(JSON.parse((seenCfg && seenCfg.value) || '[]')); }
    catch { seen = new Set(); }

    if (!seeded) {
      // Record the current backlog as already-seen; create nothing, notify no one.
      await supabase.from('app_config').upsert({ key: SEEN_KEY, value: JSON.stringify(paidBkgs) }, { onConflict: 'key' });
      await supabase.from('app_config').upsert({ key: SEED_KEY, value: '1' }, { onConflict: 'key' });
      return res.status(200).json({ seeded: true, scanned: paid.length, created: 0, notified: 0 });
    }

    // ---- find orders that NEWLY reached paid ------------------------------
    // Dedup against both the seen-set and any confirmation rows that already
    // exist (manual button / prior poll), so we never double-create.
    const { data: existRows } = await selectAll(
      () => supabase.from('payment_confirmations').select('bkg_no'), { order: 'id' });
    const haveConfirmation = new Set((existRows || []).map(r => String(r.bkg_no || '').toUpperCase()));

    const fresh = paid.filter(p =>
      !seen.has(p.bkg_no) && !haveConfirmation.has(p.bkg_no.toUpperCase()));

    let created = [];
    if (fresh.length) {
      const inserts = fresh.map(p => ({
        order_ref: null,
        bkg_no: p.bkg_no,
        tour_code: p.tour_code,
        tour_name: p.tour_name,
        departure_date: p.departure_date,
        contact_name: p.contact_name,
        destination: p.destination,
        pax_count: p.pax,
        created_by: null,
      }));
      const { data: ins, error: insErr } = await supabase
        .from('payment_confirmations').insert(inserts).select('id, bkg_no, tour_code, departure_date, contact_name, pax_count');
      if (insErr) throw new Error('payment_confirmations insert: ' + insErr.message);
      created = ins || [];
    }

    // The seen-set is bounded to the current upcoming-paid window: orders that
    // leave the window (departed / no longer paid) drop out, so app_config never
    // grows unbounded. Re-creation is still prevented by the existing-confirmation
    // dedup above, so dropping a bkg from the set can't cause a duplicate.
    await supabase.from('app_config').upsert({ key: SEEN_KEY, value: JSON.stringify(paidBkgs) }, { onConflict: 'key' });

    // ---- notify CS --------------------------------------------------------
    let notified = 0;
    if (created.length) {
      const { data: cfg } = await supabase.from('app_config').select('value').eq('key', 'lark_cs_url').maybeSingle();
      const url = cfg && cfg.value;
      if (url) {
        const lines = created.map(c =>
          `• ${dayMonth(c.departure_date)} · ${c.tour_code || '?'} · ${c.contact_name || '-'} · ${c.pax_count || 0}pax\n  ${appBase}#confirmpay=${c.id}`);
        const text =
          `<at user_id="all"></at>\n💳 New paid orders — please confirm for visa docs / Pesanan baru sudah bayar — mohon konfirmasi\n\n` +
          `${created.length} order(s):\n${lines.join('\n')}\n\n` +
          `→ Open each link, confirm destination / package / pax / visa type, then create the customer WhatsApp group.`;
        if (await postLark(url, text)) notified++;
      }
    }

    return res.status(200).json({ seeded: true, scanned: paid.length, created: created.length, notified });
  } catch (e) {
    return res.status(500).json({ error: 'confirm_poll_failed', detail: (e && e.message) || String(e) });
  } finally {
    if (conn) { try { await conn.end(); } catch {} }
  }
};
