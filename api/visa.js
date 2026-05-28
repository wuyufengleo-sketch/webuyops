// ============================================================================
//  DEPRECATED — Visa data now lives in the Supabase `visa_tours` table and is
//  read directly by the browser. This proxy is no longer used. Kept as a 410
//  stub so any stale client gets a clear signal to hard-refresh.
// ============================================================================

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(410).json({
    error: 'The visa proxy has been retired. Visa data is now served from Supabase. Hard-refresh the page.',
  });
};
