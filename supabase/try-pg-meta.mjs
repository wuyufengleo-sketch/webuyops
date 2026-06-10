// Try undocumented Supabase pg-meta endpoint via service role
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const endpoints = [
  `${URL}/pg/query`,
  `${URL}/v1/projects/_/database/query`,
];

for (const ep of endpoints) {
  try {
    const r = await fetch(ep, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ query: 'select 1 as ok' }),
    });
    console.log(ep, r.status, (await r.text()).slice(0, 200));
  } catch (e) {
    console.log(ep, 'ERR', e.message);
  }
}
