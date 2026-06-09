// Apply a SQL migration file via pg
import pg from 'pg';
import { readFileSync } from 'node:fs';

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
