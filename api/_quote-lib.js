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

// Read a positive numeric config, falling back to `def` when the env value is
// missing, non-numeric, or non-positive. Plain `env || def` is wrong here: the
// string '0' is truthy (would yield fx=0 → Rp 0) and Number('abc') is NaN.
function numCfg(override, envVal, def) {
  for (const cand of [override, envVal]) {
    if (cand == null || cand === '') continue;
    const n = Number(cand);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return def;
}

// RMB optional-activity price -> customer IDR.  raw = RMB*(1+profit)*fx, round UP to step.
function rmbToIdr(rmb, o = {}) {
  const fx = numCfg(o.fx, process.env.QUOTE_FX_RATE, 2700);
  // profit can legitimately be 0; only reject NaN, not zero.
  const profitRaw = o.profit != null ? o.profit : process.env.QUOTE_PROFIT;
  const profit = Number.isFinite(Number(profitRaw)) && Number(profitRaw) >= 0 ? Number(profitRaw) : 0.20;
  const step = numCfg(o.step, process.env.QUOTE_ROUND, 50000);
  const idr = Math.ceil((rmb * (1 + profit) * fx) / step) * step;
  return 'Rp ' + idr.toLocaleString('id-ID');     // Indonesian thousands = dots
}

// Parse an RMB amount that may carry thousands separators and/or a decimal part.
// RMB sources use Chinese/English convention: comma = thousands, dot = decimal.
// The old code stripped BOTH dots and commas, so "RMB 350.50" became 35050 — a
// 100× over-charge on the customer quote. Strip only thousands commas, then
// parseFloat so "350.50" → 350.5, "1,350" → 1350, "1,234.56" → 1234.56.
function parseRmb(str) {
  const m = String(str || '').match(/\d[\d.,]*/);
  if (!m) return NaN;
  return parseFloat(m[0].replace(/,/g, ''));
}

function convertOptionalPrices(content) {
  for (const d of content.days || []) {
    for (const o of d.optional || []) {
      if (/rmb|￥|元/i.test(o.price || '')) {
        const rmb = parseRmb(o.price);
        if (Number.isFinite(rmb) && rmb > 0) o.price = rmbToIdr(rmb) + '/orang';
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

// ── Multi-language support (id / zh / en / zh-en) ───────────────────────────
// One quote row holds the original language in `content` plus on-demand
// translations under content.translations[lang] (text fields only — images,
// prices and meal codes are language-neutral and stay on the base content).
const QUOTE_LANGS = ['id', 'zh', 'en', 'zh-en'];

const LANG_DEF = {
  id: {
    name: 'Bahasa Indonesia',
    titleRe: /\d+\s*Hari\s+\d+\s*Malam/i,
    titleFmt: (n, cities) => `${n} Hari ${n - 1} Malam ${cities}`.trim(),
    subtitleRe: /perjalanan/i,
    subtitleFix: s => 'Perjalanan ' + s,
    hotelDefault: 'Hotel bintang 4 (atau setara)',
    highlightPrefix: n => `Menjelajahi keindahan ${n}`,
    privateNote: 'Harga di atas berlaku hanya untuk incentive / private tour',
    privateNoteRe: /private/i,
    currency: '«Rp ____________»',
  },
  zh: {
    name: '中文',
    titleRe: /\d+\s*天\s*\d+\s*晚/,
    titleFmt: (n, cities) => `${n}天${n - 1}晚 ${cities}`.trim(),
    subtitleRe: /之旅/,
    subtitleFix: s => s + '之旅',
    hotelDefault: '四星级酒店（或同级）',
    highlightPrefix: n => `探索 ${n} 的迷人风光`,
    privateNote: '以上价格仅适用于私人团（Private Tour）',
    privateNoteRe: /私人团|private/i,
    currency: '«人民币 ____________»',
  },
  en: {
    name: 'English',
    titleRe: /\d+\s*Days?\s+\d+\s*Nights?/i,
    titleFmt: (n, cities) => `${n} Days ${n - 1} Nights ${cities}`.trim(),
    subtitleRe: /journey/i,
    subtitleFix: s => s + ' Journey',
    hotelDefault: '4-star hotel (or similar)',
    highlightPrefix: n => `Discover the beauty of ${n}`,
    privateNote: 'The above price applies to private tours only',
    privateNoteRe: /private/i,
    currency: '«USD ____________»',
  },
  'zh-en': {
    name: '中英双语',
    titleRe: /\d+\s*天\s*\d+\s*晚[\s\S]*\d+\s*Days?\s+\d+\s*Nights?/i,
    titleFmt: (n, cities) => `${n}天${n - 1}晚 ${cities} (${n} Days ${n - 1} Nights ${cities})`.trim(),
    subtitleRe: /之旅[\s\S]*journey/i,
    subtitleFix: s => /之旅/.test(s) ? `${s} (Journey)` : `${s}之旅 (Journey)`,
    hotelDefault: '四星级酒店（或同级）(4-star hotel or similar)',
    highlightPrefix: n => `探索 ${n} 的迷人风光 (Discover the beauty of ${n})`,
    privateNote: '以上价格仅适用于私人团 (The above price applies to private tours only)',
    privateNoteRe: /私人团|private/i,
    currency: '«人民币 / USD ____________»',
  },
};

function normalizeQuoteLang(lang) {
  return QUOTE_LANGS.includes(lang) ? lang : 'id';
}

// Returns the content viewed in `lang`: base content when it IS the base
// language, otherwise base merged with the stored translation. Translations
// carry only human text; structure (images, meal codes, prices, imageQuery)
// always comes from the base so the doc layout never drifts between languages.
function mergeQuoteLang(content, lang) {
  const base = content || {};
  const baseLang = normalizeQuoteLang(base.lang);
  lang = normalizeQuoteLang(lang);
  if (lang === baseLang) return base;
  const tr = (base.translations || {})[lang];
  if (!tr) return null;
  const days = (base.days || []).map((d, i) => {
    const td = (tr.days || [])[i] || {};
    return {
      ...d,
      routeTitle: td.routeTitle || d.routeTitle,
      intro: td.intro != null ? td.intro : d.intro,
      attractions: (d.attractions || []).map((a, j) => {
        const ta = (td.attractions || [])[j] || {};
        return { ...a, name: ta.name || a.name, desc: ta.desc || a.desc };
      }),
      optional: (d.optional || []).map((o, j) => {
        const to = (td.optional || [])[j] || {};
        return { ...o, name: to.name || o.name };
      }),
      shopping: td.shopping != null ? td.shopping : d.shopping,
      hotel: td.hotel || d.hotel,
      closing: td.closing != null ? td.closing : d.closing,
    };
  });
  return {
    ...base,
    lang,
    trip: { ...(base.trip || {}), ...(tr.trip || {}) },
    highlights: (tr.highlights && tr.highlights.length) ? tr.highlights : base.highlights,
    departure_label: tr.departure_label || base.departure_label,
    days,
    termasuk: (tr.termasuk && tr.termasuk.length) ? tr.termasuk : base.termasuk,
    tidak: (tr.tidak && tr.tidak.length) ? tr.tidak : base.tidak,
    noted: (tr.noted && tr.noted.length) ? tr.noted : base.noted,
  };
}

module.exports = { getServiceClient, requireUser, rmbToIdr, convertOptionalPrices, pexelsImageUrl, fetchBuffer, cors, QUOTE_LANGS, LANG_DEF, normalizeQuoteLang, mergeQuoteLang };
