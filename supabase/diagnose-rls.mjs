// Quick diagnostic — dump policies + profile roles
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function q(path) {
  const r = await fetch(`${URL}/rest/v1${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  return r.json();
}

console.log('\n=== Profiles ===');
const profiles = await q('/profiles?select=username,role,department,force_password_change&order=role');
for (const p of profiles) console.log(`  ${p.username.padEnd(10)} role=${(p.role||'-').padEnd(10)} dept=${p.department||'-'} force_pwd=${p.force_password_change}`);

console.log('\n=== Tables that exist ===');
// Try selecting 1 row from cs_records to test
const tables = ['cs_records','cs_complaints','cs_cases','manifest_passengers','app_config','visa_tours','visa_progress','ticketing','ticketing_items','tours','ops_workflow','order_workflow','package_sales','package_orders','user_events','profiles'];
for (const t of tables) {
  const r = await fetch(`${URL}/rest/v1/${t}?select=*&limit=1`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  console.log(`  ${t.padEnd(25)} status=${r.status}`);
}

console.log('\n=== cs_records column hint (first row) ===');
const cs = await q('/cs_records?select=*&limit=1');
if (cs.length) console.log('  columns:', Object.keys(cs[0]).join(', '));
else console.log('  (empty)');
