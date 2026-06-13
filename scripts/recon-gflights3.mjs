// Recon v3: pin the PRICE path. Fetch the same route in USD and IDR; the numeric
// leaf whose value changes by ~the FX rate between the two responses is the fare.
// Also pin stops/duration/airline paths from the structure. Deterministic.

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
  return Buffer.from(String.fromCharCode(...b),'binary').toString('base64');
}
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
    try{ const data=JSON.parse(obj.slice(aOpen,aClose+1)); if(!best||(aClose-aOpen)>best.size) best={data,size:aClose-aOpen}; }catch(e){}
  }
  return best&&best.data;
}
async function get(curr){
  const legs=[gfLeg('CGK','NRT','2026-07-20'), gfLeg('NRT','CGK','2026-07-27')];
  const url=`https://www.google.com/travel/flights?tfs=${encodeURIComponent(gfTfs(legs,1,1,1))}&hl=en&curr=${curr}`;
  const res=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36','Accept-Language':'en-US,en;q=0.9'}});
  return biggestBlob(await res.text());
}
// collect [path, value] for every number leaf
function leaves(node, path, out){
  if(typeof node==='number'){ out.push([path, node]); return; }
  if(Array.isArray(node)) node.forEach((v,i)=>leaves(v, path+'/'+i, out));
}

const usd=await get('USD');
const idr=await get('IDR');
const fu=usd[2][0], fi=idr[2][0];
console.log('best-flight count USD:', fu.length, '| IDR:', fi.length);

for(let k=0;k<Math.min(fu.length,3);k++){
  const lu=[]; leaves(fu[k],'',lu);
  const mi=new Map(); { const li=[]; leaves(fi[k],'',li); li.forEach(([p,v])=>mi.set(p,v)); }
  // find leaves whose IDR/USD ratio is in plausible FX band (10k..20k)
  const fx=[];
  for(const [p,v] of lu){
    const iv=mi.get(p);
    if(typeof iv==='number' && v>50 && v<20000){
      const r=iv/v;
      if(r>9000 && r<22000) fx.push({path:p, usd:v, idr:iv, rate:Math.round(r)});
    }
  }
  console.log(`\nflight #${k} — price-candidate leaves (USD↔IDR ~FX):`);
  fx.forEach(c=>console.log('  ', c.path, '=>', '$'+c.usd, '/ IDR', c.idr.toLocaleString(), '(x'+c.rate+')'));
  // airline + a couple of structural hints
  console.log('  airline[0]:', JSON.stringify(fu[k][0]).slice(0,40), '| stops hint flight len:', fu[k].length);
}
