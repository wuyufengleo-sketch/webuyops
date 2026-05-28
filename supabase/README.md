# Supabase Setup — Webuy OPS

This folder contains everything needed to stand up the shared database that will eventually
replace Google Sheets + localStorage.

## One-time setup (≈ 10 min)

### 1. Create the Supabase project
- Go to https://supabase.com → **New project**
- Name: `webuy-ops`
- Region: **Southeast Asia (Singapore)** — lowest latency for Indonesia
- Database password: pick a strong one, save it in your password manager
- Wait ~2 min for provisioning

### 2. Apply the schema
- Open the project → **SQL Editor** → **New query**
- Paste the entire contents of [`schema.sql`](./schema.sql)
- Click **Run**
- Expected output: `Success. No rows returned.`

You should see all tables in the **Table Editor**: `profiles`, `tours`, `visa_progress`,
`ticketing`, `ops_workflow`, `ops_logs`, `cs_cases`, `sales_inquiries`, `private_tours`,
`manifest_passengers`, `flights`, `photos`, `app_config`, `audit_log`.

### 3. Seed the initial users
- Open **Project Settings → API**
- Copy two values:
  - **Project URL** → `SUPABASE_URL`
  - **service_role** key (under "Project API keys", reveal it) → `SUPABASE_SERVICE_ROLE_KEY`
- Run locally:

  ```bash
  cd "/Users/leo/Documents/Claude Code/webuy-ops"
  SUPABASE_URL=https://xxxxx.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY=eyJ... \
  node supabase/seed-users.mjs
  ```

Expected output: six `✓` lines, one per user.

### 4. Create the photo storage bucket
- **Storage → New bucket**
- Name: `tour-photos`
- **Public**: off (we'll serve via signed URLs)
- Click **Create**

### 5. Send Leo the credentials
For wiring the website to Supabase, the next step needs:
- `SUPABASE_URL`
- `anon public` key (also in Project Settings → API — this one is safe in the frontend)

The `service_role` key **never goes near the frontend**; it stays in Vercel env vars only.

---

## Login mapping

Users sign in with their old usernames, but Supabase Auth needs emails internally.
The seed script maps username → `<username>@webuy.local`:

| Old username | New email (used by Supabase Auth) |
|---|---|
| leo       | leo@webuy.local       |
| ops       | ops@webuy.local       |
| visa      | visa@webuy.local      |
| ticketing | ticketing@webuy.local |
| cs        | cs@webuy.local        |
| sales     | sales@webuy.local     |

> Passwords are NOT stored in this repo. The default seed passwords live only in
> the local (git-ignored) `seed.sql` / `seed-users.mjs`. Reset them per-user in the
> Supabase dashboard after migration is complete.

The login page will accept the bare username; the suffix is appended automatically.

---

## Things to do later (not in this sprint)

- Tighten the v1 "any authenticated user can do anything" RLS policies into role-based rules.
- Wire `audit_log` triggers on every mutating table.
- Migrate `api/auth.js` → drop the custom HMAC JWT in favour of Supabase Auth.
- Decommission Google Apps Script after Visa Tracker fully migrates.
