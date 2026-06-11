// E2E test: open-jaw forward/reverse comparison (the user's original example).
// Forward: CGK→PEK out, PVG→CGK back. Reverse: CGK→PVG out, PEK→CGK back.
const handler = require('../api/flight-quotes.js');
const req = { method:'POST', body:{ outFrom:'CGK', outTo:'PEK', retFrom:'PVG', retTo:'CGK', depDate:'2026-07-20', retDate:'2026-07-27', pax:1, cabin:'economy', currency:'IDR', flexDays:1 } };
const rp = n => 'IDR '+Number(n).toLocaleString();
const res = { _s:200, setHeader(){}, status(c){this._s=c;return this;}, json(o){ console.log('HTTP',this._s); print(o); }, end(){} };
function print(o){
  if(o.error){ console.log('ERROR', o.error); return; }
  console.log('dirs', o.query.directions.join('+'), '| priced', o.combosPriced+'/'+o.combosTotal, '| tour', o.tourLengthDays,'d');
  console.log('baseline:', o.baseline ? o.baseline.route+' '+o.baseline.depDate+' '+rp(o.baseline.fare) : 'none');
  console.log('\nTOP PICKS:');
  o.recommendations.forEach((r,i)=>{
    const lg=r.best.legs ? ' ['+r.best.legs.out.airline+' / '+r.best.legs.in.airline+']' : '';
    console.log('  #'+(i+1)+' ['+r.direction+'] '+r.route+' | '+r.depDate+' | '+rp(r.best.fare)+lg+' | save '+r.savePct+'%');
  });
  console.log('\nMATRIX:');
  o.matrix.forEach(m=>{
    console.log('  ['+m.direction.padEnd(7)+'] off'+(m.offset>=0?'+':'')+m.offset+' '+m.depDate+' '+m.route+' | '+(m.ok ? rp(m.best.fare)+' ('+m.best.airline+')' : '✗ '+m.reason));
  });
}
handler(req,res).catch(e=>console.log('THREW', e.message));
