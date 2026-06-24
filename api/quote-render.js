// ============================================================================
//  POST /api/quote-render  — step 2 of the Itinerary Quote pipeline.
//
//  Body: { id }   (id of an itinerary_quotes row produced by quote-generate)
//
//  Uses supplier-provided photos when available, builds the WeBuy-branded .docx
//  (pure Node / docx-js), uploads it to the Supabase Storage `quote-out`
//  bucket, writes the image URLs back into the content (for the HTML preview),
//  and marks the row done. Returns { id, docxUrl, previewUrl }.
//
//  Rules baked in: <=2 distinct photos per day, no duplicates across the doc,
//  NO photo on no-sightseeing days. Finishes well under the 60s Hobby limit.
//
//  Auth: Supabase user token.
// ============================================================================
const { buildQuoteDocx } = require('./_docxgen');
const LOGO = require('./_logo');
const { getServiceClient, requireUser, pexelsSceneryUrl, fetchBuffer, cors, normalizeQuoteLang, mergeQuoteLang } = require('./_quote-lib');

const MAX_PER_DAY = 1;   // one photo per day — halves render's vision calls so long itineraries finish reliably (the viewer shows 1/day anyway)
const MCP_BASE = process.env.WEBUY_ITINERARY_MCP_URL || 'https://webuy-itinerary-mcp.onrender.com';
// Per-slot vision photo-picking calls Claude; firing all slots at once gets
// rate-limited (429) and silently falls back to the bland first result. Run a
// few at a time so the vision "爆款" pick actually succeeds for every slot.
const VISION_CONCURRENCY = Math.max(1, Number(process.env.QUOTE_VISION_CONCURRENCY || 4));
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

const CURATED_IMAGES = [
  { re: /HONGYADONG|HONGYA\s*CAVE|洪崖洞|洪亚洞/i, key: 'curated_hongyadong_night', path: '/quote-assets/chongqing/hongyadong-night.jpg', brief: 'night illuminated stilted buildings, riverside, golden lights' },
  { re: /WANGXIAN/i, key: 'curated_wangxian_valley', path: '/quote-assets/jiangnan/wangxian-valley.jpg', brief: 'dusk/night cliff village, lantern bridge, valley panorama' },
  { re: /WUKANG|TIANZIFANG|ANFU|CITY GOD/i, key: 'curated_shanghai_wukang', path: '/quote-assets/jiangnan/shanghai-wukang-road.jpg' },
  { re: /SHANGHAI|LUJIAZUI|ORIENTAL PEARL|BUND|NANJING/i, key: 'curated_shanghai_bund', path: '/quote-assets/jiangnan/shanghai-bund.jpg' },
  { re: /BALAGEZONG|BALA\s*GEZONG|巴拉格宗/i, key: 'curated_balagezong', path: '/quote-assets/yunnan/balagezong.jpg' },
  { re: /TIGER LEAPING|虎跳峡|DUKEZONG|独克宗|GUISHAN|龟山/i, key: 'curated_tiger_leaping_gorge', path: '/quote-assets/yunnan/tiger-leaping-gorge.jpg' },
  { re: /JADE DRAGON|YULONG|玉龙|BLUE MOON|蓝月谷|GANHAIZI|甘海子|BAISHUI|白水河|IMPRESSION LIJIANG|印象丽江/i, key: 'curated_jade_dragon', path: '/quote-assets/yunnan/jade-dragon-snow-mountain.jpg' },
  { re: /SHAXI|SIDENG|沙溪|寺登/i, key: 'curated_shaxi', path: '/quote-assets/yunnan/shaxi-ancient-town.jpg' },
  { re: /DALI|ERHAI|XIZHOU|S-BAY|SANTORINI|FOREIGNER/i, key: 'curated_dali_erhai', path: '/quote-assets/yunnan/dali-erhai.jpg' },
  { re: /KUNMING|SHILIN|DIANCHI|STONE FOREST|NANPING|JINMA/i, key: 'curated_kunming', path: '/quote-assets/yunnan/kunming-wetland.jpg' },
];

const XINJIANG_RE = /XINJIANG|URUMQI|KASHGAR|KANAS|TURPAN|TIAN\s*SHAN|SAYRAM|NALATI|HEMU|KEKETUOHAI|DUKU|新疆|乌鲁木齐|喀什|喀纳斯|吐鲁番|天山|天池|赛里木|那拉提|伊犁|禾木|可可托海|独库/i;

function requestOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || process.env.VERCEL_URL;
  return `${proto}://${host}`;
}

function curatedImageForDay(day) {
  // Positive match uses ONLY real place names (routeTitle + attraction names).
  // The LLM imageQuery carries generic feature words ("glass walkway", "cable
  // car", "glacier"…) that wrongly trigger region assets (e.g. Zhangjiajie's
  // glass walkway hitting Yunnan Balagezong), so it is excluded from matching.
  const names = [day.routeTitle, ...(day.attractions || []).map(a => a.name)].filter(Boolean).join(' ');
  const full = [names, ...(day.attractions || []).map(a => a.imageQuery)].filter(Boolean).join(' ');
  if (XINJIANG_RE.test(full)) return null;       // exclusion may use the full text
  return CURATED_IMAGES.find(x => x.re.test(names));
}

// Country names we recognize in the imageQuery — used to decide whether a
// short query is already specific enough or needs the generic-tourism suffix.
const KNOWN_COUNTRIES = /\b(CHINA|VIETNAM|INDONESIA|JAPAN|KOREA|THAILAND|MALAYSIA|SINGAPORE|TAIWAN|PHILIPPINES|CAMBODIA|LAOS|MYANMAR|BURMA|INDIA|TURKEY|RUSSIA|EUROPE|FRANCE|ITALY|GERMANY|SWITZERLAND|UK|UNITED KINGDOM|USA|AMERICA|AUSTRALIA|NEW ZEALAND|SCOTLAND)\b/i;

function bestPhotoQuery(raw) {
  const q = String(raw || '').replace(/[【】]/g, '').trim();
  if (!q) return '';
  if (/KANAS|喀纳斯/i.test(q)) return 'China Xinjiang Kanas Lake alpine forest mountains travel photography';
  if (/SAYRAM|赛里木/i.test(q)) return 'China Xinjiang Sayram Lake blue water snow mountains travel photography';
  if (/NALATI|那拉提/i.test(q)) return 'China Xinjiang Nalati grassland mountains travel photography';
  if (/HEMU|禾木/i.test(q)) return 'China Xinjiang Hemu village wooden houses mountains travel photography';
  if (/TIAN\s*SHAN|天山|天池/i.test(q)) return 'China Xinjiang Tianshan Heavenly Lake snow mountain travel photography';
  if (/KASHGAR|喀什/i.test(q)) return 'China Xinjiang Kashgar old city bazaar travel photography';
  if (/TURPAN|吐鲁番/i.test(q)) return 'China Xinjiang Turpan grape valley desert travel photography';
  if (XINJIANG_RE.test(q) && !/\bCHINA\b/i.test(q)) return 'China Xinjiang ' + q + ' travel photography';
  if (/HONGYADONG|HONGYA\s*CAVE|洪崖洞|洪亚洞/i.test(q)) {
    return 'Chongqing Hongyadong night view illuminated stilted buildings riverside golden lights panorama';
  }
  if (/WANGXIAN/i.test(q)) {
    return 'Wangxian Valley Jiangxi dusk night cliff village lantern bridge valley panorama';
  }
  if (/BUND|LUJIAZUI|ORIENTAL PEARL|SHANGHAI/i.test(q)) {
    return 'Shanghai Bund Lujiazui skyline night river lights panorama';
  }
  if (/JINLI|KUANZHAI/i.test(q)) {
    return q + ' Chengdu night lantern street travel photography';
  }
  // Generic fallback: if Claude (or the rule-based parser) gave a vague short
  // query without an explicit country, Pexels often returns wrong-country
  // images. Pad it with the standard tourism-photo signal so the search at
  // least lands on a recognized landmark of any country rather than a stock
  // generic photo.
  const wordCount = q.split(/\s+/).filter(Boolean).length;
  if (wordCount <= 3 && !KNOWN_COUNTRIES.test(q)) {
    return q + ' landmark travel photography';
  }
  return q;
}

function sseJson(text) {
  const lines = String(text || '').split(/\r?\n/).filter(l => l.startsWith('data:'));
  if (!lines.length) throw new Error('MCP returned no event data');
  return JSON.parse(lines.map(l => l.replace(/^data:\s*/, '')).join('\n'));
}

async function mcpRequest(method, params, sessionId, id = 1) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const r = await fetch(`${MCP_BASE}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`MCP ${method} HTTP ${r.status}: ${text.slice(0, 300)}`);
  const msg = sseJson(text);
  if (msg.error) throw new Error(`MCP ${method}: ${msg.error.message || JSON.stringify(msg.error)}`);
  return { sessionId: r.headers.get('mcp-session-id') || sessionId, result: msg.result };
}

async function mcpInit() {
  const init = await mcpRequest('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'webuy-ops-quote-render', version: '1.0.0' },
  }, null, 1);
  await fetch(`${MCP_BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': init.sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  }).catch(() => null);
  return init.sessionId;
}

function toolText(result) {
  if (result && Array.isArray(result.content)) return result.content.map(c => c.text || JSON.stringify(c)).join('\n');
  return typeof result === 'string' ? result : JSON.stringify(result || {}, null, 2);
}

function firstJsonObject(text) {
  let depth = 0, start = -1, inStr = false, esc = false;
  text = String(text || '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (start < 0) {
      if (ch === '{') { start = i; depth = 1; }
      continue;
    }
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error('MCP tool returned no JSON object');
}

async function mcpCallTool(sessionId, name, args, id) {
  const r = await mcpRequest('tools/call', { name, arguments: args }, sessionId, id);
  return r.result;
}

async function mcpUploadDocx(docxBuf, filename) {
  const fd = new FormData();
  fd.append('file', new Blob([docxBuf], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), filename);
  const r = await fetch(`${MCP_BASE}/upload`, { method: 'POST', body: fd });
  const text = await r.text();
  if (!r.ok) throw new Error(`MCP upload HTTP ${r.status}: ${text.slice(0, 300)}`);
  const j = JSON.parse(text);
  if (!j.doc_id) throw new Error('MCP upload did not return doc_id');
  return j.doc_id;
}

function cleanText(v) {
  return String(v || '').replace(/[【】]/g, '').replace(/\s+/g, ' ').trim();
}

function splitBilingual(v) {
  const s = cleanText(v);
  const m = s.match(/^(.*?)\s*[（(]([^()（）]+)[)）]\s*$/);
  if (m) return { zh: cleanText(m[1]), en: cleanText(m[2]) };
  if (/[\u4e00-\u9fff]/.test(s)) return { zh: s, en: s };
  return { zh: s, en: s };
}

function mealToBld(mealCode) {
  const s = String(mealCode || '').toUpperCase();
  if (!s) return '-/-/-';
  return ['B', 'L', 'D'].map(x => s.includes(x) ? x : '-').join('/');
}

function routeCities(routeTitle) {
  return cleanText(routeTitle)
    .split(/\s*(?:-|–|—|→|>|\/|・)\s*/)
    .map(x => x.replace(/DAY\s*\d+/i, '').trim())
    .filter(Boolean)
    .slice(0, 6);
}

function starsFromHotel(hotel) {
  const s = String(hotel || '');
  const star = s.match(/([345])\s*(?:star|星|★)/i);
  return star ? Number(star[1]) : 4;
}

function titleFallback(content, langContent) {
  const days = (langContent.days || content.days || []).length || 1;
  return `${days}D${Math.max(0, days - 1)}N WEBUY Tour`;
}

function buildMcpMetadata(content, langContent, body) {
  const tripTitle = splitBilingual((langContent.trip || {}).title || titleFallback(content, langContent));
  const tripSub = splitBilingual((langContent.trip || {}).subtitle || '');
  const days = (langContent.days || []).map(d => {
    const title = splitBilingual(d.routeTitle || `Day ${d.dayNo}`);
    const bodyEn = [];
    const bodyZh = [];
    const intro = splitBilingual(d.intro || '');
    if (intro.en) bodyEn.push(intro.en);
    if (intro.zh) bodyZh.push(intro.zh);
    for (const a of d.attractions || []) {
      const n = splitBilingual(a.name || '');
      const desc = splitBilingual(a.desc || '');
      bodyEn.push([n.en, desc.en].filter(Boolean).join(': '));
      bodyZh.push([n.zh, desc.zh].filter(Boolean).join('：'));
    }
    const closing = splitBilingual(d.closing || '');
    if (closing.en) bodyEn.push(closing.en);
    if (closing.zh) bodyZh.push(closing.zh);
    return {
      number: d.dayNo,
      title_en: title.en || `Day ${d.dayNo}`,
      title_zh: title.zh || title.en || `第${d.dayNo}天`,
      meals: mealToBld(d.mealCode),
      body_en: bodyEn.filter(Boolean),
      body_zh: bodyZh.filter(Boolean),
    };
  });

  const hotelMap = new Map();
  for (const d of langContent.days || []) {
    if (!d.hotel) continue;
    const cities = routeCities(d.routeTitle);
    const city = cities[cities.length - 1] || cities[0] || 'Hotel';
    const key = `${city}|${d.hotel}`;
    const prev = hotelMap.get(key) || { city, name: cleanText(d.hotel), stars: starsFromHotel(d.hotel), nights: 0 };
    prev.nights += 1;
    hotelMap.set(key, prev);
  }

  const firstCities = [];
  for (const d of langContent.days || []) {
    for (const c of routeCities(d.routeTitle)) {
      if (c && firstCities[firstCities.length - 1] !== c) firstCities.push(c);
    }
  }
  const map_route = firstCities.slice(0, 10).map((city, i) => ({ city, nights: i === 0 ? 1 : 0, arrive_by: i === 0 ? 'flight' : 'coach' }));

  const rawHighlights = (langContent.highlights || []).slice(0, 4).map(splitBilingual);
  const highlights = rawHighlights.slice(0, 3).map(h => ({
    name_en: h.en || h.zh || 'WEBUY Highlight',
    name_zh: h.zh || h.en || '行程亮点',
    icon: 'star',
    bullets: [h.en || h.zh || 'Curated WEBUY travel experience'].filter(Boolean),
  }));
  const feature_badges = rawHighlights.slice(0, 4).map(h => ({
    en: (h.en || h.zh || 'WEBUY trip').slice(0, 28),
    zh: (h.zh || h.en || 'WEBUY行程').slice(0, 14),
  }));

  return {
    product_code: cleanText(body.productCode || content.product_code || content.productCode || 'WEBUY-QUOTE'),
    title_en: tripTitle.en || titleFallback(content, langContent),
    title_zh: tripTitle.zh || tripTitle.en || 'WEBUY 客户行程',
    subtitle_en: tripSub.en || tripSub.zh || '',
    subtitle_zh: tripSub.zh || tripSub.en || '',
    accent_color: cleanText(body.accentColor || content.accent_color || '#C8472B'),
    departure_window: cleanText(body.departureWindow || content.departure_label || langContent.departure_label || ''),
    service_fees: cleanText(body.serviceFees || content.service_fees || content.serviceFees || ''),
    days,
    hotels: Array.from(hotelMap.values()),
    highlights,
    feature_badges: feature_badges.length ? feature_badges : [{ en: 'WEBUY curated trip', zh: 'WEBUY精选行程' }],
    map_route,
    ai_generate_map: true,
  };
}

function photoSubjectForDay(day, sourceDay) {
  const first = (sourceDay.attractions || [])[0];
  return cleanText((first && (first.imageQuery || first.name)) || day.title_en || day.title_zh || `Day ${day.number} travel`);
}

async function pickMcpPhoto(sessionId, subject, region, id) {
  const res = await mcpCallTool(sessionId, 'fetch_photo', { subject, region, strict: false, count: 4, quick: true }, id);
  const obj = firstJsonObject(toolText(res));
  const urls = (obj.candidates || []).map(c => c && c.url).filter(Boolean);
  if (obj.best && obj.best.url) urls.unshift(obj.best.url);
  return [...new Set(urls)];
}

async function handleMcpPdf({ req, res, supabase, id, row, content, body, lang }) {
  const baseLang = normalizeQuoteLang(content.lang);
  let langContent = lang === baseLang ? content : mergeQuoteLang(content, lang);
  if (!langContent) langContent = content;

  const metadata = buildMcpMetadata(content, langContent, body);
  const sessionId = await mcpInit();
  const docxBuf = await buildQuoteDocx(langContent, { logo: LOGO, images: {}, lang: langContent.lang || lang });
  const docId = await mcpUploadDocx(docxBuf, `${id}-clean-source.docx`);

  const region = cleanText(metadata.subtitle_en || metadata.title_en || 'Asia');
  const photoTasks = [];
  photoTasks.push(['hero', pickMcpPhoto(sessionId, `${metadata.title_en} hero travel`, region, 100)]);
  (metadata.days || []).forEach((d, i) => {
    const sourceDay = (langContent.days || [])[i] || {};
    photoTasks.push([`day_${d.number}`, pickMcpPhoto(sessionId, photoSubjectForDay(d, sourceDay), region, 101 + i)]);
  });

  const picked = {};
  const photoResults = await Promise.all(photoTasks.map(async ([k, p]) => [k, await p.catch(() => null)]));
  for (const [k, urls] of photoResults) if (urls && urls.length) picked[k] = urls;
  metadata.hero_image = (picked.hero || [])[0] || (Object.values(picked)[0] || [])[0];
  metadata.day_photos = {};
  metadata.day_photo_captions = {};
  const usedPhotoUrls = new Set(metadata.hero_image ? [metadata.hero_image] : []);
  for (const d of metadata.days || []) {
    const url = (picked[`day_${d.number}`] || []).find(u => !usedPhotoUrls.has(u));
    if (!url) continue;
    usedPhotoUrls.add(url);
    metadata.day_photos[String(d.number)] = url;
    metadata.day_photo_captions[String(d.number)] = { en: d.title_en, zh: d.title_zh };
  }

  const build = await mcpCallTool(sessionId, 'build_itinerary_pdf', { doc_id: docId, metadata_json: JSON.stringify(metadata) }, 500);
  const buildObj = JSON.parse(toolText(build));
  if (!buildObj.ok || !buildObj.pdf_url) {
    return res.status(422).json({ error: 'MCP PDF build blocked', mcp: buildObj });
  }

  const pdfBuf = await fetchBuffer(buildObj.pdf_url);
  const outPath = `${id}${lang === baseLang ? '' : '-' + lang}.pdf`;
  const up = await supabase.storage.from('quote-out').upload(outPath, pdfBuf, {
    contentType: 'application/pdf',
    upsert: true,
  });
  if (up.error) return res.status(500).json({ error: 'upload pdf: ' + up.error.message, mcpPdfUrl: buildObj.pdf_url });
  const { data: pub } = supabase.storage.from('quote-out').getPublicUrl(outPath);
  const pdfUrl = pub.publicUrl;
  content.pdfUrl = pdfUrl;
  content.pdfUrls = { ...(content.pdfUrls || {}), [lang]: pdfUrl };
  content.mcpPdf = { pdf_id: buildObj.pdf_id || null, generated_at: new Date().toISOString(), product_code: metadata.product_code };

  const upd = await supabase.from('itinerary_quotes').update({ status: row.status === 'generated' ? 'done' : row.status, content }).eq('id', id);
  if (upd.error && !/updated_by/i.test(upd.error.message || '')) {
    return res.status(500).json({ error: 'db: ' + upd.error.message, pdfUrl });
  }
  return res.status(200).json({ id, pdfUrl, mcpPdfUrl: buildObj.pdf_url, previewUrl: `/q?id=${id}` });
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const supabase = getServiceClient();
    const user = await requireUser(req, supabase);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const id = body.id;
    if (!id) return res.status(400).json({ error: 'id required' });

    const row = await supabase.from('itinerary_quotes').select('content,status,source_path').eq('id', id).single();
    if (row.error || !row.data) return res.status(404).json({ error: 'quote not found' });
    const content = row.data.content;
    const baseLang = normalizeQuoteLang(content.lang);
    const lang = normalizeQuoteLang(body.lang || baseLang);
    if (body.format === 'pdf' || body.format === 'mcp-pdf') {
      return handleMcpPdf({ req, res, supabase, id, row: row.data, content, body, lang });
    }

    // ---- pick images (rule: no attractions -> no photo; curated destination
    // views beat supplier/old generated images for known landmarks) ----
    const wanted = [];                       // { day, name, query } / { day, curated } / { day, source }
    for (const d of content.days || []) {
      d.imageNames = [];
      if (!d.attractions || !d.attractions.length) continue;
      const curated = curatedImageForDay(d);
      if (curated) {
        wanted.push({ d, curated });
      } else if (content.sourceImages && content.sourceImages.length) {
        wanted.push({ d, source: true });
      } else if (process.env.QUOTE_ALLOW_PEXELS_FALLBACK !== '0' && !!process.env.PEXELS_API_KEY) {
        for (const a of d.attractions.slice(0, MAX_PER_DAY)) {
          wanted.push({ d, name: a.name, query: bestPhotoQuery(a.imageQuery || a.name) });
        }
      }
    }
    if (!process.env.PEXELS_API_KEY) console.warn('[quote-render] PEXELS_API_KEY not set — Pexels fallback disabled');
    const imagesUrl = {};                    // name -> url (for preview JSON)
    if (wanted.some(w => w.curated)) {
      const origin = requestOrigin(req);
      const usedKeys = new Set();
      const usedPaths = new Set();
      for (const w of wanted) {
        if (!w.curated) continue;
        // same curated image already used on an earlier day -> skip it so this
        // day falls through to a unique Pexels scenery photo (no duplicates).
        if (usedPaths.has(w.curated.path)) continue;
        usedPaths.add(w.curated.path);
        let name = w.curated.key;
        if (usedKeys.has(name)) name = `${name}_${w.d.dayNo}`;
        usedKeys.add(name);
        imagesUrl[name] = origin + w.curated.path;
        w.d.imageNames.push(name);
      }
    }
    if (content.sourceImages && content.sourceImages.length) {
      let imgIdx = 0;
      for (const w of wanted) {
        if (!w.source) continue;
        const src = content.sourceImages[imgIdx++];
        if (!src || !src.url) break;
        const name = src.key || `source_${imgIdx}`;
        imagesUrl[name] = src.url;
        w.d.imageNames.push(name);
      }
    }
    const pexelsWanted = wanted.filter(w => w.query);
    const pexelsDays = new Set(pexelsWanted.map(w => w.d && w.d.dayNo));
    if (process.env.QUOTE_ALLOW_PEXELS_FALLBACK !== '0') {
      for (const d of content.days || []) {
        if (!d.attractions || !d.attractions.length || (d.imageNames || []).length) continue;
        if (pexelsDays.has(d.dayNo)) continue;
        for (const a of d.attractions.slice(0, MAX_PER_DAY)) {
          pexelsWanted.push({ d, name: a.name, query: bestPhotoQuery(a.imageQuery || a.name) });
        }
      }
    }
    if (pexelsWanted.length && process.env.QUOTE_ALLOW_PEXELS_FALLBACK !== '0') {
      const urls = process.env.PEXELS_API_KEY
        ? await mapLimit(pexelsWanted, VISION_CONCURRENCY, w => pexelsSceneryUrl(w.query).catch(() => null))
        : pexelsWanted.map(() => null);
      const usedUrls = new Set();
      for (const u of Object.values(imagesUrl)) usedUrls.add(u);
      const assignFetchedUrl = (w, u, source) => {
        if (u && !usedUrls.has(u)) {
          usedUrls.add(u);
          const baseName = w.name || `day_${w.d.dayNo}`;
          let name = baseName;
          let n = 2;
          while (imagesUrl[name]) name = `${baseName}_${n++}`;
          imagesUrl[name] = u;
          w.d.imageNames.push(name);
          w.d.imageSource = source;
          return true;
        }
        return false;
      };
      pexelsWanted.forEach((w, i) => assignFetchedUrl(w, urls[i], 'pexels'));
      const missingPhotoSlots = pexelsWanted.filter(w => !(w.d.imageNames || []).length);
      if (missingPhotoSlots.length) {
        try {
          const sessionId = await mcpInit();
          const mcpUrls = await Promise.all(missingPhotoSlots.map((w, i) =>
            pickMcpPhoto(sessionId, w.query || w.name || `Day ${w.d.dayNo} travel`, 'China Asia', 700 + i)
              .then(list => (list || []).find(u => !usedUrls.has(u)) || null)
              .catch(() => null)
          ));
          missingPhotoSlots.forEach((w, i) => assignFetchedUrl(w, mcpUrls[i], 'mcp'));
        } catch (mcpImgErr) {
          console.warn('[quote-render] MCP image fallback failed:', mcpImgErr.message || mcpImgErr);
        }
      }
    }
    console.log(`[quote-render] images: ${Object.keys(imagesUrl).length} resolved for ${wanted.length} slots`);
    content.images = imagesUrl;

    // Persist the picked images NOW, before the slower docx build/upload. If
    // those later steps time out (long itineraries), the online itinerary still
    // shows its photos. Best-effort: never let this extra write block render.
    try { await supabase.from('itinerary_quotes').update({ content }).eq('id', id); } catch (e) { /* best-effort */ }

    // download bytes for the docx (parallel)
    const names = Object.keys(imagesUrl);
    const bufs = await Promise.all(names.map(n => fetchBuffer(imagesUrl[n]).catch(() => null)));
    const imagesBuf = {};
    names.forEach((n, i) => {
      if (!bufs[i]) return;
      const src = (content.sourceImages || []).find(x => x.key === n);
      imagesBuf[n] = { data: bufs[i], ext: (src && src.ext) || 'jpg' };
    });
    // drop names whose download failed so docx/preview stay consistent
    for (const d of content.days || []) d.imageNames = (d.imageNames || []).filter(n => imagesBuf[n]);

    // ---- build the .docx in the requested language ----
    // mergeQuoteLang returns null when that translation hasn't been generated
    // yet — the caller should hit quote-generate {id, lang} first.
    const langContent = lang === baseLang ? content : mergeQuoteLang(content, lang);
    if (!langContent) return res.status(409).json({ error: `translation "${lang}" not generated yet — call quote-generate {id, lang} first` });
    const docx = await buildQuoteDocx(langContent, { logo: LOGO, images: imagesBuf, lang });

    // ---- upload to Storage (base language keeps the legacy `${id}.docx`) ----
    const path = lang === baseLang ? `${id}.docx` : `${id}-${lang}.docx`;
    const up = await supabase.storage.from('quote-out').upload(path, docx, {
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      upsert: true,
    });
    if (up.error) return res.status(500).json({ error: 'upload: ' + up.error.message });
    const { data: pub } = supabase.storage.from('quote-out').getPublicUrl(path);
    const docxUrl = pub.publicUrl;
    if (lang === baseLang) content.docxUrl = docxUrl;
    content.docxUrls = { ...(content.docxUrls || {}), [lang]: docxUrl };

    // docx_url column always tracks the base-language doc; per-language URLs
    // live in content.docxUrls.
    const upd = await supabase.from('itinerary_quotes').update({ status: 'done', docx_url: content.docxUrl || docxUrl, content }).eq('id', id);
    if (upd.error) {
      content.docxUrl = docxUrl;
      // Some legacy tables use public.set_updated_at(), which writes updated_by.
      // If the quote table is missing that column, do not block the customer doc.
      if (!/updated_by/i.test(upd.error.message || '')) {
        return res.status(500).json({ error: 'db: ' + upd.error.message });
      }
    }

    return res.status(200).json({ id, docxUrl, previewUrl: `/q?id=${id}` });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
