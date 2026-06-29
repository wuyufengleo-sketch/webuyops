// ============================================================================
//  POST /api/stc-provision — Phase 2 of the customer self-upload visa-docs
//  project (see docs/visa-doc-collection-project.md). Called from the
//  confirmpay page right after CS confirms a paid order. Resolves the real
//  pax list, asks Smart Travel Card (STC) to provision (or reuse) a card for
//  each one, records the OPS<->STC identity link, and returns each
//  traveller's upload link for CS to drop into the customer's WhatsApp group.
//
//  Why this is a server endpoint and not a direct browser->STC call: it needs
//  OPS_STC_SECRET, which must never reach the browser bundle.
//
//  Auth: logged-in Supabase user (same bearer-token pattern as api/sb-write).
// ============================================================================

const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPS_STC_SECRET, STC_BASE_URL } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'supabase_env_missing' });
  }
  if (!OPS_STC_SECRET) {
    return res.status(500).json({ error: 'ops_stc_secret_missing' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const auth = req.headers['authorization'] || '';
  const jwt = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!jwt) return res.status(401).json({ error: 'missing_bearer_token' });
  const { data: userData, error: userErr } = await supabase.auth.getUser(jwt);
  if (userErr || !userData || !userData.user) return res.status(401).json({ error: 'invalid_token' });

  const { confirmationId } = req.body || {};
  if (!confirmationId) return res.status(400).json({ error: 'invalid_body', detail: 'confirmationId required' });

  try {
    const { data: row, error: rowErr } = await supabase
      .from('payment_confirmations').select('*').eq('id', confirmationId).maybeSingle();
    if (rowErr) throw new Error('payment_confirmations read: ' + rowErr.message);
    if (!row) return res.status(404).json({ error: 'confirmation_not_found' });
    if (!row.tour_code) return res.status(400).json({ error: 'missing_tour_code', detail: 'CS must fill in tour code before provisioning' });

    const bkUpper = String(row.bkg_no || '').toUpperCase();
    let pax = [];
    let paxAreReal = false;
    if (bkUpper) {
      const { data: mft, error: mftErr } = await supabase
        .from('manifest_passengers').select('id, name').eq('bk', bkUpper);
      if (mftErr) throw new Error('manifest_passengers read: ' + mftErr.message);
      if (mft && mft.length) {
        pax = mft.map((m) => ({ externalRef: String(m.id), fullName: m.name || `Pax ${m.id}` }));
        paxAreReal = true;
      }
    }
    if (!pax.length) {
      // Manifest not populated yet — provision placeholder slots from pax_count
      // so CS still gets links to send; these get reconciled once Manifest data
      // lands (same externalRef convention, so a later real call won't duplicate).
      const n = Math.max(1, Number(row.pax_count) || 1);
      pax = Array.from({ length: n }, (_, i) => ({
        externalRef: `${bkUpper || row.id}-${i + 1}`,
        fullName: `Pax ${i + 1}`,
      }));
    }

    const stcBase = (STC_BASE_URL || 'https://smart-travel-card-id-h5-mu.vercel.app').replace(/\/$/, '');
    const stcRes = await fetch(`${stcBase}/api/admin/provision-doc-travellers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ops-stc-secret': OPS_STC_SECRET },
      body: JSON.stringify({
        tourCode: row.tour_code,
        destination: row.destination || undefined,
        departureDate: row.departure_date || undefined,
        paxCount: row.pax_count || pax.length,
        visaType: row.visa_type || undefined,
        visaCountry: row.visa_country || undefined,
        requiredDocs: row.doc_checklist || [],
        opsConfirmationId: String(row.id),
        pax,
      }),
    });
    const stcBody = await stcRes.json().catch(() => ({}));
    if (!stcRes.ok || !stcBody.ok) {
      throw new Error('STC provision failed: HTTP ' + stcRes.status + ' ' + JSON.stringify(stcBody));
    }

    const byRef = new Map(pax.map((p) => [p.externalRef, p.fullName]));
    const linkRows = (stcBody.links || [])
      .filter((l) => l.travellerId && l.url)
      .map((l) => ({
        manifest_id: paxAreReal ? parseInt(l.externalRef, 10) : null,
        tour_code: row.tour_code,
        bkg_no: row.bkg_no || null,
        pax_name: byRef.get(l.externalRef) || null,
        stc_tour_id: stcBody.tourId,
        stc_traveller_id: l.travellerId,
      }));
    if (linkRows.length) {
      const { error: linkErr } = await supabase
        .from('stc_traveller_links').upsert(linkRows, { onConflict: 'stc_traveller_id' });
      if (linkErr) throw new Error('stc_traveller_links upsert: ' + linkErr.message);
    }

    const links = (stcBody.links || []).map((l) => ({
      paxName: byRef.get(l.externalRef) || l.externalRef,
      url: l.url,
      error: l.error,
    }));
    return res.status(200).json({ ok: true, paxAreReal, links });
  } catch (e) {
    return res.status(500).json({ error: 'provision_failed', detail: (e && e.message) || String(e) });
  }
};
