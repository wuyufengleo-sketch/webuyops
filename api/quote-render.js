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
const { getServiceClient, requireUser, pexelsImageUrl, fetchBuffer, cors } = require('./_quote-lib');

const MAX_PER_DAY = 2;

const CURATED_IMAGES = [
  { re: /HONGYADONG|HONGYA\s*CAVE|洪崖洞|洪亚洞/i, key: 'curated_hongyadong_night', path: '/quote-assets/chongqing/hongyadong-night.jpg', brief: 'night illuminated stilted buildings, riverside, golden lights' },
  { re: /WANGXIAN/i, key: 'curated_wangxian_valley', path: '/quote-assets/jiangnan/wangxian-valley.jpg', brief: 'dusk/night cliff village, lantern bridge, valley panorama' },
  { re: /WUKANG|TIANZIFANG|ANFU|CITY GOD/i, key: 'curated_shanghai_wukang', path: '/quote-assets/jiangnan/shanghai-wukang-road.jpg' },
  { re: /SHANGHAI|LUJIAZUI|ORIENTAL PEARL|BUND|NANJING/i, key: 'curated_shanghai_bund', path: '/quote-assets/jiangnan/shanghai-bund.jpg' },
  { re: /BALAGEZONG|BALA|GEZONG|GLASS|PLANK/i, key: 'curated_balagezong', path: '/quote-assets/yunnan/balagezong.jpg' },
  { re: /TIGER LEAPING|YANGTZE|DUKEZONG|GUISHAN/i, key: 'curated_tiger_leaping_gorge', path: '/quote-assets/yunnan/tiger-leaping-gorge.jpg' },
  { re: /JADE DRAGON|BLUE MOON|GLACIER|GANHAIZI|BAISHUI|IMPRESSION LIJIANG/i, key: 'curated_jade_dragon', path: '/quote-assets/yunnan/jade-dragon-snow-mountain.jpg' },
  { re: /SHAXI|SIDENG|YUJIN|THEATRE/i, key: 'curated_shaxi', path: '/quote-assets/yunnan/shaxi-ancient-town.jpg' },
  { re: /DALI|ERHAI|XIZHOU|S-BAY|SANTORINI|FOREIGNER/i, key: 'curated_dali_erhai', path: '/quote-assets/yunnan/dali-erhai.jpg' },
  { re: /KUNMING|SHILIN|DIANCHI|STONE FOREST|NANPING|JINMA/i, key: 'curated_kunming', path: '/quote-assets/yunnan/kunming-wetland.jpg' },
];

function requestOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || process.env.VERCEL_URL;
  return `${proto}://${host}`;
}

function curatedImageForDay(day) {
  const hay = [
    day.routeTitle,
    ...(day.attractions || []).flatMap(a => [a.name, a.imageQuery]),
  ].filter(Boolean).join(' ');
  return CURATED_IMAGES.find(x => x.re.test(hay));
}

function bestPhotoQuery(raw) {
  const q = String(raw || '').replace(/[【】]/g, '').trim();
  if (!q) return '';
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
  return q;
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

    const row = await supabase.from('itinerary_quotes').select('content').eq('id', id).single();
    if (row.error || !row.data) return res.status(404).json({ error: 'quote not found' });
    const content = row.data.content;

    // ---- pick images (rule: no attractions -> no photo; curated destination
    // views beat supplier/old generated images for known landmarks) ----
    const wanted = [];                       // { day, name, query }
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
    const imagesUrl = {};                    // name -> url (for preview JSON)
    if (wanted.some(w => w.curated)) {
      const origin = requestOrigin(req);
      const usedKeys = new Set();
      for (const w of wanted) {
        if (!w.curated) continue;
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
    if (!Object.keys(imagesUrl).length && process.env.QUOTE_ALLOW_PEXELS_FALLBACK !== '0' && !!process.env.PEXELS_API_KEY) {
      // Pexels stock fallback. ON by default when PEXELS_API_KEY is set; set
      // QUOTE_ALLOW_PEXELS_FALLBACK=0 to disable. We tag the day with
      // imageSource='pexels' so the front-end can show a caption like
      // "ilustrasi" instead of pretending it's the actual venue.
      const urls = await Promise.all(wanted.map(w => pexelsImageUrl(w.query)));
      const usedUrls = new Set();
      wanted.forEach((w, i) => {
        const u = urls[i];
        if (u && !usedUrls.has(u)) {
          usedUrls.add(u);
          imagesUrl[w.name] = u;
          w.d.imageNames.push(w.name);
          w.d.imageSource = 'pexels';
        }
      });
    }
    content.images = imagesUrl;

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

    // ---- build the .docx ----
    const docx = await buildQuoteDocx(content, { logo: LOGO, images: imagesBuf });

    // ---- upload to Storage ----
    const path = `${id}.docx`;
    const up = await supabase.storage.from('quote-out').upload(path, docx, {
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      upsert: true,
    });
    if (up.error) return res.status(500).json({ error: 'upload: ' + up.error.message });
    const { data: pub } = supabase.storage.from('quote-out').getPublicUrl(path);
    const docxUrl = pub.publicUrl;
    content.docxUrl = docxUrl;

    const upd = await supabase.from('itinerary_quotes').update({ status: 'done', docx_url: docxUrl, content }).eq('id', id);
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
