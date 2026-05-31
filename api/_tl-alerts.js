// TL Output pre-departure reminder — called by api/sync-skybar.js. For every
// BK tour with a TL assigned, fires ONE H-14 and ONE H-7 reminder into the TL
// Lark group (lark_tl_url), throttled via tl_alert_state.  Silent-seed on the
// first run so the existing backlog doesn't blast at once.
//
//   H-14 window = 12..14 days before departure (catches once even if cron misses a day)
//   H-7  window = 5..7  days before departure
//
// Reminder content reminds the TL to capture / submit the 5 output areas
// (photos / report / customer feedback / incident / finance) after the tour.

const SEED_KEY = 'sprint9_tl_alerts_seeded';
const H14_RANGE = [12, 14];
const H7_RANGE  = [5,  7];
const MAX_LINES = 25;

async function getCfg(supabase, key) {
  const { data } = await supabase.from('app_config').select('value').eq('key', key).maybeSingle();
  return data ? data.value : '';
}
async function setSeed(supabase, key) {
  await supabase.from('app_config').upsert({ key, value: '1' }, { onConflict: 'key' });
}
async function postLark(url, text) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text } }) });
    return r.ok;
  } catch { return false; }
}
function fmtDay(s) {
  if (!s) return '-';
  try { return new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }); }
  catch { return s; }
}

async function reconcileTlOutputAlerts(supabase) {
  // Pull only what we need from bk_tours (id, tl, dep).
  const { data: tours, error: tErr } = await supabase
    .from('bk_tours').select('id, tl, dep, dest, code').not('tl', 'is', null);
  if (tErr) throw new Error('bk_tours read: ' + tErr.message);

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const annotated = (tours || [])
    .filter(t => (t.tl || '').trim() && t.dep)
    .map(t => {
      const d = new Date(t.dep); if (isNaN(d)) return null;
      d.setHours(0, 0, 0, 0);
      const days = Math.round((d - today) / 86400000);
      return { id: t.id, tl: t.tl.trim(), dep: t.dep, dest: t.dest || '', code: t.code || '', days };
    })
    .filter(Boolean);

  const h14 = annotated.filter(t => t.days >= H14_RANGE[0] && t.days <= H14_RANGE[1]);
  const h7  = annotated.filter(t => t.days >= H7_RANGE[0]  && t.days <= H7_RANGE[1]);

  const { data: stateRows, error: sErr } = await supabase
    .from('tl_alert_state').select('tour_id, h14_alerted_at, h7_alerted_at');
  if (sErr) throw new Error('tl_alert_state read: ' + sErr.message);
  const state = new Map((stateRows || []).map(r => [r.tour_id, r]));

  const nowIso = new Date().toISOString();
  const seeded = !!(await getCfg(supabase, SEED_KEY));

  // First-ever run: stamp every currently-in-window tour so we don't blast the backlog.
  if (!seeded) {
    const seedRows = new Map();
    for (const t of h14) seedRows.set(t.id, { tour_id: t.id, tl_name: t.tl, h14_alerted_at: nowIso, h7_alerted_at: null });
    for (const t of h7)  {
      const cur = seedRows.get(t.id) || { tour_id: t.id, tl_name: t.tl, h14_alerted_at: null };
      cur.h7_alerted_at = nowIso;
      seedRows.set(t.id, cur);
    }
    const upserts = [...seedRows.values()];
    for (let i = 0; i < upserts.length; i += 500) {
      const { error } = await supabase.from('tl_alert_state')
        .upsert(upserts.slice(i, i + 500), { onConflict: 'tour_id' });
      if (error) throw new Error('tl_alert_state seed: ' + error.message);
    }
    await setSeed(supabase, SEED_KEY);
    return { seeded: true, h14_seeded: h14.length, h7_seeded: h7.length, alerted: 0 };
  }

  // Classify: tour needs alert iff that window's timestamp is null.
  const h14ToAlert = h14.filter(t => !(state.get(t.id)?.h14_alerted_at));
  const h7ToAlert  = h7.filter(t  => !(state.get(t.id)?.h7_alerted_at));

  let alerted = 0;
  if (h14ToAlert.length || h7ToAlert.length) {
    const url = await getCfg(supabase, 'lark_tl_url');
    if (url) {
      const line = t => `• ${t.tl} · ${t.code || t.id} · ${t.dest || '-'} · Dep ${fmtDay(t.dep)} (${t.days}d)`;
      let text = `<at user_id="all"></at>\n👤 TL Output Reminder / Pengingat Output TL`;
      if (h14ToAlert.length) {
        text += `\n\n🟡 H-14 出发前 14 天 (${h14ToAlert.length})\n`
          + h14ToAlert.slice(0, MAX_LINES).map(line).join('\n')
          + (h14ToAlert.length > MAX_LINES ? `\n…and ${h14ToAlert.length - MAX_LINES} more` : '');
      }
      if (h7ToAlert.length) {
        text += `\n\n🔴 H-7 出发前 7 天 (${h7ToAlert.length})\n`
          + h7ToAlert.slice(0, MAX_LINES).map(line).join('\n')
          + (h7ToAlert.length > MAX_LINES ? `\n…and ${h7ToAlert.length - MAX_LINES} more` : '');
      }
      text += `\n\n📝 团回来后请在 OPS Center → CS Workstation → 📝 TL Output 填写：`
            + `\n   📸 出团照片 · 📝 行程总结 · ⭐ 客户反馈 · 🚨 事故上报 · 💰 财务结算`;
      if (await postLark(url, text)) alerted = h14ToAlert.length + h7ToAlert.length;
    }
  }

  // Persist alerted timestamps (merge into existing state row).
  const merged = new Map();
  for (const t of h14ToAlert) {
    const prev = state.get(t.id) || {};
    merged.set(t.id, {
      tour_id: t.id, tl_name: t.tl,
      h14_alerted_at: nowIso,
      h7_alerted_at: prev.h7_alerted_at || null,
      updated_at: nowIso,
    });
  }
  for (const t of h7ToAlert) {
    const prev = state.get(t.id) || {};
    const cur = merged.get(t.id) || {
      tour_id: t.id, tl_name: t.tl,
      h14_alerted_at: prev.h14_alerted_at || null,
      h7_alerted_at: null, updated_at: nowIso,
    };
    cur.h7_alerted_at = nowIso;
    merged.set(t.id, cur);
  }
  const upserts = [...merged.values()];
  for (let i = 0; i < upserts.length; i += 500) {
    await supabase.from('tl_alert_state').upsert(upserts.slice(i, i + 500), { onConflict: 'tour_id' });
  }

  return { seeded: true, h14_alerted: h14ToAlert.length, h7_alerted: h7ToAlert.length, alerted };
}

module.exports = { reconcileTlOutputAlerts };
