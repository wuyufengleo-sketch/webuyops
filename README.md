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

The system uses JWT-based authentication via a Vercel serverless API (`/api/auth`).

Each user is assigned a **role** that controls which modules are visible:

| Role | Access |
|---|---|
| `admin` | All modules |
| `ops` | OPS Master, Manifest, Flight, OPS Log, Resources |
| `visa` | Visa Tracker, Resources |
| `ticketing` | Ticketing Tracker, Resources |
| `cs` | CS Module, Resources |
| `sales` | Sales Inquiry, Private Tour, Resources |

Default credentials are defined in `api/auth.js`. **Override them via the `USERS_JSON` environment variable in Vercel** — never commit real passwords to this repo.

---

## 🏗️ Tech Stack / 技术栈

- **Frontend**: Vanilla HTML / CSS / JavaScript (no build step required)
- **Charts**: [Chart.js](https://www.chartjs.org/) v4
- **Backend API**: Node.js serverless functions on [Vercel](https://vercel.com/)
- **Live Data**: Google Apps Script Web App → `/api/visa` proxy
- **Auth**: Custom HMAC-SHA256 JWT (10-hour session)

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

| Variable | Required | Description |
|---|---|---|
| `JWT_SECRET` | ✅ | Secret key for signing JWT tokens. Use a long random string. |
| `USERS_JSON` | Optional | JSON array to override default users. See format below. |
| `VISA_SCRIPT_URL` | Optional | Google Apps Script Web App URL for live visa data. |

**`USERS_JSON` format:**
```json
[
  {"username": "alice", "password": "SecurePass123", "role": "ops", "name": "Alice"},
  {"username": "bob",   "password": "SecurePass456", "role": "visa", "name": "Bob"}
]
```

---

## 🗂️ Project Structure / 项目结构

```
webuy-ops/
├── index.html          # Login page
├── app.html            # Main application (all modules)
├── vercel.json         # Vercel routing config
├── api/
│   ├── auth.js         # POST /api/auth — login & JWT issuance
│   └── visa.js         # GET  /api/visa — visa data proxy from Google Sheets
└── .gitignore
```

---

## 🔗 Google Sheets Integration / Google 表格集成

The **Visa Tracker** and **Daily OPS Log** modules pull live data from Google Sheets via [Google Apps Script](https://script.google.com/).

**Setup steps:**
1. Open your Google Sheet → **Extensions → Apps Script**
2. Deploy as a **Web App** (access: Anyone)
3. Copy the Web App URL
4. Set it as `VISA_SCRIPT_URL` in your Vercel environment variables
5. Or paste it directly in the app via the ⚙️ Google Sheets button

---

## 👥 Team Collaboration / 团队协作

1. **Fork or clone** this repo
2. Create a branch for your feature: `git checkout -b feature/your-feature`
3. Push and open a Pull Request
4. Changes are auto-deployed to Vercel on merge to `main`

For access control changes (new team members, roles), update the `USERS_JSON` env var in the Vercel dashboard — no code changes needed.

---

## ⚠️ Security Notes / 安全注意事项

- **Do not commit real passwords** to this repository. Use `USERS_JSON` env var.
- **Change `JWT_SECRET`** from the default before going to production.
- The `.gitignore` already excludes `.vercel/` (contains your project IDs).

---

## 📄 License

Internal use only — Webuy Travel © 2024
