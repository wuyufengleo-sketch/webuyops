// Apply a SQL migration file via pg
import pg from 'pg';
import { readFileSync } from 'node:fs';

try {
  const envText = readFileSync('.env', 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!m || process.env[m[1]]) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
} catch (_) {}

const file = process.argv[2];
if (!file) { console.error('Usage: node supabase/apply-migration.mjs <path>'); process.exit(1); }
const sql = readFileSync(file, 'utf8');

const url = process.env.SUPABASE_DB_URL;
if (!url) { console.error('Missing SUPABASE_DB_URL'); process.exit(1); }

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query(sql);
  console.log('✅ Applied', file);
} catch (e) {
  console.error('❌ Failed:', e.message);
  process.exit(1);
} finally {
  await client.end();
}
