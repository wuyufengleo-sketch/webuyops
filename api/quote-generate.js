// ============================================================================
//  POST /api/quote-generate  — step 1 of the Itinerary Quote pipeline.
//
//  Body: { srcPath }  (path of the uploaded land-operator .docx in the
//         Supabase Storage `quote-src` bucket)
//
//  Parses the .docx (mammoth), asks Claude (one call) to translate + structure
//  it into a WeBuy customer itinerary (Bahasa Indonesia), converts optional
//  self-pay prices RMB -> IDR, and stores the structured JSON in
//  `itinerary_quotes` (status='generated'). Returns { id }.
//
//  Designed to finish well under Vercel's 60s Hobby limit (single LLM call).
//  Set QUOTE_MOCK=1 to smoke-test the pipeline without spending LLM tokens.
//
//  Auth: Supabase user token (Authorization: Bearer <token>).
// ============================================================================
const mammoth = require('mammoth');
const JSZip = require('jszip');
const { getServiceClient, requireUser, convertOptionalPrices, cors, LANG_DEF, normalizeQuoteLang, mergeQuoteLang } = require('./_quote-lib');
const { parseRuleBasedQuote, makeImageSearches, auditQuoteContent } = require('./_quote-parser');

// Per-language prompt fragments. The pipeline structure (title format check,
// highlights, meal extraction, hotel rules…) is identical across languages —
// only the output language and its idiomatic formats change.
const PROMPT_LANG = {
  id: {
    audience: 'written in BAHASA INDONESIA for Indonesian travelers',
    langRule: 'OUTPUT LANGUAGE: Bahasa Indonesia. No Chinese characters in descriptions (proper-noun show names may keep their Chinese in parentheses).',
    titleRule: `- trip.title: MUST follow EXACTLY: "{N} Hari {N-1} Malam [Main Cities]"
  N = total days. Cities = main destinations visited (NOT the origin city). Use "・" between cities.
  Examples: "5 Hari 4 Malam Chengdu・Jiuzhaigou", "8 Hari 7 Malam Kunming・Dali・Lijiang"
- trip.subtitle: MUST contain the word "Perjalanan" (之旅). Format: "Perjalanan [Theme]".
  Examples: "Perjalanan Budaya & Alam Tiongkok", "Perjalanan Alam Jiuzhaigou"`,
    hlExamples: `GOOD: "Menjelajahi keindahan air toska Jiuzhaigou Valley", "Menonton pertunjukan Face-changing Sichuan yang legendaris"
  BAD (too generic, REJECTED): "Menikmati pemandangan alam yang indah", "Wisata budaya yang menarik"`,
    nameRule: 'name: romanized English in fullwidth brackets, e.g. 【Jiuzhaigou Valley】',
    hotelRules: `* Source states hotel name → use it exactly (real hotel name + star rating from the land-operator quote).
  * Source states only star rating → "Hotel bintang X (atau setara)".
  * Source says 酒店/住宿 without detail → "Hotel (sesuai program)".
  * Source mentions nothing about hotel but the day has an overnight → "Hotel bintang 4 (atau setara)".`,
    privateNote: 'Harga di atas berlaku hanya untuk incentive / private tour',
  },
  zh: {
    audience: 'written in SIMPLIFIED CHINESE (简体中文) for Chinese-speaking travelers',
    langRule: 'OUTPUT LANGUAGE: Simplified Chinese (简体中文). All descriptions, meals notes, terms in Chinese.',
    titleRule: `- trip.title: MUST follow EXACTLY: "{N}天{N-1}晚 [Main Cities]"
  N = total days. Cities = main destinations visited (NOT the origin city). Use "・" between cities. City names in Chinese.
  Examples: "5天4晚 成都・九寨沟", "8天7晚 昆明・大理・丽江"
- trip.subtitle: MUST end with "之旅". Format: "[主题]之旅".
  Examples: "中国文化与自然之旅", "九寨沟自然风光之旅", "云南高原之旅"`,
    hlExamples: `GOOD: "探索九寨沟碧蓝海子的绝美风光", "观赏传奇的四川变脸表演", "登上玉龙雪山之巅留影"
  BAD (too generic, REJECTED): "欣赏美丽的自然风光", "有趣的文化之旅"`,
    nameRule: 'name: Chinese name + English original name in fullwidth brackets, e.g. 【景福宫 Gyeongbok Palace】,【九寨沟 Jiuzhaigou Valley】 — ALWAYS keep the English original name after the Chinese.',
    hotelRules: `* Source states hotel name → use it exactly (real hotel name + star rating from the land-operator quote).
  * Source states only star rating → "X星级酒店（或同级）".
  * Source says 酒店/住宿 without detail → "酒店（按行程安排）".
  * Source mentions nothing about hotel but the day has an overnight → "四星级酒店（或同级）".`,
    privateNote: '以上价格仅适用于私人团（Private Tour）',
  },
  en: {
    audience: 'written in ENGLISH for international travelers',
    langRule: 'OUTPUT LANGUAGE: English. No Chinese characters in descriptions (proper-noun show names may keep their Chinese in parentheses).',
    titleRule: `- trip.title: MUST follow EXACTLY: "{N} Days {N-1} Nights [Main Cities]"
  N = total days. Cities = main destinations visited (NOT the origin city). Use "・" between cities.
  Examples: "5 Days 4 Nights Chengdu・Jiuzhaigou", "8 Days 7 Nights Kunming・Dali・Lijiang"
- trip.subtitle: MUST contain the word "Journey". Format: "[Theme] Journey" or "A Journey of [Theme]".
  Examples: "China Culture & Nature Journey", "A Journey of Yunnan Highlands"`,
    hlExamples: `GOOD: "Explore the turquoise lakes of Jiuzhaigou Valley", "Watch the legendary Sichuan face-changing show"
  BAD (too generic, REJECTED): "Enjoy beautiful natural scenery", "Interesting cultural tour"`,
    nameRule: 'name: romanized English in fullwidth brackets, e.g. 【Jiuzhaigou Valley】',
    hotelRules: `* Source states hotel name → use it exactly (real hotel name + star rating from the land-operator quote).
  * Source states only star rating → "X-star hotel (or similar)".
  * Source says 酒店/住宿 without detail → "Hotel (as per program)".
  * Source mentions nothing about hotel but the day has an overnight → "4-star hotel (or similar)".`,
    privateNote: 'The above price applies to private tours only',
  },
  'zh-en': {
    audience: 'written BILINGUALLY: each text field contains CHINESE first, then ENGLISH in parentheses. Target audience: Chinese-speaking travelers who also need English reference',
    langRule: 'OUTPUT LANGUAGE: Bilingual Chinese+English. Format every text field as: "中文内容 (English content)". Example attraction desc: "九寨沟以碧蓝海子和层叠瀑布闻名 (Jiuzhaigou is famous for its turquoise lakes and cascading waterfalls)". Meal codes, dayNo, imageQuery stay in English only.',
    titleRule: `- trip.title: MUST follow EXACTLY: "{N}天{N-1}晚 [Chinese Cities] ({N} Days {N-1} Nights [English Cities])"
  N = total days. Cities = main destinations visited. Use "・" between cities.
  Examples: "5天4晚 成都・九寨沟 (5 Days 4 Nights Chengdu・Jiuzhaigou)"
- trip.subtitle: MUST contain both "之旅" and "Journey". Format: "[中文主题]之旅 ([English Theme] Journey)".
  Examples: "中国文化与自然之旅 (China Culture & Nature Journey)"`,
    hlExamples: `GOOD: "探索九寨沟碧蓝海子的绝美风光 (Explore the turquoise lakes of Jiuzhaigou Valley)"
  BAD: pure Chinese or pure English without the other language`,
    nameRule: 'name: Chinese name + English name in fullwidth brackets, e.g. 【九寨沟 Jiuzhaigou Valley】',
    hotelRules: `* Source states hotel name → use it exactly with bilingual note.
  * Source states only star rating → "X星级酒店（或同级）(X-star hotel or similar)".
  * Source says 酒店/住宿 without detail → "酒店（按行程安排）(Hotel as per program)".
  * Source mentions nothing about hotel but the day has an overnight → "四星级酒店（或同级）(4-star hotel or similar)".`,
    privateNote: '以上价格仅适用于私人团 (The above price applies to private tours only)',
  },
};

function buildSystem(lang) {
  const L = PROMPT_LANG[lang] || PROMPT_LANG.id;
  return `You convert a tour land-operator's confirmation/quotation document into a customer-facing itinerary for "WEBUY Tour & Travel", ${L.audience}.

Rules:
- ${L.langRule}
- Tone: warm, inviting, concise marketing copy.

═══ TRIP TITLE (MANDATORY) ═══
${L.titleRule}

═══ HIGHLIGHTS (MANDATORY — generate 4-6 items, NEVER skip) ═══
- highlights[]: Each highlight MUST reference a SPECIFIC real attraction or experience from the itinerary.
  Write one exciting sentence (max 20 words) per item, in the output language.
  ${L.hlExamples}

═══ EACH DAY ═══
- dayNo, routeTitle (e.g. "CHENGDU - JIUZHAIGOU")

- mealCode: Extract ONLY from the source document. Mapping:
  早餐/早/sarapan/breakfast → B, 午餐/中餐/中/makan siang/lunch → L, 晚餐/晚/makan malam/dinner → D
  Combine: "B/L/D", "B/D", "B/L", "B", "L/D", "D", etc.
  If the source does NOT mention meals for this day → use "" (empty string).
  NEVER invent or assume meals not explicitly stated in the source.

- intro: 1–2 sentence intro for the day, in the output language.

- attractions[]:
  * ${L.nameRule}
  * desc: in the output language. Apply TWO strategies based on source detail level:
    STRATEGY A — SOURCE HAS DETAILED DESCRIPTION (multiple sentences / paragraphs):
      Translate faithfully into the output language. Preserve ALL detail and information. Do NOT shorten or summarize.
    STRATEGY B — SOURCE ONLY BRIEFLY MENTIONS the attraction (just a name or one short line):
      ENHANCE: write 2–3 enticing sentences in tourism style — describe what visitors see/experience and why it is special.
  * imageQuery: *** MANDATORY for EVERY attraction, NEVER leave empty ***
    Write a concise English photo search phrase: [COUNTRY] + [CITY/PROVINCE] + [exact attraction name] + [unique visual keywords].
    ALWAYS include the country name and city so the image search returns the ACTUAL location, not a similar-looking place elsewhere.
    Examples: "Vietnam Phu Quoc Sao Beach white sand turquoise water", "China Chengdu giant panda eating bamboo", "Vietnam Hanoi Old Quarter street vendors motorbikes", "China Lijiang Old Town night lanterns canal reflection", "Vietnam Ha Long Bay limestone karsts emerald water boats", "China Beijing Great Wall Mutianyu section autumn"

- optional[]: self-pay activities — KEEP original price with "RMB", e.g. {name, price:"RMB 350/orang"}
- shopping: short label of any shopping stop in the output language, else ""

- hotel: *** MANDATORY for every night with an overnight stay ***
  ${L.hotelRules}
  * ONLY "" on the very last departure day with NO overnight stay.

- closing: closing line in the output language, may be "".

═══ OTHER RULES ═══
- A pure arrival/departure/transit day with no sightseeing MUST have an EMPTY attractions array (no photos rendered for those days).
- departure_label: the departure date if present (e.g. "13 OKT 2027"), else "«TANGGAL»".
- termasuk[] (PACKAGE INCLUDES) in the output language: combine land inclusions (hotel star, meals, transport incl. trains, entry tickets, guide) with WeBuy standard additions: international economy flight ex-origin city, baggage per airline, group visa, travel insurance, tipping, PPN 1,1%.
- tidak[] (PACKAGE EXCLUDES) in the output language: optional tours, personal expenses (phone, minibar, laundry), excess baggage, single-room supplement, anything not listed.
- noted[]: standard WeBuy notes in the output language (price validity, based on X pax, MUST include this exact private-tour note: "${L.privateNote}", schedule may change, price not binding, no booking yet).
- IMPORTANT: NEVER include the land operator's INTERNAL information (company name, contacts, cost price, markup, "tell customers to cooperate with shopping/add-ons", agency contacts). Strip them completely — only the WeBuy brand may appear.
- Do NOT invent a customer price. Leave pricing to a placeholder.

Return ONLY via the emit_quote tool.`;
}

// Translate an existing quote's human text into another language, preserving
// structure 1:1 (same days, same attractions order, imageQuery untouched).
function buildTranslateSystem(lang) {
  const L = PROMPT_LANG[lang] || PROMPT_LANG.id;
  return `You translate a WEBUY Tour & Travel customer itinerary JSON into another language, ${L.audience}.

Rules:
- ${L.langRule}
- TRANSLATE ONLY human-readable text: trip.title, trip.subtitle, highlights, routeTitle, intro, attraction name & desc, optional name, shopping, hotel, closing, termasuk, tidak, noted.
- STRUCTURE MUST MATCH the source EXACTLY: same number of days, same number of attractions per day in the same order, same optional items.
- COPY UNCHANGED: dayNo, mealCode, imageQuery (keep English), optional prices, departure_label (translate month names only if written out).
- Title format: ${L.titleRule.split('\n')[0].replace('- trip.title: MUST follow EXACTLY: ', '')}
- Subtitle: ${lang === 'zh' ? 'must end with 之旅' : lang === 'en' ? 'must contain "Journey"' : lang === 'zh-en' ? 'must contain both 之旅 and Journey' : 'must contain "Perjalanan"'}.
- Attraction ${L.nameRule}
- Hotel names: keep the real hotel name as-is, translate only descriptive parts like "(or similar)".
- noted[] MUST include: "${L.privateNote}"

Return ONLY via the emit_quote tool.`;
}

const SCHEMA = {
  type: 'object',
  properties: {
    trip: { type: 'object', properties: { title: { type: 'string' }, subtitle: { type: 'string' } }, required: ['title', 'subtitle'] },
    highlights: { type: 'array', items: { type: 'string' } },
    departure_label: { type: 'string' },
    days: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          dayNo: { type: 'integer' }, routeTitle: { type: 'string' }, mealCode: { type: 'string' }, intro: { type: 'string' },
          attractions: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, desc: { type: 'string' }, imageQuery: { type: 'string' } }, required: ['name', 'desc', 'imageQuery'] } },
          optional: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, price: { type: 'string' } }, required: ['name', 'price'] } },
          shopping: { type: 'string' }, hotel: { type: 'string' }, closing: { type: 'string' },
        },
        required: ['dayNo', 'routeTitle', 'mealCode', 'intro', 'attractions', 'optional', 'shopping', 'hotel', 'closing'],
      },
    },
    termasuk: { type: 'array', items: { type: 'string' } },
    tidak: { type: 'array', items: { type: 'string' } },
    noted: { type: 'array', items: { type: 'string' } },
  },
  required: ['trip', 'highlights', 'departure_label', 'days', 'termasuk', 'tidak'],
};

const MOCK = {
  trip: { title: '3 Hari 2 Malam Kota A・Kota B', subtitle: 'Perjalanan Budaya & Alam' },
  highlights: [
    'Menjelajahi kawasan Kota Tua yang bersejarah dan memukau',
    'Keindahan Danau Hijau yang tenang di Kota B',
    'Menikmati pertunjukan malam spektakuler Night Show',
    'Kuliner khas daerah dan pasar lokal yang autentik',
  ],
  departure_label: '«TANGGAL»',
  days: [
    { dayNo: 1, routeTitle: 'JAKARTA - KOTA A', mealCode: 'D', intro: 'Selamat datang! Tiba di Kota A dan memulai petualangan.', attractions: [{ name: '【Old Town】', desc: 'Kawasan kota tua yang menawan dengan arsitektur bersejarah dan suasana yang autentik.', imageQuery: 'Chinese old town street lanterns' }], optional: [{ name: 'Night Show (千古情)', price: 'RMB 350/orang' }], shopping: '', hotel: 'Hotel bintang 4 (atau setara)', closing: 'Check-in dan istirahat di hotel.' },
    { dayNo: 2, routeTitle: 'KOTA A - KOTA B', mealCode: 'B/L/D', intro: 'Menuju Kota B menikmati alam.', attractions: [{ name: '【Green Lake】', desc: 'Danau hijau yang tenang dengan air berwarna toska yang memukau, dikelilingi pegunungan hijau.', imageQuery: 'turquoise alpine lake china' }], optional: [], shopping: 'Pusat oleh-oleh teh lokal', hotel: 'Hotel bintang 4 (atau setara)', closing: '' },
    { dayNo: 3, routeTitle: 'KOTA B - JAKARTA', mealCode: 'B', intro: 'Sarapan di hotel, lalu diantar ke bandara sesuai jadwal penerbangan.', attractions: [], optional: [], shopping: '', hotel: '', closing: 'Sampai jumpa di perjalanan berikutnya!' },
  ],
  termasuk: ['Tiket penerbangan internasional kelas ekonomi dari Jakarta', 'Visa Group', 'Travel Insurance', 'Tipping', 'PPN 1,1%', 'Hotel bintang 4', 'Makan sesuai program', 'Pemandu berbahasa Inggris'],
  tidak: ['Acara pilihan / optional tour', 'Pengeluaran pribadi (telepon, minibar, laundry)', 'Selisih kamar single'],
  noted: ['Harga berlaku untuk 3 hari sejak dikeluarkan', 'Harga based on 15+1 Pax', 'Harga diatas berlaku hanya untuk incentive / private tour', 'Susunan acara dapat berubah sesuai keadaan & konfirmasi hotel', 'Harga tidak mengikat dan dapat berubah sewaktu-waktu.', 'Belum ada proses booking sampai saat ini'],
};

const IMAGE_EXT = {
  jpg: 'jpg',
  jpeg: 'jpg',
  png: 'png',
};

function imageMeta(buf, ext) {
  if (ext === 'png' && buf.length >= 24 && buf.toString('ascii', 1, 4) === 'PNG') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (ext === 'jpg' && buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) break;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      i += 2 + len;
    }
  }
  return {};
}

function usableSourceImage(img) {
  const { width = 0, height = 0, bytes = 0 } = img;
  if (bytes < 30000) return false;
  if (width && height) {
    if (width < 220 || height < 150) return false;
    const ratio = width / height;
    if (ratio > 4.5 || ratio < 0.35) return false;
  }
  return true;
}

async function extractDocxImages(buf) {
  const zip = await JSZip.loadAsync(buf);
  const out = [];
  const files = Object.values(zip.files)
    .filter(f => !f.dir && /^word\/media\//i.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const file of files) {
    const extRaw = (file.name.split('.').pop() || '').toLowerCase();
    const ext = IMAGE_EXT[extRaw];
    if (!ext) continue;
    const data = Buffer.from(await file.async('nodebuffer'));
    const meta = imageMeta(data, ext);
    const img = { source: 'docx', originalName: file.name.split('/').pop(), ext, data, bytes: data.length, ...meta };
    if (usableSourceImage(img)) out.push(img);
  }
  return out.slice(0, 24);
}

async function downloadStorageImage(supabase, path) {
  const dl = await supabase.storage.from('quote-src').download(path);
  if (dl.error || !dl.data) return null;
  const data = Buffer.from(await dl.data.arrayBuffer());
  const extRaw = (path.split('.').pop() || '').toLowerCase();
  const ext = IMAGE_EXT[extRaw] || (dl.data.type || '').split('/').pop();
  if (!IMAGE_EXT[ext] && ext !== 'jpg' && ext !== 'png') return null;
  const cleanExt = ext === 'jpeg' ? 'jpg' : ext;
  const meta = imageMeta(data, cleanExt);
  const img = { source: 'upload', originalName: path.split('/').pop(), ext: cleanExt, data, bytes: data.length, ...meta };
  return usableSourceImage(img) ? img : null;
}

async function uploadQuoteSourceImages(supabase, id, images) {
  const uploaded = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const path = `${id}/source-images/${String(i + 1).padStart(2, '0')}.${img.ext}`;
    const contentType = img.ext === 'png' ? 'image/png' : 'image/jpeg';
    const up = await supabase.storage.from('quote-out').upload(path, img.data, { contentType, upsert: true });
    if (up.error) continue;
    const { data: pub } = supabase.storage.from('quote-out').getPublicUrl(path);
    uploaded.push({
      key: `source_${i + 1}`,
      url: pub.publicUrl,
      ext: img.ext,
      width: img.width || null,
      height: img.height || null,
      source: img.source,
      originalName: img.originalName,
    });
  }
  return uploaded;
}

function ruleBasedFallback(landText, reason) {
  const fallback = parseRuleBasedQuote(landText);
  fallback.generator = 'rule-based';
  fallback.fallbackReason = reason;
  fallback.noted = [
    'Draft dibuat dengan rule-based parser (tanpa AI). Wajib review manual sebelum dikirim ke customer.',
    ...(fallback.noted || []),
  ];
  return fallback;
}

// Race a promise against a timeout so a hung Supabase Storage call fails FAST
// with a clear message, instead of silently burning the whole maxDuration
// budget and ending in an opaque FUNCTION_INVOCATION_TIMEOUT (504).
function withTimeout(promise, ms, label) {
  let t = null;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(label + ' timed out after ' + ms + 'ms')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => { if (t) clearTimeout(t); });
}

// Shared single-shot Claude call with the emit_quote tool. Throws on failure.
async function claudeEmitQuote({ system, userContent }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY missing at runtime');
  let timer = null;
  try {
    const controller = new AbortController();
    // Default 240s: long (12-day) itineraries need a big generation budget, yet
    // this stays below the 300s function maxDuration so a genuinely slow Claude
    // call aborts and falls back to a rule-based draft instead of a hard 504.
    const timeoutMs = Math.max(3000, Number(process.env.QUOTE_AI_TIMEOUT_MS || 240000));
    timer = setTimeout(() => controller.abort(), timeoutMs);
    const body = {
      model: process.env.QUOTE_MODEL || 'claude-sonnet-4-6',
      max_tokens: 12000,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools: [{ name: 'emit_quote', description: 'Return the structured WeBuy customer itinerary.', input_schema: SCHEMA }],
      tool_choice: { type: 'tool', name: 'emit_quote' },
      messages: [{ role: 'user', content: userContent }],
    };
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error('Claude HTTP ' + r.status + ': ' + (await r.text()).slice(0, 400));
    const j = await r.json();
    if (j.stop_reason === 'max_tokens') {
      console.warn('[quote-generate] Claude hit max_tokens — output may be truncated');
    }
    const tu = (j.content || []).find(c => c.type === 'tool_use');
    if (!tu) throw new Error('Claude returned no tool_use (stop_reason: ' + j.stop_reason + ')');
    const out = tu.input || {};
    if (!Array.isArray(out.days) || !out.days.length) {
      throw new Error('Claude returned empty days (stop_reason: ' + j.stop_reason + ', keys: ' + Object.keys(out).join(',') + ')');
    }
    return out;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function callClaude(landText, lang) {
  if (process.env.QUOTE_MOCK === '1') {
    const out = JSON.parse(JSON.stringify(MOCK));
    out.generator = 'mock';
    return out;
  }
  if (process.env.QUOTE_USE_AI === '0') {
    return ruleBasedFallback(landText, 'ai-disabled-fast-mode');
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[quote-generate] ANTHROPIC_API_KEY missing at runtime — falling back to rule-based.');
    return ruleBasedFallback(landText, 'missing-api-key');
  }
  try {
    const out = await claudeEmitQuote({
      system: buildSystem(lang),
      userContent: 'LAND OPERATOR DOCUMENT (any language) — convert to the WeBuy customer itinerary:\n\n' + landText.slice(0, 16000),
    });
    out.generator = 'claude';
    return out;
  } catch (e) {
    console.warn('[quote-generate] Claude call failed — falling back to rule-based:', e.message);
    // NOTE: the rule-based parser only writes Bahasa Indonesia; a zh/en request
    // that falls back is still tagged so the UI shows the review warning.
    return ruleBasedFallback(landText, 'llm-error: ' + (e.message || String(e)));
  }
}

// Strip a content object down to the text fields a translation stores.
function textFieldsOnly(c) {
  return {
    trip: { title: (c.trip || {}).title || '', subtitle: (c.trip || {}).subtitle || '' },
    highlights: c.highlights || [],
    departure_label: c.departure_label || '',
    days: (c.days || []).map(d => ({
      dayNo: d.dayNo, routeTitle: d.routeTitle || '', mealCode: d.mealCode || '', intro: d.intro || '',
      attractions: (d.attractions || []).map(a => ({ name: a.name || '', desc: a.desc || '', imageQuery: a.imageQuery || '' })),
      optional: (d.optional || []).map(o => ({ name: o.name || '', price: o.price || '' })),
      shopping: d.shopping || '', hotel: d.hotel || '', closing: d.closing || '',
    })),
    termasuk: c.termasuk || [],
    tidak: c.tidak || [],
    noted: c.noted || [],
  };
}

// POST {id, lang} — translate an existing quote into `lang`, store it under
// content.translations[lang], and return the merged view. Cached: repeat calls
// for the same language return the stored version without an LLM call.
async function handleTranslate(req, res, supabase, body) {
  const { id } = body;
  const lang = normalizeQuoteLang(body.lang);
  const row = await supabase.from('itinerary_quotes').select('content,status').eq('id', id).single();
  if (row.error || !row.data) return res.status(404).json({ error: 'quote not found' });
  if (!['generated', 'done'].includes(row.data.status)) return res.status(409).json({ error: 'quote not ready: ' + row.data.status });
  const content = row.data.content || {};
  const baseLang = normalizeQuoteLang(content.lang);

  if (lang === baseLang) return res.status(200).json({ id, lang, cached: true });
  if ((content.translations || {})[lang]) return res.status(200).json({ id, lang, cached: true });

  let out;
  try {
    out = await claudeEmitQuote({
      system: buildTranslateSystem(lang),
      userContent: 'SOURCE ITINERARY JSON (' + baseLang + ') — translate per the rules:\n\n' + JSON.stringify(textFieldsOnly(content)).slice(0, 30000),
    });
  } catch (e) {
    console.warn('[quote-generate] translate failed:', e.message);
    return res.status(502).json({ error: 'translate failed: ' + (e.message || String(e)) });
  }

  // Defensive: a translation is only usable if the day grid matches 1:1.
  const baseDays = (content.days || []).length;
  const gotDays = (out.days || []).length;
  if (gotDays !== baseDays) return res.status(502).json({ error: `translate structure mismatch: ${gotDays} days vs ${baseDays}` });

  const L = LANG_DEF[lang];
  const tr = textFieldsOnly(out);
  if (tr.noted && !tr.noted.some(n => L.privateNoteRe.test(n))) tr.noted.push(L.privateNote);
  if (tr.trip.subtitle && !L.subtitleRe.test(tr.trip.subtitle)) tr.trip.subtitle = L.subtitleFix(tr.trip.subtitle);

  content.translations = { ...(content.translations || {}), [lang]: tr };
  const upd = await supabase.from('itinerary_quotes').update({ content }).eq('id', id);
  if (upd.error && !/updated_by/i.test(upd.error.message || '')) {
    return res.status(500).json({ error: 'db: ' + upd.error.message });
  }
  return res.status(200).json({ id, lang, cached: false });
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

    // Translate mode: {id, lang} on an existing quote (no srcPath).
    if (body.id && !body.srcPath) return handleTranslate(req, res, supabase, body);

    const srcPath = body.srcPath;
    const pastedText = typeof body.text === 'string' ? body.text : '';
    const lang = /^(id|en|zh|zh-en)$/.test(body.lang) ? body.lang : normalizeQuoteLang(body.lang);
    const LD = LANG_DEF[lang] || LANG_DEF.zh;
    const extraImagePaths = Array.isArray(body.extraImagePaths) ? body.extraImagePaths.filter(Boolean).slice(0, 24) : [];
    if (!srcPath && !pastedText.trim()) {
      return res.status(400).json({ error: '请提供一个 .docx / .pdf / .txt 文件，或直接粘贴文本（srcPath 或 text 字段二选一）' });
    }

    // Resolve input → landText. Four supported paths:
    //   srcPath ends .docx  → mammoth.extractRawText
    //   srcPath ends .pdf   → pdf-parse
    //   srcPath ends .txt   → UTF-8 raw read
    //   pastedText          → used verbatim (no upload, no extraction)
    // Only .docx files retain `buf` for downstream embedded-image extraction;
    // .pdf / .txt / pasted-text sources have no Word media to pull.
    let landText = '';
    let buf = null;
    let srcKind = pastedText ? 'paste' : '';
    if (srcPath) {
      const ext = String(srcPath).toLowerCase().match(/\.(docx|pdf|txt)$/);
      if (!ext) {
        return res.status(400).json({ error: '不支持的文件类型，仅接受 .docx / .pdf / .txt。如已是 PDF 请直接上传，或把文字粘贴到下方文本框。' });
      }
      const STORAGE_MS = Math.max(5000, Number(process.env.QUOTE_STORAGE_TIMEOUT_MS || 20000));
      let dl, ab;
      try {
        dl = await withTimeout(supabase.storage.from('quote-src').download(srcPath), STORAGE_MS, 'Supabase Storage download');
        if (dl.error || !dl.data) return res.status(400).json({ error: '无法读取上传的文件：' + (dl.error && dl.error.message) });
        ab = await withTimeout(dl.data.arrayBuffer(), STORAGE_MS, 'reading file bytes');
      } catch (e) {
        // Storage/DB unreachable (e.g. Supabase connection timeout) — fail fast
        // with a clear, actionable message rather than hanging until maxDuration.
        return res.status(504).json({ error: '存储连接超时：无法从 Supabase 取回上传的文件（' + (e.message || e) + '）。请稍后重试，或改用下方「直接粘贴行程文字」绕过文件上传。' });
      }
      buf = Buffer.from(ab);
      srcKind = ext[1];
      try {
        if (srcKind === 'docx') {
          const r = await mammoth.extractRawText({ buffer: buf });
          landText = r.value || '';
        } else if (srcKind === 'pdf') {
          // Lazy-load: pdf-parse pulls a bunch of test fixtures at import-time
          // unless we require it deep inside its lib path. This guard keeps
          // cold-start fast for .docx (the common case) and only pays the
          // pdf-parse cost when a PDF is actually uploaded.
          const pdfParse = require('pdf-parse/lib/pdf-parse.js');
          const r = await pdfParse(buf);
          landText = r.text || '';
        } else if (srcKind === 'txt') {
          landText = buf.toString('utf8');
        }
      } catch (e) {
        return res.status(400).json({ error: `解析 ${srcKind.toUpperCase()} 文件失败：${(e && e.message) || e}。请检查文件是否有效，或换成另一种格式重试。` });
      }
    } else {
      landText = pastedText;
    }
    if (!landText || landText.trim().length < 40) {
      return res.status(400).json({ error: '文档内容太短（少于 40 字符）或没有提取到文字。请检查 PDF 是否是扫描件（需要 OCR），或粘贴文字到下方文本框。' });
    }

    // one LLM call -> structured content (callClaude never throws; on failure
    // it returns a rule-based fallback tagged with generator='rule-based' so
    // the front-end can show a warning banner. We never want a hard 5xx here
    // — the OPS team can still review the rule-based draft).
    const content = await callClaude(landText, lang);
    content.lang = content.generator === 'rule-based' ? 'id' : lang;  // fallback parser writes Bahasa only
    content.translations = {};
    content.price_label = (LANG_DEF[lang] || LANG_DEF.id).currency || '«Rp ____________»';
    if (!content.noted || !content.noted.length) content.noted = MOCK.noted;
    // enforce the private-tour-only note in the output language
    if (!content.noted.some(n => LD.privateNoteRe.test(n))) content.noted.push(LD.privateNote);

    // post-process: enforce highlights exist
    if (!content.highlights || !content.highlights.length) {
      const names = (content.days || []).flatMap(d => (d.attractions || []).map(a => a.name.replace(/[【】]/g, '')));
      content.highlights = names.slice(0, 5).map(n => LD.highlightPrefix(n));
    }

    // post-process: enforce hotel on every overnight day
    const totalDays = (content.days || []).length;
    for (const d of content.days || []) {
      if (!d.hotel && d.dayNo < totalDays) d.hotel = LD.hotelDefault;
      // ensure imageQuery is never missing
      for (const a of d.attractions || []) {
        if (!a.imageQuery) a.imageQuery = a.name.replace(/[【】]/g, '') + ' travel landmark';
      }
    }

    // post-process: enforce the per-language title format
    if (content.trip && totalDays > 0 && !LD.titleRe.test(content.trip.title || '')) {
      content.trip.title = LD.titleFmt(totalDays, content.trip.title || '');
    }
    // enforce the per-language subtitle keyword (Perjalanan / 之旅 / Journey)
    if (content.trip && content.trip.subtitle && !LD.subtitleRe.test(content.trip.subtitle)) {
      content.trip.subtitle = LD.subtitleFix(content.trip.subtitle);
    }

    convertOptionalPrices(content);                  // RMB -> IDR on optional items
    content.sourceImages = [];
    content.imagePolicy = 'supplier-first';
    content.imageSearches = makeImageSearches(content);
    content.quality = auditQuoteContent(content);
    if (!content.generator) content.generator = 'unknown';

    if (!Array.isArray(content.days) || !content.days.length) {
      return res.status(422).json({
        error: '行程解析失败：没有识别到任何 DAY。请确认文档内有 D1 / DAY 1 / 第1天 等日期标题。支持 .docx / .pdf / .txt 或直接粘贴文字。',
        generator: content.generator,
        quality: content.quality,
        debug: { textLen: landText.length, textPreview: landText.slice(0, 200), fallbackReason: content.fallbackReason || null },
      });
    }

    // status stays 'generated' regardless for non-fatal quality warnings;
    // quality flag inside content tells the front-end whether to surface a
    // warning banner. Fatal no-day parses are blocked above so we never export
    // an empty/wrong template.
    const ins = await supabase.from('itinerary_quotes').insert({
      created_by: user.id, source_path: srcPath || null, status: 'generated', content,
    }).select('id').single();
    if (ins.error) return res.status(500).json({ error: 'db: ' + ins.error.message });

    let sourceImages = [];
    try {
      // Supplier Word files often contain large or unrelated embedded images.
      // Keep generation fast; only extract DOCX media when explicitly enabled.
      // (.pdf / .txt / pasted text have no embedded Word media to mine.)
      if (process.env.QUOTE_EXTRACT_DOCX_IMAGES === '1' && srcKind === 'docx' && buf) {
        sourceImages = sourceImages.concat(await extractDocxImages(buf));
      }
      for (const p of extraImagePaths) {
        const img = await downloadStorageImage(supabase, p);
        if (img) sourceImages.push(img);
      }
      if (sourceImages.length) {
        content.sourceImages = await uploadQuoteSourceImages(supabase, ins.data.id, sourceImages);
        await supabase.from('itinerary_quotes').update({ content }).eq('id', ins.data.id);
      }
    } catch (imgErr) {
      content.imageWarning = 'Supplier images could not be extracted: ' + String(imgErr.message || imgErr);
      await supabase.from('itinerary_quotes').update({ content }).eq('id', ins.data.id);
    }

    return res.status(200).json({
      id: ins.data.id,
      lang: content.lang,
      sourceImageCount: content.sourceImages.length,
      imageSearches: content.imageSearches || [],
      generator: content.generator,
      quality: content.quality,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
