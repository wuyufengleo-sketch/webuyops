// Debug: how many orders in the last 24h, how many match Sheet basic_price
import mysql from 'mysql2/promise';
import { loadSheetPrices } from '../api/_sheet-prices.js';

const conn = await mysql.createConnection({
  host: process.env.SKYBAR_MYSQL_HOST,
  port: Number(process.env.SKYBAR_MYSQL_PORT || 3306),
  user: process.env.SKYBAR_MYSQL_USER,
  password: process.env.SKYBAR_MYSQL_PASS,
  database: process.env.SKYBAR_MYSQL_DB,
});

const [pkgRows] = await conn.query('select id as tour_id, tour_code, tour_name, departure_time as departure_date from wt_tour where deleted_status=0 limit 5000');
const [ordRows] = await conn.query(`
  select o.id as order_id, o.tour_code_id as tour_id, o.bkg_no, u.user_name as salesman,
         o.guest_num, o.total_amount, o.order_status, o.order_date
  from wt_order o
  left join wt_user u on o.salesman_id = u.id
  where o.order_date >= date_sub(now(), interval 48 hour)
    and o.order_status in (1,2,3,4,8,9)
    and o.deleted_status = 0
`);
console.log(`Recent 48h orders (valid status): ${ordRows.length}`);

const prices = await loadSheetPrices();
console.log(`Sheet load: ${prices.ok ? 'ok' : 'fail '+prices.reason}, basic prices=${prices.byCodeBasic?.size || 0}`);

const pkgByTour = new Map();
for (const r of pkgRows) pkgByTour.set(Number(r.tour_id), r);

const norm = s => String(s||'').trim().toUpperCase().replace(/\s+/g,' ');

let matched = 0, unmatched = 0;
const unmatchedCodes = new Set();
for (const o of ordRows) {
  const pkg = pkgByTour.get(Number(o.tour_id));
  if (!pkg) continue;
  const basic = prices.byCodeBasic?.get(norm(pkg.tour_code));
  if (basic) matched++;
  else { unmatched++; unmatchedCodes.add(pkg.tour_code); }
}
console.log(`In Sheet: ${matched}  ·  Not in Sheet: ${unmatched}`);
console.log('Unmatched tour codes (sample):', [...unmatchedCodes].slice(0, 15));

console.log('\nSheet keys (sample):', [...prices.byCodeBasic.keys()].slice(0, 10));

// Show last 5 orders detail
console.log('\n=== Last 5 valid orders ===');
for (const o of ordRows.slice(-5)) {
  const pkg = pkgByTour.get(Number(o.tour_id));
  const basic = pkg ? prices.byCodeBasic?.get(norm(pkg.tour_code)) : null;
  const perPax = o.guest_num ? Number(o.total_amount) / Number(o.guest_num) : null;
  console.log(`  ${o.bkg_no || 'BK?'} · ${o.salesman} · ${pkg?.tour_code || '?'} ${String(pkg?.departure_date||'').slice(0,10)} · ${o.guest_num}pax · ${o.order_date}`);
  console.log(`    total=${o.total_amount}  per-pax=${perPax?.toFixed(0)||'?'}  sheet basic=${basic || '— (not in Sheet)'}`);
}

await conn.end();
