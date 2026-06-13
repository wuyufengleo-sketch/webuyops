// ============================================================================
//  /api/sb-write — server-side write proxy that bypasses RLS.
//
//  Why this exists:
//    The Supabase project's RLS state on writes ended up half-applied (some
//    tables get policy, some don't, because a multi-step migration failed
//    halfway in SQL Editor). Without DB DDL access we can't fix RLS cleanly.
//    Instead, this endpoint takes the user's JWT, looks up their role in
//    profiles, checks the operation against an allow-list, and only then
//    performs the write using the service_role key (which bypasses RLS).
//
//  Request body: { table, op, rows, match, onConflict }
//    op: 'insert' | 'upsert' | 'update' | 'delete' | 'get_config' | 'patch_json'
//    rows: object (or array for insert)
//    match: { col: val, ... }  (for update/delete)
//    onConflict: 'col' (for upsert)
//    get_config: table='app_config', rows={ key }
//    patch_json: table='app_config', rows={ key, id, field, value }
//
//  Response: { data, error }
// ============================================================================

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (_) {}
  }
  return {};
}

// Allow-list: table → roles that can write
const WRITE_ACL = {
  // Core OPS
  tours:                ['admin','ops'],
  bk_tours:             ['admin','ops'],
  ops_workflow:         ['admin','ops','cs'],
  order_workflow:       ['admin','ops','cs'],
  ops_logs:             ['admin','ops','cs','ticketing','visa','doc','pm','sales'],
  app_config:           ['admin','ops','visa','doc'],
  staff_contacts:       ['admin','ops'],
  vendor_payments:      ['admin','ops'],
  tl_outputs:           ['admin','ops'],
  peak_periods:         ['admin','ops'],
  // Ticketing
  ticketing:            ['admin','ticketing','ops'],
  ticketing_items:      ['admin','ticketing','ops'],
  flights:              ['admin','ticketing','ops'],
  // Visa (doc team owns visa work in practice)
  visa_tours:           ['admin','visa','doc','ops'],
  visa_progress:        ['admin','visa','doc','ops'],
  // CS
  cs_records:           ['admin','cs','ops'],
  cs_complaints:        ['admin','cs','ops'],
  cs_cases:             ['admin','cs','ops'],
  refunds:              ['admin','cs','ops'],
  balance_alert_state:  ['admin','cs','ops'],
  bk_groups:            ['admin','cs','ops'],
  // Documents / manifest
  manifest_passengers:  ['admin','doc','visa','ticketing','cs','ops'],
  photos:               ['admin','doc','visa','ops'],
  skybar_passengers:    ['admin','doc','ops'],
  // Product / sales
  sales_inquiries:      ['admin','pm','sales','ops'],
  private_tours:        ['admin','pm','sales','ops'],
  itinerary_quote:      ['admin','pm','sales'],
  itinerary_quotes:     ['admin','pm','sales'],
  package_sales:        ['admin','pm','ops'],
  package_orders:       ['admin','pm','ops'],
  tour_pnl:             ['admin','pm','ops'],
  // Profiles — self only, handled separately below
  profiles:             ['__self__'],
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'server misconfigured' });

  const auth = req.headers.authorization || '';
  const jwt = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!jwt) return res.status(401).json({ error: 'missing bearer token' });

  // Validate JWT + look up role via service_role client.
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: u, error: uErr } = await sb.auth.getUser(jwt);
  if (uErr || !u?.user) return res.status(401).json({ error: 'invalid session' });
  const userId = u.user.id;

  const { data: profile, error: pErr } = await sb.from('profiles').select('id, role, username').eq('id', userId).single();
  if (pErr || !profile) return res.status(403).json({ error: 'no profile' });
  const role = profile.role;

  // Parse body
  let body = {};
  try { body = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}'); }
  catch (e) { return res.status(400).json({ error: 'invalid json body' }); }

  const { table, op, rows, match, onConflict } = body;
  if (!table || !op) return res.status(400).json({ error: 'table + op required' });

  const acl = WRITE_ACL[table];
  if (!acl) return res.status(403).json({ error: `table '${table}' not allow-listed for proxy writes` });

  // Self-only for profiles
  if (acl[0] === '__self__') {
    if (op !== 'update') return res.status(403).json({ error: 'profiles: only self update allowed' });
    if (!match || match.id !== userId) return res.status(403).json({ error: 'profiles: can only update own row' });
    // Column whitelist: a user may edit their own display fields but NEVER
    // privilege/identity columns. Without this guard a user could set
    // rows:{role:'admin'} on their own row and defeat the entire WRITE_ACL.
    const PROFILE_SELF_EDITABLE = new Set(['name', 'department', 'force_password_change']);
    const offending = rows && typeof rows === 'object'
      ? Object.keys(rows).filter(k => !PROFILE_SELF_EDITABLE.has(k))
      : [];
    if (offending.length) {
      return res.status(403).json({ error: `profiles: cannot self-update column(s): ${offending.join(',')}` });
    }
  } else if (!acl.includes(role)) {
    return res.status(403).json({ error: `role '${role}' not allowed to write ${table}. Allowed: ${acl.join(',')}` });
  }

  // Stamp audit fields if present
  const now = new Date().toISOString();
  const stampWrite = (r) => {
    if (!r || typeof r !== 'object') return r;
    const out = { ...r };
    if (op === 'insert') {
      if ('created_by' in out || op === 'insert') out.created_by = out.created_by ?? userId;
      if ('created_at' in out) out.created_at = out.created_at || now;
    }
    out.updated_by = userId;
    out.updated_at = now;
    return out;
  };
  // Some tables don't have created_by / updated_by columns — handle silently
  // (Supabase ignores unknown columns silently? No, it errors. So only stamp
  // if the row already has these keys.)
  const safeStamp = (r) => {
    if (!r || typeof r !== 'object') return r;
    const out = { ...r };
    // Only set if explicitly present in the incoming row to avoid schema mismatch.
    if ('created_by' in out && (op === 'insert' || op === 'upsert')) out.created_by = out.created_by || userId;
    if ('updated_by' in out) out.updated_by = userId;
    return out;
  };

  try {
    let q = sb.from(table);
    let result;
    if (op === 'insert') {
      const payload = Array.isArray(rows) ? rows.map(safeStamp) : safeStamp(rows);
      result = await q.insert(payload).select();
    } else if (op === 'get_config') {
      if (table !== 'app_config') return res.status(400).json({ error: 'get_config only supports app_config' });
      const key = String(rows?.key || '').trim();
      if (!key) return res.status(400).json({ error: 'get_config requires rows.key' });
      result = await q.select('key,value').eq('key', key).maybeSingle();
      if (!result.error && result.data?.key === 'visa_check_ext') {
        result.data.value = parseJsonObject(result.data.value);
      }
    } else if (op === 'upsert') {
      const payload = Array.isArray(rows) ? rows.map(safeStamp) : safeStamp(rows);
      result = await q.upsert(payload, onConflict ? { onConflict } : undefined).select();
    } else if (op === 'update') {
      if (!match || typeof match !== 'object' || Array.isArray(match) || !Object.keys(match).length) {
        return res.status(400).json({ error: 'update requires a non-empty match (refusing unfiltered table-wide update)' });
      }
      let qq = q.update(safeStamp(rows));
      for (const [k, v] of Object.entries(match)) qq = qq.eq(k, v);
      result = await qq.select();
    } else if (op === 'delete') {
      if (!match || typeof match !== 'object' || Array.isArray(match)) return res.status(400).json({ error: 'delete requires match' });
      let qq = q.delete();
      if (Array.isArray(match.in?.values) && match.in?.col) {
        if (!match.in.values.length) return res.status(400).json({ error: 'delete .in match requires a non-empty values array' });
        qq = qq.in(match.in.col, match.in.values);
      } else {
        if (!Object.keys(match).length) return res.status(400).json({ error: 'delete requires a non-empty match (refusing unfiltered table-wide delete)' });
        for (const [k, v] of Object.entries(match)) qq = qq.eq(k, v);
      }
      result = await qq.select();
    } else if (op === 'patch_json') {
      if (table !== 'app_config') return res.status(400).json({ error: 'patch_json only supports app_config' });
      const key = String(rows?.key || '').trim();
      const id = String(rows?.id || '').trim();
      const field = String(rows?.field || '').trim();
      if (!key || !id || !field) return res.status(400).json({ error: 'patch_json requires rows.key + rows.id + rows.field' });
      const current = await q.select('value').eq('key', key).maybeSingle();
      if (current.error) return res.status(400).json({ error: current.error.message, details: current.error.details });
      const value = parseJsonObject(current.data?.value);
      value[id] = { ...(value[id] || {}), [field]: rows.value };
      result = await q.upsert({ key, value: JSON.stringify(value) }, { onConflict: 'key' }).select();
      if (!result.error && Array.isArray(result.data) && result.data[0]?.key === 'visa_check_ext') {
        result.data[0].value = value;
      }
    } else {
      return res.status(400).json({ error: 'op must be insert|upsert|update|delete|get_config|patch_json' });
    }
    if (result.error) return res.status(400).json({ error: result.error.message, details: result.error.details });
    return res.status(200).json({ data: result.data, op, table, role, user: profile.username });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
};
