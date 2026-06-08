const { createClient } = require('@supabase/supabase-js');

const CONFIG_KEY = 'visa_code_merge_groups';

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

function cleanConfig(input) {
  if (typeof input === 'string') {
    try { input = JSON.parse(input); }
    catch { input = { groups: [] }; }
  }
  const groups = Array.isArray(input?.groups) ? input.groups : [];
  return {
    groups: groups.map(g => {
      const codes = [...new Set((g.codes || [])
        .map(c => String(c || '').trim().toUpperCase())
        .filter(Boolean))];
      return {
        id: String(g.id || codes.slice().sort().join('+') || '').trim(),
        codes,
      };
    }).filter(g => g.codes.length > 1),
  };
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'GET or POST only' });

  try {
    const supabase = serviceClient();
    const user = await requireUser(supabase, req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    if (req.method === 'GET') {
      const { data, error } = await supabase.from('app_config').select('value').eq('key', CONFIG_KEY).maybeSingle();
      if (error) throw error;
      return res.status(200).json(cleanConfig(data?.value || { groups: [] }));
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const value = cleanConfig(body);
    const { error } = await supabase.from('app_config').upsert({ key: CONFIG_KEY, value: JSON.stringify(value) }, { onConflict: 'key' });
    if (error) throw error;
    return res.status(200).json(value);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
