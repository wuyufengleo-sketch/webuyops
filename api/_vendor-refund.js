// Vendor Payment + Refund reconcilers — called by api/sync-skybar.js after the
// package_sales / package_orders upsert. Auto-creates shell rows so OPS doesn't
// have to add every new tour / refund order manually, and fires throttled Lark
// digests (≤1 per row per 7 days):
//   • Vendor Payment: tour departing within 14 days, status ≠ DONE/PAID
//     → lark_ops_url (Operation 群)
//   • Refund Tracking: over_due > 0, status ≠ DONE → lark_cs_url (CS 群)
//
// Silent-seed on the FIRST run (per-reconciler flag in app_config): all current
// rows get alerted_at=now() so the historical backlog never blasts Lark.

const VP_SEED_KEY = 'sprint8_vendor_alerts_seeded';
const RF_SEED_KEY = 'sprint8_refund_alerts_seeded';
const ALERT_COOLDOWN_MS = 7 * 24 * 3600 * 1000;
const VENDOR_HORIZON_DAYS = 14;
const REFUND_STATUSES = new Set([6, 7]);  // 6=退款中 7=已退款

const isVpDone = s => /DONE|PAID/i.test(s || '');
const isRfDone = s => /DONE/i.test(s || '');
const norm = s => String(s == null ? '' : s).trim().toUpperCase();

function isoDate(d) { try { return new Date(d).toISOString().slice(0, 10); } catch { return ''; } }
function parseFlex(s) {
  if (!s) return null;
  // ISO YYYY-MM-DD
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  // D/M/YYYY
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  return null;
}
async function postLark(url, text) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text } }) });
    return r.ok;
  } catch { return false; }
}
async function getCfg(supabase, key) {
  const { data } = await supabase.from('app_config').select('value').eq('key', key).maybeSingle();
  return data ? data.value : '';
}
async function setSeed(supabase, key) {
  await supabase.from('app_config').upsert({ key, value: '1' }, { onConflict: 'key' });
}

async function reconcileVendorPayments(supabase, packages) {
  // 1) Auto-create shells for not-canceled tours that don't have any vendor_payments row yet.
  const valid = packages.filter(p => p.tr_status !== 3 && p.tour_code);
  const { data: existRows, error: exErr } = await supabase
    .from('vendor_payments').select('id, tourcode, dept_date, status, alerted_at');
  if (exErr) throw new Error('vendor_payments read: ' + exErr.message);
  const exist = existRows || [];
  const haveCode = new Set(exist.map(r => norm(r.tourcode)).filter(Boolean));

  const nowIso = new Date().toISOString();
  const seeded = !!(await getCfg(supabase, VP_SEED_KEY));

  const shells = [];
  for (const p of valid) {
    if (haveCode.has(norm(p.tour_code))) continue;
    shells.push({
      id: 'vp-auto-' + p.tour_id,
      region: p.area_name || '',
      tourcode: p.tour_code,
      dept_date: p.departure_date ? isoDate(p.departure_date) : '',
      total_pax: String((p.pax_total || 0) + (p.infant_total || 0)),
      alerted_at: seeded ? null : nowIso,
    });
  }
  if (shells.length) {
    for (let i = 0; i < shells.length; i += 500) {
      const { error } = await supabase.from('vendor_payments').insert(shells.slice(i, i + 500));
      if (error) throw new Error('vendor_payments insert: ' + error.message);
    }
  }

  // 2) First-ever run: stamp every existing row + skip alert.
  if (!seeded) {
    const ids = exist.map(r => r.id);
    for (let i = 0; i < ids.length; i += 500) {
      await supabase.from('vendor_payments').update({ alerted_at: nowIso }).in('id', ids.slice(i, i + 500));
    }
    await setSeed(supabase, VP_SEED_KEY);
    return { created: shells.length, seeded: true, alerted: 0 };
  }

  // 3) Alert pass: dept_date within next 14 days, status ≠ DONE, cooldown ≥7 days.
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const horizon = new Date(today); horizon.setDate(today.getDate() + VENDOR_HORIZON_DAYS);
  const allRows = exist.concat(shells.map(s => ({ ...s, status: null })));
  const due = [];
  for (const r of allRows) {
    if (isVpDone(r.status)) continue;
    const d = parseFlex(r.dept_date);
    if (!d || d < today || d > horizon) continue;
    if (r.alerted_at && (Date.now() - new Date(r.alerted_at).getTime()) < ALERT_COOLDOWN_MS) continue;
    due.push(r);
  }
  let alerted = 0;
  if (due.length) {
    const url = await getCfg(supabase, 'lark_ops_url');
    if (url) {
      const lines = due.slice(0, 25).map(r => {
        const days = Math.round((parseFlex(r.dept_date) - today) / 86400000);
        return `• ${r.tourcode || '?'} | ${r.region || '-'} | Dep ${r.dept_date || '-'} (${days}d) | Pax ${r.total_pax || '-'} | Status: ${r.status || '—'}`;
      }).join('\n');
      const extra = due.length > 25 ? `\n…and ${due.length - 25} more` : '';
      const text =
        `<at user_id="all"></at>\n💴 Vendor Payment Alert / Pengingat Pembayaran Vendor\n\n` +
        `🚨 H-14 unpaid invoices (${due.length}):\n${lines}${extra}\n\n` +
        `→ EN: Please process the vendor invoice before departure.\n` +
        `→ ID: Mohon proses invoice vendor sebelum keberangkatan.`;
      if (await postLark(url, text)) alerted = due.length;
    }
    const ids = due.map(r => r.id);
    for (let i = 0; i < ids.length; i += 500) {
      await supabase.from('vendor_payments').update({ alerted_at: nowIso }).in('id', ids.slice(i, i + 500));
    }
  }
  return { created: shells.length, seeded: true, alerted };
}

async function reconcileRefunds(supabase, orders) {
  // 1) Auto-create shells for orders in status 6/7 without a refund row matching bk OR auto id.
  const refundOrders = orders.filter(o => REFUNDS_status(o));
  const { data: existRows, error: exErr } = await supabase
    .from('refunds').select('id, bk, over_due, status, alerted_at');
  if (exErr) throw new Error('refunds read: ' + exErr.message);
  const exist = existRows || [];
  const existIds = new Set(exist.map(r => r.id));
  const haveBk = new Set(exist.map(r => norm(r.bk)).filter(Boolean));

  const nowIso = new Date().toISOString();
  const seeded = !!(await getCfg(supabase, RF_SEED_KEY));

  const shells = [];
  for (const o of refundOrders) {
    const autoId = 'rf-auto-' + o.order_id;
    if (existIds.has(autoId)) continue;
    if (o.bkg_no && haveBk.has(norm(o.bkg_no))) continue;
    shells.push({
      id: autoId,
      tc: o.salesman || '',
      form_date: o.order_date ? isoDate(o.order_date) : '',
      bk: o.bkg_no || '',
      cust_name: o.contact_name || '',
      amount: o.refund_amount || null,
      reason: '',
      status: o.order_status === 7 ? 'DONE REFUND (auto)' : '',
      alerted_at: seeded ? null : nowIso,
    });
  }
  if (shells.length) {
    for (let i = 0; i < shells.length; i += 500) {
      const { error } = await supabase.from('refunds').insert(shells.slice(i, i + 500));
      if (error) throw new Error('refunds insert: ' + error.message);
    }
  }

  if (!seeded) {
    const ids = exist.map(r => r.id);
    for (let i = 0; i < ids.length; i += 500) {
      await supabase.from('refunds').update({ alerted_at: nowIso }).in('id', ids.slice(i, i + 500));
    }
    await setSeed(supabase, RF_SEED_KEY);
    return { created: shells.length, seeded: true, alerted: 0 };
  }

  // 2) Alert pass: over_due > 0, status ≠ DONE, cooldown ≥7 days.
  const allRows = exist.concat(shells);
  const due = [];
  for (const r of allRows) {
    const od = Number(r.over_due);
    if (!(od > 0)) continue;
    if (isRfDone(r.status)) continue;
    if (r.alerted_at && (Date.now() - new Date(r.alerted_at).getTime()) < ALERT_COOLDOWN_MS) continue;
    due.push(r);
  }
  let alerted = 0;
  if (due.length) {
    const url = await getCfg(supabase, 'lark_cs_url');
    if (url) {
      // we need cust_name + amount for the message; refetch since exist payload didn't include them.
      const { data: full } = await supabase.from('refunds').select('id, tc, bk, cust_name, amount, over_due, status').in('id', due.map(r => r.id));
      const byId = new Map((full || []).map(r => [r.id, r]));
      const lines = due.slice(0, 25).map(r => {
        const f = byId.get(r.id) || r;
        return `• ${f.bk || '?'} | ${f.cust_name || '-'} | ${(f.amount != null ? Number(f.amount).toLocaleString('en-US') : '-')} | Overdue ${f.over_due}d | TC ${f.tc || '-'} | Status: ${f.status || '—'}`;
      }).join('\n');
      const extra = due.length > 25 ? `\n…and ${due.length - 25} more` : '';
      const text =
        `<at user_id="all"></at>\n💸 Refund Tracking Alert / Pengingat Refund\n\n` +
        `🔴 Overdue refunds (${due.length}):\n${lines}${extra}\n\n` +
        `→ EN: Please follow up these overdue refunds with the customer.\n` +
        `→ ID: Mohon follow up refund yang sudah lewat jatuh tempo ini ke pelanggan.`;
      if (await postLark(url, text)) alerted = due.length;
    }
    const ids = due.map(r => r.id);
    for (let i = 0; i < ids.length; i += 500) {
      await supabase.from('refunds').update({ alerted_at: nowIso }).in('id', ids.slice(i, i + 500));
    }
  }
  return { created: shells.length, seeded: true, alerted };
}

function REFUNDS_status(o) { return REFUND_STATUSES.has(Number(o.order_status)); }

module.exports = { reconcileVendorPayments, reconcileRefunds };
