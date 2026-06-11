// Ticketing reconciliation: read every tab of the Ticketing Sheet 1 (public CSV),
// resolve each tab's declared tour_code, derive per-pax ISSUED/BOOKED status from
// the PNR column that lives directly in Sheet 1, verify pax names against
// skybar_passengers, and (with --write) upsert the `ticketing` summary table so the
// Ticketing Tracker stops showing 未开票 for tours that are actually done.
//
//   Dry-run : node --env-file=.env supabase/recon-ticketing-sync.mjs
//   Write   : node --env-file=.env supabase/recon-ticketing-sync.mjs --write
//   Items   : add --items to ALSO upsert per-pax ticketing_items rows
//
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';

const WRITE = process.argv.includes('--write');
const WRITE_ITEMS = process.argv.includes('--items');
const SHEET_ID = '1alf5os3_9k0z2UWuvpFKQrEW5PqHCGljeisqO_yB7SI';
const tabs = JSON.parse(fs.readFileSync('/tmp/tkt_tabs.json', 'utf8'));

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ── ported helpers (verbatim semantics from app.html) ───────────────────────
const _TKT_TITLE_TOKENS = new Set(['MR','MRS','MS','MISS','MSTR','MASTER','MADAM','MISTER','INF','CHD']);
const cleanText = v => String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
const normKey = v => cleanText(v).toUpperCase();
const headerKey = v => normKey(v).replace(/[^A-Z0-9]/g, '');
function normBk(v){
  const m = String(v || '').toUpperCase().match(/BK\s*0*\d+/);
  if (!m) return '';
  return 'BK' + m[0].replace(/\D/g, '').padStart(6, '0');
}
const extractCodes = t => [...new Set(String(t || '').toUpperCase().match(/\b\d{2}WB[A-Z0-9]+(?:\/\d{2})?\b/g) || [])];
function tourCodeKeys(code){
  const raw = String(code || '').trim().toUpperCase();
  if (!raw) return [];
  const base = raw.replace(/\/\d{2}$/, '');
  const compact = s => s.replace(/[^A-Z0-9]/g, '');
  return [...new Set([raw, compact(raw), base, compact(base)].filter(Boolean))];
}
function normName(name){
  let s = String(name || '').toUpperCase();
  s = s.replace(/^\s*\d+(?:\.\d+)*\s*/, '').replace(/[\/,.;:()]+/g, ' ');
  return s.split(/\s+/).map(t => t.replace(/[^A-Z]/g, '')).filter(t => t && !_TKT_TITLE_TOKENS.has(t));
}
function looksLikeFlight(raw){
  const s = String(raw || '').toUpperCase().trim();
  if (!s || /^GROUP\s+SEAT/i.test(s)) return false;
  if (/^\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?$/.test(s)) return false;
  if (/^(FIT|F\/T|ISSUED|HOLD|PENDING|DONE|TBA|TBC|NO|YES|N\/A)$/i.test(s)) return false;
  return /\b[A-Z0-9]{2}\s?\d{2,4}\b/.test(s);
}
// minimal RFC-4180 CSV parser
function parseCsv(text){
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++){
    const c = text[i];
    if (q){
      if (c === '"'){ if (text[i+1] === '"'){ field += '"'; i++; } else q = false; }
      else field += c;
    } else {
      if (c === '"') q = true;
      else if (c === ','){ row.push(field); field = ''; }
      else if (c === '\n'){ row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r'){ /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length){ row.push(field); rows.push(row); }
  return rows;
}

// parseSheet1Tab port + PNR capture
function parseTab(rows, tabTitle){
  let hdr = -1;
  for (let i = 0; i < Math.min(12, rows.length); i++){
    const keys = (rows[i] || []).map(headerKey);
    if (keys.includes('NO') && keys.includes('NAME')){ hdr = i; break; }
  }
  if (hdr < 0) return { tabTitle, rows: [], declaredTourCode: '', noHeader: true };
  let declared = '';
  outer: for (let i = 0; i < hdr; i++){
    for (const cell of (rows[i] || [])){
      const hits = extractCodes(String(cell || '').trim());
      if (hits.length){ declared = hits[0]; break outer; }
    }
  }
  const H = (rows[hdr] || []).map(headerKey);
  const iNo = H.indexOf('NO');
  let iName = H.indexOf('NAME');
  let iSex = H.findIndex(h => h === 'SEX' || h === 'TITLE' || h === 'GENDER');
  let iBk = H.findIndex(h => ['BK','BKNO','BKG','BKGNO','BOOKING','BOOKINGNO'].includes(h));
  const iPnr = H.findIndex(h => h === 'PNR' || h === 'PNRNO' || h === 'BOOKINGCODE' || h === 'CODE');
  // Column-shift correction: some tabs insert an unlabelled title column, so the
  // real names sit one column right of the "NAME" header (header not updated).
  // Among candidate columns pick the one whose data rows hold the most real
  // names (≥2 alpha tokens left after stripping MR/MRS/… titles).
  if (iName >= 0){
    const TITLES = new Set(['MR','MRS','MS','MISS','MSTR','MASTER','MADAM','MISTER','INF','CHD','M','F']);
    const score = col => {
      if (col < 0) return -1;
      let names = 0, titles = 0;
      for (let r = hdr + 1; r < Math.min(rows.length, hdr + 25); r++){
        const v = cleanText((rows[r] || [])[col]).toUpperCase();
        if (!v) continue;
        if (TITLES.has(v)) { titles++; continue; }
        if (normName(v).length >= 1 && /[A-Z]{2,}/.test(v)) names++;
      }
      return names - titles * 2;
    };
    const cand = [iName, iName + 1, iName + 2].filter(c => c >= 0 && !H[c]?.match(/^(BK|SALES|TC|SEGMENT)/));
    let best = iName, bestScore = score(iName);
    for (const c of cand){ const s = score(c); if (s > bestScore){ bestScore = s; best = c; } }
    if (best !== iName){ if (iSex < 0) iSex = iName; iName = best; }
  }
  const firstFlight = Math.max(4, Math.max(iNo, iName, iSex, iBk) + 1);
  const REPEATED = new Set(['NO','NAME','SEX','TITLE','GENDER','BK','BKNO','BKG','BKGNO','BOOKING','BOOKINGNO','TC','PAX','#']);
  const CITY = new Set(['JAKARTA','JKT','CGK','SURABAYA','SUB','MEDAN','MES','BANDUNG','BDO','SEMARANG','SRG','MAKASSAR','UPG','BALI','DPS','YOGYA','JOG','PALEMBANG','PLM','MANADO','MDC','BATAM','BTH','PEKANBARU','PKU','PADANG','PAD']);
  const out = [];
  for (let r = hdr + 1; r < rows.length; r++){
    const row = rows[r] || [];
    const name = cleanText(row[iName]);
    if (!name) continue;
    const nameU = name.toUpperCase().replace(/\s+/g, ' ').trim();
    if (REPEATED.has(nameU) || CITY.has(nameU)) continue;
    if (/^TOTAL\b|^NOTE\b|^GROUP\b/i.test(name)) continue;
    // One entry per flight leg, mirroring the app: label from the SEGMENT n
    // header when present, raw text kept for ticketing_items.remark.
    const segs = [];
    for (let c = firstFlight; c < row.length; c++){
      if (c === iPnr) continue;
      const raw = cleanText(row[c]);
      if (!raw || !looksLikeFlight(raw)) continue;
      const hm = String(H[c] || '').match(/^SEGMENT(\d+)$/);
      segs.push({ label: hm ? 'SEG' + hm[1] : 'SEG' + (segs.length + 1), raw });
    }
    const pnr = iPnr >= 0 ? cleanText(row[iPnr]).toUpperCase() : '';
    const validPnr = /^[A-Z0-9]{5,7}$/.test(pnr) ? pnr : '';
    out.push({
      tabTitle, name, nameTokens: normName(name), bk: iBk >= 0 ? normBk(row[iBk]) : '',
      segs, hasFlights: segs.length > 0, pnr: validPnr,
      status: validPnr ? 'ISSUED' : (segs.length > 0 ? 'BOOKED' : 'NOT BOOKED'),
    });
  }
  // dedup by name within tab (merge legs like the app: union by raw text)
  const seen = new Map();
  const deduped = [];
  for (const p of out){
    const k = p.name.toUpperCase().replace(/\s+/g, ' ').trim();
    if (!seen.has(k)){ seen.set(k, p); deduped.push(p); }
    else {
      const e = seen.get(k);
      if (p.pnr && !e.pnr){ e.pnr = p.pnr; e.status = 'ISSUED'; }
      const have = new Set(e.segs.map(s => s.raw.toUpperCase()));
      for (const s of p.segs) if (!have.has(s.raw.toUpperCase())){ e.segs.push(s); have.add(s.raw.toUpperCase()); }
      e.hasFlights = e.segs.length > 0;
    }
  }
  return { tabTitle, rows: deduped, declaredTourCode: declared };
}

async function fetchCsv(gid){
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`;
  for (let a = 0; a < 3; a++){
    try {
      const r = await fetch(url);
      if (r.ok) return await r.text();
    } catch {}
    await new Promise(res => setTimeout(res, 400 * (a + 1)));
  }
  return null;
}

// ── load DB context ──────────────────────────────────────────────────────────
async function loadAll(table, cols){
  let acc = [], from = 0;
  for (;;){
    const { data, error } = await sb.from(table).select(cols).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    acc = acc.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return acc;
}

console.log('Loading DB context (package_sales, package_orders, skybar_passengers, ticketing)…');
const pkg = await loadAll('package_sales', 'tour_id,tour_code,tour_name,departure_date');
const orders = await loadAll('package_orders', 'order_id,tour_id,bkg_no');
const pax = await loadAll('skybar_passengers', 'order_id,name');
const tktNow = await loadAll('ticketing', 'tour_code,status');

// tour_code canonicalization index
const codeKeyToCanonical = new Map();
for (const p of pkg){ if (!p.tour_code) continue; for (const k of tourCodeKeys(p.tour_code)) codeKeyToCanonical.set(k, p.tour_code); }
function canonical(raw){
  for (const k of tourCodeKeys(raw)) if (codeKeyToCanonical.has(k)) return codeKeyToCanonical.get(k);
  return raw; // orphan
}
// tour_code -> skybar pax name-token sets (via order -> tour)
const tourIdToCode = new Map(pkg.map(p => [Number(p.tour_id), p.tour_code]));
const orderToCode = new Map();
for (const o of orders){ const c = tourIdToCode.get(Number(o.tour_id)); if (c) orderToCode.set(Number(o.order_id), c); }
const codeToPaxNames = new Map();
// code → (name-token-string → Set<bkg_no>) — used to backfill bkg_no for sheet
// rows whose BK column holds junk like "TL"/"M". The per-tour drill-down joins
// ticketing_items by bkg_no, so rows without it are invisible there.
const codeToNameBk = new Map();
const orderToBk = new Map(orders.map(o => [Number(o.order_id), normBk(o.bkg_no)]));
for (const px of pax){
  const c = orderToCode.get(Number(px.order_id));
  if (!c) continue;
  const key = c.toUpperCase();
  if (!codeToPaxNames.has(key)) codeToPaxNames.set(key, []);
  const tok = normName(px.name).join(' ');
  codeToPaxNames.get(key).push(tok);
  const bk = orderToBk.get(Number(px.order_id));
  if (tok && bk){
    if (!codeToNameBk.has(key)) codeToNameBk.set(key, new Map());
    const m = codeToNameBk.get(key);
    if (!m.has(tok)) m.set(tok, new Set());
    m.get(tok).add(bk);
  }
}
// Resolve a missing BK by name within a tour: exact token-string hit first,
// then 0.6 token-overlap — only when the answer is a single unambiguous BK.
function backfillBk(code, nameTokens){
  const m = codeToNameBk.get(code.toUpperCase());
  if (!m || !nameTokens.length) return '';
  const tok = nameTokens.join(' ');
  const exact = m.get(tok);
  if (exact && exact.size === 1) return [...exact][0];
  const rs = new Set(nameTokens);
  const hits = new Set();
  for (const [dn, bks] of m){
    const ds = new Set(dn.split(' '));
    let inter = 0; for (const t of rs) if (ds.has(t)) inter++;
    if (inter && inter / Math.min(rs.size, ds.size) >= 0.6) for (const b of bks) hits.add(b);
    if (hits.size > 1) return '';
  }
  return hits.size === 1 ? [...hits][0] : '';
}
const tktNowByCode = new Map(tktNow.map(r => [String(r.tour_code).toLowerCase(), r.status]));

// Reverse maps for tabs that don't declare a tour code:
//   bkToCode    — BK number  → tour_code   (authoritative: package_orders)
//   nameToCode  — pax-name-token-string → [tour_code,…]  (voting fallback)
const bkToCode = new Map();
for (const o of orders){ const c = tourIdToCode.get(Number(o.tour_id)); const bk = normBk(o.bkg_no); if (c && bk) bkToCode.set(bk, c); }
const nameToCode = new Map();
for (const [code, names] of codeToPaxNames){
  for (const n of names){ if (!n) continue; if (!nameToCode.has(n)) nameToCode.set(n, new Set()); nameToCode.get(n).add(code); }
}
// Resolve a parsed tab to a tour_code via the same authority order the app uses.
function resolveCode(res, tabName){
  const declared = res.declaredTourCode || extractCodes(tabName)[0] || '';
  if (declared) return { code: canonical(declared), source: 'declared', confidence: 'high' };
  // BK vote
  const bkVotes = new Map();
  let bkPax = 0;
  for (const r of res.rows){ if (!r.bk) continue; bkPax++; const c = bkToCode.get(r.bk); if (c) bkVotes.set(c, (bkVotes.get(c) || 0) + 1); }
  let bkWin = null, bkMax = 0; for (const [c, n] of bkVotes){ if (n > bkMax){ bkMax = n; bkWin = c; } }
  if (bkWin && bkMax >= 2 && bkMax >= bkPax * 0.4) return { code: bkWin.toUpperCase(), source: 'bk', confidence: 'high', votes: `${bkMax}/${bkPax}bk` };
  // name reverse vote
  const nameVotes = new Map();
  let named = 0;
  for (const r of res.rows){ const tok = r.nameTokens.join(' '); if (!tok) continue; named++; const set = nameToCode.get(tok); if (set) for (const c of set) nameVotes.set(c, (nameVotes.get(c) || 0) + 1); }
  let nWin = null, nMax = 0; for (const [c, n] of nameVotes){ if (n > nMax){ nMax = n; nWin = c; } }
  if (nWin && nMax >= 3 && nMax >= named * 0.3){
    const share = named ? nMax / named : 0;
    return { code: nWin.toUpperCase(), source: 'name-reverse', confidence: share >= 0.5 ? 'medium' : 'low', votes: `${nMax}/${named}nm` };
  }
  return { code: '', source: '', confidence: '' };
}

// ── fetch + parse all tabs (concurrency 8) ───────────────────────────────────
console.log(`Fetching ${tabs.length} tabs…`);
const parsed = [];
const CONC = 8;
for (let i = 0; i < tabs.length; i += CONC){
  const batch = tabs.slice(i, i + CONC);
  const csvs = await Promise.all(batch.map(t => fetchCsv(t.gid)));
  for (let j = 0; j < batch.length; j++){
    const csv = csvs[j];
    if (!csv){ parsed.push({ tab: batch[j], fetchFail: true }); continue; }
    parsed.push({ tab: batch[j], result: parseTab(parseCsv(csv), batch[j].name) });
  }
  process.stdout.write(`\r  parsed ${Math.min(i + CONC, tabs.length)}/${tabs.length}`);
}
console.log('');

// ── build per-tour proposal + name check ──────────────────────────────────────
const proposals = [];        // { tour_code, status, breakdown, nameMatch }
const unmapped = [];          // tabs with no resolvable tour code
const itemsPayload = [];
for (const p of parsed){
  if (p.fetchFail){ unmapped.push({ tab: p.tab.name, reason: 'fetch failed' }); continue; }
  const res = p.result;
  if (res.noHeader){ unmapped.push({ tab: p.tab.name, reason: 'no NO/NAME header' }); continue; }
  const resolved = resolveCode(res, p.tab.name);
  if (!resolved.code){ unmapped.push({ tab: p.tab.name, reason: 'no tour code', pax: res.rows.length }); continue; }
  const code = canonical(resolved.code);
  const raw = resolved.code;
  const orphan = !codeKeyToCanonical.has(tourCodeKeys(code)[0]) && !tourCodeKeys(code).some(k => codeKeyToCanonical.has(k));
  const b = { total: 0, issued: 0, booked: 0, notBooked: 0 };
  for (const r of res.rows){ b.total++; if (r.status === 'ISSUED') b.issued++; else if (r.status === 'BOOKED') b.booked++; else b.notBooked++; }
  const status = b.total && b.issued === b.total ? 'ISSUED' : b.issued > 0 ? 'PARTIAL' : b.booked > 0 ? 'BOOKED' : 'NOT BOOKED';
  // name match vs skybar_passengers
  const dbNames = new Set((codeToPaxNames.get(code.toUpperCase()) || []).filter(Boolean));
  let matched = 0;
  for (const r of res.rows){
    const tok = r.nameTokens.join(' ');
    if (!tok) continue;
    if (dbNames.has(tok)) { matched++; continue; }
    // token-overlap fallback
    const rs = new Set(r.nameTokens);
    let hit = false;
    for (const dn of dbNames){ const ds = new Set(dn.split(' ')); let inter = 0; for (const t of rs) if (ds.has(t)) inter++; if (inter && inter / Math.min(rs.size, ds.size) >= 0.6){ hit = true; break; } }
    if (hit) matched++;
  }
  proposals.push({
    tab: p.tab.name, tour_code: code.toLowerCase(), rawCode: raw, orphan,
    source: resolved.source, confidence: resolved.confidence, votes: resolved.votes || '',
    status, breakdown: b, paxSheet: res.rows.length, paxDb: dbNames.size,
    nameMatched: matched, nameMatchPct: res.rows.length ? Math.round(matched / res.rows.length * 100) : 0,
    curStatus: tktNowByCode.get(code.toLowerCase()) || '(none)',
    pnrs: [...new Set(res.rows.map(r => r.pnr).filter(Boolean))],
  });
  if (!orphan && p.tab.name.toLowerCase() !== 'testing' && resolved.confidence !== 'low'){
    for (const r of res.rows){
      // One ticketing_items row per flight leg (remark = raw segment text) so the
      // per-tour drill-down shows the actual flights; no-flight pax get one SEG1
      // placeholder row — exactly what the in-app sync produces.
      const bk = r.bk || backfillBk(code, r.nameTokens) || null;
      const legs = r.hasFlights ? r.segs : [{ label: 'SEG1', raw: '' }];
      for (const leg of legs){
        itemsPayload.push({ tour_code: code.toLowerCase(), bkg_no: bk, pax_name: r.name, segment: leg.label, ticket_no: r.pnr || null, status: r.status, remark: leg.raw || null, currency: 'IDR' });
      }
    }
  }
}

// ── report ────────────────────────────────────────────────────────────────────
proposals.sort((a, b) => a.tour_code.localeCompare(b.tour_code));
const changed = proposals.filter(p => p.curStatus.toUpperCase() !== p.status.toUpperCase());
console.log(`\n================= RECON SUMMARY =================`);
console.log(`tabs total            : ${tabs.length}`);
console.log(`resolved to tour_code : ${proposals.length}`);
console.log(`unmapped tabs         : ${unmapped.length}`);
console.log(`orphan codes (no pkg) : ${proposals.filter(p => p.orphan).length}`);
console.log(`status WOULD CHANGE   : ${changed.length}`);
const dist = {}; for (const p of proposals) dist[p.status] = (dist[p.status] || 0) + 1;
console.log(`proposed status dist  : ${JSON.stringify(dist)}`);
const srcDist = {}; for (const p of proposals) srcDist[p.source] = (srcDist[p.source] || 0) + 1;
console.log(`resolved by source    : ${JSON.stringify(srcDist)}`);

console.log(`\n--- newly-mapped tabs (no declared code → resolved via bk/name) ---`);
for (const p of proposals.filter(x => x.source !== 'declared')){
  console.log(`  ${p.tour_code.padEnd(20)} ${p.source.padEnd(12)} ${p.confidence.padEnd(7)} ${(p.votes||'').padEnd(8)} ${p.status.padEnd(10)} name${p.nameMatchPct}%  ${p.tab}`);
}

console.log(`\n--- tours whose status WOULD CHANGE (cur → new) ---`);
console.log('tour_code'.padEnd(20), 'cur'.padEnd(11), 'new'.padEnd(11), 'pax(sheet/db)', 'name%', 'src', 'tab');
for (const p of changed){
  console.log(
    p.tour_code.padEnd(20),
    String(p.curStatus).padEnd(11),
    p.status.padEnd(11),
    `${p.paxSheet}/${p.paxDb}`.padEnd(13),
    `${p.nameMatchPct}%`.padEnd(6),
    (p.source||'').padEnd(13),
    (p.orphan ? '⚠orphan ' : '') + p.tab,
  );
}
console.log(`\n--- LOW name-match (<60%) flagged for review ---`);
for (const p of proposals.filter(x => x.paxDb > 0 && x.nameMatchPct < 60)){
  console.log(`  ${p.tour_code.padEnd(20)} match ${p.nameMatchPct}% (sheet ${p.paxSheet} / db ${p.paxDb})  ${p.tab}`);
}
console.log(`\n--- UNMAPPED tabs (no tour code resolved) ---`);
for (const u of unmapped) console.log(`  ${u.reason.padEnd(18)} ${u.tab}${u.pax ? ` (${u.pax} pax)` : ''}`);

fs.writeFileSync('/tmp/tkt_proposals.json', JSON.stringify({ proposals, unmapped, changed }, null, 2));
console.log(`\nFull proposal written to /tmp/tkt_proposals.json`);

// ── write ─────────────────────────────────────────────────────────────────────
if (WRITE){
  // snapshot current ticketing rows first
  fs.writeFileSync('/tmp/tkt_backup_ticketing.json', JSON.stringify(tktNow, null, 2));
  const RANK = { 'ISSUED': 4, 'PARTIAL': 3, 'BOOKED': 2, 'NOT BOOKED': 1 };
  // Skip the junk "testing" tab and orphan codes (not in package_sales, so the
  // Ticketing Tracker can't display them anyway). Dedup by tour_code keeping the
  // highest status when two tabs map to the same code.
  // Exclude: junk "testing" tab, orphan codes (not displayable), and
  // low-confidence name-reverse guesses (could attach to the wrong tour).
  const writable = proposals.filter(p => p.tab.toLowerCase() !== 'testing' && !p.orphan && p.confidence !== 'low');
  const byCode = new Map();
  for (const p of writable){
    const ex = byCode.get(p.tour_code);
    if (!ex || RANK[p.status] > RANK[ex.status]) byCode.set(p.tour_code, p);
  }
  const summaryRows = [...byCode.values()].map(p => ({
    tour_code: p.tour_code, status: p.status,
    pnr: p.pnrs.slice(0, 4).join(', ') || null,
    notes: `Sheet recon ${new Date().toISOString().slice(0,10)}: ${p.breakdown.issued}/${p.breakdown.total} issued${p.pnrs.length ? ` · ${p.pnrs.length} PNR` : ''}${p.nameMatchPct < 60 ? ` · ⚠name-match ${p.nameMatchPct}%` : ''}`,
  }));
  console.log(`\nSkipped: testing tab + ${proposals.filter(p=>p.orphan).length} orphan codes. Writing ${summaryRows.length} ticketing summary rows…`);
  for (let i = 0; i < summaryRows.length; i += 200){
    const { error } = await sb.from('ticketing').upsert(summaryRows.slice(i, i + 200), { onConflict: 'tour_code' });
    if (error){ console.error('upsert ticketing error', error); process.exit(1); }
  }
  console.log('✅ ticketing summary upserted.');
  if (WRITE_ITEMS){
    // Idempotent insert — skip rows already present (mirrors app _tktItemDedupKey:
    // tour_code | bkg_no | pax_name | segment | ticket_no | remark).
    const dedupKey = r => [
      String(r.tour_code || '').toUpperCase(), normBk(r.bkg_no || ''),
      normName(r.pax_name || '').join(' '), String(r.segment || '').toUpperCase(),
      String(r.ticket_no || '').toUpperCase(), String(r.remark || '').toUpperCase(),
    ].join('|');
    const existing = await loadAll('ticketing_items', 'tour_code,bkg_no,pax_name,segment,ticket_no,remark');
    const seen = new Set(existing.map(r => [
      String(r.tour_code || '').toUpperCase(), normBk(r.bkg_no || ''),
      normName(r.pax_name || '').join(' '), String(r.segment || '').toUpperCase(),
      String(r.ticket_no || '').toUpperCase(), String(r.remark || '').toUpperCase(),
    ].join('|')));
    const fresh = itemsPayload.filter(r => !seen.has(dedupKey(r)));
    console.log(`Writing ${fresh.length} new ticketing_items rows (skipped ${itemsPayload.length - fresh.length} dups)…`);
    for (let i = 0; i < fresh.length; i += 200){
      const { error } = await sb.from('ticketing_items').insert(fresh.slice(i, i + 200));
      if (error){ console.error('insert ticketing_items error', error); process.exit(1); }
    }
    console.log('✅ ticketing_items inserted.');
  }
} else {
  console.log(`\n(DRY-RUN — no DB writes. Re-run with --write to apply, --items to also load per-pax rows.)`);
}
