// Rename khira → khaira (email + metadata + profile)
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error('Missing env'); process.exit(1); }

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
const khira = (list.users||[]).find(u => u.email && u.email.toLowerCase() === 'khira@webuy.local');
if (!khira) { console.error('khira user not found'); process.exit(1); }

// Update auth user: email + metadata
await adm(`/users/${khira.id}`, {
  method: 'PUT',
  body: JSON.stringify({
    email: 'khaira@webuy.local',
    email_confirm: true,
    user_metadata: { username: 'khaira', name: 'Khaira', role: 'cs', department: 'CS', force_password_change: true },
  }),
});
console.log('✓ auth user renamed khira → khaira');

// Update profile row (username/name)
await rest(`/profiles?id=eq.${khira.id}`, {
  method: 'PATCH',
  body: JSON.stringify({ username: 'khaira', name: 'Khaira' }),
});
console.log('✓ profile row updated');
console.log('\nLogin: khaira / Webuy@2026 (forced password change on first login)');
