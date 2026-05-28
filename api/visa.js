// api/visa.js — Live Visa Tracker data from Google Apps Script
// Set VISA_SCRIPT_URL in Vercel env vars to the deployed Apps Script web app URL

const FALLBACK_URL = process.env.VISA_SCRIPT_URL || '';

function normStatus(s) {
  if (!s) return 'STILL NOT CLOSE';
  const u = s.toUpperCase().trim();
  if (u.includes('ON DELIVERY') || u.includes('DELIVERY')) return 'DELIVERY';
  if (u === 'DONE' || u.startsWith('DONE')) return 'DONE';
  if (u.includes('PREPARE DONE') || u.includes('PREP DONE')) return 'PREPARE DONE';
  if (u.includes('UNDER REVIEW') || u.includes('REVIEW')) return 'UNDER REVIEW';
  if (u.includes('SUBMITTED') || u.includes('SUBMIT')) return 'SUBMITTED';
  return 'STILL NOT CLOSE';
}

function parseDate(val) {
  if (!val) return '';
  if (typeof val === 'number') {
    // Google Sheets serial date
    const d = new Date((val - 25569) * 86400 * 1000);
    return d.toISOString().slice(0, 10);
  }
  const s = String(val).trim();
  if (!s || s === '0') return '';
  // Try to parse various date formats
  const m = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${y}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  }
  return s;
}

function monthLabel(depStr) {
  if (!depStr) return '';
  const d = new Date(depStr);
  if (isNaN(d)) return '';
  return d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
}

function parseSheetData(rows) {
  // rows is array of arrays from Apps Script
  // Find header row by looking for "TOUR CODE" or "TL" column
  let headerIdx = -1;
  let colMap = {};

  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const row = rows[i].map(c => String(c).toUpperCase().trim());
    const hasTL = row.some(c => c === 'TL' || c === 'TOUR LEADER');
    const hasDep = row.some(c => c.includes('DEP') || c.includes('DATE'));
    if (hasTL && hasDep) {
      headerIdx = i;
      row.forEach((h, idx) => { colMap[h] = idx; });
      break;
    }
  }

  if (headerIdx === -1) {
    // Fallback: assume first row is header
    headerIdx = 0;
    rows[0].forEach((h, idx) => { colMap[String(h).toUpperCase().trim()] = idx; });
  }

  // Column index helpers
  const col = (...names) => {
    for (const n of names) {
      for (const [k, v] of Object.entries(colMap)) {
        if (k === n || k.includes(n)) return v;
      }
    }
    return -1;
  };

  const iDep     = col('DEP DATE', 'DEPARTURE', 'DEP');
  const iTour    = col('TOUR NAME', 'TOUR', 'PACKAGE');
  const iCode    = col('TOUR CODE', 'CODE');
  const iFrom    = col('FROM', 'CITY', 'ORIGIN');
  const iTL      = col('TL', 'TOUR LEADER');
  const iPax     = col('TOTAL PAX', 'PAX', 'TOTAL');
  const iGroup   = col('GROUP', 'GRP');
  const iIndiv   = col('INDIVIDUAL', 'INDIV');
  const iHold    = col('HOLD');
  const iVendor  = col('VENDOR', 'AGENT', 'SUPPLIER');
  const iStatus  = col('STATUS', 'VISA STATUS');
  const iRemark  = col('REMARK', 'NOTE', 'KET');

  const records = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every(c => !c)) continue;

    const depRaw = iDep >= 0 ? row[iDep] : '';
    const depStr = parseDate(depRaw);
    if (!depStr) continue;

    const month = monthLabel(depStr);
    if (!month) continue;

    records.push({
      month,
      dep: depStr,
      tour: iTour >= 0 ? String(row[iTour] || '').trim() : '',
      code: iCode >= 0 ? String(row[iCode] || '').trim() : '',
      from: iFrom >= 0 ? String(row[iFrom] || '').trim() : '',
      tl:   iTL   >= 0 ? String(row[iTL]   || '').trim() : '',
      pax:  iPax  >= 0 ? (parseInt(row[iPax])  || 0) : 0,
      group:   iGroup >= 0 ? (parseInt(row[iGroup])   || 0) : 0,
      indiv:   iIndiv >= 0 ? (parseInt(row[iIndiv])   || 0) : 0,
      hold:    iHold  >= 0 ? (parseInt(row[iHold])    || 0) : 0,
      vendor:  iVendor >= 0 ? String(row[iVendor] || '').trim() : '',
      status:  normStatus(iStatus >= 0 ? row[iStatus] : ''),
      remark:  iRemark >= 0 ? String(row[iRemark] || '').trim() : '',
    });
  }

  return records;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // No edge cache — the Sheet is the source of truth and must reflect immediately.
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!FALLBACK_URL) {
    return res.status(503).json({ error: 'VISA_SCRIPT_URL not configured in Vercel env vars.' });
  }

  try {
    const response = await fetch(FALLBACK_URL + '?sheet=VISA TRACKER', {
      redirect: 'follow',
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) throw new Error(`Apps Script returned ${response.status}`);

    const raw = await response.json();

    // raw is either array-of-arrays (sheet values) or pre-parsed
    let records;
    if (Array.isArray(raw) && Array.isArray(raw[0])) {
      records = parseSheetData(raw);
    } else if (Array.isArray(raw)) {
      records = raw; // already parsed by Apps Script
    } else {
      throw new Error('Unexpected response format from Apps Script');
    }

    return res.status(200).json({ ok: true, count: records.length, data: records });
  } catch (err) {
    console.error('visa.js error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
