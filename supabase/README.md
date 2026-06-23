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

## Migrations

Incremental schema changes live in [`migrations/`](./migrations) as numbered SQL
files (`NNN-short-name.sql`). Apply one with the bundled helper:

```bash
# SUPABASE_DB_URL is read from a local .env or the environment.
node supabase/apply-migration.mjs supabase/migrations/035-enable-rls-on-alert-states.sql
```

**Connecting (`SUPABASE_DB_URL`).** The direct host `db.<ref>.supabase.co` is
IPv6-only and won't resolve on most IPv4 networks. Use the **Session pooler**
(IPv4) instead — note the username becomes `postgres.<ref>` and newer projects
use the `aws-1-` prefix:

```
postgresql://postgres.<ref>:<password>@aws-1-<region>.pooler.supabase.com:5432/postgres
```

This project: `region = ap-southeast-1`, `ref = vnjdlxgwdgofghqjvxqp`.

**Conventions & known issues.**
- Files run **in numeric order**; the prefix must be unique. Two prefixes were
  accidentally reused — `017-itinerary-quote` / `017-order-workflow-manual-at`
  and `028-fix-updated-by-trigger` / `028-flight-quote-cache`. Their contents
  don't conflict, but don't reuse a number again; a CI uniqueness check is worth
  adding.
- `026-rls-rewrite-from-audit.sql` lists a non-existent singular table
  `itinerary_quote` alongside the correct plural `itinerary_quotes`; the `if not
  exists … continue` guard silently skips it. Harmless, inherited typo from 025.
- Migrations are **forward-only and several are irreversible** (`drop table` /
  `drop column` / bulk `drop policy`). There is no down-migration tooling — back
  up before applying anything destructive, and prefer additive changes.

## Things to do later (not in this sprint)

- Tighten the v1 "any authenticated user can do anything" RLS policies into role-based rules.
- Wire `audit_log` triggers on every mutating table.
- Decommission Google Apps Script after Visa Tracker fully migrates.

> `api/auth.js` (custom HMAC JWT) has already been retired — login goes directly
> to Supabase Auth from the browser; the endpoint is now a 410 stub.
