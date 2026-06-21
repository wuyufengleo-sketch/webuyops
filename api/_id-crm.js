const fs = require('fs');
const os = require('os');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const STATE_KEY = 'id_crm_ops_state_v1';
const MAX_LOGS = 600;
const AUD_EXPORT_KEY = 'crm_audience_exports_v1';
const AUD_TAG_KEY = 'crm_customer_tags_v1';
const CAMPAIGN_KEY = 'crm_campaigns_v1';
const CAMPAIGN_TYPES = new Set(['reactivation', 'retarget', 'referral', 'broadcast', 'other']);
const CAMPAIGN_CHANNELS = new Set(['wa', 'meta_ads', 'google_ads', 'csv', 'other']);
const AUD_EXPORT_FIELDS = ['customer_name','phone','passport_no','segment','reason','last_trip','trips_active','spend_idr','sample_tour_codes','source_group','respondio_contact_id','match_confidence','recommended_message_angle'];
const AUD_TAGS = new Set(['family','premium','price_sensitive','complaint_risk','referral_candidate']);
const AUD_PRESETS = {
  repeat_travelers: ['Repeat Travelers', 'Passengers who traveled with us 2+ times. Best for repeat-trip ads and loyalty offers.', 'Do not over-message recent travelers; filter by last trip date when needed.'],
  high_value: ['High Value', 'Top 20% IDR spenders (per-pax share). Best for premium, long-haul, and higher margin products.', 'Some high-value passengers travel with agents or in large groups; review before VIP messaging.'],
  dormant: ['Dormant', 'Past travelers whose last trip was 180+ days ago. Best for reactivation campaigns.', 'Check recent complaint/refund tags before sending aggressive offers.'],
  destination_interest: ['Destination Interest', 'Travelers who previously visited a destination family such as Korea, China, Japan, Vietnam, Europe, or Turkey.', 'Destination is inferred from historical tour codes, so review samples for noisy codes.'],
  respond_converted: ['Respond Converted', 'Respond contacts that converted to high-confidence ID orders. Best for lookalike audiences.', 'Use match_confidence and avoid treating low-confidence phone matches as truth.'],
  post_trip_1m: ['Post-Trip 1 Month', 'Travelers whose last trip ended 25-40 days ago. Best for thank-you follow-up and review requests.', 'Send personalized messages, not bulk blasts.'],
  post_trip_3m: ['Post-Trip 3 Months', 'Travelers whose last trip ended 75-105 days ago. Best for re-engagement and next trip suggestions.', 'Recommend destinations different from their last trip.'],
  birthday_soon: ['Birthday Soon', 'Travelers with a birthday in the next 30 days. Best for birthday voucher campaigns.', 'Birthday is from passport data; some may be inaccurate.'],
};
const CUSTOMER_BASE_CTE = `pax_count AS (
  SELECT order_id, count(*) AS n
  FROM curated.passengers WHERE business_entity = 'wbt_id' GROUP BY order_id
),
pax_trips AS (
  SELECT
    p.payload->>'passport_no' AS passport_no,
    p.payload->>'passenger_name' AS pax_name,
    p.payload->>'gender' AS gender,
    p.payload->>'birthday' AS birthday,
    p.payload->>'passenger_phone' AS pax_phone,
    o.order_id, o.tour_code, o.order_status_mapped, o.departure_date,
    o.payload->>'contact_no' AS booker_phone,
    o.total_amount / NULLIF(pc.n, 0) AS pax_spend
  FROM curated.passengers p
  JOIN curated.orders o ON p.order_id = o.order_id AND p.business_entity = o.business_entity
  JOIN pax_count pc ON pc.order_id = o.order_id
  WHERE p.business_entity = 'wbt_id'
    AND coalesce(p.payload->>'passenger_name','') != ''
    AND coalesce(p.payload->>'passport_no','') != ''
    AND length(p.payload->>'passport_no') >= 5
    AND p.payload->>'passport_no' !~ '[\\u00a5\\uffe5()\\uff08\\uff09\\[\\]]'
),
customer_base AS (
  SELECT
    passport_no,
    (array_agg(pax_name ORDER BY departure_date DESC NULLS LAST))[1] AS customer_name,
    coalesce(
      (array_agg(pax_phone ORDER BY departure_date DESC NULLS LAST) FILTER (WHERE coalesce(pax_phone,'') != ''))[1],
      (array_agg(booker_phone ORDER BY departure_date DESC NULLS LAST) FILTER (WHERE coalesce(booker_phone,'') != ''))[1]
    ) AS phone,
    (array_agg(booker_phone ORDER BY departure_date DESC NULLS LAST) FILTER (WHERE coalesce(booker_phone,'') != ''))[1] AS booker_phone,
    count(DISTINCT order_id) AS total_trips,
    count(DISTINCT order_id) FILTER (WHERE order_status_mapped NOT IN ('CANCELLED','REFUNDED')) AS trips_active,
    coalesce(sum(pax_spend) FILTER (WHERE order_status_mapped NOT IN ('CANCELLED','REFUNDED')), 0) AS spend_idr,
    min(departure_date) AS first_trip,
    max(departure_date) AS last_trip,
    (array_agg(DISTINCT tour_code ORDER BY tour_code))[1:8] AS sample_tour_codes,
    (array_agg(gender ORDER BY departure_date DESC NULLS LAST) FILTER (WHERE gender IN ('F','M')))[1] AS gender,
    (array_agg(birthday ORDER BY departure_date DESC NULLS LAST) FILTER (WHERE birthday ~ '^\\d{4}-\\d{2}-\\d{2}'))[1] AS birthday
  FROM pax_trips
  GROUP BY passport_no
)`;
const AUD_DESTINATIONS = {
  korea: ['KREA', 'KR'],
  china: ['BJSH', 'CH', 'ZHJ', 'YUN', 'HAIN', 'SHA', 'BJ'],
  japan: ['JPN', 'JAP', 'NJG', 'OSA', 'TYO'],
  vietnam: ['VIE', 'VTVIE'],
  europe: ['EUR', 'EURO', 'WEU'],
  turkey: ['TRK', 'TUR'],
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
}

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

function audLimit(v, fallback, max) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}

function audDestinationWhere(destination) {
  const key = String(destination || 'korea').toLowerCase();
  const words = AUD_DESTINATIONS[key] || AUD_DESTINATIONS.korea;
  return {
    key: AUD_DESTINATIONS[key] ? key : 'korea',
    where: words.map(w => `upper(code) like ${sqlLiteral('%' + w + '%')}`).join(' or '),
  };
}

function buildTagFilterWhere(tf) {
  if (!tf || typeof tf !== 'object') return '';
  const c = [];
  if (tf.age_tier === '18-24') c.push("b.birthday IS NOT NULL AND EXTRACT(YEAR FROM age(CURRENT_DATE, b.birthday::date)) BETWEEN 18 AND 24");
  else if (tf.age_tier === '25-39') c.push("b.birthday IS NOT NULL AND EXTRACT(YEAR FROM age(CURRENT_DATE, b.birthday::date)) BETWEEN 25 AND 39");
  else if (tf.age_tier === '40-54') c.push("b.birthday IS NOT NULL AND EXTRACT(YEAR FROM age(CURRENT_DATE, b.birthday::date)) BETWEEN 40 AND 54");
  else if (tf.age_tier === '55+') c.push("b.birthday IS NOT NULL AND EXTRACT(YEAR FROM age(CURRENT_DATE, b.birthday::date)) >= 55");
  if (tf.spend_tier === 'budget') c.push("b.spend_idr < 10000000");
  else if (tf.spend_tier === 'standard') c.push("b.spend_idr >= 10000000 AND b.spend_idr < 30000000");
  else if (tf.spend_tier === 'vip') c.push("b.spend_idr >= 30000000");
  if (tf.recency === 'active') c.push("b.last_trip >= CURRENT_DATE - INTERVAL '3 months'");
  else if (tf.recency === 'warm') c.push("b.last_trip >= CURRENT_DATE - INTERVAL '6 months' AND b.last_trip < CURRENT_DATE - INTERVAL '3 months'");
  else if (tf.recency === 'cool') c.push("b.last_trip >= CURRENT_DATE - INTERVAL '12 months' AND b.last_trip < CURRENT_DATE - INTERVAL '6 months'");
  else if (tf.recency === 'dormant') c.push("b.last_trip < CURRENT_DATE - INTERVAL '12 months'");
  if (tf.gender === 'F' || tf.gender === 'M') c.push(`b.gender = ${sqlLiteral(tf.gender)}`);
  if (tf.dest) {
    const dw = audDestinationWhere(tf.dest);
    c.push(`EXISTS (SELECT 1 FROM unnest(b.sample_tour_codes) code WHERE ${dw.where})`);
  }
  if (tf.min_trips) c.push(`b.trips_active >= ${Math.max(1, parseInt(tf.min_trips, 10) || 1)}`);
  if (tf.not_dest) {
    const dw = audDestinationWhere(tf.not_dest);
    c.push(`NOT EXISTS (SELECT 1 FROM unnest(b.sample_tour_codes) code WHERE ${dw.where})`);
  }
  return c.length ? ' AND ' + c.join(' AND ') : '';
}

const TAG_SELECT_COLS = `,
       b.gender,
       CASE WHEN b.birthday IS NOT NULL THEN EXTRACT(YEAR FROM age(CURRENT_DATE, b.birthday::date))::int END AS age,
       CASE
         WHEN b.birthday IS NOT NULL AND EXTRACT(YEAR FROM age(CURRENT_DATE, b.birthday::date)) < 25 THEN '18-24'
         WHEN b.birthday IS NOT NULL AND EXTRACT(YEAR FROM age(CURRENT_DATE, b.birthday::date)) < 40 THEN '25-39'
         WHEN b.birthday IS NOT NULL AND EXTRACT(YEAR FROM age(CURRENT_DATE, b.birthday::date)) < 55 THEN '40-54'
         WHEN b.birthday IS NOT NULL THEN '55+'
         ELSE NULL
       END AS age_tier,
       CASE
         WHEN b.spend_idr >= 30000000 THEN 'vip'
         WHEN b.spend_idr >= 10000000 THEN 'standard'
         ELSE 'budget'
       END AS spend_tier,
       CASE
         WHEN b.last_trip >= CURRENT_DATE - INTERVAL '3 months' THEN 'active'
         WHEN b.last_trip >= CURRENT_DATE - INTERVAL '6 months' THEN 'warm'
         WHEN b.last_trip >= CURRENT_DATE - INTERVAL '12 months' THEN 'cool'
         ELSE 'dormant'
       END AS recency`;

function paxBuyerSql(whereClause, limit, tagFilters) {
  const tagWhere = buildTagFilterWhere(tagFilters);
  return `
WITH ${CUSTOMER_BASE_CTE}
SELECT b.customer_name, b.phone, b.passport_no, b.booker_phone,
       b.trips_active, b.spend_idr, b.last_trip, b.sample_tour_codes,
       '-' AS source_group,
       NULL AS respondio_contact_id, NULL AS match_confidence
       ${TAG_SELECT_COLS}
FROM customer_base b
WHERE b.spend_idr > 0
  ${whereClause || ''}
  ${tagWhere}
ORDER BY b.spend_idr DESC NULLS LAST, b.last_trip DESC NULLS LAST
LIMIT ${limit}`;
}

function audPresetSql(preset, filters, limit, tagFilters) {
  if (preset === 'repeat_travelers') return paxBuyerSql('AND b.trips_active >= 2', limit, tagFilters);
  if (preset === 'dormant') return paxBuyerSql(`AND b.last_trip <= current_date - interval '180 days'`, limit, tagFilters);
  if (preset === 'destination_interest') {
    const dest = audDestinationWhere(filters?.destination);
    return paxBuyerSql(`AND EXISTS (SELECT 1 FROM unnest(b.sample_tour_codes) code WHERE ${dest.where})`, limit, tagFilters);
  }
  if (preset === 'high_value') {
    const tagWhere = buildTagFilterWhere(tagFilters);
    return `
WITH ${CUSTOMER_BASE_CTE},
threshold AS (
  SELECT percentile_cont(0.8) WITHIN GROUP (ORDER BY spend_idr) AS min_spend
  FROM customer_base WHERE spend_idr > 0
)
SELECT b.customer_name, b.phone, b.passport_no, b.booker_phone,
       b.trips_active, b.spend_idr, b.last_trip, b.sample_tour_codes,
       '-' AS source_group,
       NULL AS respondio_contact_id, NULL AS match_confidence
       ${TAG_SELECT_COLS}
FROM customer_base b
WHERE b.spend_idr > 0 AND b.spend_idr >= (SELECT min_spend FROM threshold)
  ${tagWhere}
ORDER BY b.spend_idr DESC NULLS LAST, b.last_trip DESC NULLS LAST
LIMIT ${limit}`;
  }
  if (preset === 'respond_converted') {
    return `
WITH linked AS (
  SELECT respondio_contact_id, count(DISTINCT order_id)::int AS orders_non_cancelled,
         sum(total_amount) AS spend_idr, max(booking_date) AS last_order_date,
         array_agg(DISTINCT tour_code ORDER BY tour_code) FILTER (WHERE tour_code IS NOT NULL) AS sample_tour_codes,
         max(match_confidence) AS match_confidence
  FROM semantic.contact_order_link
  WHERE region = 'id' AND order_business_entity = 'wbt_id' AND match_confidence >= 0.95 AND order_after_inquiry
  GROUP BY respondio_contact_id
)
SELECT coalesce(nullif(f.name,''), 'Unknown Respond Contact') AS customer_name,
       f.phone_normalized AS phone,
       right(coalesce(nullif(f.phone_digits,''), regexp_replace(f.phone_normalized, '\\D', '', 'g')), 8) AS canonical_customer_id,
       l.orders_non_cancelled, l.spend_idr, l.last_order_date, l.sample_tour_codes,
       f.source_group, f.respondio_contact_id, l.match_confidence
FROM linked l
JOIN semantic.respondio_contact_attribution_fact f ON f.respondio_contact_id = l.respondio_contact_id
WHERE nullif(f.phone_normalized, '') IS NOT NULL
ORDER BY l.spend_idr DESC NULLS LAST, l.last_order_date DESC NULLS LAST
LIMIT ${limit}`;
  }
  if (preset === 'post_trip_1m') return paxBuyerSql(`AND b.last_trip BETWEEN current_date - 40 AND current_date - 25`, limit, tagFilters);
  if (preset === 'post_trip_3m') return paxBuyerSql(`AND b.last_trip BETWEEN current_date - 105 AND current_date - 75`, limit, tagFilters);
  if (preset === 'birthday_soon') {
    const tagWhere = buildTagFilterWhere(tagFilters);
    return `
WITH ${CUSTOMER_BASE_CTE},
pax_bday AS (
  SELECT DISTINCT ON (payload->>'passport_no')
    payload->>'passport_no' AS passport_no,
    (payload->>'birthday')::date AS bday
  FROM curated.passengers
  WHERE business_entity = 'wbt_id'
    AND coalesce(payload->>'passport_no','') != ''
    AND length(payload->>'passport_no') >= 5
    AND payload->>'birthday' ~ '^\\d{4}-\\d{2}-\\d{2}$'
  ORDER BY payload->>'passport_no'
)
SELECT b.customer_name, b.phone, b.passport_no, b.booker_phone,
       b.trips_active, b.spend_idr, b.last_trip, b.sample_tour_codes,
       '-' AS source_group,
       NULL AS respondio_contact_id, NULL AS match_confidence,
       to_char(bd.bday, 'MM-DD') AS birthday_mmdd
       ${TAG_SELECT_COLS}
FROM customer_base b
JOIN pax_bday bd ON bd.passport_no = b.passport_no
WHERE b.spend_idr > 0
  AND ((extract(month FROM bd.bday) = extract(month FROM current_date)
       AND extract(day FROM bd.bday) >= extract(day FROM current_date))
    OR (extract(month FROM bd.bday) = extract(month FROM current_date + 30)
       AND extract(day FROM bd.bday) <= extract(day FROM current_date + 30)))
  ${tagWhere}
ORDER BY to_char(bd.bday, 'MM-DD'), b.spend_idr DESC NULLS LAST
LIMIT ${limit}`;
  }
  if (preset === 'respond_not_bought') {
    return `
WITH converted AS (
  SELECT DISTINCT respondio_contact_id
  FROM semantic.contact_order_link
  WHERE region = 'id' AND order_business_entity = 'wbt_id' AND match_confidence >= 0.95 AND order_after_inquiry
)
SELECT coalesce(nullif(f.name,''), 'Unknown Respond Contact') AS customer_name,
       f.phone_normalized AS phone,
       right(coalesce(nullif(f.phone_digits,''), regexp_replace(f.phone_normalized, '\\D', '', 'g')), 8) AS canonical_customer_id,
       0::int AS orders_non_cancelled, 0::numeric AS spend_idr, NULL::date AS last_order_date,
       ARRAY[]::text[] AS sample_tour_codes, f.source_group, f.respondio_contact_id,
       f.attribution_confidence AS match_confidence
FROM semantic.respondio_contact_attribution_fact f
LEFT JOIN converted c ON c.respondio_contact_id = f.respondio_contact_id
WHERE f.region = 'id' AND f.account = 'id_webuytravel' AND c.respondio_contact_id IS NULL
  AND nullif(f.phone_normalized, '') IS NOT NULL
ORDER BY f.lead_date DESC NULLS LAST
LIMIT ${limit}`;
  }
  throw new Error(`unknown preset: ${preset}`);
}

function audCountSql(preset, filters) {
  if (preset === 'repeat_travelers') return `WITH ${CUSTOMER_BASE_CTE} SELECT count(*)::int AS count FROM customer_base WHERE spend_idr > 0 AND trips_active >= 2`;
  if (preset === 'high_value') return `WITH ${CUSTOMER_BASE_CTE}, threshold AS (SELECT percentile_cont(0.8) WITHIN GROUP (ORDER BY spend_idr) AS min_spend FROM customer_base WHERE spend_idr > 0) SELECT count(*)::int AS count FROM customer_base WHERE spend_idr > 0 AND spend_idr >= (SELECT min_spend FROM threshold)`;
  if (preset === 'dormant') return `WITH ${CUSTOMER_BASE_CTE} SELECT count(*)::int AS count FROM customer_base WHERE spend_idr > 0 AND last_trip <= current_date - interval '180 days'`;
  if (preset === 'destination_interest') {
    const dest = audDestinationWhere(filters?.destination);
    return `WITH ${CUSTOMER_BASE_CTE} SELECT count(*)::int AS count FROM customer_base WHERE spend_idr > 0 AND EXISTS (SELECT 1 FROM unnest(sample_tour_codes) code WHERE ${dest.where})`;
  }
  if (preset === 'respond_converted') return `SELECT count(DISTINCT respondio_contact_id)::int AS count FROM semantic.contact_order_link WHERE region='id' AND order_business_entity='wbt_id' AND match_confidence >= 0.95 AND order_after_inquiry`;
  if (preset === 'post_trip_1m') return `WITH ${CUSTOMER_BASE_CTE} SELECT count(*)::int AS count FROM customer_base WHERE spend_idr > 0 AND last_trip BETWEEN current_date - 40 AND current_date - 25`;
  if (preset === 'post_trip_3m') return `WITH ${CUSTOMER_BASE_CTE} SELECT count(*)::int AS count FROM customer_base WHERE spend_idr > 0 AND last_trip BETWEEN current_date - 105 AND current_date - 75`;
  if (preset === 'birthday_soon') return `WITH pax_bday AS (SELECT DISTINCT payload->>'passport_no' AS pp, (payload->>'birthday')::date AS bd FROM curated.passengers WHERE business_entity='wbt_id' AND payload->>'birthday' ~ '^\\d{4}-\\d{2}-\\d{2}$' AND length(payload->>'passport_no')>=5) SELECT count(*)::int AS count FROM pax_bday WHERE (extract(month FROM bd)=extract(month FROM current_date) AND extract(day FROM bd)>=extract(day FROM current_date)) OR (extract(month FROM bd)=extract(month FROM current_date+30) AND extract(day FROM bd)<=extract(day FROM current_date+30))`;
  throw new Error(`unknown preset: ${preset}`);
}

function audArrayText(v) {
  return Array.isArray(v) ? v.filter(Boolean).join(', ') : (v == null ? '' : String(v));
}

function audMessageAngle(preset, filters) {
  const dest = String(filters?.destination || '').toUpperCase();
  if (preset === 'repeat_travelers') return 'Thank them as repeat travelers; offer early access to next seasonal group tour.';
  if (preset === 'high_value') return 'Position premium comfort, longer itinerary, better hotel, or private upgrade.';
  if (preset === 'dormant') return 'Reactivation: new departure calendar, limited seats, and a soft welcome-back angle.';
  if (preset === 'destination_interest') return `Recommend fresh ${dest || 'destination'} departures based on past travel interest.`;
  if (preset === 'respond_converted') return 'Use for lookalike audience seed; message only if manually approved.';
  if (preset === 'post_trip_1m') return 'Thank-you follow-up: ask for review, offer voucher for next trip.';
  if (preset === 'post_trip_3m') return 'Re-engagement: suggest new destination, highlight upcoming tours.';
  if (preset === 'birthday_soon') return 'Birthday greeting with voucher; warm, personal tone.';
  return 'Manual review recommended.';
}

function audReason(preset, row, filters) {
  if (preset === 'repeat_travelers') return `${row.trips_active || 0} trips; proven repeat traveler.`;
  if (preset === 'high_value') return `Top 20% IDR spender; total spend ${row.spend_idr || 0}.`;
  if (preset === 'dormant') return `Last trip ${row.last_trip || '-'}; no travel for 180+ days.`;
  if (preset === 'destination_interest') return `Traveled to ${String(filters?.destination || 'destination')} before.`;
  if (preset === 'respond_converted') return `Respond contact linked to ${row.trips_active || row.orders_non_cancelled || 0} high-confidence ID order(s).`;
  if (preset === 'post_trip_1m') return `Last trip ${row.last_trip || '-'}; ~1 month ago.`;
  if (preset === 'post_trip_3m') return `Last trip ${row.last_trip || '-'}; ~3 months ago.`;
  if (preset === 'birthday_soon') return `Birthday ${row.birthday_mmdd || '-'}; send greeting + voucher.`;
  return '';
}

function audRows(preset, filters, rows) {
  return (rows || []).filter(r => String(r.phone || r.booker_phone || '').trim()).map(r => ({
    customer_name: r.customer_name || '',
    phone: r.phone || r.booker_phone || '',
    passport_no: r.passport_no || '',
    segment: preset,
    reason: audReason(preset, r, filters),
    last_trip: r.last_trip || r.last_order_date || '',
    trips_active: Number(r.trips_active || r.orders_non_cancelled || 0),
    spend_idr: Number(r.spend_idr || 0),
    sample_tour_codes: audArrayText(r.sample_tour_codes),
    source_group: r.source_group || '',
    respondio_contact_id: r.respondio_contact_id || '',
    match_confidence: r.match_confidence == null ? '' : r.match_confidence,
    recommended_message_angle: audMessageAngle(preset, filters),
  }));
}

function audCsv(rows) {
  const esc = v => {
    const s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [AUD_EXPORT_FIELDS.join(','), ...rows.map(r => AUD_EXPORT_FIELDS.map(f => esc(r[f])).join(','))].join('\n');
}

function parseConfig(value, fallback) {
  if (Array.isArray(value) || (value && typeof value === 'object')) return value;
  if (typeof value === 'string' && value.trim()) {
    try { return JSON.parse(value); } catch (_) {}
  }
  return fallback;
}

async function audReadExports(supabase) {
  const table = await supabase.from('crm_audience_exports').select('id,preset,filters,row_count,filename,created_by,created_at').order('created_at', { ascending: false }).limit(50);
  if (!table.error) return table.data || [];
  const cfg = await supabase.from('app_config').select('value').eq('key', AUD_EXPORT_KEY).maybeSingle();
  return parseConfig(cfg.data?.value, []).slice(0, 50);
}

async function audSaveExport(supabase, user, rec) {
  const row = { id: rec.id, preset: rec.preset, filters: rec.filters, row_count: rec.row_count, filename: rec.filename, created_by: user.id };
  const table = await supabase.from('crm_audience_exports').insert(row).select().maybeSingle();
  if (!table.error) return table.data || row;
  const current = await audReadExports(supabase);
  const out = [{ ...row, created_at: new Date().toISOString(), created_by: user.email || user.id }, ...current].slice(0, 100);
  await supabase.from('app_config').upsert({ key: AUD_EXPORT_KEY, value: JSON.stringify(out) }, { onConflict: 'key' });
  return out[0];
}

async function audReadTags(supabase, ids) {
  const clean = [...new Set((ids || []).map(String).filter(Boolean))];
  if (!clean.length) return {};
  const table = await supabase.from('crm_customer_tags').select('canonical_customer_id,tags,note').in('canonical_customer_id', clean);
  if (!table.error) return Object.fromEntries((table.data || []).map(r => [String(r.canonical_customer_id), { tags: r.tags || [], note: r.note || '' }]));
  const cfg = await supabase.from('app_config').select('value').eq('key', AUD_TAG_KEY).maybeSingle();
  const obj = parseConfig(cfg.data?.value, {});
  return Object.fromEntries(clean.map(id => [id, obj[id] || { tags: [], note: '' }]));
}

async function handleAudienceSummary(supabase) {
  const rows = await runSql(`
WITH ${CUSTOMER_BASE_CTE},
buyers AS (SELECT * FROM customer_base WHERE spend_idr > 0),
threshold AS (SELECT percentile_cont(0.8) WITHIN GROUP (ORDER BY spend_idr) AS min_spend FROM buyers),
converted AS (SELECT count(DISTINCT respondio_contact_id)::int AS converted_contacts FROM semantic.contact_order_link WHERE region = 'id' AND order_business_entity = 'wbt_id' AND match_confidence >= 0.95 AND order_after_inquiry)
SELECT count(*)::int AS id_travelers,
       count(*) FILTER (WHERE trips_active >= 2)::int AS repeat_travelers,
       count(*) FILTER (WHERE spend_idr >= (SELECT min_spend FROM threshold))::int AS high_value,
       count(*) FILTER (WHERE last_trip <= current_date - interval '180 days')::int AS dormant,
       count(*) FILTER (WHERE last_trip BETWEEN current_date - 40 AND current_date - 25)::int AS post_trip_1m,
       count(*) FILTER (WHERE last_trip BETWEEN current_date - 105 AND current_date - 75)::int AS post_trip_3m,
       coalesce(sum(spend_idr), 0) AS total_spend_idr,
       (SELECT converted_contacts FROM converted) AS converted_contacts
FROM buyers`);
  return {
    generated_at: new Date().toISOString(),
    scope: { market: 'ID', currency: 'IDR', grain: 'passenger (passport dedup)', delivery: 'CSV/Excel only' },
    summary: rows[0] || {},
    exports: await audReadExports(supabase),
  };
}

async function handleAudiencePresets() {
  const presets = await Promise.all(Object.keys(AUD_PRESETS).map(async id => {
    const filters = id === 'destination_interest' ? { destination: 'korea' } : {};
    const rows = await runSql(audCountSql(id, filters));
    const [label, use_case, risk] = AUD_PRESETS[id];
    return { id, label, use_case, risk, count: Number(rows[0]?.count || 0), filters, export_fields: AUD_EXPORT_FIELDS };
  }));
  return { generated_at: new Date().toISOString(), scope: { market: 'ID', currency: 'IDR' }, destinations: Object.keys(AUD_DESTINATIONS), presets };
}

async function handleAudiencePreview(supabase, body) {
  const preset = String(body.preset || '').trim();
  if (!AUD_PRESETS[preset]) throw new Error('preset not supported');
  const filters = body.filters || {};
  const tagFilters = body.tag_filters || null;
  const rawRows = await runSql(audPresetSql(preset, filters, audLimit(body.limit, 2000, 3000), tagFilters));
  const rows = audRows(preset, filters, rawRows);
  rows.forEach((r, i) => {
    const raw = rawRows[i] || {};
    r.gender = raw.gender || '';
    r.age = raw.age != null ? Number(raw.age) : null;
    r.age_tier = raw.age_tier || '';
    r.spend_tier = raw.spend_tier || '';
    r.recency = raw.recency || '';
  });
  const tags = await audReadTags(supabase, rows.map(r => r.canonical_customer_id));
  rows.forEach(r => { r.manual_tags = tags[r.canonical_customer_id]?.tags || []; r.manual_note = tags[r.canonical_customer_id]?.note || ''; });
  return { generated_at: new Date().toISOString(), preset, preset_label: AUD_PRESETS[preset][0], filters, tag_filters: tagFilters, export_fields: AUD_EXPORT_FIELDS, rows };
}

async function handleAudienceExport(supabase, user, body) {
  const preset = String(body.preset || '').trim();
  if (!AUD_PRESETS[preset]) throw new Error('preset not supported');
  const filters = body.filters || {};
  const tagFilters = body.tag_filters || null;
  const rows = audRows(preset, filters, await runSql(audPresetSql(preset, filters, audLimit(body.limit, 5000, 10000), tagFilters)));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `webuy-id-${preset}-${stamp}.csv`;
  const rec = await audSaveExport(supabase, user, { id: `aud_${Date.now()}`, preset, filters, row_count: rows.length, filename });
  return { generated_at: new Date().toISOString(), export: rec, preset, filters, row_count: rows.length, filename, fields: AUD_EXPORT_FIELDS, csv: audCsv(rows) };
}

async function handleAudienceTag(supabase, user, body) {
  const id = String(body.canonical_customer_id || '').trim();
  const tag = String(body.tag || '').trim();
  const op = String(body.op || 'add').trim();
  if (!id) throw new Error('canonical_customer_id required');
  if (!AUD_TAGS.has(tag)) throw new Error('unsupported tag');
  if (!['add', 'remove'].includes(op)) throw new Error('op must be add/remove');
  const current = await supabase.from('crm_customer_tags').select('*').eq('canonical_customer_id', id).maybeSingle();
  if (!current.error) {
    const tags = new Set(current.data?.tags || []);
    op === 'add' ? tags.add(tag) : tags.delete(tag);
    const payload = { canonical_customer_id: id, customer_name: body.customer_name || current.data?.customer_name || null, phone: body.phone || current.data?.phone || null, tags: [...tags], note: body.note || current.data?.note || null, updated_by: user.id };
    const saved = await supabase.from('crm_customer_tags').upsert(payload, { onConflict: 'canonical_customer_id' }).select().maybeSingle();
    if (saved.error) throw saved.error;
    return { ok: true, tag_state: saved.data };
  }
  const cfg = await supabase.from('app_config').select('value').eq('key', AUD_TAG_KEY).maybeSingle();
  const obj = parseConfig(cfg.data?.value, {});
  const rec = obj[id] || { tags: [], note: '', customer_name: body.customer_name || '', phone: body.phone || '' };
  const tags = new Set(rec.tags || []);
  op === 'add' ? tags.add(tag) : tags.delete(tag);
  obj[id] = { ...rec, tags: [...tags], note: body.note || rec.note || '', customer_name: body.customer_name || rec.customer_name || '', phone: body.phone || rec.phone || '', updated_by: user.email || user.id, updated_at: new Date().toISOString() };
  await supabase.from('app_config').upsert({ key: AUD_TAG_KEY, value: JSON.stringify(obj) }, { onConflict: 'key' });
  return { ok: true, tag_state: { canonical_customer_id: id, ...obj[id] } };
}

const newLeadSql = `
WITH converted AS (
  SELECT DISTINCT respondio_contact_id
  FROM semantic.contact_order_link
  WHERE respondio_account = 'id_webuytravel'
    AND order_business_entity = 'wbt_id'
    AND match_confidence >= 0.95
    AND order_after_inquiry
),
lead_base AS (
  SELECT
    f.respondio_contact_id,
    f.name,
    f.phone_normalized,
    f.email_normalized,
    f.lead_date,
    f.source_group,
    f.source_channel,
    COALESCE(NULLIF(f.campaign_name,''), NULLIF(f.adset_name,''), NULLIF(f.ad_name,''), f.source_group, '-') AS campaign_name,
    f.confirmed_ad,
    f.tags
  FROM semantic.respondio_contact_attribution_fact f
  LEFT JOIN converted c ON c.respondio_contact_id = f.respondio_contact_id
  WHERE f.region = 'id'
    AND f.lead_date >= current_date - interval '21 days'
    AND c.respondio_contact_id IS NULL
)
SELECT
  ('lead:' || respondio_contact_id) AS task_id,
  'new_lead' AS task_type,
  'New Lead Follow-up' AS stage,
  current_date::date AS due_date,
  CASE WHEN confirmed_ad THEN 'HIGH' ELSE 'NORMAL' END AS priority,
  respondio_contact_id,
  COALESCE(NULLIF(name,''), 'Unknown Respond Lead') AS customer_name,
  phone_normalized AS phone,
  email_normalized AS email,
  lead_date,
  NULL::date AS booking_date,
  NULL::date AS departure_date,
  NULL::bigint AS order_id,
  NULL::text AS order_no,
  NULL::text AS tour_code,
  campaign_name AS product_name,
  source_group,
  source_channel,
  campaign_name,
  0::numeric AS revenue_idr,
  ARRAY_REMOVE(ARRAY[
    CASE WHEN confirmed_ad THEN 'confirmed ad lead' ELSE NULL END,
    source_group,
    source_channel
  ], NULL) AS ai_tags,
  tags::text AS raw_tags,
  'Lead has entered Respond ID and has no high-confidence ID order yet.' AS next_action_reason
FROM lead_base
ORDER BY lead_date DESC
LIMIT 80`;

async function readState(supabase) {
  const { data, error } = await supabase.from('app_config').select('value').eq('key', STATE_KEY).maybeSingle();
  if (error) throw error;
  if (!data?.value) return { tasks: {}, logs: [] };
  try {
    const parsed = JSON.parse(data.value);
    return {
      tasks: parsed && typeof parsed.tasks === 'object' ? parsed.tasks : {},
      logs: Array.isArray(parsed.logs) ? parsed.logs : [],
    };
  } catch {
    return { tasks: {}, logs: [] };
  }
}

async function writeState(supabase, state) {
  const safe = {
    tasks: state.tasks || {},
    logs: (state.logs || []).slice(0, MAX_LOGS),
  };
  const { error } = await supabase.from('app_config').upsert(
    { key: STATE_KEY, value: JSON.stringify(safe) },
    { onConflict: 'key' },
  );
  if (error) throw error;
  return safe;
}

function taskSort(a, b) {
  const ad = String(a.next_due_date || a.due_date || '9999-12-31');
  const bd = String(b.next_due_date || b.due_date || '9999-12-31');
  if (ad !== bd) return ad.localeCompare(bd);
  const ap = a.priority === 'URGENT' ? 0 : a.priority === 'HIGH' ? 1 : 2;
  const bp = b.priority === 'URGENT' ? 0 : b.priority === 'HIGH' ? 1 : 2;
  return ap - bp;
}

function jakartaToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date()).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function parseJakartaDate(s) {
  const ymd = String(s || '').slice(0, 10);
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
}

function dateOnly(s) {
  return String(s || '').slice(0, 10);
}

function sqlLiteral(s) {
  return `'${String(s == null ? '' : s).replace(/'/g, "''")}'`;
}

function addDays(ymd, days) {
  const d = parseJakartaDate(ymd);
  if (!d) return '';
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function diffDays(a, b) {
  const da = parseJakartaDate(a);
  const db = parseJakartaDate(b);
  if (!da || !db) return null;
  return Math.round((da - db) / 86400000);
}

function preDepartureStage(daysToDeparture) {
  if (daysToDeparture <= 1) return ['D-1 Final Reminder', 'URGENT', 0];
  if (daysToDeparture <= 7) return ['D-7 Travel Readiness', 'HIGH', -7];
  return ['D-14 Docs / Payment', daysToDeparture <= 14 ? 'HIGH' : 'NORMAL', -14];
}

function postTourStage(daysAfterDeparture) {
  if (daysAfterDeparture <= 1) return ['D+1 Safe Arrival', 'HIGH', 1];
  if (daysAfterDeparture <= 3) return ['D+3 Review / Issue Check', 'HIGH', 3];
  if (daysAfterDeparture <= 14) return ['D+14 Complaint Close / Review', 'NORMAL', 14];
  return ['D+30 Relationship Maintenance', 'NORMAL', 30];
}

function skybarTask(order, tour, today, type) {
  const dep = dateOnly(tour.departure_date);
  const days = type === 'pre_departure' ? diffDays(dep, today) : diffDays(today, dep);
  if (days === null) return null;
  const stageInfo = type === 'pre_departure' ? preDepartureStage(days) : postTourStage(days);
  const dueDate = addDays(dep, stageInfo[2]);
  const balance = Number(order.balance_amount || 0);
  const tags = [
    type === 'pre_departure' ? 'booked' : 'returned customer',
    balance > 0 ? 'balance due' : 'paid/low balance',
    order.lead_source || '',
  ].filter(Boolean);
  return {
    task_id: `${type === 'pre_departure' ? 'pre' : 'post'}:${order.bkg_no || order.order_id}`,
    task_type: type,
    stage: stageInfo[0],
    due_date: dueDate || today,
    priority: balance > 0 && type === 'pre_departure' ? 'URGENT' : stageInfo[1],
    respondio_contact_id: null,
    customer_name: order.contact_name || 'Skybar Customer',
    phone: order.contact_no || '',
    email: '',
    lead_date: null,
    booking_date: dateOnly(order.order_date),
    departure_date: dep,
    order_id: order.order_id,
    order_no: order.bkg_no || '',
    tour_code: tour.tour_code || '',
    product_name: tour.tour_name || tour.tour_code || '',
    source_group: order.lead_source || '',
    source_channel: '',
    campaign_name: order.lead_source || '',
    revenue_idr: Number(order.total_amount || 0),
    balance_idr: balance,
    ai_tags: tags,
    raw_tags: '',
    next_action_reason: type === 'pre_departure'
      ? 'ID Skybar booked customer needs pre-departure reminder, document/payment check, or WA readiness.'
      : 'ID Skybar returned customer needs safe-arrival check, review request, issue capture, or repeat offer.',
  };
}

async function loadSkybarCrmTasks(supabase) {
  const today = jakartaToday();
  const start = addDays(today, -45);
  const end = addDays(today, 60);
  const { data: tours, error: tourError } = await supabase
    .from('package_sales')
    .select('tour_id,tour_code,tour_name,departure_date,return_date,pax_total,sold_seat,revenue')
    .gte('departure_date', `${start}T00:00:00+07:00`)
    .lte('departure_date', `${end}T23:59:59+07:00`)
    .gt('pax_total', 0)
    .order('departure_date', { ascending: true })
    .limit(220);
  if (tourError) throw tourError;
  const byTour = new Map((tours || []).map(t => [String(t.tour_id), t]));
  const ids = [...byTour.keys()];
  if (!ids.length) return [];
  const { data: orders, error: orderError } = await supabase
    .from('package_orders')
    .select('order_id,tour_id,bkg_no,order_date,order_status,contact_name,contact_no,guest_num,total_amount,deposit_amount,balance_amount,refund_amount,salesman,lead_source')
    .in('tour_id', ids.map(Number))
    .not('bkg_no', 'is', null)
    .limit(800);
  if (orderError) throw orderError;

  const tasks = [];
  for (const order of orders || []) {
    const tour = byTour.get(String(order.tour_id));
    if (!tour) continue;
    const dep = dateOnly(tour.departure_date);
    const daysTo = diffDays(dep, today);
    if (daysTo !== null && daysTo >= 0 && daysTo <= 60) {
      const t = skybarTask(order, tour, today, 'pre_departure');
      if (t) tasks.push(t);
    }
    const daysAfter = diffDays(today, dep);
    if (daysAfter !== null && daysAfter >= 1 && daysAfter <= 45) {
      const t = skybarTask(order, tour, today, 'post_tour');
      if (t) tasks.push(t);
    }
  }
  return tasks;
}

function mergeState(tasks, state) {
  return tasks.map(task => {
    const saved = state.tasks?.[task.task_id] || {};
    return {
      ...task,
      status: saved.status || 'open',
      owner: saved.owner || '',
      next_due_date: saved.next_due_date || task.due_date,
      last_action_at: saved.last_action_at || null,
      last_outcome: saved.last_outcome || '',
      last_note: saved.last_note || '',
      last_message: saved.last_message || '',
    };
  }).sort(taskSort);
}

function summarize(tasks, logs) {
  const today = jakartaToday();
  const active = tasks.filter(t => t.status !== 'done' && t.status !== 'closed');
  return {
    total_tasks: tasks.length,
    active_tasks: active.length,
    due_today: active.filter(t => String(t.next_due_date || t.due_date || '') <= today).length,
    overdue: active.filter(t => String(t.next_due_date || t.due_date || '') < today).length,
    completed: tasks.filter(t => t.status === 'done' || t.status === 'closed').length,
    touches_logged: logs.length,
    new_leads: active.filter(t => t.task_type === 'new_lead').length,
    pre_departure: active.filter(t => t.task_type === 'pre_departure').length,
    post_tour: active.filter(t => t.task_type === 'post_tour').length,
  };
}

function customerDirectorySql(page, perPage, q) {
  const offset = (page - 1) * perPage;
  const term = String(q || '').trim().toLowerCase();
  const search = term ? `
    AND (
      lower(coalesce(name,'')) LIKE ${sqlLiteral(`%${term}%`)}
      OR lower(coalesce(phone_normalized,'')) LIKE ${sqlLiteral(`%${term}%`)}
      OR lower(coalesce(email_normalized,'')) LIKE ${sqlLiteral(`%${term}%`)}
      OR lower(coalesce(campaign_name,'')) LIKE ${sqlLiteral(`%${term}%`)}
      OR lower(coalesce(adset_name,'')) LIKE ${sqlLiteral(`%${term}%`)}
      OR lower(coalesce(ad_name,'')) LIKE ${sqlLiteral(`%${term}%`)}
      OR respondio_contact_id::text LIKE ${sqlLiteral(`%${term}%`)}
    )` : '';
  return `
WITH base AS (
  SELECT
    respondio_contact_id,
    COALESCE(NULLIF(name,''), 'Unknown Respond Contact') AS customer_name,
    phone_normalized AS phone,
    email_normalized AS email,
    lead_date,
    source_group,
    source_channel,
    COALESCE(NULLIF(campaign_name,''), NULLIF(adset_name,''), NULLIF(ad_name,''), source_group, '-') AS campaign_name,
    confirmed_ad,
    attribution_confidence,
    business_estimated,
    tags::text AS raw_tags
  FROM semantic.respondio_contact_attribution_fact
  WHERE region = 'id'
    AND account = 'id_webuytravel'
    ${search}
),
counted AS (
  SELECT COUNT(*)::bigint AS total FROM base
)
SELECT b.*, c.total
FROM base b CROSS JOIN counted c
ORDER BY b.lead_date DESC NULLS LAST, b.respondio_contact_id
LIMIT ${perPage} OFFSET ${offset}`;
}

async function handleCustomersGet(req, res) {
  const url = new URL(req.url || '/', 'https://webuy-ops.local');
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const perPage = Math.min(30, Math.max(1, Number.parseInt(url.searchParams.get('per_page') || '30', 10) || 30));
  const q = String(url.searchParams.get('q') || '').trim().slice(0, 120);
  const rows = await runSql(customerDirectorySql(page, perPage, q));
  const total = Number(rows[0]?.total || 0);
  return res.status(200).json({
    generated_at: new Date().toISOString(),
    scope: {
      business_entity: 'wbt_id',
      region: 'id',
      respondio_account: 'id_webuytravel',
      currency: 'IDR',
      blocked: ['sg_webuytravel', 'wbt_sg', 'SGD aggregation'],
    },
    page,
    per_page: perPage,
    total,
    total_pages: total ? Math.ceil(total / perPage) : 0,
    q,
    customers: rows.map(({ total: _total, ...r }) => r),
  });
}

async function handleGet(supabase, req, res) {
  const url = new URL(req.url || '/', 'https://webuy-ops.local');
  if (url.searchParams.get('mode') === 'customers') return handleCustomersGet(req, res);
  const [state, newLeads, skybarTasks] = await Promise.all([
    readState(supabase),
    runSql(newLeadSql),
    loadSkybarCrmTasks(supabase),
  ]);
  const tasks = mergeState([...newLeads, ...skybarTasks], state);
  return res.status(200).json({
    generated_at: new Date().toISOString(),
    scope: {
      business_entity: 'wbt_id',
      region: 'id',
      respondio_account: 'id_webuytravel',
      currency: 'IDR',
      blocked: ['sg_webuytravel', 'wbt_sg', 'SGD aggregation'],
    },
    summary: summarize(tasks, state.logs || []),
    tasks,
    logs: (state.logs || []).slice(0, 80),
  });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');
  return body ? JSON.parse(body) : {};
}

async function handlePost(supabase, user, req, res) {
  const body = await readJson(req);
  const action = String(body.action || '');
  const taskId = String(body.task_id || '');
  if (!taskId) return res.status(400).json({ error: 'task_id required' });

  const state = await readState(supabase);
  const now = new Date().toISOString();
  const taskState = state.tasks[taskId] || {};
  const actor = user.email || user.id;

  if (action === 'complete') {
    state.tasks[taskId] = {
      ...taskState,
      status: 'done',
      last_action_at: now,
      last_outcome: body.outcome || 'completed',
      last_note: body.note || taskState.last_note || '',
      owner: body.owner || taskState.owner || actor,
    };
  } else if (action === 'snooze') {
    state.tasks[taskId] = {
      ...taskState,
      status: 'open',
      next_due_date: body.next_due_date || taskState.next_due_date,
      last_action_at: now,
      last_outcome: body.outcome || 'snoozed',
      last_note: body.note || taskState.last_note || '',
      owner: body.owner || taskState.owner || actor,
    };
  } else if (action === 'log_followup') {
    state.tasks[taskId] = {
      ...taskState,
      status: body.status || 'open',
      next_due_date: body.next_due_date || taskState.next_due_date,
      last_action_at: now,
      last_outcome: body.outcome || 'followed_up',
      last_note: body.note || '',
      last_message: body.message || '',
      owner: body.owner || taskState.owner || actor,
    };
  } else if (action === 'reopen') {
    state.tasks[taskId] = {
      ...taskState,
      status: 'open',
      next_due_date: body.next_due_date || new Date().toISOString().slice(0, 10),
      last_action_at: now,
      last_outcome: 'reopened',
      last_note: body.note || '',
      owner: body.owner || taskState.owner || actor,
    };
  } else {
    return res.status(400).json({ error: 'unsupported action' });
  }

  state.logs = [{
    id: `crm_${Date.now()}`,
    task_id: taskId,
    action,
    outcome: body.outcome || '',
    note: body.note || '',
    message: body.message || '',
    next_due_date: body.next_due_date || '',
    actor,
    at: now,
  }, ...(state.logs || [])].slice(0, MAX_LOGS);

  const saved = await writeState(supabase, state);
  return res.status(200).json({ ok: true, state: saved.tasks[taskId], log: saved.logs[0] });
}

const DEST_TOUR_KEYWORDS = {
  korea: ['KREA', 'KR', 'KOREA', 'SEOUL', 'BUSAN', 'JEJU'],
  china: ['BJSH', 'CH', 'ZHJ', 'YUN', 'HAIN', 'SHA', 'BJ', 'CHINA', 'BEIJING', 'SHANGHAI', 'CHONGQING', 'ZHANGJIAJIE', 'CANTON', 'GUILIN', 'XIAMEN', 'KUNMING', 'YUNNAN', 'HAINAN', 'GUANGZHOU', 'TIBET', 'LHASA', 'XIAN', 'SICHUAN', 'HUNAN', 'WULONG', 'DAZU', 'YANGTZE'],
  japan: ['JPN', 'JAP', 'NJG', 'OSA', 'TYO', 'JAPAN', 'TOKYO', 'OSAKA', 'NAGOYA', 'HOKKAIDO', 'KYOTO', 'FUJI'],
  vietnam: ['VIE', 'VTVIE', 'VIETNAM', 'HANOI', 'SAIGON', 'DANANG', 'HALONG'],
  europe: ['EUR', 'EURO', 'WEU', 'EUROPE', 'ITALY', 'FRANCE', 'SWITZERLAND', 'SPAIN', 'GERMANY', 'AUSTRIA', 'SCANDINAVIA', 'BALKANS', 'LONDON', 'PARIS', 'ROME'],
  turkey: ['TRK', 'TUR', 'TURKEY', 'ISTANBUL', 'CAPPADOCIA'],
};

function classifyDestFromCodes(tourCodes) {
  const codes = (Array.isArray(tourCodes) ? tourCodes : []).map(c => String(c).toUpperCase());
  const hits = [];
  for (const [dest, keywords] of Object.entries(DEST_TOUR_KEYWORDS)) {
    if (codes.some(c => keywords.some(kw => c.includes(kw)))) hits.push(dest);
  }
  return hits;
}

function classifyTourDest(tourCode, tourName) {
  const text = `${tourCode || ''} ${tourName || ''}`.toUpperCase();
  const hits = [];
  for (const [dest, keywords] of Object.entries(DEST_TOUR_KEYWORDS)) {
    if (keywords.some(kw => text.includes(kw))) hits.push(dest);
  }
  return hits;
}

function dormantTier(spendIdr, orders) {
  if (spendIdr >= 30_000_000 && orders >= 2) return 'wa_vip';
  if (spendIdr >= 15_000_000 || orders >= 2) return 'meta_custom';
  return 'ads_only';
}

function tierLabel(tier) {
  if (tier === 'wa_vip') return 'WA 1:1 — high value repeat';
  if (tier === 'meta_custom') return 'Meta Custom Audience — medium value';
  return 'Ads only — low value / old';
}

async function handleDormantMatch(supabase) {
  const dormantRows = await runSql(`
WITH ${CUSTOMER_BASE_CTE}
SELECT passport_no, customer_name, phone, booker_phone,
       trips_active, spend_idr, last_trip, sample_tour_codes
FROM customer_base
WHERE spend_idr > 0
  AND last_trip <= current_date - interval '180 days'
ORDER BY spend_idr DESC NULLS LAST
LIMIT 2000`);

  const today = jakartaToday();
  const start = addDays(today, 0);
  const end = addDays(today, 90);
  const { data: tours, error: tourError } = await supabase
    .from('package_sales')
    .select('tour_id,tour_code,tour_name,departure_date,pax_total,sold_seat')
    .gte('departure_date', `${start}T00:00:00+07:00`)
    .lte('departure_date', `${end}T23:59:59+07:00`)
    .order('departure_date', { ascending: true })
    .limit(300);
  if (tourError) throw tourError;

  const toursByDest = {};
  for (const t of tours || []) {
    const dests = classifyTourDest(t.tour_code, t.tour_name);
    for (const d of dests) {
      if (!toursByDest[d]) toursByDest[d] = [];
      toursByDest[d].push({
        tour_code: t.tour_code, tour_name: t.tour_name,
        departure_date: dateOnly(t.departure_date),
        pax: t.pax_total || 0,
      });
    }
  }

  const matches = [];
  const tierCounts = { wa_vip: 0, meta_custom: 0, ads_only: 0 };

  for (const row of dormantRows) {
    const custDests = classifyDestFromCodes(row.sample_tour_codes);
    const matchedTours = [];
    for (const d of custDests) {
      for (const t of toursByDest[d] || []) {
        matchedTours.push({ ...t, matched_destination: d });
      }
    }
    if (matchedTours.length === 0) continue;
    const seen = new Set();
    const unique = matchedTours.filter(t => {
      const k = t.tour_code;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 5);

    const spend = Number(row.spend_idr || 0);
    const trips = Number(row.trips_active || 0);
    const tier = dormantTier(spend, trips);
    tierCounts[tier]++;

    matches.push({
      customer_name: row.customer_name || '',
      phone: row.phone || row.booker_phone || '',
      passport_no: row.passport_no || '',
      trips_active: trips,
      spend_idr: spend,
      last_trip: row.last_trip || '',
      sample_tour_codes: audArrayText(row.sample_tour_codes),
      dest_interests: custDests,
      tier,
      tier_label: tierLabel(tier),
      matched_tours: unique,
    });
  }

  return {
    generated_at: new Date().toISOString(),
    scope: { market: 'ID', currency: 'IDR' },
    total_dormant: dormantRows.length,
    matched_count: matches.length,
    tier_counts: tierCounts,
    upcoming_tours_by_dest: Object.fromEntries(
      Object.entries(toursByDest).map(([d, ts]) => [d, ts.length])
    ),
    matches,
  };
}

async function readCampaigns(supabase) {
  const table = await supabase.from('crm_campaigns')
    .select('*').order('created_at', { ascending: false }).limit(100);
  if (!table.error) return table.data || [];
  const cfg = await supabase.from('app_config').select('value').eq('key', CAMPAIGN_KEY).maybeSingle();
  return parseConfig(cfg.data?.value, []).slice(0, 100);
}

async function saveCampaign(supabase, user, rec) {
  const row = {
    id: rec.id, name: rec.name, type: rec.type,
    preset: rec.preset || null, filters: rec.filters || {},
    tag_filters: rec.tag_filters || {},
    channel: rec.channel || 'csv', audience_count: rec.audience_count || 0,
    notes: rec.notes || null, status: rec.status || 'draft',
    sent_count: rec.sent_count ?? 0,
    delivered_count: rec.delivered_count ?? null,
    read_count: rec.read_count ?? null,
    reply_count: rec.reply_count ?? null,
    inquiry_count: rec.inquiry_count ?? null,
    responded_count: rec.responded_count ?? null,
    converted_count: rec.converted_count ?? null,
    revenue_idr: rec.revenue_idr ?? null,
    sent_at: rec.sent_at || null,
    created_by: user.id,
  };
  const table = await supabase.from('crm_campaigns').upsert(row, { onConflict: 'id' }).select().maybeSingle();
  if (!table.error) return table.data || row;
  const current = await readCampaigns(supabase);
  const exists = current.findIndex(c => c.id === rec.id);
  const entry = { ...row, created_at: new Date().toISOString(), created_by: user.email || user.id };
  if (exists >= 0) current[exists] = { ...current[exists], ...entry };
  else current.unshift(entry);
  await supabase.from('app_config').upsert({ key: CAMPAIGN_KEY, value: JSON.stringify(current.slice(0, 200)) }, { onConflict: 'key' });
  return entry;
}

async function handleCampaignList(supabase) {
  return { generated_at: new Date().toISOString(), campaigns: await readCampaigns(supabase) };
}

async function handleCampaignCreate(supabase, user, body) {
  const name = String(body.name || '').trim();
  if (!name) throw new Error('campaign name required');
  const type = CAMPAIGN_TYPES.has(body.type) ? body.type : 'other';
  const channel = CAMPAIGN_CHANNELS.has(body.channel) ? body.channel : 'csv';
  const rec = {
    id: `camp_${Date.now()}`, name, type, channel,
    preset: body.preset || null, filters: body.filters || {},
    tag_filters: body.tag_filters || {},
    audience_count: Number(body.audience_count) || 0,
    notes: body.notes || null, status: 'draft',
    sent_count: 0, delivered_count: null, read_count: null,
    reply_count: null, inquiry_count: null,
  };
  const saved = await saveCampaign(supabase, user, rec);
  return { ok: true, campaign: saved };
}

async function handleCampaignUpdate(supabase, user, body) {
  const id = String(body.id || '').trim();
  if (!id) throw new Error('campaign id required');
  const campaigns = await readCampaigns(supabase);
  const existing = campaigns.find(c => c.id === id);
  if (!existing) throw new Error('campaign not found');
  const updates = {
    ...existing,
    status: body.status || existing.status,
    sent_count: body.sent_count ?? existing.sent_count,
    delivered_count: body.delivered_count ?? existing.delivered_count,
    read_count: body.read_count ?? existing.read_count,
    reply_count: body.reply_count ?? existing.reply_count,
    inquiry_count: body.inquiry_count ?? existing.inquiry_count,
    responded_count: body.responded_count ?? existing.responded_count,
    converted_count: body.converted_count ?? existing.converted_count,
    revenue_idr: body.revenue_idr ?? existing.revenue_idr,
    notes: body.notes !== undefined ? body.notes : existing.notes,
    sent_at: body.status === 'sent' && !existing.sent_at ? new Date().toISOString() : existing.sent_at,
    completed_at: body.status === 'completed' ? new Date().toISOString() : existing.completed_at,
  };
  const saved = await saveCampaign(supabase, user, updates);
  return { ok: true, campaign: saved };
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'GET/POST only' });

  try {
    const supabase = serviceClient();
    const user = await requireUser(supabase, req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    const url = new URL(req.url || '/', 'https://webuy-ops.local');
    const audience = String(url.searchParams.get('audience') || '');
    if (audience) {
      if (req.method === 'GET' && audience === 'summary') return res.status(200).json(await handleAudienceSummary(supabase));
      if (req.method === 'GET' && audience === 'presets') return res.status(200).json(await handleAudiencePresets());
      if (req.method === 'POST' && audience === 'preview') return res.status(200).json(await handleAudiencePreview(supabase, await readJson(req)));
      if (req.method === 'POST' && audience === 'export') return res.status(200).json(await handleAudienceExport(supabase, user, await readJson(req)));
      if (req.method === 'POST' && audience === 'tags') return res.status(200).json(await handleAudienceTag(supabase, user, await readJson(req)));
      if (req.method === 'GET' && audience === 'dormant-match') return res.status(200).json(await handleDormantMatch(supabase));
      if (req.method === 'GET' && audience === 'campaigns') return res.status(200).json(await handleCampaignList(supabase));
      if (req.method === 'POST' && audience === 'campaign-create') return res.status(200).json(await handleCampaignCreate(supabase, user, await readJson(req)));
      if (req.method === 'POST' && audience === 'campaign-update') return res.status(200).json(await handleCampaignUpdate(supabase, user, await readJson(req)));
      return res.status(405).json({ error: 'unsupported crm audience endpoint' });
    }
    // await so handler rejections (bad JSON body, MCP/Supabase errors) are caught
    // here and returned as JSON, instead of escaping as an unhandled rejection
    // that Vercel surfaces as an opaque FUNCTION_INVOCATION_FAILED.
    if (req.method === 'GET') return await handleGet(supabase, req, res);
    return await handlePost(supabase, user, req, res);
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
};
