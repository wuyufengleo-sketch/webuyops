// Ticketing + Visa reminder reconcilers, called from sync-skybar.js after the
// package_orders upsert.
//
//  Ticketing — state machine (sprint 11 #A v2):
//    READY_TO_TICKET   pax ≥ region_min AND total_deposit ≥ pax × per_pax_min
//                      → notify lark_ticketing_url ("tour confirmed, book now")
//    CHASE_DEPOSIT     pax ≥ region_min BUT deposit short
//                      → notify lark_sales_url  ("tour formed, X juta still owed")
//    PEAK_URGENT       departure_date in peak_periods window AND dep ≤ 30
//                      AND pax ≥ region_min
//                      → notify lark_ticketing_url with PEAK tag (earlier)
//    H-14 / H-7        dep ≤ 14 / ≤ 7 AND ticketing.status ∉ {ISSUED, REISSUED}
//                      → notify lark_ticketing_url (fallback)
//
//    Each state has its own *_alerted_at column on ticketing_alert_state so
//    every trigger fires exactly once per tour per state.
//
//  Visa:
//    iterate visa_tours where status ≠ DONE; if dep within 14d → H-14/H-7
//    reminder to lark_visa_url. (Still the simpler model — once Skybar's
//    area_name is populated and visa_tours is re-maintained, we can extend
//    visa to a similar state machine.)
//
//  Silent-seed gate (sprint11_{ticketing,visa}_seeded in app_config) keeps
//  day-1 from blasting the backlog.

const { selectAll } = require('./_db-util');

const dayMs = 24 * 60 * 60 * 1000;
const JUTA  = 1_000_000;       // 1 juta = 1,000,000 IDR
const TICKET_DONE = /^(ISSUED|REISSUED)$/i;
const VISA_DONE   = /^DONE$/i;
// 有效订单 status：排除 5转团 / 6退款中 / 7已退款 / 10取消。Same set used by
// _price-watch / _order-workflow. Deposit totals must use this filter so they
// line up with paxSold (pax_total, which Skybar already computes VALID-only).
const VALID_ORDER_STATUS = new Set([1, 2, 3, 4, 8, 9]);

// ── Region classifier (Sprint 11 v3) ────────────────────────────────────────
// Reads tour_name (always present, always destination words). Previous
// tour_code-based version misread Webuy product-line shorthand (BEU =
// "Beautiful series", JOYFUL, etc.) as geographic codes — BEUVIE was mapped
// to EUROPE instead of VIETNAM. This rewrite mirrors app.html's classifier
// so the Tracker pages + Dashboard + cron all agree.
function classifyRegion(p) {
  const txt = ((p.tour_name || '') + ' ' + (p.tour_code || '')).toUpperCase();
  if (/XINJIANG|URUMQI|KASHGAR|KAYI BEIJIANG|新疆|TIANSHAN|乌鲁木齐|喀什/.test(txt)) return 'XINJIANG';
  if (/HONGKONG|HONG KONG|MACAU|MACAO/.test(txt)) return 'HK_MACAU';
  if (/BEUVIE|VIETNAM|HANOI|SAPA|HALONG|HCM|HO CHI MINH|DA NANG|DANANG|SAIGON|HUE|HOIAN/.test(txt)) return 'VIETNAM';
  if (/THAILAND|BANGKOK|BKK|PHUKET|PATTAYA|CHIANG MAI|CHIANGMAI/.test(txt)) return 'THAILAND';
  if (/SINGAPORE|SENTOSA/.test(txt)) return 'SINGAPORE';
  if (/MALAYSIA|KUALA LUMPUR|\bKL\b|GENTING|PENANG/.test(txt)) return 'MALAYSIA';
  if (/JAPAN|TOKYO|OSAKA|KYOTO|HOKKAIDO|NAGOYA|FUJI|SHIRAKAWAGO|CENTRAL JAPAN/.test(txt)) return 'JAPAN';
  if (/KOREA|ANNYEONG|SEOUL|BUSAN|JEJU|EVERLAND/.test(txt)) return 'KOREA';
  if (/RUSSIA|MOSCOW|KREMLIN|ST\.? PETERSBURG/.test(txt)) return 'RUSSIA';
  if (/TURKIYE|TURKEY|CAPPADOCIA|ISTANBUL/.test(txt)) return 'TURKEY';
  if (/\bUK\b|UNITED KINGDOM|SCOTLAND|LONDON|EDINBURGH|MANCHESTER|LIVERPOOL/.test(txt)) return 'UK';
  if (/EUROPE|SWITZERLAND|SWITZ|\bSWISS\b|NORWAY|SWEDEN|FINLAND|DENMARK|LOFOTEN|MT\.? TITLIS|TITLIS|EURODISNEY|CINQUE TERRE|PARIS|ROMA?|MILAN|BERLIN|AMSTERDAM|VIENNA|ZURICH|MADRID|BARCELONA|PRAGUE|VENICE|ITALY|FRANCE|GERMANY|SPAIN|JUNGFRAUJOCH/.test(txt)) return 'EUROPE';
  if (/AUSTRALIA|SYDNEY|MELBOURNE|BRISBANE|PERTH|GOLD COAST|CAIRNS|VIVID SYDNEY/.test(txt)) return 'AUSTRALIA';
  if (/NEW ZEALAND|AUCKLAND|QUEENSTOWN|CHRISTCHURCH/.test(txt)) return 'NZ';
  if (/CHINA|BEIJING|SHANGHAI|CHENGDU|CHONGQING|XIAN|HUANGSHAN|HANGZHOU|SUZHOU|HARBIN|CHANGSHA|ZHANGJIAJIE|DALIAN|QINGDAO|JIUZHAIGOU|YUNNAN|KUNMING|DALI|LIJIANG|SHANGRILLA|SHANGRILA|GUANGZHOU|SHENZHEN|WUYUAN|PHOENIX|TAIWAN|TAIPEI|TIBET|LHASA|HAINAN|GUILIN/.test(txt)) return 'CHINA';
  return 'UNKNOWN';
}

// Minimum pax to consider a tour "formed". CHINA / XINJIANG → 8, rest → 10.
function getMinPax(region) {
  return (region === 'CHINA' || region === 'XINJIANG') ? 8 : 10;
}

// Minimum deposit PER PAX in IDR. Long-haul tier (XINJIANG / EUROPE / UK /
// RUSSIA / TURKEY / AUSTRALIA / NZ) → 10 juta; rest → 5 juta.
function getMinDepositPerPax(region) {
  if (['XINJIANG','EUROPE','UK','RUSSIA','TURKEY','AUSTRALIA','NZ'].includes(region)) return 10 * JUTA;
  return 5 * JUTA;
}

// True if any peak_periods row covers `date`.
function checkPeak(date, periods) {
  for (const p of periods) {
    if (date >= p.start && date <= p.end) return p.reason;
  }
  return null;
}

function fmtJuta(n) { return (n / JUTA).toFixed(1) + ' juta'; }

async function postLark(url, text) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text } }),
    });
    return r.ok;
  } catch { return false; }
}

const dayMonth = d => { try { return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }); } catch { return '-'; } };

async function getCfg(supabase, key) {
  const { data } = await supabase.from('app_config').select('value').eq('key', key).maybeSingle();
  return data && data.value;
}

async function isSeeded(supabase, key) {
  const v = await getCfg(supabase, key);
  return !!v;
}

async function markSeeded(supabase, key) {
  await supabase.from('app_config').upsert({ key, value: '1' }, { onConflict: 'key' });
}

async function upsertChunks(supabase, table, rows, conflict) {
  for (let i = 0; i < rows.length; i += 200) {
    await supabase.from(table).upsert(rows.slice(i, i + 200), { onConflict: conflict });
  }
}

// ── Ticketing state machine ─────────────────────────────────────────────────
async function reconcileTicketingAlerts(supabase, packages, orders) {
  const SEED_KEY = 'sprint11_ticketing_seeded';

  // Index ticketing rows by tour_code. A discarded read error here would leave
  // tktByTour empty → every tour defaults to NOT BOOKED → already-ISSUED tours
  // would consume their one-shot H-14/H-7/READY alerts with bogus alerts. Throw
  // instead (the caller wraps this and surfaces it in the heartbeat).
  const { data: tkt, error: tktErr } = await selectAll(
    () => supabase.from('ticketing').select('tour_code, status'), { order: 'tour_code' });
  if (tktErr) throw new Error('ticketing read: ' + tktErr.message);
  const tktByTour = new Map();
  for (const t of tkt || []) {
    if (t.tour_code) tktByTour.set(String(t.tour_code).toUpperCase(), t.status || 'NOT BOOKED');
  }

  // Sum actual amount paid per tour_id, over VALID orders only. sync-skybar
  // writes the true paid total into deposit_amount (from wt_order_payment_receipt),
  // but that value is retained even after a refund/cancel, so summing ALL orders
  // would inflate the deposit vs paxSold (which is VALID-only) — making
  // READY_TO_TICKET fire while the active bookings are actually short.
  const depositByTour = new Map();
  for (const o of orders || []) {
    if (o.order_status == null || !VALID_ORDER_STATUS.has(Number(o.order_status))) continue;
    const k = Number(o.tour_id);
    if (!k) continue;
    const paid = Math.max(0, Number(o.deposit_amount) || 0);
    depositByTour.set(k, (depositByTour.get(k) || 0) + paid);
  }

  // Load peak periods
  const { data: peaks } = await supabase.from('peak_periods').select('start_date, end_date, reason');
  const peakPeriods = (peaks || []).map(p => ({
    start: new Date(p.start_date), end: new Date(p.end_date), reason: p.reason,
  }));

  // Classify every active package + compute state inputs
  const now = new Date();
  const nowIso = now.toISOString();
  const classified = [];
  for (const p of packages || []) {
    if (!p.tour_code || !p.departure_date) continue;
    const status = tktByTour.get(String(p.tour_code).toUpperCase()) || 'NOT BOOKED';
    if (TICKET_DONE.test(status)) continue;                  // already issued — skip entirely

    const dep = new Date(p.departure_date);
    const days = Math.floor((dep - now) / dayMs);
    if (days < 0) continue;                                  // past departures — skip

    const region = classifyRegion(p);
    const minPax = getMinPax(region);
    const minDepPerPax = getMinDepositPerPax(region);
    const paxSold = Number(p.pax_total || 0);                // excluding infants
    if (paxSold <= 0) continue;
    const depositPaid = depositByTour.get(Number(p.tour_id)) || 0;
    const depositRequired = paxSold * minDepPerPax;
    const peakReason = checkPeak(dep, peakPeriods);

    // Determine which states the tour matches
    const formed = (minPax != null) && paxSold >= minPax;
    const depositMet = depositPaid >= depositRequired && depositRequired > 0;
    const states = {
      ready:    formed && depositMet,
      chase:    formed && !depositMet,
      peak:     formed && peakReason && days <= 30,
      h14:      days <= 14,
      h7:       days <=  7,
    };
    classified.push({
      tour_code: p.tour_code, tour_name: p.tour_name, dep: p.departure_date, days,
      region, paxSold, minPax, depositPaid, depositRequired, peakReason, status,
      states,
    });
  }

  if (!classified.length) {
    if (!(await isSeeded(supabase, SEED_KEY))) await markSeeded(supabase, SEED_KEY);
    return { seeded: true, considered: 0, posted_ticketing: 0, posted_sales: 0 };
  }

  // Pull current alert state for any tour that matches at least one state.
  const codes = classified.filter(c => Object.values(c.states).some(Boolean)).map(c => c.tour_code);
  let stateByTour = new Map();
  if (codes.length) {
    // A discarded error here would leave stateByTour empty → every matching tour
    // re-fires every state (mass double-fire) and the upsert below overwrites the
    // real alerted_at history. Throw instead.
    const { data: states, error: stErr } = await supabase.from('ticketing_alert_state').select('*').in('tour_code', codes);
    if (stErr) throw new Error('ticketing_alert_state read: ' + stErr.message);
    stateByTour = new Map((states || []).map(s => [s.tour_code, s]));
  }

  // Classify into buckets (each bucket lists newly-triggered tours for that state).
  const bucket = { ready: [], chase: [], peak: [], h14: [], h7: [] };
  for (const c of classified) {
    const state = stateByTour.get(c.tour_code) || {};
    if (c.states.ready && !state.ready_alerted_at)              bucket.ready.push(c);
    if (c.states.chase && !state.deposit_chase_alerted_at)      bucket.chase.push(c);
    if (c.states.peak  && !state.peak_alerted_at)               bucket.peak.push(c);
    if (c.states.h14   && !state.h14_alerted_at)                bucket.h14.push(c);
    if (c.states.h7    && !state.h7_alerted_at)                 bucket.h7.push(c);
  }

  // Build the per-tour alerted_at stamps. Channels are committed independently:
  // the ready/peak/h14/h7 fields belong to the ticketing channel, the chase
  // field to the sales channel. We only persist a channel's stamps if its Lark
  // post actually succeeded — otherwise a failed/unconfigured webhook would burn
  // these one-shot alerts forever (they'd never re-fire).
  const buildUpdates = (commitTicketing, commitChase) => {
    const m = new Map();
    const stamp = (code, field) => {
      const u = m.get(code) || { tour_code: code };
      u[field] = nowIso;
      m.set(code, u);
    };
    if (commitTicketing) {
      for (const c of bucket.ready) stamp(c.tour_code, 'ready_alerted_at');
      for (const c of bucket.peak)  stamp(c.tour_code, 'peak_alerted_at');
      for (const c of bucket.h14)   stamp(c.tour_code, 'h14_alerted_at');
      for (const c of bucket.h7)    stamp(c.tour_code, 'h7_alerted_at');
    }
    if (commitChase) {
      for (const c of bucket.chase) stamp(c.tour_code, 'deposit_chase_alerted_at');
    }
    return [...m.values()];
  };

  // Silent seed on first run — stamp everything without posting (intentional).
  const seeded = await isSeeded(supabase, SEED_KEY);
  if (!seeded) {
    await upsertChunks(supabase, 'ticketing_alert_state', buildUpdates(true, true), 'tour_code');
    await markSeeded(supabase, SEED_KEY);
    return {
      seeded: true, considered: classified.length,
      ready_seeded: bucket.ready.length, chase_seeded: bucket.chase.length,
      peak_seeded:  bucket.peak.length,
      h14_seeded:   bucket.h14.length,   h7_seeded:    bucket.h7.length,
      posted_ticketing: 0, posted_sales: 0,
    };
  }

  // Build + post Lark digests. ticketingOk/chaseOk gate whether we persist each
  // channel's alerted_at stamps. Default true so a channel with nothing to post
  // doesn't block the commit; set false only when there IS something to post but
  // the webhook is unconfigured or the post failed.
  let posted_ticketing = 0, posted_sales = 0;
  let ticketingOk = true, chaseOk = true;
  const fmtTktLine = c =>
    `• ${dayMonth(c.dep)} · ${c.tour_code} · ${c.paxSold}pax · ${c.region} · ${c.status}` +
    (c.peakReason ? ` · 🔥 ${c.peakReason}` : '');
  const fmtChaseLine = c =>
    `• ${dayMonth(c.dep)} · ${c.tour_code} · ${c.paxSold}pax · paid ${fmtJuta(c.depositPaid)} / need ${fmtJuta(c.depositRequired)} (short ${fmtJuta(c.depositRequired - c.depositPaid)})`;

  // Ticketing digest (ready + peak + h14 + h7 collapsed into one post)
  if (bucket.ready.length || bucket.peak.length || bucket.h14.length || bucket.h7.length) {
    ticketingOk = false;
    const url = await getCfg(supabase, 'lark_ticketing_url');
    if (url) {
      let text = `<at user_id="all"></at>\n🎫 Ticketing Alert / Notifikasi Tiket`;
      if (bucket.ready.length) text += `\n\n✅ Ready to ticket — pax 已成团 + 定金到位 (${bucket.ready.length})\n` + bucket.ready.map(fmtTktLine).join('\n');
      if (bucket.peak.length)  text += `\n\n🔥 Peak season — 提前出票 (${bucket.peak.length})\n`              + bucket.peak.map(fmtTktLine).join('\n');
      if (bucket.h14.length)   text += `\n\n🟠 H-14 fallback (${bucket.h14.length})\n`                        + bucket.h14.map(fmtTktLine).join('\n');
      if (bucket.h7.length)    text += `\n\n🔴 H-7 fallback (${bucket.h7.length})\n`                          + bucket.h7.map(fmtTktLine).join('\n');
      text += `\n\n→ Please book / issue these tickets and update status in Webuy OPS.`;
      text += `\n   Mohon book / issue tiket dan update status di Webuy OPS.`;
      ticketingOk = await postLark(url, text);
      if (ticketingOk) posted_ticketing = 1;
    }
  }

  // Deposit-chase digest (separate channel — Sales team)
  if (bucket.chase.length) {
    chaseOk = false;
    const url = await getCfg(supabase, 'lark_sales_url');
    if (url) {
      let text = `<at user_id="all"></at>\n💰 Deposit Chase / Tagih Deposit`;
      text += `\n\n⚠️ Tour 已成团但定金不足 (${bucket.chase.length})\n` + bucket.chase.map(fmtChaseLine).join('\n');
      text += `\n\n→ Please chase the remaining deposit so we can issue tickets.`;
      text += `\n   Mohon tagih sisa deposit supaya bisa issue tiket.`;
      chaseOk = await postLark(url, text);
      if (chaseOk) posted_sales = 1;
    }
  }

  // Persist only the channels whose post actually landed.
  await upsertChunks(supabase, 'ticketing_alert_state', buildUpdates(ticketingOk, chaseOk), 'tour_code');
  return {
    seeded: true, considered: classified.length,
    ready_alerted: bucket.ready.length, chase_alerted: bucket.chase.length,
    peak_alerted:  bucket.peak.length,
    h14_alerted:   bucket.h14.length,   h7_alerted:    bucket.h7.length,
    posted_ticketing, posted_sales,
  };
}

// ── Visa ────────────────────────────────────────────────────────────────────
async function reconcileVisaAlerts(supabase) {
  const SEED_KEY = 'sprint11_visa_seeded';

  // A discarded error here makes activeCodes empty → candidates empty → the
  // module marks itself seeded with zero work and silently skips every visa
  // reminder. Throw instead.
  const { data: activePackages, error: apErr } = await selectAll(
    () => supabase.from('package_sales').select('tour_code, pax_total').gt('pax_total', 0),
    { order: 'id' });
  if (apErr) throw new Error('package_sales read: ' + apErr.message);
  const activeCodes = new Set((activePackages || [])
    .map(p => String(p.tour_code || '').toUpperCase())
    .filter(Boolean));

  // Pull non-DONE visa_tours with a parseable dep date
  const { data: rows, error: vtErr } = await selectAll(
    () => supabase.from('visa_tours').select('id, code, tour, dep, status'), { order: 'id' });
  if (vtErr) throw new Error('visa_tours read: ' + vtErr.message);
  const now = new Date();
  const candidates = [];
  for (const r of rows || []) {
    const code = String(r.code || '').toUpperCase();
    if (!code || !activeCodes.has(code)) continue;
    if (VISA_DONE.test(r.status || '')) continue;
    if (!r.dep) continue;
    const t = new Date(r.dep);
    if (isNaN(t)) continue;
    const days = Math.floor((t - now) / dayMs);
    if (days < 0 || days > 14) continue;
    candidates.push({ ...r, _days: days });
  }

  if (!candidates.length) {
    if (!(await isSeeded(supabase, SEED_KEY))) await markSeeded(supabase, SEED_KEY);
    return { seeded: true, considered: 0, h14_alerted: 0, h7_alerted: 0, posted: 0 };
  }

  const ids = candidates.map(c => c.id);
  const { data: states, error: vsErr } = await supabase.from('visa_alert_state').select('*').in('visa_id', ids);
  if (vsErr) throw new Error('visa_alert_state read: ' + vsErr.message);
  const stateByVisa = new Map((states || []).map(s => [s.visa_id, s]));

  const h14 = [], h7 = [], updates = [];
  const nowIso = now.toISOString();
  for (const c of candidates) {
    const state = stateByVisa.get(c.id) || {};
    const upd = { visa_id: c.id };
    const line = { code: c.code || '—', tour: c.tour, dep: c.dep, status: c.status };
    if (c._days <= 14 && !state.h14_alerted_at) { h14.push(line); upd.h14_alerted_at = nowIso; }
    if (c._days <= 7  && !state.h7_alerted_at)  { h7.push(line);  upd.h7_alerted_at  = nowIso; }
    if (upd.h14_alerted_at || upd.h7_alerted_at) updates.push(upd);
  }

  const seeded = await isSeeded(supabase, SEED_KEY);
  if (!seeded) {
    await upsertChunks(supabase, 'visa_alert_state', updates, 'visa_id');
    await markSeeded(supabase, SEED_KEY);
    return { seeded: true, considered: candidates.length, h14_seeded: h14.length, h7_seeded: h7.length, posted: 0 };
  }

  let posted = 0;
  // Default ok=true so "nothing to post" doesn't block the (empty) commit; set
  // false only when there are alerts to send but the webhook is missing or the
  // post failed — so these one-shot H-14/H-7 reminders re-fire next run instead
  // of being silently burned.
  let visaOk = true;
  if (h14.length || h7.length) {
    visaOk = false;
    const url = await getCfg(supabase, 'lark_visa_url');
    if (url) {
      const fmtLine = l => `• ${dayMonth(l.dep)} · ${l.code} · ${(l.tour||'').slice(0,40)} · ${l.status}`;
      let text = `<at user_id="all"></at>\n🛂 Visa Alert / Notifikasi Visa`;
      if (h14.length) text += `\n\n🟠 H-14 (${h14.length})\n` + h14.map(fmtLine).join('\n');
      if (h7.length)  text += `\n\n🔴 H-7 (${h7.length})\n`  + h7.map(fmtLine).join('\n');
      text += `\n\n→ Please process these visas and update status in Webuy OPS.`;
      text += `\n   Mohon proses visa dan update status di Webuy OPS.`;
      visaOk = await postLark(url, text);
      if (visaOk) posted = 1;
    }
  }

  if (visaOk) await upsertChunks(supabase, 'visa_alert_state', updates, 'visa_id');
  return { seeded: true, considered: candidates.length, h14_alerted: h14.length, h7_alerted: h7.length, posted };
}

module.exports = { reconcileTicketingAlerts, reconcileVisaAlerts };
