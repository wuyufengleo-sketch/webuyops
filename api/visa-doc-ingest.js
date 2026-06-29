// ============================================================================
//  POST /api/visa-doc-ingest — Phase 3 of the customer self-upload visa-docs
//  project (see docs/visa-doc-collection-project.md). Smart Travel Card (STC)
//  calls this every time a customer uploads a document on their
//  /card/{token}/documents page, so the file ends up in this OPS's
//  visa_documents table exactly like a CS-uploaded one — the existing Visa
//  page / CS checklist / Ticketing badge need zero changes to read it.
//
//  Why copy bytes instead of storing STC's Blob URL: the Visa page's preview
//  generates a signed Supabase Storage URL from `storage_path` (see app.html
//  _visaStoragePath / previewVisaDoc). Keeping that single code path means OPS
//  isn't dependent on STC's Blob URL staying reachable, and review/export
//  flows work unchanged. `external_url` is kept alongside for audit only.
//
//  Linking: STC only knows its own traveller_id/tour_id. stc_traveller_links
//  (populated when OPS pushes a visa requirement to STC — Phase 2) maps that
//  back to this OPS's manifest_id / tour_code / bkg_no / pax_name. If no link
//  exists yet, this is a no-op ack (best-effort sync; never blocks the
//  customer's STC upload).
//
//  Auth: x-ops-stc-secret header, shared with STC's OPS_STC_SECRET env.
// ============================================================================

const { createClient } = require('@supabase/supabase-js');

function safePathPart(s) {
  return String(s || 'unknown').replace(/[^a-zA-Z0-9_.\- ]/g, '_').trim().replace(/\s+/g, '_');
}

function storagePathFor(tourCode, paxName, docKey, fileName) {
  const ext = String(fileName || '').split('.').pop() || 'bin';
  return `visa-docs/${safePathPart(tourCode)}/${safePathPart(paxName)}/${safePathPart(docKey)}_${Date.now()}.${safePathPart(ext)}`;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPS_STC_SECRET } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'supabase_env_missing' });
  }
  if (!OPS_STC_SECRET || req.headers['x-ops-stc-secret'] !== OPS_STC_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { stcTravellerId, stcTourId, docKey, docLabel, fileUrl, fileName } = req.body || {};
  if (!stcTravellerId || !docKey || !fileUrl) {
    return res.status(400).json({ error: 'invalid_body', detail: 'stcTravellerId, docKey, fileUrl are required' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const { data: link, error: linkErr } = await supabase
      .from('stc_traveller_links')
      .select('manifest_id, tour_code, bkg_no, pax_name')
      .eq('stc_traveller_id', stcTravellerId)
      .maybeSingle();
    if (linkErr) throw new Error('stc_traveller_links read: ' + linkErr.message);
    if (!link) {
      return res.status(200).json({ ok: true, linked: false, note: 'no stc_traveller_links row for this traveller yet' });
    }

    const fileRes = await fetch(fileUrl);
    if (!fileRes.ok) throw new Error('fetch fileUrl failed: HTTP ' + fileRes.status);
    const contentType = fileRes.headers.get('content-type') || 'application/octet-stream';
    const bytes = Buffer.from(await fileRes.arrayBuffer());

    const path = storagePathFor(link.tour_code, link.pax_name, docKey, fileName);
    const { error: upErr } = await supabase.storage.from('tour-photos').upload(path, bytes, {
      contentType, upsert: true,
    });
    if (upErr) throw new Error('storage upload: ' + upErr.message);

    const row = {
      manifest_id: link.manifest_id,
      tour_code: link.tour_code,
      bkg_no: link.bkg_no,
      pax_name: link.pax_name,
      doc_type: docKey,
      storage_path: path,
      file_name: fileName || docLabel || docKey,
      file_size: bytes.length,
      mime_type: contentType,
      review_status: 'pending',
      source: 'customer',
      external_url: fileUrl,
    };
    const { data: ins, error: insErr } = await supabase.from('visa_documents').insert([row]).select('id');
    if (insErr) throw new Error('visa_documents insert: ' + insErr.message);

    return res.status(200).json({ ok: true, linked: true, visaDocumentId: ins && ins[0] && ins[0].id });
  } catch (e) {
    return res.status(500).json({ error: 'ingest_failed', detail: (e && e.message) || String(e) });
  }
};
