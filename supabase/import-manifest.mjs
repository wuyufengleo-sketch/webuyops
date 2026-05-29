// One-time migration: Manifest & Roomlist (Google Sheet) → Supabase
// manifest_passengers. Sprint 8 batch 1. One TAB per tour group; tab name is
// stored as tour_label so the Manifest page can filter / group by departure.
//
//   node supabase/import-manifest.mjs --dry   # preview, no write
//   node supabase/import-manifest.mjs         # full replace + insert
//
// REQUIRES migration 008 (tour_label column) to be applied first.
// Credentials from .env; sheet read via public xlsx export.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as XLSX from 'xlsx';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');
const SHEET_ID = '1e_Trc5lQybFoyEJQh8Yu9qbDTkLC3V5p_SByH3HhvdM';

for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !line.trim().startsWith('#')) process.env[m[1]] = m[2];
}

const norm = s => String(s == null ? '' : s).trim().toUpperCase().replace(/\s+/g, ' ');
const txt = v => String(v == null ? '' : v).trim();
function dateCell(v) {
  if (typeof v === 'number' && isFinite(v) && v > 0) {
    const d = XLSX.SSF.parse_date_code(v);
    if (d && d.y) return `${d.d}/${d.m}/${d.y}`;
  }
  return txt(v);
}

// header synonyms → canonical field
const COLMAP = [
  ['no', ['NO']],
  ['name', ['NAME']],
  ['title', ['TITLE', 'SEX']],
  ['room', ['ROOM TYPE']],
  ['dob', ['DOB']],
  ['passport', ['NO.PASSPOR', 'NO. PASSPOR', 'NO PASSPOR', 'NO.PASSPORT', 'NO. PASSPORT', 'PASSPORT NO', 'PASSPORT NO.']],
  ['expiry', ['EXPIRED', 'EXPIRY']],
  ['bk', ['BK NO.', 'BK NO', 'ORDER NO.', 'ORDER NO']],
  ['sales', ['SALES']],
];

async function loadWb() {
  const r = await fetch(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=xlsx`, { redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.slice(0, 2).toString() !== 'PK') throw new Error('not xlsx (sheet private?)');
  return XLSX.read(buf, { type: 'buffer' });
}

const wb = await loadWb();
const out = [];
let seq = 0;
const skippedTabs = [];

for (const tab of wb.SheetNames) {
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[tab], { header: 1, blankrows: false, defval: '' });
  // header = first row (within first 8) containing both NAME and ROOM TYPE
  let h = -1;
  for (let i = 0; i < Math.min(8, rows.length); i++) {
    const cells = rows[i].map(norm);
    if (cells.includes('NAME') && cells.includes('ROOM TYPE')) { h = i; break; }
  }
  if (h < 0) { skippedTabs.push(tab); continue; }

  const H = rows[h].map(norm);
  const idx = {};
  for (const [field, labels] of COLMAP) {
    let ci = -1;
    for (const lbl of labels) { ci = H.indexOf(lbl); if (ci >= 0) break; }
    idx[field] = ci;
  }
  if (idx.name < 0) { skippedTabs.push(tab); continue; }

  const label = tab.trim();
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i];
    const name = txt(r[idx.name]);
    if (!name) continue;
    out.push({
      id: 'mft-sheet-' + (++seq),
      tour_label: label,
      no: idx.no >= 0 ? txt(r[idx.no]) : '',
      name,
      title: idx.title >= 0 ? txt(r[idx.title]) : '',
      room: idx.room >= 0 ? txt(r[idx.room]) : '',
      dob: idx.dob >= 0 ? dateCell(r[idx.dob]) : '',
      passport: idx.passport >= 0 ? txt(r[idx.passport]) : '',
      expiry: idx.expiry >= 0 ? dateCell(r[idx.expiry]) : '',
      bk: idx.bk >= 0 ? txt(r[idx.bk]) : '',
      sales: idx.sales >= 0 ? txt(r[idx.sales]) : '',
    });
  }
}

const groups = new Set(out.map(o => o.tour_label));
console.log(`解析: ${wb.SheetNames.length} 个标签 → ${groups.size} 个团, ${out.length} 名乘客`);
if (skippedTabs.length) console.log(`跳过(无表头) ${skippedTabs.length} 个标签:`, skippedTabs.join(' | '));
console.log('样例:');
out.slice(0, 4).forEach(u => console.log('  ', JSON.stringify({ tour_label: u.tour_label, no: u.no, name: u.name, dob: u.dob, passport: u.passport, expiry: u.expiry, bk: u.bk, sales: u.sales }).slice(0, 240)));

if (DRY) { console.log('\n[dry-run] 未写库。去掉 --dry 实际写入。'); process.exit(0); }

const { createClient } = await import('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// preflight: tour_label column must exist (migration 008)
const probe = await sb.from('manifest_passengers').select('tour_label').limit(1);
if (probe.error) { console.error('❌ tour_label 列不存在，请先在 SQL Editor 跑 migration 008。', probe.error.message); process.exit(1); }

const del = await sb.from('manifest_passengers').delete().neq('id', '');
if (del.error) { console.error('清理旧数据失败:', del.error.message); process.exit(1); }

let ok = 0;
for (let i = 0; i < out.length; i += 500) {
  const chunk = out.slice(i, i + 500);
  const { error } = await sb.from('manifest_passengers').insert(chunk);
  if (error) { console.error('写入失败 (chunk @' + i + '):', error.message); process.exit(1); }
  ok += chunk.length;
}
console.log(`\n✅ 已导入 ${ok} 名乘客 / ${groups.size} 个团到 manifest_passengers。`);
