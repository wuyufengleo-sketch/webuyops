// Recon: can a plain server-side fetch read Google Flights prices?
// Reuses the tfs protobuf encoder already shipped in app.html (_gfTfs).
// If prices show up in the returned HTML's AF_initDataCallback blobs, Route A
// (HTTP replay, no browser) is viable. If we get a consent wall / empty shell,
// it isn't and we escalate. Read-only probe — one GET, no side effects.

function gfVarint(n){const o=[];while(true){let b=n&0x7f;n=Math.floor(n/128);if(n>0)o.push(b|0x80);else{o.push(b);break;}}return o;}
function gfTag(f,w){return gfVarint((f<<3)|w);}
function gfStr(f,s){const b=[];for(let i=0;i<s.length;i++)b.push(s.charCodeAt(i)&0xff);return [...gfTag(f,2),...gfVarint(b.length),...b];}
function gfInt(f,v){return [...gfTag(f,0),...gfVarint(v)];}
function gfEmb(f,bytes){return [...gfTag(f,2),...gfVarint(bytes.length),...bytes];}
function gfLeg(from,to,date){return [...gfStr(2,date),...gfEmb(13,gfStr(2,from)),...gfEmb(14,gfStr(2,to))];}
function gfTfs(legs,trip,pax,seat){
  let b=[];
  for(const l of legs) b=b.concat(gfEmb(3,l));
  b=b.concat(gfInt(5,trip));
  for(let i=0;i<pax;i++) b=b.concat(gfInt(8,1));
  b=b.concat(gfInt(9,seat));
  let s=''; for(const x of b) s+=String.fromCharCode(x);
  return Buffer.from(s,'binary').toString('base64');
}

const legs=[gfLeg('CGK','NRT','2026-07-20'), gfLeg('NRT','CGK','2026-07-27')];
const tfs=gfTfs(legs,1,1,1);            // trip=1 (round), 1 pax, economy
const url=`https://www.google.com/travel/flights?tfs=${encodeURIComponent(tfs)}&hl=en&curr=USD`;

console.log('URL:', url, '\n');

const res=await fetch(url,{
  headers:{
    'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept-Language':'en-US,en;q=0.9',
    'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  },
});
const html=await res.text();
console.log('HTTP', res.status, '| bytes', html.length);

// Signals
const consent = /consent\.google\.com|Before you continue|CONSENT/i.test(html);
const initData = (html.match(/AF_initDataCallback/g)||[]).length;
const priceUS = [...html.matchAll(/\$\s?\d[\d,]{2,}/g)].map(m=>m[0]).slice(0,12);
const priceIDR= [...html.matchAll(/(?:IDR|Rp)\s?\d[\d.,]{3,}/g)].map(m=>m[0]).slice(0,12);
const dollarFlights = /\bUS\$|US dollars|round trip|nonstop|\bstop\b/i.test(html);

console.log('\n--- signals ---');
console.log('consent wall:', consent);
console.log('AF_initDataCallback blobs:', initData);
console.log('flighty words (stop/nonstop/round trip):', dollarFlights);
console.log('$ price-like matches:', priceUS);
console.log('IDR price-like matches:', priceIDR);

// Dump a window around the first plausible price array if present
const di = html.indexOf('AF_initDataCallback');
if(di>=0) console.log('\nfirst AF blob head:\n', html.slice(di, di+240).replace(/\s+/g,' '));
