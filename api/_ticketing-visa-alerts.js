// Ticketing + Visa H-14 / H-7 reminder reconcilers, called from sync-skybar.js
// after the package_orders upsert.
//
//  • Ticketing: iterate active Skybar tours; if days_to_dep ≤ 14 AND ticketing
//    row missing OR status not in {ISSUED, REISSUED} → schedule reminder.
//  • Visa: iterate visa_tours where status ≠ DONE; if days_to_dep ≤ 14 →
//    schedule reminder. (Will be a no-op until visa_tours is re-populated
//    after the Skybar area_name / visa team maintenance discussion.)
//
//  State tables track per-tour H-14 and H-7 firings so each ping happens
//  exactly once per tour per stage. First call silent-seeds (mass-marks
//  everything alerted, no Lark post) so day-1 doesn't blast the backlog.

const dayMs = 24 * 60 * 60 * 1000;
const TICKET_DONE = /^(ISSUED|REISSUED)$/i;
const VISA_DONE   = /^DONE$/i;

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

// ── Ticketing ───────────────────────────────────────────────────────────────
async function reconcileTicketingAlerts(supabase, packages) {
  const SEED_KEY = 'sprint11_ticketing_seeded';

  // Index ticketing rows by tour_code (case-insensitive)
  const { data: tkt } = await supabase.from('ticketing').select('tour_code, status');
  const tktByTour = new Map();
  for (const t of tkt || []) {
    if (t.tour_code) tktByTour.set(String(t.tour_code).toUpperCase(), t.status || 'NOT BOOKED');
  }

  // Candidate tours: have departure_date, days_to_dep in [0,14], status not ISSUED
  const now = new Date();
  const candidates = [];
  for (const p of packages || []) {
    if (!p.tour_code || !p.departure_date) continue;
    const days = Math.floor((new Date(p.departure_date) - now) / dayMs);
    if (days < 0 || days > 14) continue;
    const status = tktByTour.get(String(p.tour_code).toUpperCase()) || 'NOT BOOKED';
    if (TICKET_DONE.test(status)) continue;
    candidates.push({ ...p, _days: days, _status: status });
  }

  if (!candidates.length) {
    if (!(await isSeeded(supabase, SEED_KEY))) await markSeeded(supabase, SEED_KEY);
    return { seeded: true, considered: 0, h14_alerted: 0, h7_alerted: 0, posted: 0 };
  }

  // Load existing alert state for the candidates
  const codes = candidates.map(c => c.tour_code);
  const { data: states } = await supabase.from('ticketing_alert_state').select('*').in('tour_code', codes);
  const stateByTour = new Map((states || []).map(s => [s.tour_code, s]));

  const h14 = [], h7 = [], updates = [];
  const nowIso = now.toISOString();
  for (const c of candidates) {
    const state = stateByTour.get(c.tour_code) || {};
    const upd = { tour_code: c.tour_code };
    const line = { tour_code: c.tour_code, tour_name: c.tour_name, dep: c.departure_date, pax: c.sold_seat || 0, status: c._status };
    if (c._days <= 14 && !state.h14_alerted_at) { h14.push(line); upd.h14_alerted_at = nowIso; }
    if (c._days <= 7  && !state.h7_alerted_at)  { h7.push(line);  upd.h7_alerted_at  = nowIso; }
    if (upd.h14_alerted_at || upd.h7_alerted_at) updates.push(upd);
  }

  // Silent seed on first run — mark state, do NOT post.
  const seeded = await isSeeded(supabase, SEED_KEY);
  if (!seeded) {
    await upsertChunks(supabase, 'ticketing_alert_state', updates, 'tour_code');
    await markSeeded(supabase, SEED_KEY);
    return { seeded: true, considered: candidates.length, h14_seeded: h14.length, h7_seeded: h7.length, posted: 0 };
  }

  // Post Lark digest if any new alerts queued
  let posted = 0;
  if (h14.length || h7.length) {
    const url = await getCfg(supabase, 'lark_ticketing_url');
    if (url) {
      const fmtLine = l => `• ${dayMonth(l.dep)} · ${l.tour_code} · ${l.pax}pax · ${l.status}`;
      let text = `<at user_id="all"></at>\n🎫 Ticketing Alert / Notifikasi Tiket`;
      if (h14.length) text += `\n\n🟠 H-14 (${h14.length})\n` + h14.map(fmtLine).join('\n');
      if (h7.length)  text += `\n\n🔴 H-7 (${h7.length})\n`  + h7.map(fmtLine).join('\n');
      text += `\n\n→ Please book / issue these tickets and update status in Webuy OPS.`;
      text += `\n   Mohon book / issue tiket dan update status di Webuy OPS.`;
      if (await postLark(url, text)) posted = 1;
    }
  }

  // Save state regardless of post result (don't repeat-spam on retry)
  await upsertChunks(supabase, 'ticketing_alert_state', updates, 'tour_code');
  return { seeded: true, considered: candidates.length, h14_alerted: h14.length, h7_alerted: h7.length, posted };
}

// ── Visa ────────────────────────────────────────────────────────────────────
async function reconcileVisaAlerts(supabase) {
  const SEED_KEY = 'sprint11_visa_seeded';

  // Pull non-DONE visa_tours with a parseable dep date
  const { data: rows } = await supabase.from('visa_tours').select('id, code, tour, dep, status');
  const now = new Date();
  const candidates = [];
  for (const r of rows || []) {
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
  const { data: states } = await supabase.from('visa_alert_state').select('*').in('visa_id', ids);
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
  if (h14.length || h7.length) {
    const url = await getCfg(supabase, 'lark_visa_url');
    if (url) {
      const fmtLine = l => `• ${dayMonth(l.dep)} · ${l.code} · ${(l.tour||'').slice(0,40)} · ${l.status}`;
      let text = `<at user_id="all"></at>\n🛂 Visa Alert / Notifikasi Visa`;
      if (h14.length) text += `\n\n🟠 H-14 (${h14.length})\n` + h14.map(fmtLine).join('\n');
      if (h7.length)  text += `\n\n🔴 H-7 (${h7.length})\n`  + h7.map(fmtLine).join('\n');
      text += `\n\n→ Please process these visas and update status in Webuy OPS.`;
      text += `\n   Mohon proses visa dan update status di Webuy OPS.`;
      if (await postLark(url, text)) posted = 1;
    }
  }

  await upsertChunks(supabase, 'visa_alert_state', updates, 'visa_id');
  return { seeded: true, considered: candidates.length, h14_alerted: h14.length, h7_alerted: h7.length, posted };
}

module.exports = { reconcileTicketingAlerts, reconcileVisaAlerts };
