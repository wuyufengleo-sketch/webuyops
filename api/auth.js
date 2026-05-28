// ============================================================================
//  DEPRECATED — login now goes directly to Supabase Auth from the browser.
//  This endpoint stays only to give a clear error to any client still loading
//  the old cached index.html. Safe to delete once all browsers refresh.
// ============================================================================

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(410).json({
    error: 'This login endpoint has been retired. Please hard-refresh the page (Cmd/Ctrl+Shift+R) and sign in again.',
  });
};
