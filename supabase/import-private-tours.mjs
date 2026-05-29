// One-time migration: List Private Req (Google Sheet) "UPDATE" tab → Supabase
// private_tours table. Sprint 8 batch 1.
//
//   node supabase/import-private-tours.mjs --dry   # preview, no write
//   node supabase/import-private-tours.mjs         # clear sheet-imported rows + insert
//
// Credentials from .env (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY). The sheet is
// read via the public xlsx export endpoint (shared "anyone with link – viewer").
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as XLSX from 'xlsx';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');
const SHEET_ID = '1Jx6PpgFeTfFpw6O1irXg9G0HT1wuCeSZ5_mDXToYJIk';
const TAB = 'UPDATE';
const ID_PREFIX = 'pvt-sheet-';   // marks rows that came from this migration

for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !line.trim().startsWith('#')) process.env[m[1]] = m[2];
}

const txt = v => String(v == null ? '' : v).trim();
// Excel serial (number) → "D/M/YYYY"; non-numeric text passed through unchanged.
function dateCell(v) {
  if (typeof v === 'number' && isFinite(v) && v > 0) {
    const d = XLSX.SSF.parse_date_code(v);
    if (d && d.y) return `${d.d}/${d.m}/${d.y}`;
  }
  return txt(v);
}

async function loadTab() {
  const r = await fetch(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=xlsx`, { redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.slice(0, 2).toString() !== 'PK') throw new Error('not xlsx (sheet private?)');
  const wb = XLSX.read(buf, { type: 'buffer' });
  if (!wb.Sheets[TAB]) throw new Error(`tab "${TAB}" not found`);
  return XLSX.utils.sheet_to_json(wb.Sheets[TAB], { header: 1, blankrows: false, defval: '' });
}

const rows = await loadTab();
// Header is row index 1 ("NO","DATE REQ",…); data starts at row 2.
const out = [];
for (let i = 2; i < rows.length; i++) {
  const r = rows[i];
  const dest = txt(r[7]);
  const tc = txt(r[6]);
  if (!dest && !tc) continue;                       // skip blank filler rows

  let contact = txt(r[2]);
  const link = txt(r[3]);
  if (link) contact = contact ? `${contact} | ${link}` : link;

  let budget = txt(r[15]);
  const price = txt(r[9]);
  if (!budget && price) budget = price;

  const revOverflow = [r[31], r[32], r[33], r[34]].map(txt).filter(Boolean).join(' · ');

  out.push({
    id: ID_PREFIX + (i - 1),
    dateReq: dateCell(r[1]),
    dateOffered: dateCell(r[4]),
    contact,
    rae: txt(r[5]),
    tc,
    dest,
    flight: txt(r[10]),
    dep: dateCell(r[11]),
    pax: txt(r[12]),
    specialReq: txt(r[13]),
    detailReq: txt(r[14]),
    budget,
    opsQuotation: txt(r[16]),
    status: txt(r[17]),
    sla2rae: dateCell(r[18]),
    sla4rae: dateCell(r[19]),
    sla6rae: dateCell(r[20]),
    itinReal1: txt(r[21]), itinReal2: txt(r[22]), itinReal3: txt(r[23]), itinReal4: txt(r[24]),
    itinInitial: txt(r[25]),
    itinRev2: txt(r[26]), itinRev3: txt(r[27]), itinRev4: txt(r[28]), itinRev5: txt(r[29]), itinRev6: txt(r[30]),
    opsUpdate: txt(r[35]),
    remarks: revOverflow,
    source: 'Private Sheet',
  });
}

console.log(`解析 ${TAB}: ${out.length} 条私团记录`);
console.log('样例:');
out.slice(0, 3).forEach(u => console.log('  ', JSON.stringify({ id: u.id, dateReq: u.dateReq, tc: u.tc, dest: u.dest, dep: u.dep, pax: u.pax, status: u.status }).slice(0, 220)));

if (DRY) { console.log('\n[dry-run] 未写库。去掉 --dry 实际写入。'); process.exit(0); }

const { createClient } = await import('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Full replace (table is sheet-sourced for this migration): clear all rows first.
const del = await sb.from('private_tours').delete().neq('id', '');
if (del.error) { console.error('清理旧数据失败:', del.error.message); process.exit(1); }

let ok = 0;
for (let i = 0; i < out.length; i += 500) {
  const chunk = out.slice(i, i + 500);
  const { error } = await sb.from('private_tours').insert(chunk);
  if (error) { console.error('写入失败:', error.message); process.exit(1); }
  ok += chunk.length;
}
console.log(`\n✅ 已导入 ${ok} 条私团记录到 private_tours。`);
