// One-time migration: Refund List → REFUND WEBUY CUST tab → Supabase refunds.
// Sprint 8 batch 2.
//
//   node supabase/import-refunds.mjs --dry
//   node supabase/import-refunds.mjs            # full replace + insert
//
// REQUIRES migration 009. Credentials from .env; sheet read via public xlsx export.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as XLSX from 'xlsx';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');
const SHEET_ID = '1Sho_OVnL8_2e-r9_9GIwAZP5lehT_phUZsGgZ_nsfvQ';
const TAB = 'REFUND WEBUY CUST';

for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !line.trim().startsWith('#')) process.env[m[1]] = m[2];
}

const txt = v => String(v == null ? '' : v).trim().replace(/[\r\n]+/g, ' ');
function dateCell(v) {
  if (typeof v === 'number' && isFinite(v) && v > 0) {
    const d = XLSX.SSF.parse_date_code(v);
    if (d && d.y) return `${d.d}/${d.m}/${d.y}`;
  }
  return txt(v);
}
function num(v) { const s = String(v == null ? '' : v).replace(/[^\d.\-]/g, ''); if (!s) return null; const n = parseFloat(s); return isNaN(n) ? null : n; }
function intOrNull(v) { const n = num(v); return n == null ? null : Math.round(n); }

const r = await fetch(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=xlsx`, { redirect: 'follow' });
if (!r.ok) throw new Error(`HTTP ${r.status}`);
const buf = Buffer.from(await r.arrayBuffer());
if (buf.slice(0, 2).toString() !== 'PK') throw new Error('not xlsx (sheet private?)');
const wb = XLSX.read(buf, { type: 'buffer' });
if (!wb.Sheets[TAB]) throw new Error(`tab "${TAB}" not found`);
const rows = XLSX.utils.sheet_to_json(wb.Sheets[TAB], { header: 1, blankrows: false, defval: '' });

// header at row 0: TC, FORM DATE, BOOKING NUMBER, CUST NAME, AMOUNT, REFUND REASON,
//                  SUBMIT DATE TO KHAIRA, DUE DATE REFUND, OVER DUE, STATUS REFUND
const out = [];
for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  const tc = txt(r[0]), bk = txt(r[2]), name = txt(r[3]);
  if (!tc && !bk && !name) continue;            // skip empty/formula filler rows
  out.push({
    id: 'rf-sheet-' + i,
    tc,
    form_date: dateCell(r[1]),
    bk,
    cust_name: name,
    amount: num(r[4]),
    reason: txt(r[5]),
    submit_date: dateCell(r[6]),
    due_date: dateCell(r[7]),
    over_due: intOrNull(r[8]),
    status: txt(r[9]),
  });
}

console.log(`解析 ${TAB}: ${out.length} 条退款记录`);
console.log('样例:');
out.slice(0, 4).forEach(u => console.log('  ', JSON.stringify(u).slice(0, 230)));

if (DRY) { console.log('\n[dry-run] 未写库。去掉 --dry 实际写入。'); process.exit(0); }

const { createClient } = await import('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const probe = await sb.from('refunds').select('id').limit(1);
if (probe.error) { console.error('❌ refunds 表不存在，请先跑 migration 009。', probe.error.message); process.exit(1); }
const del = await sb.from('refunds').delete().neq('id', '');
if (del.error) { console.error('清理旧数据失败:', del.error.message); process.exit(1); }
let ok = 0;
for (let i = 0; i < out.length; i += 500) {
  const chunk = out.slice(i, i + 500);
  const { error } = await sb.from('refunds').insert(chunk);
  if (error) { console.error('写入失败:', error.message); process.exit(1); }
  ok += chunk.length;
}
console.log(`\n✅ 已导入 ${ok} 条退款记录到 refunds。`);
