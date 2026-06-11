// BK Group Phase 3 — daily "no WhatsApp group yet" digest.
//
// After the package_orders upsert, find every active BK whose
//   • created_at (sync first-seen) was > 24h ago, AND
//   • either has no bk_groups row at all OR bk_groups.wa_link is null.
// Group by CS (cs_name on bk_groups if set, otherwise "(unassigned)") and
// post a digest to lark_cs_url. State is tracked on bk_groups itself via
// a new no_group_alerted_at column (kept null until the first nag, then
// timestamped — the reconciler only nags one extra time per BK per week).
//
// Single-direction: once a wa_link is set, future calls leave that row alone.

const { selectAll } = require('./_db-util');

const dayMs = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * dayMs;

async function postLark(url, text) {
  try {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
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

async function reconcileBkGroupAlerts(supabase) {
  // 1) Pull all active BKs via order_workflow (one row per active BK,
  //    bkg_no is backfilled, created_at is the first-seen timestamp).
  const { data: bks, error: bksErr } = await selectAll(
    () => supabase.from('order_workflow').select('bkg_no, tour_code, departure_date, pax, created_at'),
    { order: 'id' });
  if (bksErr) throw new Error('order_workflow read: ' + bksErr.message);
  if (!bks || !bks.length) return { considered: 0, missing: 0, alerted: 0, posted: 0 };

  // 2) Cross-reference bk_groups. A discarded error here would leave grpByBk
  //    empty → every ≥24h-old BK looks group-less → mass false nag to CS and
  //    no_group_alerted_at overwritten for rows that did have groups. Throw.
  const { data: grps, error: grpsErr } = await selectAll(
    () => supabase.from('bk_groups').select('bkg_no, wa_link, cs_name, no_group_alerted_at'),
    { order: 'bkg_no' });
  if (grpsErr) throw new Error('bk_groups read: ' + grpsErr.message);
  const grpByBk = new Map((grps || []).map(g => [String(g.bkg_no || '').toUpperCase(), g]));

  const now = new Date();
  const cutoff = new Date(now - dayMs);              // BK must be ≥24h old
  const weekAgo = new Date(now - WEEK_MS);

  // 3) Find BKs that need a poke
  const candidates = [];
  for (const r of bks) {
    if (!r.bkg_no) continue;
    if (new Date(r.created_at) > cutoff) continue;   // too fresh
    const g = grpByBk.get(String(r.bkg_no).toUpperCase());
    if (g && g.wa_link) continue;                    // group exists, all good
    // Throttle: skip if we already alerted within the last 7 days
    if (g && g.no_group_alerted_at && new Date(g.no_group_alerted_at) > weekAgo) continue;
    candidates.push({
      bkg_no: r.bkg_no,
      tour_code: r.tour_code,
      dep: r.departure_date,
      pax: r.pax,
      cs_name: (g && g.cs_name) || '(unassigned)',
      hasShellRow: !!g,
    });
  }

  if (!candidates.length) return { considered: bks.length, missing: 0, alerted: 0, posted: 0 };

  // 4) Group by CS handler
  const byCs = new Map();
  for (const c of candidates) {
    if (!byCs.has(c.cs_name)) byCs.set(c.cs_name, []);
    byCs.get(c.cs_name).push(c);
  }

  // 5) Compose + post the digest
  let posted = 0;
  const url = await getCfg(supabase, 'lark_cs_url');
  if (url) {
    let text = `<at user_id="all"></at>\n📱 BK WhatsApp Group · Nag / Reminder`;
    text += `\n\n⚠️ ${candidates.length} BK(s) still missing a WhatsApp group (created > 24h ago):`;
    for (const [cs, list] of byCs) {
      text += `\n\n👤 ${cs} (${list.length})`;
      for (const c of list) {
        text += `\n  • ${c.bkg_no} · ${c.tour_code || '?'} · ${c.pax || 0}pax · dep ${dayMonth(c.dep)}`;
      }
    }
    text += `\n\n→ Please create the WA group for each BK above (📱 button anywhere in Webuy OPS).`;
    text += `\n   Mohon buatkan WhatsApp group untuk setiap BK di atas.`;
    if (await postLark(url, text)) posted = 1;
  }

  // 6) Mark alerted (create shell row if missing) — only if the nag actually
  //    posted. Otherwise (webhook unset or post failed) leave the state so the
  //    BKs are reconsidered next run instead of being silently throttled.
  const nowIso = now.toISOString();
  if (posted) {
    const upserts = candidates.map(c => ({
      bkg_no: c.bkg_no,
      no_group_alerted_at: nowIso,
    }));
    for (let i = 0; i < upserts.length; i += 200) {
      await supabase.from('bk_groups').upsert(upserts.slice(i, i + 200), { onConflict: 'bkg_no' });
    }
  }

  return { considered: bks.length, missing: candidates.length, alerted: candidates.length, posted };
}

module.exports = { reconcileBkGroupAlerts };
