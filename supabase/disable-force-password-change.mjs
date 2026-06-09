// Clear force_password_change for everyone — feature was too annoying in practice.
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const r = await fetch(`${URL}/rest/v1/profiles?force_password_change=eq.true`, {
  method: 'PATCH',
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
  body: JSON.stringify({ force_password_change: false }),
});
const body = await r.json();
console.log(`Updated ${Array.isArray(body) ? body.length : 0} profile(s) — force_password_change set to false.`);
if (Array.isArray(body)) for (const p of body) console.log(`  · ${p.username}`);
