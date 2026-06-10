const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType } = require('docx');
const { parseRuleBasedQuote, auditQuoteContent } = require('../api/_quote-parser');
const { buildQuoteDocx } = require('../api/_docxgen');

const outDir = path.join(__dirname, '..', 'tmp', 'quote-smoke');
fs.mkdirSync(outDir, { recursive: true });

const cases = [
  {
    name: 'd-prefix-yunnan',
    blocks: [
      ['D1 印尼/昆明', '抵达昆明长水机场，接机入住酒店。酒店：维居金鹰酒店或同级携程4钻。'],
      ['D2 昆明/大理', '游览滇池，金马碧鸡坊，南屏步行街。早餐：酒店含早 L：中餐 D：晚餐。酒店：兰林阁酒店或万达美华酒店。'],
      ['D3 大理/沙溪古镇/丽江', '游览大理古城，喜洲古镇，沙溪古镇，玉津桥。酒店：亚俪酒店或拾光城景酒店。'],
    ],
  },
  {
    name: 'day-english-chongqing',
    blocks: [
      ['DAY 1 JAKARTA - CHONGQING', 'Arrive Chongqing. Transfer to hotel.'],
      ['DAY 2 CHONGQING CITY TOUR', 'Visit 解放碑, 洪崖洞 night view, 千厮门大桥. Meals: B/L/D.'],
      ['DAY 3 CHONGQING - DEPARTURE', 'Free time then airport transfer.'],
    ],
  },
  {
    name: 'cn-day-wangxian',
    blocks: [
      ['第1天 北京-上饶', '乘坐高铁前往上饶，抵达后入住饶派数字文创酒店。'],
      ['第2天 望仙谷一日游', '早餐后游览望仙谷，欣赏悬崖民居与夜景灯光。'],
      ['第3天 前往上海', '前往上海，游览外滩，南京路，武康路。酒店：上海瑞斯国际酒店。'],
      ['第4天 上海送机', '根据航班时间送机。'],
    ],
  },
  {
    name: 'date-heading-chengdu',
    blocks: [
      ['10/05 成都天府机场接站', '抵达成都天府机场，接站后入住浣花溪智选假日酒店。'],
      ['10/06 成都市内', '游览熊猫基地，宽窄巷子，锦里古街，IFS熊猫爬墙雕塑。'],
      ['10/07 送机', '早餐后送机。'],
    ],
  },
  {
    name: 'table-style-yunnan',
    table: true,
    rows: [
      ['天数', '城市', '行程内容', '酒店'],
      ['第一天', '印尼/昆明', '抵达昆明长水机场，接机入住酒店。', '维居金鹰酒店'],
      ['第二天', '昆明/石林县/昆明', '游览滇池、海洪湿地公园、杏林大观园、黑石林。', '维居金鹰酒店'],
      ['第三天', '昆明/大理', '游览理想邦圣托里尼、大理古城、洋人街。', '兰林阁酒店'],
    ],
  },
];

function para(text) {
  return new Paragraph({ children: [new TextRun(String(text || ''))] });
}

async function writeDocx(testCase) {
  const children = [para('地接行程确认书 / TEST ' + testCase.name), para('出发日期：2026年10月')];
  if (testCase.table) {
    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: testCase.rows.map(row => new TableRow({
        children: row.map(cell => new TableCell({ children: [para(cell)] })),
      })),
    }));
  } else {
    for (const [head, body] of testCase.blocks) {
      children.push(para(head));
      children.push(para(body));
    }
  }
  const doc = new Document({ sections: [{ children }] });
  const buf = await Packer.toBuffer(doc);
  const file = path.join(outDir, testCase.name + '.docx');
  fs.writeFileSync(file, buf);
  return file;
}

(async () => {
  const summary = [];
  for (const testCase of cases) {
    const file = await writeDocx(testCase);
    const buf = fs.readFileSync(file);
    const { value } = await mammoth.extractRawText({ buffer: buf });
    const parsed = parseRuleBasedQuote(value);
    parsed.price_label = '«Rp ____________»';
    const audit = auditQuoteContent(parsed);
    let renderOk = true;
    let renderError = '';
    try {
      await buildQuoteDocx(parsed, { images: {} });
    } catch (e) {
      renderOk = false;
      renderError = e.message || String(e);
    }
    summary.push({
      name: testCase.name,
      docx: path.relative(process.cwd(), file),
      textChars: value.length,
      days: parsed.days.length,
      routes: parsed.days.map(d => d.routeTitle),
      attractions: parsed.days.map(d => (d.attractions || []).map(a => a.name)),
      audit,
      renderOk,
      renderError,
    });
  }
  console.log(JSON.stringify(summary, null, 2));
})();
