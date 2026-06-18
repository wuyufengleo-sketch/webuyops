// ============================================================================
//  POST /api/flight-quotes — one-click flight price report for Ticketing.
//
//  Ticketing enters the route ONCE (outbound + inbound, asymmetric allowed)
//  plus a baseline departure/return date. We then fan out across:
//    • DATES:     baseline departure ±flexDays (return follows, tour length fixed)
//    • DIRECTION: forward routing + reverse routing (swap the two non-home points)
//  query each combo for the cheapest round-trip fare, score for value, and
//  return a report: recommendations + full date×direction price matrix.
//
//  Routing model — inputs out{from,to} and ret{from,to}:
//    forward:  out from→to ,        ret from→to
//    reverse:  out from→ret.from ,  ret out.to→ret.to
//  e.g. CGK→PEK / PVG→CGK  ⇒ reverse: CGK→PVG / PEK→CGK
//  (If reverse legs equal forward, it's a plain round trip — reverse is skipped.)
//
//  Prices are retail estimates scraped from Google Flights at 1 pax and scaled
//  to the requested headcount (fare = per-pax × pax) — a DECISION BASELINE for
//  "which date + which direction is cheapest", not the final team-fare. Each
//  combo carries deep links to confirm + actually book.
//
//  Caching: identical combos hit a Supabase table (flight_quote_cache, 12h TTL)
//  so re-clicking the same search the same day doesn't re-crawl. ?refresh=1
//  bypasses the cache.
// ============================================================================

const { createClient } = require('@supabase/supabase-js');
const { googleRoundTrip, googleOneWay } = require('./_flight-crawl.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CACHE_TTL_MS = 12 * 3600 * 1000;
const MAX_FLEX     = 3;          // UI offers ±1/±2/±3; the wall-clock budget caps runtime
const CONCURRENCY  = 6;          // fewer waves under the 60s function cap
const BUDGET_MS    = 45000;      // wall-clock crawl budget; once spent, skip remaining
                                 // network crawls and return a partial 200 (never a 504)

// Scoring weights (relative to the combo's own cheapest fare). A flight is
// ranked by fare first, then penalised for stops and for being slower than the
// fastest option on that combo. Tunable later via app_config.
const W = { stopPct: 0.06, hourPct: 0.015 };

const isIata = v => /^[A-Z]{3}$/.test(String(v||'').trim().toUpperCase());
const up = v => String(v||'').trim().toUpperCase();
const addDays = (iso, n) => { const d=new Date(iso+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); };
const daysBetween = (a,b) => Math.round((new Date(b+'T00:00:00Z') - new Date(a+'T00:00:00Z')) / 86400000);

// score a combo's quote list → best pick by value (lower is better)
function scoreQuotes(quotes){
  if (!quotes.length) return null;
  const minFare = Math.min(...quotes.map(q=>q.fare));
  const minDur  = Math.min(...quotes.map(q=>q.durationMin||Infinity));
  let best=null;
  for(const q of quotes){
    const stopPen = q.stops * W.stopPct * minFare;
    const durPen  = q.durationMin && minDur!==Infinity ? ((q.durationMin-minDur)/60) * W.hourPct * minFare : 0;
    const score   = q.fare + stopPen + durPen;
    if(!best || score<best.score) best={ ...q, score };
  }
  return best;
}

function legsFor(dir, o, depDate, retDate){
  // o = { outFrom, outTo, retFrom, retTo }
  if (dir==='forward')
    return { outFrom:o.outFrom, outTo:o.outTo, depDate, retFrom:o.retFrom, retTo:o.retTo, retDate };
  // reverse: swap the two "away" endpoints
  return { outFrom:o.outFrom, outTo:o.retFrom, depDate, retFrom:o.outTo, retTo:o.retTo, retDate };
}
const legsDesc = l => `${l.outFrom}→${l.outTo} / ${l.retFrom}→${l.retTo}`;
const cacheKey = (l,pax,cabin,cur) => [l.outFrom,l.outTo,l.depDate,l.retFrom,l.retTo,l.retDate,pax,cabin,cur,'g'].join('|');
const owKey    = (from,to,date,pax,cabin,cur) => ['ow',from,to,date,pax,cabin,cur].join('|');
// A combo's legs are a true round trip when the away point is shared (out and
// in mirror each other). Open-jaw legs (CGK→PEK / PVG→CGK) are not — those are
// priced as two one-ways summed, since no carrier bundles a return on them.
const isSymmetric = l => l.outTo===l.retFrom && l.outFrom===l.retTo;

// run async thunks with a concurrency cap
async function pool(items, limit, fn){
  const out=new Array(items.length); let i=0;
  const workers=Array.from({length:Math.min(limit,items.length)}, async()=>{
    while(i<items.length){ const idx=i++; out[idx]=await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  res.setHeader('Cache-Control','no-store');
  if (req.method==='OPTIONS') return res.status(204).end();
  if (req.method!=='POST')    return res.status(405).json({ error:'POST only' });

  // Auth: require a valid Supabase user session. The Flight Search UI already
  // sends `Authorization: Bearer <access_token>` (app.html ~4156); validate it
  // with the service-role client (same pattern as api/sb-write.js). Without this
  // the endpoint is open to the internet and can be driven to crawl Google.
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error:'server misconfigured' });
  const _authHdr = req.headers.authorization || '';
  const _jwt = _authHdr.startsWith('Bearer ') ? _authHdr.slice(7) : '';
  if (!_jwt) return res.status(401).json({ error:'sign in required' });
  const authClient = createClient(SUPABASE_URL, SERVICE_KEY, { auth:{ persistSession:false, autoRefreshToken:false } });
  const { data:_authData, error:_authErr } = await authClient.auth.getUser(_jwt);
  if (_authErr || !_authData?.user) return res.status(401).json({ error:'invalid session' });

  let body = req.body;
  if (typeof body==='string') { try{ body=JSON.parse(body); }catch{ return res.status(400).json({error:'bad json'}); } }
  body = body || {};

  // Date-comparison mode takes a single symmetric route (from/to); open-jaw
  // forward/reverse inputs (outFrom/outTo/retFrom/retTo) are also accepted so
  // the same endpoint serves the direction-comparison feature when it lands.
  const outFrom=up(body.outFrom||body.from), outTo=up(body.outTo||body.to);
  const retFrom=up(body.retFrom||body.outTo||body.to), retTo=up(body.retTo||body.outFrom||body.from);
  const depDate=body.depDate, retDate=body.retDate;
  const pax=Math.min(9,Math.max(1,parseInt(body.pax,10)||1));
  // Always crawl with 1 pax and scale by `pax` afterwards. Google Flights stops
  // SSR-ing results at high passenger counts (≈8-9, near team size) — a 9-pax
  // query returns a page with no embedded fares. The per-pax fare scales
  // linearly, so 1-pax × N gives the same total while always returning data and
  // keeping the cheapest-date / forward-vs-reverse signal intact.
  const CRAWL_PAX=1;
  const cabin=['economy','premium','business','first'].includes(body.cabin)?body.cabin:'economy';
  const currency=/^[A-Z]{3}$/.test(up(body.currency))?up(body.currency):'IDR';
  const flex=Math.min(MAX_FLEX,Math.max(0,parseInt(body.flexDays,10) ?? MAX_FLEX));
  const refresh=!!body.refresh;

  for(const [k,v] of [['outFrom',outFrom],['outTo',outTo],['retFrom',retFrom],['retTo',retTo]])
    if(!isIata(v)) return res.status(400).json({ error:`${k} must be a 3-letter IATA code (got "${v}")` });
  if(!/^\d{4}-\d{2}-\d{2}$/.test(depDate||'')) return res.status(400).json({ error:'depDate must be YYYY-MM-DD' });
  if(!/^\d{4}-\d{2}-\d{2}$/.test(retDate||'')) return res.status(400).json({ error:'retDate must be YYYY-MM-DD' });
  const span=daysBetween(depDate,retDate);
  if(span<0) return res.status(400).json({ error:'retDate is before depDate' });

  const o={ outFrom, outTo, retFrom, retTo };
  // forward vs reverse identical? (plain round trip) → only one direction
  const fwd=legsFor('forward',o,depDate,retDate), rev=legsFor('reverse',o,depDate,retDate);
  const dirs = (fwd.outTo===rev.outTo && fwd.retFrom===rev.retFrom) ? ['forward'] : ['forward','reverse'];

  // expand combos: offsets -flex..+flex × directions
  const offsets=[]; for(let k=-flex;k<=flex;k++) offsets.push(k);
  const combos=[];
  for(const off of offsets){
    const dep=addDays(depDate,off), ret=addDays(dep,span);
    for(const dir of dirs) combos.push({ off, dir, dep, ret, legs:legsFor(dir,o,dep,ret) });
  }

  const sb = authClient;   // reuse the validated service-role client (auth gate guarantees it)
  const now=Date.now();

  // cache read — collect round-trip keys (symmetric combos) + one-way leg keys
  // (open-jaw combos) so both price paths share the same cache table.
  let cacheHits={};
  if(sb && !refresh){
    const keySet=new Set();
    for(const c of combos){
      if(isSymmetric(c.legs)) keySet.add(cacheKey(c.legs,CRAWL_PAX,cabin,currency));
      else {
        keySet.add(owKey(c.legs.outFrom,c.legs.outTo,c.dep,CRAWL_PAX,cabin,currency));
        keySet.add(owKey(c.legs.retFrom,c.legs.retTo,c.ret,CRAWL_PAX,cabin,currency));
      }
    }
    try{
      const { data } = await sb.from('flight_quote_cache').select('cache_key,quotes,fetched_at').in('cache_key',[...keySet]);
      for(const row of (data||[])){
        if(now - new Date(row.fetched_at).getTime() < CACHE_TTL_MS) cacheHits[row.cache_key]=row.quotes;
      }
    }catch(_){}
  }

  // crawl misses with concurrency cap. Symmetric combos = one round-trip query;
  // open-jaw combos = two one-way queries (run in parallel) summed into a best.
  const toWrite=[];
  const stamp=new Date(now).toISOString();
  const fetchOneWay=async(from,to,date)=>{
    const k=owKey(from,to,date,CRAWL_PAX,cabin,currency);
    if(cacheHits[k]) return { quotes:cacheHits[k], cached:true, ok:true };
    const r=await googleOneWay({ from, to, date, pax:CRAWL_PAX, cabin, currency });
    if(r.ok){ toWrite.push({ cache_key:k, quotes:r.quotes, fetched_at:stamp }); return { quotes:r.quotes, cached:false, ok:true }; }
    return { quotes:[], cached:false, ok:false, reason:r.reason };
  };
  const baseRow=(c,extra)=>({ offset:c.off, direction:c.dir, depDate:c.dep, retDate:c.ret, route:legsDesc(c.legs), legs:c.legs, ...extra });

  // A combo is "free" when both its price paths are already in cacheHits — those
  // resolve from memory and are never skipped. Only combos that still need a live
  // network crawl are dropped once the wall-clock budget is spent.
  const comboCached=(c)=> isSymmetric(c.legs)
    ? !!cacheHits[cacheKey(c.legs,CRAWL_PAX,cabin,currency)]
    : (!!cacheHits[owKey(c.legs.outFrom,c.legs.outTo,c.dep,CRAWL_PAX,cabin,currency)]
       && !!cacheHits[owKey(c.legs.retFrom,c.legs.retTo,c.ret,CRAWL_PAX,cabin,currency)]);

  const results = await pool(combos, CONCURRENCY, async (c)=>{
    if(!comboCached(c) && Date.now()-now > BUDGET_MS)
      return baseRow(c,{ ok:false, reason:'time budget exceeded', cached:false, best:null, offers:[] });
    if(isSymmetric(c.legs)){
      const key=cacheKey(c.legs,CRAWL_PAX,cabin,currency);
      let quotes=cacheHits[key], cached=!!quotes, ok=true, reason=null;
      if(!quotes){
        const r=await googleRoundTrip({ ...c.legs, pax:CRAWL_PAX, cabin, currency });
        if(r.ok){ quotes=r.quotes; toWrite.push({ cache_key:key, quotes, fetched_at:stamp }); }
        else { ok=false; reason=r.reason; quotes=[]; }
      }
      const best=scoreQuotes(quotes);   // per-pax; scale to total by × pax
      return baseRow(c,{
        ok: ok && !!best, reason, cached,
        best: best ? { fare:best.fare*pax, farePerPax:best.fare, airline:best.airline, stops:best.stops, durationMin:best.durationMin, segments:best.segments } : null,
        offers: quotes.slice(0,5).map(q=>({ fare:q.fare*pax, farePerPax:q.fare, airline:q.airline, stops:q.stops, durationMin:q.durationMin })),
      });
    }
    // open-jaw: price both legs as one-ways, sum into a combined "best"
    const [outL,inL]=await Promise.all([
      fetchOneWay(c.legs.outFrom, c.legs.outTo, c.dep),
      fetchOneWay(c.legs.retFrom, c.legs.retTo, c.ret),
    ]);
    const ob=scoreQuotes(outL.quotes), ib=scoreQuotes(inL.quotes);   // per-pax legs
    const ok=outL.ok && inL.ok && !!ob && !!ib;
    const mkLeg=(b,from,to)=>b?{ from, to, fare:b.fare*pax, farePerPax:b.fare, airline:b.airline, stops:b.stops, durationMin:b.durationMin }:{ from, to };
    const best=ok ? {
      fare: (ob.fare+ib.fare)*pax,
      farePerPax: ob.fare+ib.fare,
      airline: ob.airline===ib.airline ? ob.airline : (ob.airline+' + '+ib.airline),
      stops: ob.stops+ib.stops,
      durationMin: (ob.durationMin||0)+(ib.durationMin||0),
      legs: { out: mkLeg(ob,c.legs.outFrom,c.legs.outTo), in: mkLeg(ib,c.legs.retFrom,c.legs.retTo) },
    } : null;
    const reason = ok ? null
      : (!outL.ok ? `out ${c.legs.outFrom}→${c.legs.outTo}: ${outL.reason}`
                  : `in ${c.legs.retFrom}→${c.legs.retTo}: ${inL.reason}`);
    return baseRow(c,{ ok, reason, cached: outL.cached && inL.cached, best, offers:[] });
  });

  // cache write (best-effort)
  if(sb && toWrite.length){ try{ await sb.from('flight_quote_cache').upsert(toWrite,{onConflict:'cache_key'}); }catch(_){} }

  // baseline = forward routing at offset 0 (what staff would book by default)
  const baseline = results.find(r=>r.offset===0 && r.direction==='forward' && r.ok)
              || results.find(r=>r.ok) || null;
  const basePrice = baseline?.best?.fare || null;

  // recommendations: rank all ok combos by value score, annotate savings
  const ranked = results.filter(r=>r.ok && r.best)
    .map(r=>{
      const stopPen=r.best.stops*W.stopPct*r.best.fare;
      const value = r.best.fare + stopPen;   // light value score for cross-combo ranking
      const savePct = basePrice ? Math.round((basePrice-r.best.fare)/basePrice*100) : null;
      return { ...r, value, savePct };
    })
    .sort((a,b)=>a.value-b.value);

  const okCount=results.filter(r=>r.ok).length;
  return res.status(200).json({
    ok:true,
    query:{ outFrom, outTo, retFrom, retTo, depDate, retDate, pax, cabin, currency, flexDays:flex, directions:dirs },
    tourLengthDays: span,
    baseline: baseline ? { route:baseline.route, depDate:baseline.depDate, retDate:baseline.retDate, fare:basePrice } : null,
    combosTotal: combos.length,
    combosPriced: okCount,
    recommendations: ranked.slice(0,3),
    matrix: results,    // full date×direction grid for the UI table
    note: `Retail estimates from Google Flights, priced at 1 pax × ${pax} — a decision baseline for the cheapest date/direction, not the final team fare. Confirm + book via the per-combo links.`,
  });
};
