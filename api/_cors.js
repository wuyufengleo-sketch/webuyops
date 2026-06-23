// ============================================================================
//  Shared CORS helper for the authenticated API surface.
//
//  Why not a blanket "Access-Control-Allow-Origin: *":
//    The browser sends the user's Supabase access token in the Authorization
//    header (not a cookie), so requests are not "credentialed" in the CORS
//    sense and `*` does not leak cookies. But `*` still lets ANY third-party
//    page read the JSON response if it somehow already holds a valid token.
//    Reflecting an allow-listed Origin instead removes that replay surface for
//    the private endpoints while same-origin app calls are unaffected (the
//    browser never enforces CORS on same-origin requests).
//
//  Public share endpoints (e.g. /api/quote-get) intentionally stay `*` and use
//  their own helper — do NOT route those through here.
// ============================================================================

function isAllowedOrigin(origin) {
  if (!origin) return false;
  // Production alias.
  if (origin === 'https://webuy-ops.vercel.app') return true;
  // This team's Vercel preview deployments: <anything>-webuyops.vercel.app
  if (/^https:\/\/[a-z0-9-]+-webuyops\.vercel\.app$/.test(origin)) return true;
  // Local development.
  if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return true;
  if (/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return true;
  return false;
}

// Set CORS headers on the response. Reflects the request Origin only when it is
// allow-listed; otherwise omits Access-Control-Allow-Origin so a cross-origin
// reader is blocked by the browser. Same-origin callers are never affected.
function applyCors(req, res, { methods = 'GET,POST,OPTIONS' } = {}) {
  const origin = (req.headers && req.headers.origin) || '';
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Cache-Control', 'no-store');
}

// Handle an OPTIONS preflight. Returns true if the request was a preflight and
// a 204 has been sent (caller should return immediately).
function handlePreflight(req, res, opts) {
  applyCors(req, res, opts);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

module.exports = { applyCors, handlePreflight, isAllowedOrigin };
