// 本地一键执行：(可选)应用迁移 006 → 调用 api/sync-skybar 同步逻辑。
// 用法: node supabase/local-run.mjs
// 凭据全部从项目根目录的 .env 读取（不进 git）。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── 加载 .env ────────────────────────────────────────────────────────
const envPath = path.join(ROOT, '.env');
if (!fs.existsSync(envPath)) { console.error('❌ 找不到 .env'); process.exit(1); }
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !line.trim().startsWith('#')) process.env[m[1]] = m[2];
}

const SR = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SR || SR.includes('__set_me__')) {
  console.error('❌ 请先在 .env 里填入 SUPABASE_SERVICE_ROLE_KEY（service_role secret key）。');
  process.exit(1);
}

const { createClient } = await import('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, SR, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── 1. 检查目标表是否存在；不存在则尝试用 SUPABASE_DB_URL 跑迁移 ──────
async function tableExists() {
  const { error } = await supabase.from('package_sales').select('id').limit(1);
  return !(error && /relation .* does not exist|Could not find the table|schema cache/i.test(error.message));
}

if (!(await tableExists())) {
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl || dbUrl.includes('set_me')) {
    console.error('❌ 表 package_sales 不存在，且未提供 SUPABASE_DB_URL。');
    console.error('   方式一：在 Supabase SQL Editor 里跑 supabase/migrations/006-package-sales-sprint6.sql；');
    console.error('   方式二：把数据库连接串填进 .env 的 SUPABASE_DB_URL，我来自动跑。');
    process.exit(1);
  }
  console.log('• 表不存在，正在用 SUPABASE_DB_URL 应用迁移 006 ...');
  let pg;
  try { pg = await import('pg'); }
  catch { console.error('❌ 需要 pg 包：npm install pg'); process.exit(1); }
  const client = new pg.default.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const sql = fs.readFileSync(path.join(ROOT, 'supabase/migrations/006-package-sales-sprint6.sql'), 'utf8');
  await client.query(sql);
  await client.end();
  console.log('✓ 迁移 006 已应用');
} else {
  console.log('• 表已存在，跳过迁移');
}

// ── 2. 复用 api/sync-skybar.js 的同步逻辑（mock req/res 调用 handler）──
const handler = (await import(path.join(ROOT, 'api/sync-skybar.js'))).default
             || (await import(path.join(ROOT, 'api/sync-skybar.js')));
const req = { method: 'POST', headers: { 'x-sync-secret': process.env.SYNC_SECRET } };
const res = {
  _code: 200,
  setHeader() {},
  status(c) { this._code = c; return this; },
  json(o) { console.log(`\n同步结果 [HTTP ${this._code}]:`, JSON.stringify(o)); return this; },
};
console.log('• 正在从 Skybar 同步 ...');
await handler(req, res);
process.exit(0);
