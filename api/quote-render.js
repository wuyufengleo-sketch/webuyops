// ============================================================================
//  POST /api/quote-render  — step 2 of the Itinerary Quote pipeline.
//
//  Body: { id }   (id of an itinerary_quotes row produced by quote-generate)
//
//  Sources photos (Pexels, center-cropped 3:2), builds the WeBuy-branded .docx
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

    // ---- pick image queries (rule: no attractions -> no photo; <=2/day; global dedupe) ----
    const wanted = [];                       // { day, name, query }
    for (const d of content.days || []) {
      d.imageNames = [];
      if (!d.attractions || !d.attractions.length) continue;
      for (const a of d.attractions.slice(0, MAX_PER_DAY)) {
        wanted.push({ d, name: a.name, query: a.imageQuery || a.name.replace(/[【】]/g, '') + ' travel' });
      }
    }
    if (!process.env.PEXELS_API_KEY) console.warn('[quote-render] PEXELS_API_KEY not set — images will be skipped');
    // resolve Pexels URLs in parallel
    const urls = await Promise.all(wanted.map(w => pexelsImageUrl(w.query)));
    const imagesUrl = {};                    // name -> url (for preview JSON)
    const usedUrls = new Set();
    let imgHits = 0;
    wanted.forEach((w, i) => {
      const u = urls[i];
      if (u && !usedUrls.has(u)) { usedUrls.add(u); imagesUrl[w.name] = u; w.d.imageNames.push(w.name); imgHits++; }
    });
    console.log(`[quote-render] images: ${imgHits}/${wanted.length} resolved`);
    content.images = imagesUrl;

    // download bytes for the docx (parallel)
    const names = Object.keys(imagesUrl);
    const bufs = await Promise.all(names.map(n => fetchBuffer(imagesUrl[n]).catch(() => null)));
    const imagesBuf = {};
    names.forEach((n, i) => { if (bufs[i]) imagesBuf[n] = { data: bufs[i], ext: 'jpg' }; });
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
    if (upd.error) return res.status(500).json({ error: 'db: ' + upd.error.message });

    return res.status(200).json({ id, docxUrl, previewUrl: `/q?id=${id}` });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
