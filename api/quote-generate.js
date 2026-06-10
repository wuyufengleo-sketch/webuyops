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
const { getServiceClient, requireUser, convertOptionalPrices, cors } = require('./_quote-lib');
const { parseRuleBasedQuote, makeImageSearches, auditQuoteContent } = require('./_quote-parser');

const SYSTEM = `You convert a tour land-operator's confirmation/quotation document into a customer-facing itinerary for "WEBUY Tour & Travel", written in BAHASA INDONESIA for Indonesian travelers.

Rules:
- OUTPUT LANGUAGE: Bahasa Indonesia. No Chinese characters in descriptions (proper-noun show names may keep their Chinese in parentheses).
- Tone: warm, inviting, concise marketing copy.

═══ TRIP TITLE (MANDATORY) ═══
- trip.title: MUST follow EXACTLY: "{N} Hari {N-1} Malam [Main Cities]"
  N = total days. Cities = main destinations visited (NOT the origin city). Use "・" between cities.
  Examples: "5 Hari 4 Malam Chengdu・Jiuzhaigou", "8 Hari 7 Malam Kunming・Dali・Lijiang"
- trip.subtitle: MUST contain the word "Perjalanan" (之旅). Format: "Perjalanan [Theme]".
  Examples: "Perjalanan Budaya & Alam Tiongkok", "Perjalanan Alam Jiuzhaigou", "Perjalanan Dataran Tinggi Yunnan"

═══ HIGHLIGHTS (MANDATORY — generate 4-6 items, NEVER skip) ═══
- highlights[]: Each highlight MUST reference a SPECIFIC real attraction or experience from the itinerary.
  Write one exciting Bahasa sentence (max 20 words) per item.
  GOOD: "Menjelajahi keindahan air toska Jiuzhaigou Valley", "Menonton pertunjukan Face-changing Sichuan yang legendaris", "Berfoto di puncak Jade Dragon Snow Mountain yang megah"
  BAD (too generic, REJECTED): "Menikmati pemandangan alam yang indah", "Wisata budaya yang menarik"

═══ EACH DAY ═══
- dayNo, routeTitle (e.g. "CHENGDU - JIUZHAIGOU")

- mealCode: Extract ONLY from the source document. Mapping:
  早餐/早/sarapan → B, 午餐/中餐/中/makan siang → L, 晚餐/晚/makan malam → D
  Combine: "B/L/D", "B/D", "B/L", "B", "L/D", "D", etc.
  If the source does NOT mention meals for this day → use "" (empty string).
  NEVER invent or assume meals not explicitly stated in the source.

- intro: 1–2 sentence Bahasa intro for the day.

- attractions[]:
  * name: romanized English in fullwidth brackets, e.g. 【Jiuzhaigou Valley】
  * desc: Apply TWO strategies based on source detail level:
    STRATEGY A — SOURCE HAS DETAILED DESCRIPTION (multiple sentences / paragraphs):
      Translate faithfully into Bahasa Indonesia. Preserve ALL detail and information. Do NOT shorten or summarize.
    STRATEGY B — SOURCE ONLY BRIEFLY MENTIONS the attraction (just a name or one short line):
      ENHANCE: write 2–3 enticing Bahasa sentences in tourism style — describe what visitors see/experience and why it is special.
  * imageQuery: *** MANDATORY for EVERY attraction, NEVER leave empty ***
    Write a concise English photo search phrase: [attraction name] + [visual keywords].
    Examples: "Jiuzhaigou Valley turquoise lake autumn", "Chengdu giant panda eating bamboo", "Lijiang Old Town night lanterns canal reflection", "Great Wall of China Mutianyu section"

- optional[]: self-pay activities — KEEP original price with "RMB", e.g. {name, price:"RMB 350/orang"}
- shopping: short Bahasa label of any shopping stop, else ""

- hotel: *** MANDATORY for every night with an overnight stay ***
  * Source states hotel name → use it exactly.
  * Source states only star rating → "Hotel bintang X (atau setara)".
  * Source says 酒店/住宿 without detail → "Hotel (sesuai program)".
  * Source mentions nothing about hotel but the day has an overnight → "Hotel bintang 4 (atau setara)".
  * ONLY "" on the very last departure day with NO overnight stay.

- closing: Bahasa closing line, may be "".

═══ OTHER RULES ═══
- A pure arrival/departure/transit day with no sightseeing MUST have an EMPTY attractions array (no photos rendered for those days).
- departure_label: the departure date if present (e.g. "13 OKT 2027"), else "«TANGGAL»".
- termasuk[] (HARGA PAKET TERMASUK) in Bahasa: combine land inclusions (hotel star, meals, transport incl. trains, entry tickets, guide) with WeBuy standard additions: international economy flight ex-origin city, baggage per airline, group visa, travel insurance, tipping, PPN 1,1%.
- tidak[] (HARGA PAKET TIDAK TERMASUK) in Bahasa: optional tours, personal expenses (phone, minibar, laundry), excess baggage, single-room supplement, anything not listed.
- noted[]: standard WeBuy notes (price validity, based on X pax, incentive/private only, schedule may change, price not binding, no booking yet).
- IMPORTANT: NEVER include the land operator's INTERNAL notes (cost price, markup, "tell customers to cooperate with shopping/add-ons", agency contacts). Strip them completely.
- Do NOT invent a customer price. Leave pricing to a placeholder.

Return ONLY via the emit_quote tool.`;

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

async function callClaude(landText) {
  if (process.env.QUOTE_MOCK === '1') {
    const out = JSON.parse(JSON.stringify(MOCK));
    out.generator = 'mock';
    return out;
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (process.env.QUOTE_USE_AI === '0') {
    return ruleBasedFallback(landText, 'ai-disabled-fast-mode');
  }
  if (!key) {
    console.warn('[quote-generate] ANTHROPIC_API_KEY missing at runtime — falling back to rule-based.');
    return ruleBasedFallback(landText, 'missing-api-key');
  }
  let timer = null;
  try {
    const controller = new AbortController();
    const timeoutMs = Math.max(3000, Number(process.env.QUOTE_AI_TIMEOUT_MS || 45000));
    timer = setTimeout(() => controller.abort(), timeoutMs);
    const body = {
      model: process.env.QUOTE_MODEL || 'claude-sonnet-4-6',
      max_tokens: 5000,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: [{ name: 'emit_quote', description: 'Return the structured WeBuy customer itinerary.', input_schema: SCHEMA }],
      tool_choice: { type: 'tool', name: 'emit_quote' },
      messages: [{ role: 'user', content: 'LAND OPERATOR DOCUMENT (any language) — convert to the WeBuy customer itinerary:\n\n' + landText.slice(0, 16000) }],
    };
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error('Claude HTTP ' + r.status + ': ' + (await r.text()).slice(0, 400));
    const j = await r.json();
    const tu = (j.content || []).find(c => c.type === 'tool_use');
    if (!tu) throw new Error('Claude returned no tool_use');
    const out = tu.input || {};
    out.generator = 'claude';
    return out;
  } catch (e) {
    console.warn('[quote-generate] Claude call failed — falling back to rule-based:', e.message);
    return ruleBasedFallback(landText, 'llm-error: ' + (e.message || String(e)));
  } finally {
    if (timer) clearTimeout(timer);
  }
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
    const srcPath = body.srcPath;
    const extraImagePaths = Array.isArray(body.extraImagePaths) ? body.extraImagePaths.filter(Boolean).slice(0, 24) : [];
    if (!srcPath) return res.status(400).json({ error: 'srcPath required' });

    // download the uploaded .docx from Storage and extract text
    const dl = await supabase.storage.from('quote-src').download(srcPath);
    if (dl.error || !dl.data) return res.status(400).json({ error: 'cannot read src: ' + (dl.error && dl.error.message) });
    const buf = Buffer.from(await dl.data.arrayBuffer());
    const { value: landText } = await mammoth.extractRawText({ buffer: buf });
    if (!landText || landText.trim().length < 40) return res.status(400).json({ error: 'document text too short / not a .docx' });

    // one LLM call -> structured content (callClaude never throws; on failure
    // it returns a rule-based fallback tagged with generator='rule-based' so
    // the front-end can show a warning banner. We never want a hard 5xx here
    // — the OPS team can still review the rule-based draft).
    const content = await callClaude(landText);
    content.price_label = '«Rp ____________»';
    if (!content.noted || !content.noted.length) content.noted = MOCK.noted;

    // post-process: enforce highlights exist
    if (!content.highlights || !content.highlights.length) {
      const names = (content.days || []).flatMap(d => (d.attractions || []).map(a => a.name.replace(/[【】]/g, '')));
      content.highlights = names.slice(0, 5).map(n => `Menjelajahi keindahan ${n}`);
    }

    // post-process: enforce hotel on every overnight day
    const totalDays = (content.days || []).length;
    for (const d of content.days || []) {
      if (!d.hotel && d.dayNo < totalDays) d.hotel = 'Hotel bintang 4 (atau setara)';
      // ensure imageQuery is never missing
      for (const a of d.attractions || []) {
        if (!a.imageQuery) a.imageQuery = a.name.replace(/[【】]/g, '') + ' travel landmark';
      }
    }

    // post-process: enforce title format "{N} Hari {N-1} Malam ..."
    if (content.trip && totalDays > 0 && !/\d+\s*Hari\s+\d+\s*Malam/i.test(content.trip.title || '')) {
      const cities = content.trip.title || '';
      content.trip.title = `${totalDays} Hari ${totalDays - 1} Malam ${cities}`.trim();
    }
    // enforce subtitle contains "Perjalanan"
    if (content.trip && content.trip.subtitle && !/perjalanan/i.test(content.trip.subtitle)) {
      content.trip.subtitle = 'Perjalanan ' + content.trip.subtitle;
    }

    convertOptionalPrices(content);                  // RMB -> IDR on optional items
    content.sourceImages = [];
    content.imagePolicy = 'supplier-first';
    content.imageSearches = makeImageSearches(content);
    content.quality = auditQuoteContent(content);
    if (!content.generator) content.generator = 'unknown';

    if (!Array.isArray(content.days) || !content.days.length) {
      return res.status(422).json({
        error: '行程解析失败：没有识别到任何 DAY。请确认 Word 内有 D1 / DAY 1 / 第1天 / 日期行程标题，或换成 .docx 后重试。',
        generator: content.generator,
        quality: content.quality,
      });
    }

    // status stays 'generated' regardless for non-fatal quality warnings;
    // quality flag inside content tells the front-end whether to surface a
    // warning banner. Fatal no-day parses are blocked above so we never export
    // an empty/wrong template.
    const ins = await supabase.from('itinerary_quotes').insert({
      created_by: user.id, source_path: srcPath, status: 'generated', content,
    }).select('id').single();
    if (ins.error) return res.status(500).json({ error: 'db: ' + ins.error.message });

    let sourceImages = [];
    try {
      // Supplier Word files often contain large or unrelated embedded images.
      // Keep generation fast; only extract DOCX media when explicitly enabled.
      if (process.env.QUOTE_EXTRACT_DOCX_IMAGES === '1') {
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
      sourceImageCount: content.sourceImages.length,
      imageSearches: content.imageSearches || [],
      generator: content.generator,
      quality: content.quality,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
