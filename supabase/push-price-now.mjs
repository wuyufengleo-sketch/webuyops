// Build today's BK price-compare block locally and push directly to OPS Lark.
import mysql from 'mysql2/promise';
import { loadSheetPrices } from '../api/_sheet-prices.js';
import pkg from '../api/_price-watch.js';
const { detectLowPriceOrders, priceWatchHeartbeatLine, priceWatchFullBlock } = pkg;

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// 1) Read lark_admin_url from Supabase
const cfg = await fetch(`${URL}/rest/v1/app_config?key=eq.lark_ops_url&select=value`, {
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
}).then(r => r.json());
const larkUrl = cfg?.[0]?.value;
if (!larkUrl) { console.error('No lark_admin_url configured'); process.exit(1); }
console.log('lark_admin_url:', larkUrl.slice(0, 60) + '...');

// 2) Pull Skybar packages + recent orders
const conn = await mysql.createConnection({
  host: process.env.SKYBAR_MYSQL_HOST, port: Number(process.env.SKYBAR_MYSQL_PORT||3306),
  user: process.env.SKYBAR_MYSQL_USER, password: process.env.SKYBAR_MYSQL_PASS, database: process.env.SKYBAR_MYSQL_DB,
});
const [pkgRows] = await conn.query('select id as tour_id, tour_code, tour_name, departure_time as departure_date from wt_tour where deleted_status=0 and departure_time >= date_sub(now(), interval 30 day)');
const [ordRows] = await conn.query("select o.id as order_id, o.tour_code_id as tour_id, o.bkg_no, u.user_name as salesman, o.guest_num, o.total_amount, o.order_status, o.order_date from wt_order o left join wt_user u on o.salesman_id = u.id where o.deleted_status=0 and o.order_status in (1,2,3,4,8,9)");
await conn.end();

// 3) Apply Sheet enrichment with fallback matching
const prices = await loadSheetPrices();
if (!prices.ok) { console.error('Sheet load failed:', prices.reason); process.exit(1); }
// Re-pull pkg+type info — need type_code for byType fallback.
const [pkgRowsWithType] = await (async () => {
  const c = await mysql.createConnection({host:process.env.SKYBAR_MYSQL_HOST,port:Number(process.env.SKYBAR_MYSQL_PORT||3306),user:process.env.SKYBAR_MYSQL_USER,password:process.env.SKYBAR_MYSQL_PASS,database:process.env.SKYBAR_MYSQL_DB});
  const out = await c.query('select t.id as tour_id, t.tour_code, t.tour_name, t.departure_time as departure_date, tt.type_code from wt_tour t left join wt_tour_type tt on t.tour_type_id=tt.id where t.deleted_status=0 and t.departure_time >= date_sub(now(), interval 60 day)');
  await c.end();
  return out;
})();
const norm = s => String(s||'').trim().toUpperCase().replace(/\s+/g,' ');
const packages = pkgRowsWithType.map(r => {
  const pkg = { tour_id: Number(r.tour_id), tour_code: r.tour_code, tour_name: r.tour_name, departure_date: r.departure_date };
  const tc = norm(r.tour_code);
  const ty = norm(r.type_code);
  const fixed = prices.byType?.get(ty) || {};
  const recC = prices.byCode?.get(tc)
    || prices.byCode?.get(tc.replace(/\/\d{2}$/, ''))
    || (() => { const s = tc.replace(/^\d{2}/, '').replace(/\/\d{2}$/, '').replace(/\d+$/, ''); return s && s.length>=4 ? prices.byCode?.get(s) : null; })();
  pkg.basic_price = recC?.basic_price ?? fixed.basic_price ?? null;
  pkg.total_price = recC?.total_price ?? fixed.total_price ?? null;
  pkg.visa_price = fixed.visa_price ?? null;
  pkg.tipping = fixed.tipping ?? null;
  pkg.insurance = fixed.insurance ?? null;
  pkg.optional_mandatory = fixed.optional_mandatory ?? null;
  return pkg;
});

// 4) Build price-watch result + heartbeat block
const r = detectLowPriceOrders({ packages, orders: ordRows, windowHours: 24 });
const headerLine = priceWatchHeartbeatLine(r);
const fullBlock = priceWatchFullBlock(r, 60);

const stamp = new Date().toISOString().replace('T',' ').slice(0,16);
const message = [
  `📊 Rekap Sales Harian OPS · ${stamp} UTC`,
  `(Cron jalan setiap hari jam 18:00 WIB; ini push manual.)`,
  '',
  headerLine,
  '',
  fullBlock,
].join('\n');

console.log('\n=== Message preview ===\n' + message + '\n');

// 5) Send
const res = await fetch(larkUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ msg_type: 'text', content: { text: message } }),
});
const body = await res.json().catch(()=>({}));
console.log(`\nLark response: HTTP ${res.status}`, body);
if (!res.ok || (body && body.code !== 0 && body.StatusCode !== 0)) {
  console.error('⚠️  Lark may have rejected — check the response above (code/StatusCode should be 0).');
} else {
  console.log('✅ Push successful — check the OPS Lark group now.');
}
