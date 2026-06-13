// ============================================================================
//  Flight price crawler — Route A (HTTP replay, no browser, no proxy).
//
//  Google Flights server-side-renders its first result set into the page HTML
//  inside AF_initDataCallback({key:'ds:1', data:[...]}) blobs. We build the
//  same tfs protobuf the browser uses (the encoder already shipped in app.html
//  as _gfTfs), GET the flights URL, parse the embedded data, and read fares.
//
//  Field paths were pinned empirically (see scripts/recon-gflights*.mjs):
//    biggest AF blob → data[2][0] = best flights, data[3][0] = other flights
//    flight[0]        = [airlineCode, [airlineName], [segments...]]
//    flight[1][0][1]  = total fare (round-trip total OR one-way fare — verified
//                       for both via USD↔IDR FX diff; same path)
//    segment[3]/[6]   = origin / destination IATA
//    segment[11]      = segment duration (minutes)
//    segment[20]      = [Y,M,D] departure date
//
//  Both round-trip (trip=1) and one-way (trip=2) SSR the same data shape. One
//  caveat: Google occasionally returns a lightweight SHELL page with no data
//  blob (more common for one-way); crawlGoogle retries a couple of times to
//  ride that out.
//
//  This is the brittle layer: if Google changes the embedded shape, the parser
//  breaks and these paths must be re-derived with the recon scripts. Everything
//  is wrapped so a parse failure yields { ok:false } rather than throwing — the
//  report degrades to "no price for this combo" instead of a 500.
// ============================================================================

// ----- tfs protobuf encoder (mirror of app.html _gfTfs) -----
const vint = n => { const o=[]; while(true){ let b=n&0x7f; n=Math.floor(n/128); if(n>0)o.push(b|0x80); else{o.push(b);break;} } return o; };
const tag  = (f,w) => vint((f<<3)|w);
const pStr = (f,s) => { const b=[]; for(let i=0;i<s.length;i++) b.push(s.charCodeAt(i)&0xff); return [...tag(f,2),...vint(b.length),...b]; };
const pInt = (f,v) => [...tag(f,0),...vint(v)];
const pEmb = (f,by) => [...tag(f,2),...vint(by.length),...by];
const pLeg = (from,to,date) => [...pStr(2,date),...pEmb(13,pStr(2,from)),...pEmb(14,pStr(2,to))];
const GSEAT = { economy:1, premium:2, business:3, first:4 };
function buildTfs(legs, trip, pax, cabin){
  let b=[];
  for(const l of legs) b=b.concat(pEmb(3, pLeg(l.from, l.to, l.date)));
  b=b.concat(pInt(5, trip));                       // 1=round, 2=one-way, 3=multi-city
  for(let i=0;i<pax;i++) b=b.concat(pInt(8,1));     // one adult entry per pax
  b=b.concat(pInt(9, GSEAT[cabin]||1));
  return Buffer.from(String.fromCharCode(...b),'binary').toString('base64');
}

// ----- balance-matched bracket scan + AF blob extraction -----
function matchBracket(s, open){
  let depth=0, inStr=false, esc=false;
  for(let i=open;i<s.length;i++){
    const c=s[i];
    if(inStr){ if(esc) esc=false; else if(c==='\\') esc=true; else if(c==='"') inStr=false; continue; }
    if(c==='"'){ inStr=true; continue; }
    if(c==='['||c==='(') depth++;
    else if(c===']'||c===')'){ depth--; if(depth===0) return i; }
  }
  return -1;
}
function biggestBlob(html){
  let idx=0, best=null;
  while(true){
    const at=html.indexOf('AF_initDataCallback(', idx);
    if(at<0) break;
    const pOpen=html.indexOf('(', at), pClose=matchBracket(html,pOpen);
    if(pClose<0) break;
    const obj=html.slice(pOpen+1,pClose); idx=pClose;
    const dAt=obj.indexOf('data:'); if(dAt<0) continue;
    const aOpen=obj.indexOf('[',dAt), aClose=matchBracket(obj,aOpen);
    if(aClose<0) continue;
    try { const data=JSON.parse(obj.slice(aOpen,aClose+1)); if(!best||(aClose-aOpen)>best.size) best={data,size:aClose-aOpen}; }
    catch(_){}
  }
  return best && best.data;
}

// ----- one flight entry → normalized quote -----
const asNum = v => (typeof v==='number' && Number.isFinite(v)) ? v : null;
function parseFlight(fl){
  try {
    const head = fl[0];                       // [airlineCode, [airlineName], [segments]]
    const fare = asNum(fl?.[1]?.[0]?.[1]);     // total fare
    if (fare==null) return null;
    const segs = Array.isArray(head?.[2]) ? head[2] : [];
    const airlines = [...new Set(segs.map(s => s?.[22]?.[3] || head?.[1]?.[0]).filter(Boolean))];
    const carrierMain = head?.[1]?.[0] || head?.[0] || (airlines[0]||'—');
    const segOut = segs.map(s => ({
      from: s?.[3]||null, to: s?.[6]||null,
      durMin: asNum(s?.[11]),
      flightNo: (s?.[22]?.[0]||'') + (s?.[22]?.[1]||''),
      depDate: Array.isArray(s?.[20]) ? s[20].join('-') : null,
    }));
    const stops = Math.max(0, segs.length - 1);
    const totalDur = segOut.reduce((a,s)=>a+(s.durMin||0),0) || null;
    return { fare, airline: carrierMain, airlines, stops, durationMin: totalDur, segments: segOut };
  } catch(_) { return null; }
}

// ----- core Google Flights crawl (round-trip OR one-way via leg/trip args) -----
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const sleep = ms => new Promise(r=>setTimeout(r,ms));

async function _fetchParse(legs, trip, pax, cabin, currency, timeoutMs){
  const tfs = buildTfs(legs, trip, Math.max(1,pax), cabin);
  const url = `https://www.google.com/travel/flights?tfs=${encodeURIComponent(tfs)}&hl=en&curr=${currency}`;
  const ctrl = new AbortController();
  const timer = setTimeout(()=>ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, 'Accept-Language':'en-US,en;q=0.9', 'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    });
    if (!res.ok) return { ok:false, reason:`HTTP ${res.status}`, url };
    const html = await res.text();
    if (/consent\.google\.com|sorry\/index|unusual traffic/i.test(html)) return { ok:false, reason:'blocked/consent', url, blocked:true };
    const data = biggestBlob(html);
    if (!data) return { ok:false, reason:'shell page (no data blob)', url, shell:true };
    const best   = Array.isArray(data?.[2]?.[0]) ? data[2][0] : [];
    const others = Array.isArray(data?.[3]?.[0]) ? data[3][0] : [];
    let quotes = [...best, ...others].map(parseFlight).filter(Boolean).sort((a,b)=>a.fare-b.fare);
    const seen=new Set(), uniq=[];
    for(const q of quotes){ const k=q.airline+'|'+q.fare+'|'+q.stops; if(!seen.has(k)){ seen.add(k); uniq.push(q); } }
    if (!uniq.length) return { ok:false, reason:'parsed 0 flights', url, shell:true };
    return { ok:true, currency, url, quotes: uniq };
  } catch(e) {
    return { ok:false, reason: e.name==='AbortError' ? 'timeout' : e.message, url };
  } finally { clearTimeout(timer); }
}

// Crawl with shell-page retry. One-way responses are SSR'd less reliably than
// round-trip, so a shell/empty result is retried (with small backoff) before
// giving up.
async function crawlGoogle(legs, trip, { pax=1, cabin='economy', currency='IDR', timeoutMs=12000, retries=2 }={}){
  let last;
  for(let attempt=0; attempt<=retries; attempt++){
    last = await _fetchParse(legs, trip, pax, cabin, currency, timeoutMs);
    if (last.ok || last.blocked) return last;     // don't hammer if hard-blocked
    if (attempt < retries) await sleep(400 + attempt*500);
  }
  return last;
}

// Round-trip (open-jaw aware): outbound and inbound legs given explicitly.
async function googleRoundTrip({ outFrom, outTo, depDate, retFrom, retTo, retDate, ...opts }){
  return crawlGoogle([{from:outFrom,to:outTo,date:depDate}, {from:retFrom,to:retTo,date:retDate}], 1, opts);
}

// One-way single leg — the building block for open-jaw forward/reverse pricing.
async function googleOneWay({ from, to, date, ...opts }){
  return crawlGoogle([{from,to,date}], 2, opts);
}

// Provider interface — swap/extend without touching the report pipeline.
const PROVIDERS = { google: { roundTrip: googleRoundTrip, oneWay: googleOneWay } };

module.exports = { buildTfs, biggestBlob, parseFlight, crawlGoogle, googleRoundTrip, googleOneWay, PROVIDERS };
