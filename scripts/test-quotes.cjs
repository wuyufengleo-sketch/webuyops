const handler = require('../api/flight-quotes.js');
const req = { method:'POST', body:{ from:'CGK', to:'NRT', depDate:'2026-07-20', retDate:'2026-07-27', pax:1, cabin:'economy', currency:'IDR', flexDays:2 } };
const res = { _s:200, setHeader(){}, status(c){this._s=c;return this;}, json(o){ console.log('HTTP',this._s); print(o); }, end(){} };
const rp = n => 'IDR '+Number(n).toLocaleString();
function print(o){
  if(o.error){ console.log('ERROR', o.error); return; }
  console.log('tour', o.tourLengthDays, 'd | dirs', o.query.directions.join('+'), '| priced', o.combosPriced+'/'+o.combosTotal);
  console.log('baseline:', o.baseline ? o.baseline.depDate+'→'+o.baseline.retDate+' '+rp(o.baseline.fare) : 'none');
  console.log('\nTOP PICKS:');
  o.recommendations.forEach((r,i)=>{
    const sv = r.savePct>0 ? 'save '+r.savePct+'%' : (r.savePct<0 ? '+'+(-r.savePct)+'% pricier' : 'baseline');
    console.log('  #'+(i+1)+' '+r.depDate+'→'+r.retDate+' | '+rp(r.best.fare)+' | '+r.best.airline+' | '+r.best.stops+'stop '+(r.best.durationMin/60).toFixed(1)+'h | '+sv);
  });
  console.log('\nDATE MATRIX:');
  o.matrix.forEach(m=>{
    console.log('  off'+(m.offset>=0?'+':'')+m.offset+' '+m.depDate+' | '+(m.ok ? rp(m.best.fare)+' '+m.best.airline+' '+m.best.stops+'stop' : '✗ '+m.reason));
  });
}
handler(req,res).catch(e=>console.log('THREW', e.message));
