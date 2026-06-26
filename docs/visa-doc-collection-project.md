# 顾客自助护照/签证材料收集 —— 完整项目逻辑

> 版本：v1 · 2026-06-26
> 范围：跨 **Webuy OPS**（内部端）与 **Smart Travel Card / STC**（顾客端）两个系统
> 目标：把"CS 手动上传顾客护照证件"改成"**顾客自己上传**"，并保持签证团队现有审核习惯不变。

---

## 1. 背景与目标

### 现在的痛点
今天签证材料（护照、照片、KTP、KK、银行流水等）是 **CS 一个个手动收集、手动上传**到 OPS 的 `visa_documents`。顾客把文件发到群里 / 邮箱，CS 再下载、重命名、上传，重复劳动量大、易错、易漏。

### 目标
1. **顾客自己上传**：每个顾客拿到一个专属链接，自己把材料传进系统。
2. **按签证类型给清单**：团签 / 个签、不同国家，要的材料不一样，系统自动给出对应清单，顾客只传该传的。
3. **签证团队不改工作习惯**：顾客传上来的文件，最终仍然出现在 OPS 的 Visa 页，签证团队照常在那里审。
4. **触发自然（已修正）**：顾客付订金 → 销售在 Skybear 确认订单（= 订单进入 `PARTIAL_PAID`/`FULL_PAID`）→ 系统**近实时自动**生成确认记录 → CS 确认签证类型 → 建群发链接给顾客。
   > 触发点不是"财务在 OPS 手动点按钮"，而是 OPS 轮询器检测到 Skybear 订单付款状态变化后**自动创建**。财务/CS 手动按钮保留为兜底。

---

## 2. 现状：两个独立系统

| | **Webuy OPS**（内部端） | **Smart Travel Card / STC**（顾客端） |
|---|---|---|
| 用途 | 财务 / CS / 签证团队 / OP 日常作业 | 顾客扫 NFC 卡或点链接看自己的行程 |
| 仓库 | `wuyufengleo-sketch/webuyops`（本地 `webuy-ops`） | `webuytravel/smart-travel-card-idn` |
| 技术栈 | 单文件 `app.html` + `api/*.js` serverless | Next.js 14 + Drizzle ORM（monorepo） |
| 数据库 | **Supabase** Postgres | **Neon** Postgres（`webuy_travel_card_id`） |
| 文件存储 | Supabase Storage（`tour-photos` bucket） | Cloudflare R2 / Vercel Blob |
| 部署 | `webuy-ops.vercel.app` | `smart-travel-card-id-h5-mu.vercel.app` |

> **关键约束**：两个系统是**不同数据库**，不能共享同一张表。"贯通"只能走 **HTTP API 互调**。

### STC 已有的、可复用的能力
- **顾客卡片体系**：每个乘客一个不可枚举 token → `/card/{token}/...`。
  `nfc_cards.token` → `nfc_card_assignments`(active) → `travellerId / tourId / bookingId`。
- **顾客自助模式**：已有 `/card/{token}/profile`（顾客改自己的过敏/紧急联系人等）+ `profile/self` 接口。token 进来天然就是本人，无需登录。
- 顾客端已有页面：行程、航班、酒店、集合点、领队联系方式、SOS 求救。
- **文件直传**：已有 Vercel Blob 直传握手模式（绕开 serverless 4.5MB body 限制）。

### OPS 已完成的部分（已上线）
- `payment_confirmations` 表（Supabase）。
- DP Collection 页每行 **🔗 Confirm** 按钮 → 生成 `#confirmpay=<id>` 链接。
- CS 确认页：确认目的地 / 配套团号 / 人数 / 签证类型(团签/个签)+国家 → 按签证类型给材料清单 → "Copy for WhatsApp"。

---

## 3. 端到端数据流（核心逻辑）

```
①  顾客付订金 → 销售在 Skybear 确认订单
        │  Skybear wt_order.order_status 变为 3(PARTIAL_PAID) 或 4(FULL_PAID)
        ▼
②  OPS 轮询器(每 ~5 分钟直连 Skybear MySQL)检测到订单【新进入】3/4
        │  自动创建 payment_confirmations(status=PENDING) + 推送通知给 CS
        │  (财务/CS 在 DP Collection 手动点按钮 = 兜底路径，逻辑相同)
        ▼
③  CS 打开确认链接，核对并填写：
        · 目的地        · 配套 / 团号
        · 客户信息 / 人数   · 签证类型（团签/个签 + 国家）
        │  提交 → status=CONFIRMED，并按签证类型生成材料清单
        ▼
④  OPS 调用 STC 接口 POST /api/admin/visa-requirement   ← 跨系统①
        │  把【团号 / 每个乘客 / 签证类型 / 材料清单】写进 STC
        │  STC 返回每个乘客的上传链接 https://travel.webuyid.com/card/{token}/documents
        ▼
⑤  CS 手动建 WhatsApp 群，把对应顾客的上传链接丢进群
        ▼
⑥  顾客点链接 → STC 顾客页 /card/{token}/documents
        │  看到"你需要上传：护照、照片、KTP…"清单 → 逐项拍照/选文件上传
        │  文件直传到 R2 / Blob，写进 STC traveller_documents
        ▼
⑦  顾客每传一份，STC 调 OPS 接口 POST /api/visa-doc-ingest  ← 跨系统②
        │  把文件 URL + 文档类型 + 乘客 写进 OPS visa_documents
        ▼
⑧  签证团队在 OPS › Visa 页照常看到这些文件 → 审核（通过/驳回）
        │  （可选）驳回状态再回写 STC，顾客页提示"照片不清，请重传"
        ▼
   完成：CS 不再手动上传，顾客自助完成，签证团队工作流不变
```

**两个跨系统调用点**：
- **跨系统①**（OPS → STC）：CS 确认后推送清单，换回上传链接。
- **跨系统②**（STC → OPS）：顾客上传后把文件同步回 OPS 供审核。

### 3.1 触发机制（近实时，关键）

**已确认的事实**（数据查证）：
- Skybear 订单同步过来只有 `order_status`（付款状态 1-10）和 `deleted_status`，**没有独立的"cfm 确认"字段**。"销售确认订单"在外部可检测的信号 = `order_status` 进入 **3(PARTIAL_PAID)** 或 **4(FULL_PAID)**。
- **OPS 用只读 MySQL 账号直连 Skybear**（`api/sync-skybar.js`，查 `wt_tour`/`wt_order`），所以 OPS **可以随时实时查 Skybear**，不受"每天一次 cron"限制——那个 cron 只是定时跑全量同步。

**机制**：新增轻量轮询端点 `POST /api/confirm-poll`，每次：
1. 直连 Skybear 查 `wt_order`：`order_status IN (3,4)` 且 `departure_time >= NOW()` 的订单。
2. 与上次记录对比，挑出**新进入** 3/4 的订单（用 OPS 侧已有的 `package_orders` 状态快照，或在 `payment_confirmations` 记 `order_ref` 去重）。
3. 对每个新订单自动 `INSERT payment_confirmations(status='PENDING')`，并推送通知给 CS（Lark/WA），附该订单的确认链接。

**调度（已定）**：用 **GitHub Actions 定时**（~5 分钟）打 `confirm-poll` 端点（免费，无需升级）。在 webuyops 仓库加 `.github/workflows/confirm-poll.yml`，`schedule: cron '*/5 * * * *'`，带 `SYNC_SECRET` 调用 `https://webuy-ops.vercel.app/api/confirm-poll`。
> 备选：升 Vercel Pro cron（每分钟）。秒级实时需 Skybear ERP webhook（改 `webuy-tourt-service-idn`），暂不做。

> 真正的"秒级实时"需要 Skybear ERP 在订单状态变更时主动推 webhook —— 那要改 `webuy-tourt-service-idn`（ERP 后端，另一个团队/仓库）。除非必须秒级，否则 (a)/(b) 的几分钟轮询性价比最高。

---

## 4. 角色与触点

| 角色 | 在哪个系统 | 做什么 |
|---|---|---|
| 财务 | OPS · DP Collection | 收到截图 → 点生成确认链接 → 发给 CS |
| CS | OPS · 确认页 | 核对 4 项信息 + 选签证类型 → 提交；建 WA 群发链接 |
| 顾客 | STC · `/card/{token}/documents` | 看清单 → 自助上传材料 |
| 签证团队 | OPS · Visa 页 | 审核顾客上传的材料（通过/驳回） |

---

## 5. 数据模型

### 5.1 OPS 端（Supabase）

**`payment_confirmations`**（已建）—— 财务/CS 确认记录
```
id(uuid, =链接token) · order_ref · bkg_no · tour_code · tour_name · departure_date
contact_name · destination · pax_count · visa_type · visa_country
doc_checklist(jsonb) · status(PENDING/CONFIRMED) · created_by/at · confirmed_by/at
```

**`visa_documents`**（已存在）—— 签证团队审核用，新增来源标记
```
（现有）tour_id · pax_name · doc_type · storage_path · review_status(pending/approved/rejected)
（建议新增）source('cs'|'customer') · external_url(R2链接) · stc_traveller_id
```

### 5.2 STC 端（Neon · 新增 2 张 Drizzle 表）

**`traveller_visa_requirements`** —— OPS 推过来的"该乘客要传什么"
```
id · travellerId(=passenger.id) · tourId · visaType · visaCountry
requiredDocs(jsonb: [{key,label}]) · opsConfirmationId(可溯源回 OPS)
status(pending/submitted/complete) · createdAt/updatedAt   [travellerId 唯一]
```

**`traveller_documents`** —— 顾客上传的文件
```
id · travellerId · tourId · docKey(passport/photo/...) · fileUrl · fileName
status(uploaded/synced/rejected) · syncedToOps(bool) · uploadedAt   [travellerId 索引]
```

---

## 6. API 接口契约

### 6.1 STC 新增

**`POST /api/admin/visa-requirement`**（OPS 调用，共享密钥鉴权）
```jsonc
// 请求
{
  "tourCode": "TST250101",
  "visaType": "INDIVIDUAL VISA",
  "visaCountry": "Japan",
  "requiredDocs": [{"key":"passport","label":"Passport"}, ...],
  "opsConfirmationId": "<payment_confirmations.id>",
  "travellers": [{"travellerId": 123}, ...]   // 可选；不传则按团号全员
}
// 响应
{ "ok": true, "links": [{"travellerId":123,"name":"...","url":"https://travel.webuyid.com/card/{token}/documents"}] }
```

**`GET /api/card/{token}/documents`**（顾客页读取，token 鉴权）
```jsonc
{ "status":"ok",
  "requirement": {"visaType":"...","visaCountry":"...","requiredDocs":[...]},
  "uploaded": [{"docKey":"passport","fileName":"...","fileUrl":"...","status":"uploaded"}] }
```

**`POST /api/card/{token}/documents`**（顾客上传完成回调，token 鉴权）
```jsonc
{ "docKey":"passport", "fileUrl":"<blob/r2 url>", "fileName":"..." }
// → 写 traveller_documents，并触发同步回 OPS
```

**`POST /api/card/{token}/documents/blob-upload`**（Blob 直传握手，token 鉴权）
> 仿现有 admin `blob-upload`，把 admin token 校验换成 card token 校验，路径前缀 `customer-docs/{tourCode}/{travellerId}/`。

### 6.2 OPS 新增

**`POST /api/visa-doc-ingest`**（STC 调用，共享密钥鉴权）
```jsonc
{ "tourCode":"...", "stcTravellerId":123, "paxName":"...",
  "docType":"passport", "externalUrl":"<r2 url>", "fileName":"..." }
// → upsert 到 visa_documents（source='customer', review_status='pending'）
```

---

## 7. 鉴权与密钥

| 调用 | 方向 | 鉴权方式 |
|---|---|---|
| 顾客读/传材料 | 浏览器 → STC | **card token**（URL 里的 token，天然本人） |
| 推送清单 | OPS → STC | **共享密钥** `X-Ops-Stc-Secret`（两边 Vercel env 各配一份） |
| 同步回审核 | STC → OPS | **共享密钥** `X-Stc-Ops-Secret` |

> 共享密钥由我生成随机值，你分别填到 OPS 和 STC 的 Vercel 环境变量。**不进 git**。

---

## 8. 签证材料清单规则

MVP 先用"团签/个签"两套默认清单（已在 OPS 确认页内置）：
- **个签**（默认 7 项）：护照、照片、KTP、KK、3 个月银行流水、银行证明、…
- **团签**（默认 3 项）：护照、照片、KTP

CS 在确认页可手动增减。**后续**若不同国家差异大，再加一张"按国家×签证类型"的清单配置表（`visa_checklist_rules`），让清单按 `destination + visaType` 自动取。

---

## 9. 分阶段交付

| 阶段 | 内容 | 系统 | 依赖 |
|---|---|---|---|
| ✅ Phase 0 | 手动生链接 + CS 确认页（兜底路径） | OPS | 已上线 |
| **Phase A** | **近实时触发**：`confirm-poll` 端点（直连 Skybear 查 3/4）+ 自动建记录 + 通知 CS + 调度器 | OPS | 调度方案（Pro cron / GitHub Actions） |
| Phase 1 | STC 顾客上传页 + 2 张表 + 顾客接口 | STC | Neon 连接串、Blob token |
| Phase 2 | OPS→STC 推清单（CS 确认时触发）+ 回链接给 CS | 两边 | 共享密钥、STC base URL |
| Phase 3 | STC→OPS 同步回 visa_documents | 两边 | 共享密钥、visa_documents 加列 |
| Phase 4 | 两边部署 + 配密钥 + 端到端实测 | 两边 | STC Vercel 部署权限 |

> Phase 1 的 STC 代码可以**先全部写出来审查**，不需要任何密钥；只有跑迁移/部署/测才需要凭据。

---

## 10. 需要你提供的（卡点）

1. **触发调度方案**（Phase A）：升 Vercel Pro cron（每分钟）/ 用 GitHub Actions（~5 分钟）/ 已有 worker —— 选一个。
2. **STC 的 Neon 连接串**（`DATABASE_URL_UNPOOLED`）—— 建表 + 本地测。
3. **STC 的 Vercel 部署权限**（独立项目，非 webuy-ops）—— 或你来点部署。
4. **共享密钥**：我生成，你填到两边 Vercel env。
5. 确认 **STC 顾客域名**（`travel.webuyid.com`？还是仍用 `smart-travel-card-id-h5-mu.vercel.app`），链接要用对域名。
6. 确认 **CS 通知渠道**：自动建记录后用什么通知 CS（Lark 群？WA？OPS 内 Work Queue？）。

---

## 11. 风险与边界

- **已有 `webuy-confirmation-worker`**（Python，"团审/客户确认书 worker"）与本项目相邻，偏"确认书 PDF 生成/比对"，与"收护照"不同；动工前需确认两者职责不重叠。
- **隐私**：护照是高敏数据。顾客上传走 token 私链 + R2 私有桶 + 签名 URL；OPS 侧沿用现有 RLS。不在 URL 放任何明文身份信息。
- **文件归属**：MVP 让 OPS `visa_documents` 存 R2 外链（不复制文件字节），最省事；若签证团队需要"OPS 本地留底"，Phase 3 再加 R2→Supabase Storage 拷贝。
- **STC 数据来源**：当前 STC runtime 在 Phase 2 前读 onboarding 快照（`tour_setup_states.draftData.merged`），乘客 `travellerId` 以此为准；接清单时按团号匹配乘客需对齐这套 id。
```
