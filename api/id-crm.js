const fs = require('fs');
const os = require('os');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const STATE_KEY = 'id_crm_ops_state_v1';
const MAX_LOGS = 600;

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

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'GET/POST only' });

  try {
    const supabase = serviceClient();
    const user = await requireUser(supabase, req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    // await so handler rejections (bad JSON body, MCP/Supabase errors) are caught
    // here and returned as JSON, instead of escaping as an unhandled rejection
    // that Vercel surfaces as an opaque FUNCTION_INVOCATION_FAILED.
    if (req.method === 'GET') return await handleGet(supabase, req, res);
    return await handlePost(supabase, user, req, res);
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
};
