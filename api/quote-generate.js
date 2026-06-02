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
const { getServiceClient, requireUser, convertOptionalPrices, cors } = require('./_quote-lib');

const SYSTEM = `You convert a tour land-operator's confirmation/quotation document into a customer-facing itinerary for "WEBUY Tour & Travel", written in BAHASA INDONESIA for Indonesian travelers.

Rules:
- OUTPUT LANGUAGE: Bahasa Indonesia. No Chinese characters in descriptions (proper-noun show names may keep their Chinese in parentheses).
- Tone: warm, inviting, concise marketing copy.
- Attraction names: keep as romanized English wrapped in fullwidth brackets, e.g. 【Jiuzhaigou Valley】. Give ONE short enticing Bahasa sentence per attraction. Also give an English "imageQuery" per attraction (a concise stock-photo search phrase, e.g. "Jiuzhaigou Valley turquoise lake autumn").
- Each day: dayNo, routeTitle (e.g. "CHENGDU - JIUZHAIGOU"), mealCode (combine included meals: breakfast=B, lunch=L, dinner=D, e.g. "B/L/D"; "" if none), a 1-2 sentence Bahasa intro, attractions[], optional[] (推荐自费/self-pay activities — KEEP the original price string with its "RMB" so it can be converted later, e.g. {name, price:"RMB 350/orang"}), shopping (short Bahasa label of any shopping stop, else ""), hotel (the day's reference hotel, "" on departure day), closing (Bahasa closing line, may be "").
- A pure arrival/departure/transit day with no sightseeing MUST have an EMPTY attractions array (the renderer shows no photo for those days).
- departure_label: the departure date if present in the document (e.g. "13 OKT 2027"), else "«TANGGAL»".
- termasuk[] (HARGA PAKET TERMASUK) in Bahasa: combine the land inclusions (hotel star, meals count, transport incl. trains, listed first-entry tickets, English-speaking guide, etc.) with WeBuy's standard package additions: international economy flight ex-origin city, baggage per airline, group visa, travel insurance, tipping, PPN 1,1%.
- tidak[] (HARGA PAKET TIDAK TERMASUK) in Bahasa: optional/self-pay tours, personal expenses (phone, minibar, laundry), excess baggage, single-room supplement, anything not listed.
- noted[]: standard WeBuy notes (price validity, based on X pax, incentive/private only, schedule may change, price not binding, no booking yet).
- IMPORTANT: NEVER include the land operator's INTERNAL notes (settlement price, markup, "tell customers to cooperate with shopping/add-ons", agency contact). Strip them.
- Do NOT invent a customer price. Leave pricing to a placeholder.

Return ONLY via the emit_quote tool.`;

const SCHEMA = {
  type: 'object',
  properties: {
    trip: { type: 'object', properties: { title: { type: 'string' }, subtitle: { type: 'string' } }, required: ['title', 'subtitle'] },
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
  required: ['trip', 'departure_label', 'days', 'termasuk', 'tidak'],
};

const MOCK = {
  trip: { title: '【Pesona Demo】Kota A ・ Kota B', subtitle: 'Perjalanan Mendalam 3 Hari 2 Malam' },
  departure_label: '«TANGGAL»',
  days: [
    { dayNo: 1, routeTitle: 'JAKARTA - KOTA A', mealCode: 'D', intro: 'Selamat datang! Tiba di Kota A dan memulai petualangan.', attractions: [{ name: '【Old Town】', desc: 'Kawasan kota tua yang menawan.', imageQuery: 'Chinese old town street lanterns' }], optional: [{ name: 'Night Show (千古情)', price: 'RMB 350/orang' }], shopping: '', hotel: 'Hotel A (4★) or similar', closing: 'Istirahat di hotel.' },
    { dayNo: 2, routeTitle: 'KOTA A - KOTA B', mealCode: 'B/L/D', intro: 'Menuju Kota B menikmati alam.', attractions: [{ name: '【Green Lake】', desc: 'Danau hijau yang tenang.', imageQuery: 'turquoise alpine lake china' }], optional: [], shopping: 'teh', hotel: 'Hotel B (4★) or similar', closing: '' },
    { dayNo: 3, routeTitle: 'KOTA B - JAKARTA', mealCode: 'B', intro: 'Diantar ke bandara sesuai jadwal penerbangan.', attractions: [], optional: [], shopping: '', hotel: '', closing: 'Sampai jumpa!' },
  ],
  termasuk: ['Tiket penerbangan internasional kelas ekonomi dari Jakarta', 'Visa Group', 'Travel Insurance', 'Tipping', 'PPN 1,1%', 'Hotel bintang 4', 'Makan sesuai program', 'Pemandu berbahasa Inggris'],
  tidak: ['Acara pilihan / optional tour', 'Pengeluaran pribadi (telepon, minibar, laundry)', 'Selisih kamar single'],
  noted: ['Harga berlaku untuk 3 hari sejak dikeluarkan', 'Harga based on 15+1 Pax', 'Harga diatas berlaku hanya untuk incentive / private tour', 'Susunan acara dapat berubah sesuai keadaan & konfirmasi hotel', 'Harga tidak mengikat dan dapat berubah sewaktu-waktu.', 'Belum ada proses booking sampai saat ini'],
};

async function callClaude(landText) {
  if (process.env.QUOTE_MOCK === '1') return JSON.parse(JSON.stringify(MOCK));
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set (or set QUOTE_MOCK=1 to smoke-test)');
  const body = {
    model: process.env.QUOTE_MODEL || 'claude-sonnet-4-6',
    max_tokens: 8000,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    tools: [{ name: 'emit_quote', description: 'Return the structured WeBuy customer itinerary.', input_schema: SCHEMA }],
    tool_choice: { type: 'tool', name: 'emit_quote' },
    messages: [{ role: 'user', content: 'LAND OPERATOR DOCUMENT (any language) — convert to the WeBuy customer itinerary:\n\n' + landText.slice(0, 24000) }],
  };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('Claude HTTP ' + r.status + ': ' + (await r.text()).slice(0, 400));
  const j = await r.json();
  const tu = (j.content || []).find(c => c.type === 'tool_use');
  if (!tu) throw new Error('Claude returned no tool_use');
  return tu.input;
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
    if (!srcPath) return res.status(400).json({ error: 'srcPath required' });

    // download the uploaded .docx from Storage and extract text
    const dl = await supabase.storage.from('quote-src').download(srcPath);
    if (dl.error || !dl.data) return res.status(400).json({ error: 'cannot read src: ' + (dl.error && dl.error.message) });
    const buf = Buffer.from(await dl.data.arrayBuffer());
    const { value: landText } = await mammoth.extractRawText({ buffer: buf });
    if (!landText || landText.trim().length < 40) return res.status(400).json({ error: 'document text too short / not a .docx' });

    // one LLM call -> structured content
    const content = await callClaude(landText);
    content.price_label = '«Rp ____________»';
    if (!content.noted || !content.noted.length) content.noted = MOCK.noted;
    convertOptionalPrices(content);                  // RMB -> IDR on optional items

    const ins = await supabase.from('itinerary_quotes').insert({
      created_by: user.id, source_path: srcPath, status: 'generated', content,
    }).select('id').single();
    if (ins.error) return res.status(500).json({ error: 'db: ' + ins.error.message });

    return res.status(200).json({ id: ins.data.id });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
