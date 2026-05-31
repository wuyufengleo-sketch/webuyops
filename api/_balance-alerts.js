// Balance reconciliation alerter — called by api/sync-skybar.js after the
// vendor/refund reconcilers. Runs the Sheet ↔ Skybar diff (via
// balance-recon's runReconciliation), then identifies NEW alert-worthy issues
// vs the balance_alert_state table and pings the CS Lark group.
//
//   NEW issue = bk not yet in state, OR flag changed (e.g. ok→mismatch,
//   mismatch→skybar_only), OR sb_balance moved >1 unit (an actual financial
//   change worth re-flagging), OR alerted_at > 7 days ago (weekly re-ping).
//
// Silent-seed on first run (app_config key) so the 68 existing mismatches and
// 585 existing orphans don't blast on the very first cron.

const { runReconciliation } = require('./balance-recon');

const SEED_KEY = 'sprint9_balance_alerts_seeded';
const ALERT_COOLDOWN_MS = 7 * 24 * 3600 * 1000;
const MAX_LINES_PER_SECTION = 15;

const fmt = n => (n == null ? '-' : Number(n).toLocaleString('en-US'));

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

async function reconcileBalanceAlerts(supabase) {
  const { summary, diffs, skybar_only } = await runReconciliation(supabase);

  // Combine alert-worthy issues into a single list with a uniform shape.
  const issues = [
    ...diffs.filter(d => d.flag === 'mismatch').map(d => ({
      bk: d.bk, flag: 'mismatch',
      sb_balance: d.sb_balance, sheet_balance: d.sheet_balance,
      tc: d.tc, tourcode: d.tourcode, dept_date: d.dept_date, note: d.sheet_note,
      diff: d.balance_diff,
    })),
    ...skybar_only.map(o => ({
      bk: o.bk, flag: 'skybar_only',
      sb_balance: o.sb_balance, sheet_balance: null,
      tc: o.sb_salesman, tourcode: null, dept_date: null, note: null,
      diff: null,
    })),
  ];

  const { data: stateRows, error: stErr } = await supabase
    .from('balance_alert_state').select('bk, flag, sb_balance, alerted_at');
  if (stErr) throw new Error('balance_alert_state read: ' + stErr.message);
  const state = new Map((stateRows || []).map(r => [r.bk, r]));

  const nowIso = new Date().toISOString();
  const seeded = !!(await getCfg(supabase, SEED_KEY));

  // First-ever run: silent-seed every current issue, no Lark.
  if (!seeded) {
    const upserts = issues.map(i => ({
      bk: i.bk, flag: i.flag,
      sb_balance: i.sb_balance, sheet_balance: i.sheet_balance,
      alerted_at: nowIso, updated_at: nowIso,
    }));
    for (let i = 0; i < upserts.length; i += 500) {
      const { error } = await supabase.from('balance_alert_state')
        .upsert(upserts.slice(i, i + 500), { onConflict: 'bk' });
      if (error) throw new Error('balance_alert_state seed: ' + error.message);
    }
    await setSeed(supabase, SEED_KEY);
    return { seeded: true, issues: issues.length, alerted: 0, summary };
  }

  // Classify each current issue.
  const newOnes = [];
  for (const i of issues) {
    const prev = state.get(i.bk);
    const balChanged = prev && Math.abs(Number(prev.sb_balance || 0) - Number(i.sb_balance || 0)) > 1;
    const stale = prev && (Date.now() - new Date(prev.alerted_at).getTime()) >= ALERT_COOLDOWN_MS;
    const flagChanged = prev && prev.flag !== i.flag;
    if (!prev || flagChanged || balChanged || stale) newOnes.push(i);
  }

  let alerted = 0;
  if (newOnes.length) {
    const url = await getCfg(supabase, 'lark_cs_url');
    if (url) {
      const mismatches = newOnes.filter(i => i.flag === 'mismatch');
      const orphans = newOnes.filter(i => i.flag === 'skybar_only');
      const line = i => i.flag === 'mismatch'
        ? `• ${i.bk} · ${i.tc || '-'} · Sheet bal ${fmt(i.sheet_balance)} vs Skybar ${fmt(i.sb_balance)} (Δ ${fmt(i.diff)})`
        : `• ${i.bk} · ${i.tc || '-'} · Skybar 余款 ${fmt(i.sb_balance)} — not in Sheet`;
      let text = `<at user_id="all"></at>\n💰 Balance Recon Alert / 余款对账提醒\n\n`;
      if (mismatches.length) {
        text += `🔴 Sheet ↔ Skybar mismatch (${mismatches.length})\n`
          + mismatches.slice(0, MAX_LINES_PER_SECTION).map(line).join('\n')
          + (mismatches.length > MAX_LINES_PER_SECTION ? `\n…and ${mismatches.length - MAX_LINES_PER_SECTION} more` : '')
          + '\n\n';
      }
      if (orphans.length) {
        text += `🟠 In Skybar, missing from Sheet (${orphans.length})\n`
          + orphans.slice(0, MAX_LINES_PER_SECTION).map(line).join('\n')
          + (orphans.length > MAX_LINES_PER_SECTION ? `\n…and ${orphans.length - MAX_LINES_PER_SECTION} more` : '')
          + '\n\n';
      }
      text += `→ EN: Please reconcile the Sheet against Skybar.\n→ ID: Mohon cek Sheet vs Skybar.`;
      if (await postLark(url, text)) alerted = newOnes.length;
    }
  }

  // Upsert current state for every issue (even unchanged ones — refreshes sb_balance snapshot).
  if (issues.length) {
    const upserts = issues.map(i => {
      const prev = state.get(i.bk);
      // only bump alerted_at for the ones we actually alerted on
      const wasAlerted = newOnes.includes(i);
      return {
        bk: i.bk, flag: i.flag,
        sb_balance: i.sb_balance, sheet_balance: i.sheet_balance,
        alerted_at: wasAlerted ? nowIso : (prev ? prev.alerted_at : nowIso),
        updated_at: nowIso,
      };
    });
    for (let i = 0; i < upserts.length; i += 500) {
      await supabase.from('balance_alert_state')
        .upsert(upserts.slice(i, i + 500), { onConflict: 'bk' });
    }
  }
  // Prune state rows whose issue is now resolved (no longer in current issues).
  const activeBks = new Set(issues.map(i => i.bk));
  const toResolve = (stateRows || []).filter(r => !activeBks.has(r.bk)).map(r => r.bk);
  for (let i = 0; i < toResolve.length; i += 200) {
    await supabase.from('balance_alert_state').delete().in('bk', toResolve.slice(i, i + 200));
  }

  return { seeded: true, issues: issues.length, alerted, resolved: toResolve.length, summary };
}

module.exports = { reconcileBalanceAlerts };
