# Webuy OPS Center

> 内部运营管理系统 · Internal Operations Management System

A web-based operations dashboard for Webuy travel teams — covering tour bookings, visa tracking, ticketing, customer service, and daily OPS reporting. Deployed on Vercel with role-based access control.

---

## ✨ Features / 功能模块

| Module | Description |
|---|---|
| 📊 **Dashboard** | KPI overview, tour status charts, visa urgency alerts |
| 📋 **OPS Master (BK)** | Tour booking workflow — checklist, financials, logs |
| 💼 **Sales Inquiry** | Track sales inquiries from lead to confirmed tour |
| 🎯 **Private Tour** | Manage private/custom tour requests |
| 🛂 **Visa Tracker** | Live visa status from Google Sheets via Apps Script |
| 🎫 **Ticketing Tracker** | Track ticketing progress per tour |
| 📋 **Manifest / PAX** | Passenger manifest and PAX management |
| 💬 **CS Module** | Customer service case logging and SLA tracking |
| ✈️ **Flight Schedule** | Flight records per tour |
| 📊 **Daily OPS Log** | Team daily work update (live from Google Sheets) |
| 🔗 **Resources** | Quick links to shared tools and documents |

---

## 🔐 Authentication & Roles / 登录与权限

The system uses **Supabase Auth**. The browser signs in directly against Supabase (email/password); the legacy `/api/auth` HMAC-JWT endpoint has been retired (it now returns 410). Each user has a row in the `profiles` table whose **role** controls which modules are visible:

| Role | Access |
|---|---|
| `admin` | All modules |
| `ops` | OPS Master, Manifest, Flight, OPS Log, Resources |
| `visa` | Visa Tracker, Resources |
| `ticketing` | Ticketing Tracker, Resources |
| `cs` | CS Module, Resources |
| `sales` | Sales Inquiry, Private Tour, Resources |

Manage users and passwords in the **Supabase dashboard → Authentication**; set each user's role in the `profiles` table. No credentials live in this repo.

---

## 🏗️ Tech Stack / 技术栈

- **Frontend**: Vanilla HTML / CSS / JavaScript (no build step required)
- **Charts**: [Chart.js](https://www.chartjs.org/) v4
- **Backend API**: Node.js serverless functions on [Vercel](https://vercel.com/)
- **Database**: [Supabase](https://supabase.com/) Postgres (visa, tours, ticketing, CS, etc.) with RLS
- **Auth**: Supabase Auth (email/password, JWT sessions)

---

## 🚀 Deployment / 部署方式

### Quick Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/YOUR_USERNAME/webuy-ops)

### Manual Steps

```bash
# 1. Clone the repo
git clone https://github.com/YOUR_USERNAME/webuy-ops.git
cd webuy-ops

# 2. Install Vercel CLI (if not already installed)
npm i -g vercel

# 3. Deploy
vercel --prod
```

### Environment Variables (set in Vercel Dashboard)

See [`.env.example`](./.env.example) for the full, annotated list. The essentials:

| Variable | Required | Description |
|---|---|---|
| `SUPABASE_URL` | ✅ | Supabase project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Service-role key for server-side API writes. **Never expose to the browser.** |
| `CRON_SECRET` | ✅ | Bearer secret Vercel attaches to cron invocations (Skybar sync). |
| `ANTHROPIC_API_KEY` | Quote tool | AI itinerary extraction + scenery-photo picks. |
| `WEBUY_DATA_MCP_TOKEN` | ID modules | Auth token for the 数据中台 MCP. |
| `SKYBAR_MYSQL_*` | Skybar sync | Read-only MySQL connection for the daily sync cron. |

The Supabase **anon** key is embedded in `app.html` (safe for the browser). The Visa Tracker's Apps Script URL is **not** a Vercel env var — it's configured in-app (stored in `localStorage`), see Google Sheets Integration below.

---

## 🗂️ Project Structure / 项目结构

```
webuy-ops/
├── index.html          # Login page
├── app.html            # Main application (all modules)
├── vercel.json         # Vercel routing config
├── api/                # Vercel serverless functions (see vercel.json for routes)
│   ├── sb-write.js     # POST — role-checked write proxy (service_role, bypasses RLS)
│   ├── id-intelligence.js  # GET/POST — ID data center + CRM (?crm=1) via 数据中台 MCP
│   ├── quote-*.js      # AI itinerary quote generator pipeline
│   ├── _cors.js        # shared CORS allow-list helper (underscore = not a route)
│   └── …               # auth.js / visa.js are retired 410 stubs
├── supabase/migrations # numbered forward-only SQL migrations
└── .gitignore
```

---

## 🔗 Google Sheets Integration / Google 表格集成

The **Daily OPS Log** module pulls live data from Google Sheets via [Google Apps Script](https://script.google.com/). (Visa data has moved to the Supabase `visa_tours` table and is read directly by the browser — the old `/api/visa` proxy is retired.)

**Setup steps:**
1. Open your Google Sheet → **Extensions → Apps Script**
2. Deploy as a **Web App** (access: Anyone)
3. Copy the Web App URL
4. Paste it directly in the app via the ⚙️ Google Sheets button — it's stored in the browser's `localStorage`, **not** a Vercel env var.

---

## 👥 Team Collaboration / 团队协作

1. **Fork or clone** this repo
2. Create a branch for your feature: `git checkout -b feature/your-feature`
3. Push and open a Pull Request
4. Changes are auto-deployed to Vercel on merge to `main`

For access control changes (new team members, roles), add the user in the **Supabase dashboard → Authentication** and set their role in the `profiles` table — no code changes needed.

---

## ⚠️ Security Notes / 安全注意事项

- **Do not commit secrets** to this repository. Manage users/passwords in Supabase Auth; keep keys in Vercel env vars / a local `.env` (git-ignored).
- The `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS — server-side only, **never** ship it to the browser.
- The `.gitignore` already excludes `.vercel/` and `.env`.

---

## 📄 License

Internal use only — Webuy Travel © 2024
