// ============================================================================
//  Sprint 13 — Seed 14 staff accounts into Supabase Auth using the service-role key.
//  Sets a default password (Webuy@2026) + force_password_change=true so the
//  app forces a reset on first login.
//
//  Run locally once after applying migration 025:
//    SUPABASE_URL=https://xxx.supabase.co \
//    SUPABASE_SERVICE_ROLE_KEY=eyJ... \
//    node supabase/seed-staff-2026.mjs
//
//  Idempotent: skips users whose email is already in Supabase Auth, but
//  always re-syncs their profile row (name / role / department / force flag).
// ============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('❌ Missing env. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const EMAIL_DOMAIN     = 'webuy.local';
const DEFAULT_PASSWORD = 'Webuy@2026';

const STAFF = [
  // Ticketing
  { username: 'alma',    role: 'ticketing', dept: 'Ticketing', name: 'Alma' },
  { username: 'hendy',   role: 'ticketing', dept: 'Ticketing', name: 'Hendy' },
  { username: 'lydia',   role: 'ticketing', dept: 'Ticketing', name: 'Lydia' },
  // Ops
  { username: 'agatha',  role: 'ops',       dept: 'OPS',       name: 'Agatha' },
  { username: 'baby',    role: 'ops',       dept: 'OPS',       name: 'Baby' },
  { username: 'yuni',    role: 'ops',       dept: 'OPS',       name: 'Yuni' },
  // CS
  { username: 'fita',    role: 'cs',        dept: 'CS',        name: 'Fita' },
  { username: 'zahara',  role: 'cs',        dept: 'CS',        name: 'Zahara' },
  { username: 'oryza',   role: 'cs',        dept: 'CS',        name: 'Oryza' },
  { username: 'khaira',  role: 'cs',        dept: 'CS',        name: 'Khaira' },
  // Documents
  { username: 'lodan',   role: 'doc',       dept: 'Documents', name: 'Lodan' },
  { username: 'martina', role: 'doc',       dept: 'Documents', name: 'Martina' },
  { username: 'nisa',    role: 'doc',       dept: 'Documents', name: 'Nisa' },
  // Product Management
  { username: 'dave',    role: 'pm',        dept: 'Product',   name: 'Dave' },
  { username: 'tirsa',   role: 'pm',        dept: 'Product',   name: 'Tirsa' },
  { username: 'adit',    role: 'pm',        dept: 'Product',   name: 'Adit' },
];

async function adminFetch(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin${path}`, {
    ...opts,
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function restFetch(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=representation',
      ...(opts.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function listExistingByEmail() {
  const out = new Map();
  let page = 1;
  while (true) {
    const data = await adminFetch(`/users?page=${page}&per_page=100`);
    const users = data.users || [];
    if (users.length === 0) break;
    for (const u of users) if (u.email) out.set(u.email.toLowerCase(), u);
    if (users.length < 100) break;
    page += 1;
  }
  return out;
}

async function main() {
  console.log('→ Seeding Sprint-13 staff into', SUPABASE_URL);
  const existing = await listExistingByEmail();

  for (const u of STAFF) {
    const email = `${u.username}@${EMAIL_DOMAIN}`;
    let userId = existing.get(email.toLowerCase())?.id || null;

    if (!userId) {
      const created = await adminFetch('/users', {
        method: 'POST',
        body: JSON.stringify({
          email,
          password: DEFAULT_PASSWORD,
          email_confirm: true,
          user_metadata: {
            username: u.username,
            name:     u.name,
            role:     u.role,
            department: u.dept,
            force_password_change: true,
          },
        }),
      });
      userId = created.id;
      console.log(`  ✓ created  ${email}  (role=${u.role})`);
    } else {
      console.log(`  ↩ exists   ${email}  → updating metadata`);
      await adminFetch(`/users/${userId}`, {
        method: 'PUT',
        body: JSON.stringify({
          user_metadata: {
            username: u.username,
            name:     u.name,
            role:     u.role,
            department: u.dept,
            force_password_change: true,
          },
        }),
      });
    }

    // Upsert into public.profiles so role + department land in the row used by
    // the front-end (handle_new_user only fires on insert, won't refresh existing).
    await restFetch('/profiles?on_conflict=id', {
      method: 'POST',
      body: JSON.stringify({
        id: userId,
        username: u.username,
        name: u.name,
        role: u.role,
        department: u.dept,
        force_password_change: true,
      }),
    });
  }

  console.log(`\n✅ Done. ${STAFF.length} staff seeded with default password: ${DEFAULT_PASSWORD}`);
  console.log('   They will be forced to change password on first login.');
}

main().catch(err => {
  console.error('❌ Seed failed:', err.message);
  process.exit(1);
});
