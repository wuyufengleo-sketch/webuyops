// ============================================================================
//  GET /api/quote-get?id=<uuid>  — PUBLIC read for the customer preview page.
//
//  Returns the stored itinerary JSON (trip, days, images URLs, pricing,
//  inclusions, docxUrl) so quote.html can render it for the customer.
//  No auth: this is the shareable customer-facing link. Only the rendered
//  itinerary is exposed (no internal fields).
// ============================================================================
const { getServiceClient, cors } = require('./_quote-lib');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  try {
    const id = req.query && req.query.id;
    if (!id) return res.status(400).json({ error: 'id required' });
    const supabase = getServiceClient();
    const row = await supabase.from('itinerary_quotes').select('content, status').eq('id', id).single();
    if (row.error || !row.data) return res.status(404).json({ error: 'not found' });
    if (row.data.status !== 'done') return res.status(409).json({ error: 'not ready', status: row.data.status });
    res.setHeader('Cache-Control', 'public, max-age=120');
    return res.status(200).json(row.data.content);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
