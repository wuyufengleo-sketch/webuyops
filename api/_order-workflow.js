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
const dmy = d => { try { return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); } catch { return '-'; } };

async function postLark(url, text) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msg_type: 'text', content: { text } }) });
    return r.ok;
  } catch { return false; }
}

function teamDigest(team, news, changes) {
  const line = r => `• ${r.bkg_no || r.id} | ${r.tour_code || '-'} ${r.tour_name || ''} | Dep ${dmy(r.departure_date)} | ${r.pax}pax`;
  let t = `<at user_id="all"></at>\n${team.emoji} ${team.name} — Order Alert / Notifikasi Pesanan`;
  if (news.length)    t += `\n\n🆕 New orders / Pesanan baru (${news.length})\n` + news.map(line).join('\n');
  if (changes.length) t += `\n\n🔄 Changed / Perubahan (${changes.length})\n` + changes.map(line).join('\n');
  t += `\n\n→ EN: ${team.en}\n→ ID: ${team.id}`;
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

module.exports = { reconcileWorkflow, TEAMS };
