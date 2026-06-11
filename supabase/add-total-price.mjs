// Add total_price column to package_sales via REST PATCH that will fail and
// then via SQL — but we have no DB URL. Workaround: skip the column write
// at the upsert step instead. (Less invasive than schema change.)
// We just verify the column doesn't exist.
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const r = await fetch(`${URL}/rest/v1/package_sales?select=id,total_price&limit=1`, {
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
});
const body = await r.json();
console.log(r.status, body);
