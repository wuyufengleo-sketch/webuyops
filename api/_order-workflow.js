// Cross-team order workflow reconciler — called by api/sync-skybar.js after the
// package_orders upsert. Keeps public.order_workflow in step with the synced
// orders and fires Lark notifications to each team on NEW / CHANGED orders.
//
//  • Board state lives in its own table so the sync's prune never wipes it.
//  • NEW  = order_id not yet on the board.
//  • CHANGED = fingerprint (tour_code|guest|infant|status|amount) differs.
//  • Detection is existence/fingerprint based, so each order notifies exactly
//    once per change — no per-sync re-spam.
//  • First ever run SEEDS the board silently (notified, no Lark) so the initial
//    backlog of orders doesn't blast every team.

const VALID = new Set([1, 2, 3, 4, 8, 9]); // 有效订单：排除 5转团/6退款中/7已退款/10取消
const SEED_KEY = 'order_workflow_seeded';

const TEAMS = [
  { col: 'ticketing', cfg: 'lark_ticketing_url', emoji: '🎫', name: 'Ticketing',
    en: 'Please check / book flights.', id: 'Mohon cek / booking tiket pesawat.' },
  { col: 'document',  cfg: 'lark_document_url',  emoji: '📄', name: 'Document',
    en: 'Prepare customer documents / passports & make the Manifest.', id: 'Siapkan dokumen / paspor pelanggan & buat Manifest.' },
  { col: 'cs',        cfg: 'lark_cs_url',        emoji: '📞', name: 'CS',
    en: 'Follow up guests, collect & upload personal data.', id: 'Follow up tamu, kumpulkan & upload data pribadi.' },
  { col: 'ops',       cfg: 'lark_ops_url',       emoji: '🧭', name: 'Operation',
    en: 'Overall coordination & arrange the land tour.', id: 'Koordinasi keseluruhan & atur land tour.' },
];

const fpOf = (o, tourCode) => [tourCode || '', o.guest_num || 0, o.infant || 0, o.order_status, o.total_amount || 0].join('|');
const dayMonth = d => { try { return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }); } catch { return '-'; } };

async function postLark(url, text) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msg_type: 'text', content: { text } }) });
    return r.ok;
  } catch { return false; }
}

// Group orders by tour_code + departure_date so duplicate bookings on the same
// tour collapse into one readable line. Sort by departure date ascending.
function groupRows(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = (r.tour_code || '?') + '|' + (r.departure_date || '');
    if (!m.has(k)) m.set(k, { tc: r.tour_code, dep: r.departure_date, pax: 0, n: 0 });
    const g = m.get(k);
    g.pax += r.pax || 0;
    g.n += 1;
  }
  return [...m.values()].sort((a, b) => new Date(a.dep || 0) - new Date(b.dep || 0));
}

function teamDigest(team, news, changes) {
  const line = g => `• ${dayMonth(g.dep)} · ${g.tc || '?'} · ${g.pax}pax${g.n > 1 ? ` (${g.n} bkg)` : ''}`;
  let t = `<at user_id="all"></at>\n${team.emoji} ${team.name} — Order Alert / Notifikasi Pesanan`;
  if (news.length) {
    const g = groupRows(news);
    const head = g.length < news.length ? `${news.length} orders / ${g.length} groups` : `${news.length}`;
    t += `\n\n🆕 New (${head})\n` + g.map(line).join('\n');
  }
  if (changes.length) {
    const g = groupRows(changes);
    t += `\n\n🔄 Changed (${changes.length})\n` + g.map(line).join('\n');
  }
  t += `\n\n→ ${team.en} · ${team.id}`;
  return t;
}

async function reconcileWorkflow(supabase, orders, packages) {
  // tour_id → {tour_code, tour_name, departure_date}
  const tourMap = new Map();
  for (const p of packages) tourMap.set(Number(p.tour_id), p);

  const active = orders.filter(o => VALID.has(o.order_status));
  const rowOf = o => {
    const t = tourMap.get(Number(o.tour_id)) || {};
    return {
      id: o.id, tour_id: Number(o.tour_id), bkg_no: o.bkg_no || null,
      tour_code: t.tour_code || null, tour_name: t.tour_name || null,
      departure_date: t.departure_date || null,
      pax: (o.guest_num || 0) + (o.infant || 0),
      fingerprint: fpOf(o, t.tour_code), notified: true,
    };
  };

  // first-ever run? seed silently
  const { data: seedCfg } = await supabase.from('app_config').select('value').eq('key', SEED_KEY).maybeSingle();
  const seeded = !!(seedCfg && seedCfg.value);

  // existing board rows
  const { data: existRows, error: exErr } = await supabase.from('order_workflow').select('id, fingerprint');
  if (exErr) throw new Error('order_workflow read: ' + exErr.message);
  const existing = new Map((existRows || []).map(r => [r.id, r.fingerprint]));

  async function upsertRows(rows) {
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from('order_workflow').upsert(rows.slice(i, i + 500), { onConflict: 'id' });
      if (error) throw new Error('order_workflow upsert: ' + error.message);
    }
  }

  if (!seeded) {
    await upsertRows(active.map(rowOf));
    await supabase.from('app_config').upsert({ key: SEED_KEY, value: '1' }, { onConflict: 'key' });
    return { seeded: true, newCount: active.length, changedCount: 0, notified: 0 };
  }

  // classify
  const news = [], changes = [];
  for (const o of active) {
    const r = rowOf(o);
    if (!existing.has(o.id)) news.push(r);
    else if (existing.get(o.id) !== r.fingerprint) changes.push(r);
  }

  // prune board rows whose order is no longer active (cancelled / gone)
  const activeIds = new Set(active.map(o => o.id));
  const toDelete = (existRows || []).map(r => r.id).filter(id => !activeIds.has(id));
  for (let i = 0; i < toDelete.length; i += 200) {
    await supabase.from('order_workflow').delete().in('id', toDelete.slice(i, i + 200));
  }

  // write new + changed (board is source of truth; statuses preserved on update)
  await upsertRows([...news, ...changes]);

  // Drift repair: catch denorm fields that went stale (e.g. bkg_no first arrived
  // in upstream AFTER the seed run wrote a row without it). Only updates fields
  // we own; status columns are untouched.
  const sameFp = active.filter(o => existing.has(o.id) && existing.get(o.id) === fpOf(o, (tourMap.get(Number(o.tour_id))||{}).tour_code));
  if (sameFp.length) {
    const { data: denormRows } = await supabase.from('order_workflow').select('id, bkg_no, tour_code, tour_name, departure_date, pax').in('id', sameFp.map(o => o.id));
    const byId = new Map((denormRows || []).map(r => [r.id, r]));
    const repairs = [];
    for (const o of sameFp) {
      const cur = byId.get(o.id); if (!cur) continue;
      const r = rowOf(o);
      const patch = {};
      if (cur.bkg_no         !== r.bkg_no)         patch.bkg_no         = r.bkg_no;
      if (cur.tour_code      !== r.tour_code)      patch.tour_code      = r.tour_code;
      if (cur.tour_name      !== r.tour_name)      patch.tour_name      = r.tour_name;
      if (cur.pax            !== r.pax)            patch.pax            = r.pax;
      // departure_date string comparison can be flaky; only patch when sourceIs set and target is null
      if (!cur.departure_date && r.departure_date) patch.departure_date = r.departure_date;
      if (Object.keys(patch).length) repairs.push({ id: o.id, patch });
    }
    // Batch in chunks of 20 concurrent updates to stay under serverless time limits.
    for (let i = 0; i < repairs.length; i += 20) {
      await Promise.all(repairs.slice(i, i + 20).map(({ id, patch }) =>
        supabase.from('order_workflow').update(patch).eq('id', id)
      ));
    }
  }

  // best-effort Lark digest per team
  let notified = 0;
  if (news.length || changes.length) {
    const { data: cfgRows } = await supabase.from('app_config').select('key, value').in('key', TEAMS.map(t => t.cfg));
    const cfg = Object.fromEntries((cfgRows || []).map(r => [r.key, r.value]));
    for (const team of TEAMS) {
      const url = cfg[team.cfg];
      if (!url) continue;
      if (await postLark(url, teamDigest(team, news, changes))) notified++;
    }
  }

  return { seeded: true, newCount: news.length, changedCount: changes.length, notified };
}

// ============================================================================
//  Phase 2 — auto-derive *_status from upstream data, but only for cells that
//  have never been hand-edited (i.e. *_status_manual_at IS NULL). Single-
//  direction: only promotes to 'Done'. Leaves Pending alone (avoids ratchet
//  flip-flop while ticketing/manifests are still partial).
//
//  Rules:
//    ticketing_status ← ticketing.status ∈ {'BOOKED','ISSUED'}    (keyed by tour_code)
//    document_status  ← all manifests.passport non-empty for the BK
//    cs_status        ← bk_groups.wa_link present for the BK
//    ops_status       ← all vendor_payments.status match /DONE|PAID/ for the tour
// ============================================================================
async function reconcileWorkflowStatuses(supabase) {
  const [boardRes, tktRes, mftRes, vpRes, bkgRes] = await Promise.all([
    supabase.from('order_workflow').select('id, bkg_no, tour_code, ticketing_status, document_status, cs_status, ops_status, ticketing_status_manual_at, document_status_manual_at, cs_status_manual_at, ops_status_manual_at'),
    supabase.from('ticketing').select('tour_code, status'),
    supabase.from('manifests').select('bk, passport'),
    supabase.from('vendor_payments').select('tourcode, status'),
    supabase.from('bk_groups').select('bkg_no, wa_link'),
  ]);
  if (boardRes.error) throw new Error('order_workflow read (status): ' + boardRes.error.message);
  const board = boardRes.data || [];
  if (!board.length) return { scanned: 0, promoted: 0 };

  // Indexes
  const tktByTour = new Map();
  for (const t of (tktRes.data || [])) {
    if (t.tour_code) tktByTour.set(String(t.tour_code).toUpperCase(), t.status || '');
  }
  // BK → {total, withPassport}
  const mftByBk = new Map();
  for (const m of (mftRes.data || [])) {
    if (!m.bk) continue;
    const k = String(m.bk).toUpperCase();
    if (!mftByBk.has(k)) mftByBk.set(k, { total: 0, withPp: 0 });
    const g = mftByBk.get(k);
    g.total++;
    if (m.passport && String(m.passport).trim()) g.withPp++;
  }
  // tour → {total, done}
  const vpByTour = new Map();
  for (const v of (vpRes.data || [])) {
    if (!v.tourcode) continue;
    const k = String(v.tourcode).toUpperCase();
    if (!vpByTour.has(k)) vpByTour.set(k, { total: 0, done: 0 });
    const g = vpByTour.get(k);
    g.total++;
    if (/DONE|PAID/i.test(v.status || '')) g.done++;
  }
  // bkg_no → wa_link presence
  const bkgWithLink = new Set();
  for (const g of (bkgRes.data || [])) {
    if (g.bkg_no && g.wa_link) bkgWithLink.add(String(g.bkg_no).toUpperCase());
  }

  // Derive per-row patches (only fields where manual_at IS NULL and current ≠ 'Done')
  const updates = [];
  for (const r of board) {
    const patch = {};
    const tour = (r.tour_code || '').toUpperCase();
    const bk = (r.bkg_no || '').toUpperCase();

    if (!r.ticketing_status_manual_at && r.ticketing_status !== 'Done' && tour) {
      const s = tktByTour.get(tour);
      if (s && /^(BOOKED|ISSUED)$/i.test(s)) patch.ticketing_status = 'Done';
    }
    if (!r.document_status_manual_at && r.document_status !== 'Done' && bk) {
      const g = mftByBk.get(bk);
      if (g && g.total > 0 && g.withPp === g.total) patch.document_status = 'Done';
    }
    if (!r.cs_status_manual_at && r.cs_status !== 'Done' && bk) {
      if (bkgWithLink.has(bk)) patch.cs_status = 'Done';
    }
    if (!r.ops_status_manual_at && r.ops_status !== 'Done' && tour) {
      const g = vpByTour.get(tour);
      if (g && g.total > 0 && g.done === g.total) patch.ops_status = 'Done';
    }

    if (Object.keys(patch).length) updates.push({ id: r.id, ...patch });
  }

  let promoted = 0;
  // Per-row update (so we don't clobber columns we didn't touch), but in
  // chunks of 20 concurrent calls to stay well under the 30s function limit.
  for (let i = 0; i < updates.length; i += 20) {
    const results = await Promise.all(updates.slice(i, i + 20).map(u => {
      const { id, ...patch } = u;
      return supabase.from('order_workflow').update(patch).eq('id', id);
    }));
    for (const r of results) if (!r.error) promoted++;
  }
  return { scanned: board.length, promoted };
}

module.exports = { reconcileWorkflow, reconcileWorkflowStatuses, TEAMS };
