const fs = require('fs');
const os = require('os');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { applyCors } = require('./_cors');

// This endpoint also dispatches to the CRM handler (which accepts POST), so the
// preflight must advertise POST in addition to the GET intelligence path.
function cors(req, res) { applyCors(req, res, { methods: 'GET,POST,OPTIONS' }); }

function serviceClient() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function requireUser(supabase, req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

function dataPlatformUrl() {
  if (process.env.WEBUY_DATA_MCP_URL) return process.env.WEBUY_DATA_MCP_URL;
  if (process.env.WEBUY_DATA_MCP_TOKEN) {
    return `https://webuy-data-platform.onrender.com/mcp?token=${process.env.WEBUY_DATA_MCP_TOKEN}`;
  }

  if (process.env.VERCEL) return '';
  try {
    const cfg = fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8');
    const m = cfg.match(/https:\/\/webuy-data-platform\.onrender\.com\/mcp\?token=[^"\]\s]+/);
    return m ? m[0] : '';
  } catch {
    return '';
  }
}

function parseSseJson(body) {
  const lines = String(body || '').split(/\r?\n/).filter(line => line.startsWith('data: ')).map(line => line.slice(6));
  return JSON.parse(lines.length ? lines.join('\n') : body);
}

async function callMcpTool(name, args) {
  const url = dataPlatformUrl();
  if (!url) throw new Error('WEBUY_DATA_MCP_URL or WEBUY_DATA_MCP_TOKEN not set');

  const payload = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: { name, arguments: args || {} },
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`data platform HTTP ${r.status}: ${text.slice(0, 220)}`);
  const obj = parseSseJson(text);
  if (obj.error) throw new Error(obj.error.message || JSON.stringify(obj.error));
  const content = obj.result?.content?.[0]?.text || obj.result?.result || obj.result;
  return typeof content === 'string' ? JSON.parse(content) : content;
}

async function runSql(sql) {
  const out = await callMcpTool('run_sql', { sql });
  return out.rows || [];
}

const PRODUCT_FAMILY_CASE = `
CASE
  WHEN upper(txt) LIKE '%XINJIANG%' OR txt LIKE '%新疆%' OR txt LIKE '%北疆%' THEN 'China · Xinjiang'
  WHEN upper(txt) LIKE '%CHONGQING%' OR txt LIKE '%重庆%' OR upper(txt) LIKE '%ZHANGJIAJIE%' OR txt LIKE '%张家界%' THEN 'China · Chongqing/Zhangjiajie'
  WHEN upper(txt) LIKE '%BEIJING%' OR txt LIKE '%北京%' OR upper(txt) LIKE '%SHANGHAI%' OR txt LIKE '%上海%' THEN 'China · Beijing/Shanghai'
  WHEN upper(txt) LIKE '%CHINA%' OR txt LIKE '%中国%' OR upper(txt) LIKE '%YUNNAN%' OR upper(txt) LIKE '%KUNMING%' OR upper(txt) LIKE '%DALI%' OR upper(txt) LIKE '%LIJIANG%' OR upper(txt) LIKE '%SHANGRILA%' OR upper(txt) LIKE '%SHANGRILLA%' THEN 'China · Other'
  WHEN upper(txt) LIKE '%KOREA%' OR txt LIKE '%韩国%' OR upper(txt) LIKE '%NAMI%' THEN 'Korea'
  WHEN upper(txt) LIKE '%JAPAN%' OR txt LIKE '%日本%' OR upper(txt) LIKE '%TOKYO%' OR upper(txt) LIKE '%OSAKA%' OR upper(txt) LIKE '%HOKKAIDO%' THEN 'Japan'
  WHEN upper(txt) LIKE '%VIETNAM%' OR txt LIKE '%越南%' OR upper(txt) LIKE '%HANOI%' OR upper(txt) LIKE '%SAPA%' OR upper(txt) LIKE '%HALONG%' THEN 'Vietnam'
  WHEN upper(txt) LIKE '%EUROPE%' OR txt LIKE '%欧洲%' OR txt LIKE '%西欧%' THEN 'Europe'
  WHEN upper(txt) LIKE '%TURKEY%' OR upper(txt) LIKE '%TURKIYE%' OR txt LIKE '%土耳其%' THEN 'Turkey'
  WHEN upper(txt) LIKE '%BALI%' THEN 'Bali'
  WHEN upper(txt) LIKE '%SINGAPORE%' OR txt LIKE '%新加坡%' THEN 'Singapore'
  ELSE 'Other / Unmapped'
END`;

const PRODUCT_NAME_EXPR = `regexp_replace(trim(COALESCE(NULLIF(tour_name,''), NULLIF(product_type_name,''), NULLIF(tour_code,''), '-')), '\\s+', ' ', 'g')`;

const salesFamilySql = `
WITH o AS (
  SELECT
    order_id,
    tour_code,
    COALESCE(tour_name, product_type_name, tour_code, '') AS tour_name,
    (COALESCE(tour_name,'') || ' ' || COALESCE(product_type_name,'') || ' ' || COALESCE(tour_code,'')) AS txt,
    total_amount,
    booking_date,
    departure_date,
    order_status_mapped
  FROM semantic.order_sales_view
  WHERE legal_entity = 'wbt_id'
    AND booking_date >= current_date - interval '180 days'
    AND order_status_mapped NOT IN ('CANCELLED','REFUNDED')
),
c AS (
  SELECT *, ${PRODUCT_FAMILY_CASE} AS product_family
  FROM o
)
SELECT
  product_family,
  COUNT(*) AS orders,
  COUNT(DISTINCT tour_code) AS tour_codes,
  SUM(total_amount) AS revenue_idr,
  COUNT(*) FILTER (WHERE booking_date >= current_date - interval '30 days') AS orders_30d,
  MAX(booking_date) AS last_booking,
  MIN(departure_date) FILTER (WHERE departure_date >= current_date) AS next_departure
FROM c
GROUP BY product_family
ORDER BY orders DESC, revenue_idr DESC
LIMIT 18`;

const topProductsSql = `
WITH base AS (
  SELECT
    ${PRODUCT_NAME_EXPR} AS product_name,
    tour_code,
    total_amount,
    booking_date,
    departure_date,
    (${PRODUCT_NAME_EXPR} || ' ' || COALESCE(tour_code,'')) AS txt
  FROM semantic.order_sales_view
  WHERE legal_entity = 'wbt_id'
    AND booking_date >= current_date - interval '180 days'
    AND order_status_mapped NOT IN ('CANCELLED','REFUNDED')
),
mapped AS (
  SELECT *, ${PRODUCT_FAMILY_CASE} AS product_family
  FROM base
)
SELECT
  product_name,
  product_family,
  COUNT(*) AS orders,
  COUNT(DISTINCT tour_code) AS tour_codes,
  SUM(total_amount) AS revenue_idr,
  COUNT(*) FILTER (WHERE booking_date >= current_date - interval '30 days') AS orders_30d,
  MAX(booking_date) AS last_booking,
  MIN(departure_date) FILTER (WHERE departure_date >= current_date) AS next_departure
FROM mapped
GROUP BY product_name, product_family
ORDER BY orders DESC, revenue_idr DESC
LIMIT 30`;

const productMonthlySalesSql = `
WITH base AS (
  SELECT
    date_trunc('month', booking_date)::date AS booking_month,
    ${PRODUCT_NAME_EXPR} AS product_name,
    tour_code,
    total_amount,
    booking_date,
    departure_date,
    (${PRODUCT_NAME_EXPR} || ' ' || COALESCE(tour_code,'')) AS txt
  FROM semantic.order_sales_view
  WHERE legal_entity = 'wbt_id'
    AND booking_date >= date_trunc('month', current_date) - interval '11 months'
    AND order_status_mapped NOT IN ('CANCELLED','REFUNDED')
),
mapped AS (
  SELECT *, ${PRODUCT_FAMILY_CASE} AS product_family
  FROM base
)
SELECT
  booking_month,
  product_name,
  product_family,
  COUNT(*) AS orders,
  COUNT(DISTINCT tour_code) AS tour_codes,
  SUM(total_amount) AS revenue_idr,
  MAX(booking_date) AS last_booking,
  MIN(departure_date) FILTER (WHERE departure_date >= current_date) AS next_departure
FROM mapped
GROUP BY booking_month, product_name, product_family
ORDER BY booking_month DESC, orders DESC, revenue_idr DESC
LIMIT 500`;

const demandFamilySql = `
WITH u AS (
  SELECT contact_id, mentioned_destinations, topics
  FROM curated.respondio_id_webuytravel_contact_history_conversations
  WHERE summary_status = 'SUCCESS'
  UNION ALL
  SELECT contact_id, mentioned_destinations, topics
  FROM curated.respondio_id_webuytravel_contact_day_conversations
  WHERE summary_status = 'SUCCESS'
),
d AS (
  SELECT contact_id, lower(trim(x)) AS raw_destination
  FROM u, unnest(mentioned_destinations) x
  WHERE trim(x) <> ''
),
m AS (
  SELECT
    contact_id,
    raw_destination,
    CASE
      WHEN raw_destination LIKE '%xinjiang%' OR raw_destination LIKE '%新疆%' OR raw_destination LIKE '%北疆%' THEN 'China · Xinjiang'
      WHEN raw_destination LIKE '%chongqing%' OR raw_destination LIKE '%重庆%' OR raw_destination LIKE '%zhangjiajie%' OR raw_destination LIKE '%张家界%' THEN 'China · Chongqing/Zhangjiajie'
      WHEN raw_destination LIKE '%beijing%' OR raw_destination LIKE '%北京%' OR raw_destination LIKE '%shanghai%' OR raw_destination LIKE '%上海%' THEN 'China · Beijing/Shanghai'
      WHEN raw_destination LIKE '%china%' OR raw_destination LIKE '%中国%' OR raw_destination LIKE '%yunnan%' OR raw_destination LIKE '%kunming%' OR raw_destination LIKE '%dali%' OR raw_destination LIKE '%lijiang%' OR raw_destination LIKE '%shangrila%' OR raw_destination LIKE '%shangrilla%' THEN 'China · Other'
      WHEN raw_destination LIKE '%korea%' OR raw_destination LIKE '%韩国%' OR raw_destination LIKE '%nami%' THEN 'Korea'
      WHEN raw_destination LIKE '%japan%' OR raw_destination LIKE '%日本%' OR raw_destination LIKE '%tokyo%' OR raw_destination LIKE '%osaka%' OR raw_destination LIKE '%hokkaido%' THEN 'Japan'
      WHEN raw_destination LIKE '%vietnam%' OR raw_destination LIKE '%越南%' OR raw_destination LIKE '%hanoi%' OR raw_destination LIKE '%sapa%' OR raw_destination LIKE '%halong%' THEN 'Vietnam'
      WHEN raw_destination LIKE '%europe%' OR raw_destination LIKE '%欧洲%' OR raw_destination LIKE '%西欧%' THEN 'Europe'
      WHEN raw_destination LIKE '%turkey%' OR raw_destination LIKE '%turkiye%' OR raw_destination LIKE '%土耳其%' THEN 'Turkey'
      WHEN raw_destination LIKE '%bali%' THEN 'Bali'
      WHEN raw_destination LIKE '%singapore%' OR raw_destination LIKE '%新加坡%' THEN 'Singapore'
      ELSE 'Other / Unmapped'
    END AS product_family
  FROM d
),
family_agg AS (
  SELECT product_family, COUNT(*) AS mentions, COUNT(DISTINCT contact_id) AS contacts
  FROM m
  GROUP BY product_family
),
raw_ranked AS (
  SELECT
    product_family,
    raw_destination,
    COUNT(*) AS raw_mentions,
    ROW_NUMBER() OVER (PARTITION BY product_family ORDER BY COUNT(*) DESC, raw_destination) AS rn
  FROM m
  WHERE raw_destination <> ''
  GROUP BY product_family, raw_destination
),
examples AS (
  SELECT product_family, ARRAY_AGG(raw_destination ORDER BY raw_mentions DESC, raw_destination) AS raw_examples
  FROM raw_ranked
  WHERE rn <= 8
  GROUP BY product_family
)
SELECT
  f.product_family,
  f.mentions,
  f.contacts,
  COALESCE(e.raw_examples, ARRAY[]::text[]) AS raw_examples
FROM family_agg f
LEFT JOIN examples e ON e.product_family = f.product_family
ORDER BY contacts DESC, mentions DESC
LIMIT 18`;

const topTopicsSql = `
WITH u AS (
  SELECT contact_id, topics
  FROM curated.respondio_id_webuytravel_contact_history_conversations
  WHERE summary_status = 'SUCCESS'
  UNION ALL
  SELECT contact_id, topics
  FROM curated.respondio_id_webuytravel_contact_day_conversations
  WHERE summary_status = 'SUCCESS'
),
t AS (
  SELECT lower(trim(x)) AS topic, contact_id
  FROM u, unnest(topics) x
  WHERE trim(x) <> ''
),
mapped AS (
  SELECT
    contact_id,
    topic AS raw_topic,
    CASE
      WHEN topic LIKE '%price%' OR topic LIKE '%harga%' OR topic LIKE '%budget%' OR topic LIKE '%biaya%' OR topic LIKE '%价格%' OR topic LIKE '%预算%' OR topic LIKE '%费用%' THEN '价格/预算'
      WHEN topic LIKE '%date%' OR topic LIKE '%tanggal%' OR topic LIKE '%jadwal%' OR topic LIKE '%schedule%' OR topic LIKE '%season%' OR topic LIKE '%musim%' OR topic LIKE '%出发%' OR topic LIKE '%日期%' OR topic LIKE '%季节%' OR topic LIKE '%时间%' THEN '出发日期/淡旺季'
      WHEN topic LIKE '%itinerary%' OR topic LIKE '%route%' OR topic LIKE '%rute%' OR topic LIKE '%行程%' OR topic LIKE '%景点%' OR topic LIKE '%安排%' OR topic LIKE '%travel plan%' OR topic LIKE '%出行计划%' THEN '行程/路线'
      WHEN topic LIKE '%promo%' OR topic LIKE '%promotion%' OR topic LIKE '%促销%' OR topic LIKE '%package%' OR topic LIKE '%paket%' OR topic LIKE '%套餐%' OR topic LIKE '%product%' OR topic LIKE '%产品%' THEN '套餐/促销'
      WHEN topic LIKE '%booking%' OR topic LIKE '%book%' OR topic LIKE '%payment%' OR topic LIKE '%deposit%' OR topic LIKE '%dp%' OR topic LIKE '%付款%' OR topic LIKE '%支付%' OR topic LIKE '%预订%' THEN '预订/付款'
      WHEN topic LIKE '%visa%' OR topic LIKE '%passport%' OR topic LIKE '%document%' OR topic LIKE '%签证%' OR topic LIKE '%护照%' OR topic LIKE '%文件%' THEN '签证/文件'
      WHEN topic LIKE '%flight%' OR topic LIKE '%airline%' OR topic LIKE '%航班%' OR topic LIKE '%机票%' OR topic LIKE '%航空%' THEN '航班/航空'
      WHEN topic LIKE '%hotel%' OR topic LIKE '%meal%' OR topic LIKE '%makan%' OR topic LIKE '%halal%' OR topic LIKE '%酒店%' OR topic LIKE '%餐%' OR topic LIKE '%升级%' THEN '酒店/餐食/升级'
      WHEN topic LIKE '%private%' OR topic LIKE '%customized%' OR topic LIKE '%customised%' OR topic LIKE '%custom tour%' OR topic LIKE '%custom trip%' OR topic LIKE '%group tour%' OR topic LIKE '%定制%' OR topic LIKE '%私人%' OR topic LIKE '%包团%' THEN '私人/定制团'
      WHEN topic LIKE '%follow%' OR topic LIKE '%response%' OR topic LIKE '%客户跟进%' OR topic LIKE '%跟进%' THEN '销售跟进'
      WHEN topic LIKE '%客户需求%' OR topic LIKE '%客户咨询%' OR topic LIKE '%customer inquiry%' OR topic LIKE '%旅行咨询%' OR topic LIKE '%旅游咨询%' THEN '一般咨询/需求'
      WHEN topic LIKE '%destination%' OR topic LIKE '%目的地%' OR topic LIKE '%越南%' OR topic LIKE '%韩国%' OR topic LIKE '%日本%' OR topic LIKE '%欧洲%' OR topic LIKE '%中国%' OR topic LIKE '%北京%' OR topic LIKE '%上海%' OR topic LIKE '%重庆%' OR topic LIKE '%新疆%' OR topic LIKE '%korea%' OR topic LIKE '%japan%' OR topic LIKE '%vietnam%' OR topic LIKE '%europe%' OR topic LIKE '%china%' THEN '目的地兴趣'
      ELSE '其他待复核'
    END AS topic_category
  FROM t
),
agg AS (
  SELECT topic_category, COUNT(*) AS mentions, COUNT(DISTINCT contact_id) AS contacts
  FROM mapped
  GROUP BY topic_category
),
raw_ranked AS (
  SELECT
    topic_category,
    raw_topic,
    COUNT(*) AS raw_mentions,
    ROW_NUMBER() OVER (PARTITION BY topic_category ORDER BY COUNT(*) DESC, raw_topic) AS rn
  FROM mapped
  GROUP BY topic_category, raw_topic
),
examples AS (
  SELECT topic_category, ARRAY_AGG(raw_topic ORDER BY raw_mentions DESC, raw_topic) AS examples
  FROM raw_ranked
  WHERE rn <= 5
  GROUP BY topic_category
)
SELECT
  a.topic_category,
  a.mentions,
  a.contacts,
  COALESCE(e.examples, ARRAY[]::text[]) AS examples
FROM agg a
LEFT JOIN examples e ON e.topic_category = a.topic_category
ORDER BY contacts DESC, mentions DESC
LIMIT 15`;

const totalsSql = `
SELECT
  (SELECT COUNT(*) FROM semantic.order_sales_view WHERE legal_entity='wbt_id') AS id_orders,
  (SELECT COUNT(*) FROM semantic.order_sales_view WHERE legal_entity='wbt_id' AND booking_date >= current_date - interval '90 days') AS id_orders_90d,
  (SELECT COUNT(DISTINCT tour_code) FROM semantic.order_sales_view WHERE legal_entity='wbt_id') AS id_tour_codes,
  (SELECT COUNT(*) FROM semantic.id_customer_360_view) AS id_customers,
  (SELECT COUNT(*) FROM curated.respondio_id_webuytravel_contact_history_conversations WHERE summary_status='SUCCESS') AS respond_history_success,
  (SELECT COUNT(*) FROM curated.respondio_id_webuytravel_contact_day_conversations WHERE summary_status='SUCCESS') AS respond_day_success,
  (SELECT COUNT(*) FROM semantic.respondio_contact_attribution_fact WHERE region='id') AS id_attribution_contacts`;

const metaMonthlySql = `
SELECT
  date_trunc('month', date)::date AS month,
  currency,
  SUM(meta_spend) AS spend,
  SUM(meta_platform_leads) AS platform_leads,
  CASE WHEN SUM(meta_platform_leads) > 0 THEN ROUND(SUM(meta_spend) / SUM(meta_platform_leads), 2) END AS cpl
FROM semantic.lead_funnel_meta_spend
WHERE region = 'id'
  AND date >= current_date - interval '180 days'
GROUP BY month, currency
ORDER BY month DESC`;

const sourceAttributionSql = `
SELECT
  date_trunc('month', lead_date)::date AS month,
  source_group,
  COUNT(*) AS leads,
  COUNT(*) FILTER (WHERE confirmed_ad) AS confirmed_ad,
  COUNT(*) FILTER (WHERE attribution_confidence >= 0.8) AS high_confidence
FROM semantic.respondio_contact_attribution_fact
WHERE region = 'id'
  AND lead_date >= date_trunc('month', current_date) - interval '11 months'
GROUP BY month, source_group
ORDER BY month DESC, leads DESC`;

const channelConversionSql = `
WITH linked AS (
  SELECT
    date_trunc('month', lead_date)::date AS month,
    source_group,
    respondio_contact_id,
    order_id,
    total_amount
  FROM semantic.contact_order_link
  WHERE respondio_account = 'id_webuytravel'
    AND match_confidence >= 0.95
    AND order_after_inquiry
    AND order_business_entity = 'wbt_id'
    AND lead_date >= date_trunc('month', current_date) - interval '11 months'
),
distinct_orders AS (
  SELECT DISTINCT month, source_group, order_id, total_amount
  FROM linked
),
link_counts AS (
  SELECT
    month,
    source_group,
    COUNT(DISTINCT respondio_contact_id) AS converted_contacts,
    COUNT(DISTINCT order_id) AS linked_orders
  FROM linked
  GROUP BY month, source_group
),
revenue AS (
  SELECT
    month,
    source_group,
    SUM(total_amount) AS linked_revenue_idr
  FROM distinct_orders
  GROUP BY month, source_group
)
SELECT
  c.month,
  c.source_group,
  c.converted_contacts,
  c.linked_orders,
  COALESCE(r.linked_revenue_idr, 0) AS linked_revenue_idr
FROM link_counts c
LEFT JOIN revenue r ON r.month = c.month AND r.source_group = c.source_group
ORDER BY c.month DESC, linked_orders DESC, linked_revenue_idr DESC`;

const campaignLeadSql = `
SELECT
  date_trunc('month', lead_date)::date AS month,
  COALESCE(NULLIF(campaign_name,''), '(no campaign name)') AS campaign_name,
  source_group,
  COUNT(*) AS leads,
  COUNT(*) FILTER (WHERE confirmed_ad) AS confirmed_ad,
  MAX(lead_date) AS last_lead_date
FROM semantic.respondio_contact_attribution_fact
WHERE region = 'id'
  AND lead_date >= date_trunc('month', current_date) - interval '11 months'
GROUP BY month, campaign_name, source_group
ORDER BY month DESC, leads DESC
LIMIT 120`;

const googleMonthlySql = `
SELECT
  date_trunc('month', date)::date AS month,
  currency,
  SUM(ad_cost) AS ad_cost,
  SUM(ad_leads) AS ad_leads,
  SUM(revenue) AS revenue,
  CASE WHEN SUM(ad_cost) > 0 THEN ROUND(SUM(revenue) / SUM(ad_cost), 2) END AS roi
FROM semantic.ad_roi_business_view
WHERE source_system = 'GOOGLE_ADS'
  AND region = 'id'
  AND account_id = '2245831515'
  AND date >= current_date - interval '180 days'
GROUP BY month, currency
ORDER BY month DESC`;

const crmIdentitySql = `
SELECT
  COUNT(DISTINCT canonical_customer_id) AS canonical_customers,
  COUNT(*) FILTER (WHERE source_system='SKYBEAR' AND scope='wbt_id') AS skybear_id_rows,
  COUNT(*) FILTER (WHERE source_system='RESPONDIO' AND scope='id') AS respond_id_rows,
  COUNT(DISTINCT canonical_customer_id) FILTER (WHERE cross_system) AS cross_system_customers
FROM semantic.customer_identity_map
WHERE scope IN ('wbt_id','id')`;

const autoSqlMonthlySql = `
SELECT
  date_trunc('month', auto_sql_date)::date AS month,
  COUNT(*) AS auto_sql_count,
  COUNT(DISTINCT salesperson) AS salespeople
FROM semantic.respondio_auto_sql_contact_fact
WHERE account = 'id_webuytravel'
  AND auto_sql_on_marked_date
  AND auto_sql_date >= current_date - interval '180 days'
GROUP BY month
ORDER BY month DESC`;

const autoSqlSalesSql = `
SELECT
  salesperson,
  COUNT(*) AS auto_sql_count,
  MAX(auto_sql_date) AS last_auto_sql_date
FROM semantic.respondio_auto_sql_contact_fact
WHERE account = 'id_webuytravel'
  AND auto_sql_on_marked_date
  AND auto_sql_date >= current_date - interval '30 days'
GROUP BY salesperson
ORDER BY auto_sql_count DESC
LIMIT 20`;

const crmHandler = require('./_id-crm');

module.exports = async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  const url = new URL(req.url || '/', 'https://webuy-ops.local');
  if (url.searchParams.has('audience') || url.searchParams.get('crm') === '1') return crmHandler(req, res);
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const supabase = serviceClient();
    const user = await requireUser(supabase, req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const [
      totals,
      salesFamilies,
      topProducts,
      productMonthlySales,
      demandFamilies,
      topTopics,
      metaMonthly,
      sourceAttribution,
      channelConversion,
      campaignLeads,
      googleMonthly,
      crmIdentity,
      autoSqlMonthly,
      autoSqlSales,
    ] = await Promise.all([
      runSql(totalsSql),
      runSql(salesFamilySql),
      runSql(topProductsSql),
      runSql(productMonthlySalesSql),
      runSql(demandFamilySql),
      runSql(topTopicsSql),
      runSql(metaMonthlySql),
      runSql(sourceAttributionSql),
      runSql(channelConversionSql),
      runSql(campaignLeadSql),
      runSql(googleMonthlySql),
      runSql(crmIdentitySql),
      runSql(autoSqlMonthlySql),
      runSql(autoSqlSalesSql),
    ]);

    return res.status(200).json({
      generated_at: new Date().toISOString(),
      scope: {
        business_entity: 'wbt_id',
        region: 'id',
        respondio_account: 'id_webuytravel',
        currency: 'IDR',
        blocked: ['sg_webuytravel', 'wbt_sg', 'SGD aggregation'],
      },
      totals: totals[0] || {},
      product: {
        sales_families: salesFamilies,
        top_products: topProducts,
        monthly_sales: productMonthlySales,
        demand_families: demandFamilies.map(r => ({
          ...r,
          raw_examples: Array.isArray(r.raw_examples) ? [...new Set(r.raw_examples)].slice(0, 8) : [],
        })),
        top_topics: topTopics.map(r => ({
          ...r,
          examples: Array.isArray(r.examples) ? [...new Set(r.examples)].slice(0, 5) : [],
        })),
      },
      marketing: {
        meta_monthly: metaMonthly,
        google_monthly: googleMonthly,
        source_attribution: sourceAttribution,
        channel_conversion: channelConversion,
        campaign_leads: campaignLeads,
        product_monthly_sales: productMonthlySales,
      },
      crm: {
        identity: crmIdentity[0] || {},
        auto_sql_monthly: autoSqlMonthly,
        auto_sql_sales: autoSqlSales,
      },
      notes: [
        'All SQL is fixed server-side and filtered to Indonesia scope only.',
        'Respond history table covers <=2026-05-23; day conversation table is unioned for recent successful summaries.',
        'Revenue is IDR only and must not be mixed with SGD.',
        'Product family mapping is a first-pass deterministic map; unmapped rows should be reviewed in ID Product Map.',
      ],
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
