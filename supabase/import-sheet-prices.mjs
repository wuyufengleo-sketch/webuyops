// 手动一次性把 Google Sheet 的对客报价拆分写入 Supabase package_sales。
//   用法: node supabase/import-sheet-prices.mjs [--dry]
//   --dry 只预览不写库。凭据从 .env 读取（SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SKYBAR_MYSQL_*）。
//
// 注意：价格现在已并入每小时同步（api/sync-skybar.js 调用同一个 loadSheetPrices）。
// 本脚本仅用于不想等下次同步时的手动补价/调试，匹配规则与同步完全一致：
//   • basic_price 按 TOUR CODE 逐团取（缺则留空）
//   • 其余固定项按 TOUR TYPE 取（同 type 首个有效值）
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');

// ── .env ──
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !line.trim().startsWith('#')) process.env[m[1]] = m[2];
}

const norm = s => String(s == null ? '' : s).trim().toUpperCase().replace(/\s+/g, ' ');

// ── 1) Sheet 价格（复用与 sync 相同的加载/匹配逻辑）──
const { loadSheetPrices, TYPE_FIELDS } = await import(path.join(ROOT, 'api/_sheet-prices.js'));
const prices = await loadSheetPrices();
if (!prices.ok) { console.error('❌ Sheet 加载失败:', prices.reason, '(权限需设为「知道链接的任何人 - 查看者」)'); process.exit(1); }
console.log('使用标签:', prices.usedTabs.length, '→', prices.usedTabs.join(' / '));
console.log('Sheet 提取: tour_code(basic)', prices.byCodeBasic.size, '/ type_code(固定项)', prices.byType.size);

// ── 2) DB: 在场 tour 的 tour_code / type_code ──
const mysql = (await import('mysql2/promise')).default;
const c = await mysql.createConnection({ host: process.env.SKYBAR_MYSQL_HOST, port: +process.env.SKYBAR_MYSQL_PORT, user: process.env.SKYBAR_MYSQL_USER, password: process.env.SKYBAR_MYSQL_PASS, database: process.env.SKYBAR_MYSQL_DB, connectTimeout: 15000 });
const [dbrows] = await c.query(`SELECT t.id tour_id, UPPER(TRIM(t.tour_code)) tour_code, UPPER(TRIM(tt.type_code)) type_code FROM wt_tour t JOIN wt_tour_type tt ON t.tour_type_id=tt.id WHERE t.deleted_status=0 AND t.departure_time>=DATE_SUB(NOW(),INTERVAL 30 DAY)`);
await c.end();

// ── 3) 组装 update（basic 按 code 留空兜底，固定项按 type）──
const ENRICH = ['basic_price', ...new Set(Object.values(TYPE_FIELDS))];
const updates = [];
let mBasic = 0, mFixed = 0;
for (const row of dbrows) {
  const basic = prices.byCodeBasic.get(norm(row.tour_code)) ?? null;
  const fixed = prices.byType.get(norm(row.type_code)) || {};
  if (basic == null && !Object.keys(fixed).length) continue;
  const rec = {};
  for (const f of ENRICH) rec[f] = null;
  rec.basic_price = basic;
  for (const [f, v] of Object.entries(fixed)) rec[f] = v;
  if (basic != null) mBasic++;
  if (Object.keys(fixed).length) mFixed++;
  updates.push({ id: 'wt-' + row.tour_id, ...rec });
}
console.log(`\n匹配配套: ${updates.length}/${dbrows.length} (${Math.round(updates.length / dbrows.length * 100)}%) — basic ${mBasic}, 固定项 ${mFixed}`);
console.log('样例:'); updates.slice(0, 4).forEach(u => console.log('  ', JSON.stringify(u).slice(0, 180)));

if (DRY) { console.log('\n[dry-run] 未写库。去掉 --dry 实际写入。'); process.exit(0); }

// ── 4) 写 Supabase（service_role）──
const { createClient } = await import('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
let ok = 0, fail = 0;
for (const u of updates) {
  const { id, ...fields } = u;
  const { error } = await sb.from('package_sales').update(fields).eq('id', id);
  if (error) { fail++; console.error('  写入失败', id, ':', error.message); }
  else ok++;
}
console.log(`\n✅ 写入完成: 成功 ${ok}, 失败 ${fail}`);
