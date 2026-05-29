// One-time migration: Payment Vendor (Google Sheet) → Supabase vendor_payments.
// Sprint 8 batch 2. One TAB per destination/region; region = tab name.
//
//   node supabase/import-vendor-payments.mjs --dry
//   node supabase/import-vendor-payments.mjs          # full replace + insert
//
// REQUIRES migration 009. Credentials from .env; sheet read via public xlsx export.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as XLSX from 'xlsx';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');
const SHEET_ID = '1fA0YlSSO7QUiHgAZlSRSdB1o6m1RPdc7lgn-wvBzoqE';
const SKIP_TABS = new Set(['LIST GROUP']);   // LIST GROUP is a summary, not invoice data

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
function num(v) {
  const s = String(v == null ? '' : v).replace(/[^\d.\-]/g, '');
  if (!s) return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

const r = await fetch(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=xlsx`, { redirect: 'follow' });
if (!r.ok) throw new Error(`HTTP ${r.status}`);
const buf = Buffer.from(await r.arrayBuffer());
if (buf.slice(0, 2).toString() !== 'PK') throw new Error('not xlsx (sheet private?)');
const wb = XLSX.read(buf, { type: 'buffer' });

const out = [];
let seq = 0;
const skipped = [];
for (const tab of wb.SheetNames) {
  if (SKIP_TABS.has(tab)) continue;
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[tab], { header: 1, blankrows: false, defval: '' });
  // header = first row (within 6) containing TOURCODE and (DEPT DATE or an INVOICE column)
  let h = -1;
  for (let i = 0; i < Math.min(6, rows.length); i++) {
    const c = rows[i].map(norm);
    if (c.includes('TOURCODE') && (c.includes('DEPT DATE') || c.some(x => x.startsWith('INVOICE')))) { h = i; break; }
  }
  if (h < 0) { skipped.push(tab); continue; }

  const H = rows[h].map(norm);
  const invLabel = H.find(x => x.startsWith('INVOICE')) || '';
  const currency = /USD/.test(invLabel) ? 'USD' : /RMB/.test(invLabel) ? 'RMB' : '';
  const col = lbl => H.indexOf(lbl);
  const iCode = col('TOURCODE');
  const iInv = H.findIndex(x => x.startsWith('INVOICE'));
  const iDept = col('DEPT DATE');
  const iPax = col('TOTAL PAX');
  const iLark = (() => { const a = col('NO. LARK'); if (a >= 0) return a; const b = col('LARK SUBMIT'); return b; })();
  const iPay = col('PAYMENT DATE');
  const iStat = col('STATUS PAYMENT');

  const region = tab.trim();
  for (let i = h + 1; i < rows.length; i++) {
    const row = rows[i];
    const tc = iCode >= 0 ? txt(row[iCode]) : '';
    if (!tc) continue;
    out.push({
      id: 'vp-sheet-' + (++seq),
      region,
      tourcode: tc,
      invoice_amount: iInv >= 0 ? num(row[iInv]) : null,
      currency,
      dept_date: iDept >= 0 ? dateCell(row[iDept]) : '',
      total_pax: iPax >= 0 ? txt(row[iPax]) : '',
      lark_no: iLark >= 0 ? txt(row[iLark]) : '',
      payment_date: iPay >= 0 ? dateCell(row[iPay]) : '',
      status: iStat >= 0 ? txt(row[iStat]) : '',
    });
  }
}

const regions = new Set(out.map(o => o.region));
console.log(`解析: ${regions.size} 个目的地, ${out.length} 条 vendor 付款记录`);
if (skipped.length) console.log('跳过(无表头/汇总):', skipped.join(' | '));
console.log('样例:');
out.slice(0, 4).forEach(u => console.log('  ', JSON.stringify(u).slice(0, 220)));

if (DRY) { console.log('\n[dry-run] 未写库。去掉 --dry 实际写入。'); process.exit(0); }

const { createClient } = await import('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const probe = await sb.from('vendor_payments').select('id').limit(1);
if (probe.error) { console.error('❌ vendor_payments 表不存在，请先跑 migration 009。', probe.error.message); process.exit(1); }
const del = await sb.from('vendor_payments').delete().neq('id', '');
if (del.error) { console.error('清理旧数据失败:', del.error.message); process.exit(1); }
let ok = 0;
for (let i = 0; i < out.length; i += 500) {
  const chunk = out.slice(i, i + 500);
  const { error } = await sb.from('vendor_payments').insert(chunk);
  if (error) { console.error('写入失败:', error.message); process.exit(1); }
  ok += chunk.length;
}
console.log(`\n✅ 已导入 ${ok} 条 vendor 付款记录 / ${regions.size} 个目的地。`);
