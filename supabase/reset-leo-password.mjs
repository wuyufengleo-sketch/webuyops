// Reset leo's password back to Webuy@2026 and force a change on next login.
// Run: source .env && node supabase/reset-leo-password.mjs
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }

async function adm(path, opts = {}) {
  const r = await fetch(`${URL}/auth/v1/admin${path}`, {
    ...opts,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(opts.headers||{}) },
  });
  const b = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(b)}`);
  return b;
}
async function rest(path, opts = {}) {
  const r = await fetch(`${URL}/rest/v1${path}`, {
    ...opts,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation', ...(opts.headers||{}) },
  });
  const b = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(b)}`);
  return b;
}

const list = await adm('/users?per_page=200');
const leo = (list.users||[]).find(u => u.email && u.email.toLowerCase().startsWith('leo@'));
if (!leo) { console.error('leo user not found'); process.exit(1); }
console.log('Found leo:', leo.email, 'id=', leo.id);

await adm(`/users/${leo.id}`, {
  method: 'PUT',
  body: JSON.stringify({
    password: 'Webuy@2026',
    email_confirm: true,
    user_metadata: { username: 'leo', name: 'Leo', role: 'admin', department: 'Admin', force_password_change: true },
  }),
});
console.log('✓ password reset to Webuy@2026 + force_password_change=true');

await rest('/profiles?on_conflict=id', {
  method: 'POST',
  body: JSON.stringify({ id: leo.id, username: 'leo', name: 'Leo', role: 'admin', department: 'Admin', force_password_change: true }),
});
console.log('✓ profile synced (role=admin)');

console.log('\nLogin: leo / Webuy@2026 — you will be forced to set a new password on first login.');
