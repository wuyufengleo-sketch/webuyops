# 部署清单 — 行程报价生成 (Itinerary Quote)

一次性配置，之后业务员在 `/app` 里上传地接 `.docx` 即可生成客户版 Word + 在线链接。
全程跑在 Vercel + Supabase，无独立服务器/worker。

## 架构
```
app.html「行程报价生成」模块
  └─ 上传 .docx → Supabase Storage(quote-src) + insert itinerary_quotes
  └─ POST /api/quote-generate   mammoth 解析 + Claude(Sonnet) 一次调用 → 存 JSON   (<60s)
  └─ POST /api/quote-render     Pexels 抓图 + docx-js 拼 Word + 传 Storage(quote-out) (<60s)
  └─ 显示：📄 Word 下载链  +  🔗 /q?id=… 在线预览页（quote.html，含一键 PDF）
公开页 /q?id=…  → GET /api/quote-get 取 JSON 渲染（客户手机直接看，点 PDF = 浏览器打印转 PDF）
```

## 1) Supabase（运行一次 migration）
在 Supabase SQL editor 跑 `supabase/migrations/017-itinerary-quote.sql`。
它会建：表 `itinerary_quotes`（+RLS +Realtime）、两个 Storage bucket
`quote-src`(私有) / `quote-out`(公开) 及其访问策略。

## 2) Vercel 环境变量（Project → Settings → Environment Variables）
| 变量 | 必填 | 说明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | Claude API key（行程文案生成） |
| `PEXELS_API_KEY` | ✅ | Pexels 免费 API key（景点配图）。无则不配图，其余照常 |
| `SUPABASE_URL` | ✅ | 已存在（sync-skybar 用的同一个） |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | 已存在；服务端读写/上传用，**切勿暴露给浏览器** |
| `QUOTE_MODEL` | 选 | 默认 `claude-sonnet-4-6`（快+省，稳进 60s） |
| `QUOTE_FX_RATE` | 选 | 自费项目 RMB→IDR 汇率，默认 `2700` |
| `QUOTE_PROFIT` | 选 | 自费项目加价，默认 `0.20`（20%） |
| `QUOTE_ROUND` | 选 | 自费项目向上取整到，默认 `50000`（5 万印尼盾） |
| `QUOTE_MOCK` | 选 | 设 `1` 用假数据冒烟测（不花 LLM token），上线后删掉 |

> 免费 Hobby 套餐：函数时限已在 `vercel.json` 配到 60s。生成走「单次 LLM 调用」+ 抓图/拼 Word 分两个函数，稳进 60s。超大团若仍偏紧，把 `quote-generate` 的 LLM 按天拆两次即可。

## 3) 前端模块
按 `docs/quote-module.md` 把模块贴进 `app.html`（4 处：nav / page 容器 / ROLE_NAV / renderFn+goPage）。
把 `quote` 加进 sales、ops、admin 的可见角色。

## 4) 冒烟测试
1. 先设 `QUOTE_MOCK=1` 部署。
2. `/app` →「行程报价生成」→ 上传任意 `.docx`（内容不限，mock 会忽略）→ 应得到 Word 下载链 + `/q?id=…` 在线页。
3. 打开在线页，点「⬇️ PDF」确认能转 PDF。
4. 删掉 `QUOTE_MOCK`，配好 `ANTHROPIC_API_KEY`/`PEXELS_API_KEY`，用真实地接 `.docx` 验收。

## 注意
- **只收 `.docx`**（业务员在 Word「另存为 .docx」）。老 `.doc` 需 LibreOffice 转换，会破坏轻量化，故不支持。
- 配图来自 Pexels（免费可商用）。地接结尾的内部备注（结算价/加点/配合购物）由 LLM 自动剔除，不进客户版。
- 自费项目价已按 `RMB×(1+QUOTE_PROFIT)×QUOTE_FX_RATE` 向上取整成印尼盾。
