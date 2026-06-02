// ============================================================================
//  _quote-lib.js — shared helpers for the Itinerary Quote feature.
//  (underscore-prefixed = internal module, not a routed endpoint)
// ============================================================================
const { createClient } = require('@supabase/supabase-js');

function getServiceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  return createClient(url, key, { auth: { persistSession: false } });
}

// Authenticate the caller via their Supabase user token (same as other endpoints).
async function requireUser(req, supabase) {
  const auth = req.headers['authorization'] || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!bearer) return null;
  const { data, error } = await supabase.auth.getUser(bearer);
  if (error || !data || !data.user) return null;
  return data.user;
}

// RMB optional-activity price -> customer IDR.  raw = RMB*(1+profit)*fx, round UP to step.
function rmbToIdr(rmb, o = {}) {
  const fx = Number(o.fx != null ? o.fx : process.env.QUOTE_FX_RATE || 2700);
  const profit = Number(o.profit != null ? o.profit : process.env.QUOTE_PROFIT || 0.20);
  const step = Number(o.step != null ? o.step : process.env.QUOTE_ROUND || 50000);
  const idr = Math.ceil((rmb * (1 + profit) * fx) / step) * step;
  return 'Rp ' + idr.toLocaleString('id-ID');     // Indonesian thousands = dots
}

function convertOptionalPrices(content) {
  for (const d of content.days || []) {
    for (const o of d.optional || []) {
      const m = String(o.price || '').match(/(\d[\d.,]*)/);
      if (m && /rmb|￥|元/i.test(o.price)) {
        const rmb = parseInt(m[1].replace(/[.,]/g, ''), 10);
        if (rmb) o.price = rmbToIdr(rmb) + '/orang';
      }
    }
  }
  return content;
}

// Pexels search -> a center-cropped 3:2 (1200x800) image URL via CDN params.
async function pexelsImageUrl(query) {
  const key = process.env.PEXELS_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch('https://api.pexels.com/v1/search?orientation=landscape&per_page=3&query=' + encodeURIComponent(query), { headers: { Authorization: key } });
    if (!r.ok) return null;
    const j = await r.json();
    const p = (j.photos || [])[0];
    const base = p && p.src && (p.src.original || p.src.large2x);
    if (!base) return null;
    return base.split('?')[0] + '?auto=compress&cs=tinysrgb&fit=crop&w=1200&h=800';
  } catch { return null; }
}

async function fetchBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('img HTTP ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Cache-Control', 'no-store');
}

module.exports = { getServiceClient, requireUser, rmbToIdr, convertOptionalPrices, pexelsImageUrl, fetchBuffer, cors };
