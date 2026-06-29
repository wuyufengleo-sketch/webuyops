// Seed visa checklist rules from the SQL migration into Supabase.
//
// The normalized table is preferred when migration 040 has been applied.
// Until DB DDL access is available, the same rules are also stored in
// app_config.visa_checklist_rules_v1 so the browser can use them immediately.

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const CONFIG_KEY = 'visa_checklist_rules_v1';
const MIGRATION_FILE = new URL('./migrations/040-visa-checklist-rules.sql', import.meta.url);

function loadEnv() {
  try {
    const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
    for (const line of envText.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
      if (!m || process.env[m[1]]) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  } catch (_) {}
}

function parseSqlString(value) {
  if (!value || value.toLowerCase() === 'null') return null;
  return value.replace(/^'/, '').replace(/'$/, '').replace(/''/g, "'");
}

function parseAliases(value) {
  return [...String(value || '').matchAll(/'([^']*)'/g)].map(m => m[1]);
}

function parseRules(sql) {
  const tupleRe = /\('([^']*)','([^']*)',array\[(.*?)\],\s*'([^']*)',\s*\$\$([\s\S]*?)\$\$::jsonb,\s*(null|'(?:[^']|'')*')\)/g;
  const rules = [];
  for (const m of sql.matchAll(tupleRe)) {
    rules.push({
      country: m[1],
      country_key: m[2],
      aliases: parseAliases(m[3]),
      visa_type: m[4],
      required_docs: JSON.parse(m[5]),
      notes: parseSqlString(m[6]),
      source_title: 'WEBUY Visa New.pdf',
      active: true,
    });
  }
  return rules;
}

loadEnv();

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const sql = readFileSync(MIGRATION_FILE, 'utf8');
const rules = parseRules(sql);
if (!rules.length) {
  console.error('No visa checklist rules parsed from migration');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const cfg = await supabase
  .from('app_config')
  .upsert({ key: CONFIG_KEY, value: JSON.stringify(rules) }, { onConflict: 'key' })
  .select('key');
if (cfg.error) {
  console.error('app_config upsert failed:', cfg.error.message);
  process.exit(1);
}

let tableStatus = 'skipped';
const table = await supabase
  .from('visa_checklist_rules')
  .upsert(rules, { onConflict: 'country_key,visa_type' })
  .select('id');
if (table.error) {
  tableStatus = `not synced (${table.error.code || 'error'}: ${table.error.message})`;
} else {
  tableStatus = `synced ${table.data?.length || 0}`;
}

console.log(`Seeded ${rules.length} visa checklist rules into app_config.${CONFIG_KEY}; table ${tableStatus}.`);
