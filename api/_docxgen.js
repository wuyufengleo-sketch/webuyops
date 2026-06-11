// ============================================================================
//  docxgen.js — build a WeBuy customer itinerary .docx in pure Node (docx-js).
//  Port of build_docx.py. Runs anywhere Node runs (incl. Vercel serverless),
//  no Python / LibreOffice / native deps.
//
//  buildQuoteDocx(content, { logo, images }) -> Promise<Buffer>
//    content : { trip:{title,subtitle}, departure_label, price_label,
//                noted[], termasuk[], tidak[],
//                days:[{ dayNo, routeTitle, mealCode, intro,
//                        attractions:[{name,desc}], optional:[{name,price}],
//                        shopping, hotel, closing, imageNames:[...] }] }
//    logo    : Buffer (png)         — WEBUY header logo
//    images  : { [attractionName]: { data:Buffer, ext:'jpg'|'png' } }
//              (images should already be ~3:2; they are displayed as 3:2)
// ============================================================================
const {
  Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, BorderStyle, WidthType, ShadingType, VerticalAlign,
  TabStopType, PageBreak,
} = require('docx');

// ── per-language static labels (template layout itself never changes) ──
const DOC_LABELS = {
  id: {
    highlights: '✨  HIGHLIGHT PERJALANAN',
    overviewPeriod: 'PERIODE', overviewDuration: 'DURASI', overviewHotel: 'HOTEL',
    durationFmt: n => `${n} Hari ${n - 1} Malam`,
    dest: 'Destinasi hari ini:',
    optional: '✨ Acara Pilihan (opsional, biaya sendiri): ',
    shopping: '🛍️ Kunjungan Toko: ',
    hotel: '🏨  Hotel: ',
    priceHeading: 'INFORMASI HARGA',
    priceCol0: 'DEPARTURE', priceCol1: 'HARGA KAMAR TWIN / orang',
    noted: 'Noted :',
    includes: 'HARGA PAKET TERMASUK :', excludes: 'HARGA PAKET TIDAK TERMASUK :',
    disclaimer: '**Demi kelancaran Tour, flight detail dan tour masih bisa berubah sewaktu waktu tanpa mengurangi destinasi **',
  },
  zh: {
    highlights: '✨  行程亮点',
    overviewPeriod: '出发时段', overviewDuration: '行程天数', overviewHotel: '酒店星级',
    durationFmt: n => `${n}天${n - 1}晚`,
    dest: '今日景点：',
    optional: '✨ 自费项目（可选）：',
    shopping: '🛍️ 购物店：',
    hotel: '🏨  酒店：',
    priceHeading: '价格信息',
    priceCol0: '出发日期', priceCol1: '双人间价格 / 每人',
    noted: '注意事项：',
    includes: '费用包含：', excludes: '费用不包含：',
    disclaimer: '**为保证行程顺利，航班及行程顺序可能调整，不减少游览景点**',
  },
  en: {
    highlights: '✨  TRIP HIGHLIGHTS',
    overviewPeriod: 'PERIOD', overviewDuration: 'DURATION', overviewHotel: 'HOTEL',
    durationFmt: n => `${n} Days ${n - 1} Nights`,
    dest: "Today's destinations:",
    optional: '✨ Optional activity (self-paid): ',
    shopping: '🛍️ Shopping stop: ',
    hotel: '🏨  Hotel: ',
    priceHeading: 'PRICE INFORMATION',
    priceCol0: 'DEPARTURE', priceCol1: 'TWIN ROOM PRICE / person',
    noted: 'Notes :',
    includes: 'PACKAGE INCLUDES :', excludes: 'PACKAGE EXCLUDES :',
    disclaimer: '**To ensure a smooth tour, flight details and itinerary order may change without reducing destinations**',
  },
};

// derive a hotel-star summary from the days ("4★ (or similar)" style), used
// in the overview strip; falls back to the most common star digit mentioned
function hotelStarSummary(content) {
  const stars = (content.days || []).map(d => {
    const m = String(d.hotel || '').match(/bintang\s*([3-5])|([3-5])\s*-?\s*star|([3-5])\s*星|([3-5])\s*★/i);
    return m ? Number(m[1] || m[2] || m[3] || m[4]) : 0;
  }).filter(Boolean);
  if (!stars.length) return '4★';
  const counts = {};
  for (const s of stars) counts[s] = (counts[s] || 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  return `${top}★`;
}

// ---- brand ----
const NAVY = '1B2F6B', BLUE = '2E74B5', RED = 'C00000', WHITE = 'FFFFFF';
const GREY = '404040', ORANGE = 'C05A00', SHOP = '6B4A2A', LIGHTBLUE = 'D6E4F0';
const FONT = 'Calibri';

// A4 in DXA (1 inch = 1440 dxa; 1 cm = 567 dxa). 96px = 1440 dxa  ->  px = dxa/15.
const PAGE_W = 11906, PAGE_H = 16838;
const MARGIN_X = 1077, MARGIN_Y = 794;            // 1.9cm / 1.4cm
const CONTENT_DXA = PAGE_W - 2 * MARGIN_X;        // 9752
const CONTENT_PX = Math.floor(CONTENT_DXA / 15);  // ~650

const NONE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const NO_BORDERS = { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE };

function run(text, o = {}) {
  return new TextRun({
    text, bold: !!o.bold, italics: !!o.italic,
    size: o.size ? Math.round(o.size * 2) : 22,            // pt -> half-pt
    color: o.color || GREY, font: FONT,
    ...(o.highlight ? { highlight: 'yellow' } : {}),
  });
}
const P = (children, o = {}) => new Paragraph({
  children: Array.isArray(children) ? children : [children],
  alignment: o.align, spacing: o.spacing,
  indent: o.indentCm ? { left: Math.round(o.indentCm * 567) } : undefined,
  ...(o.border ? { border: o.border } : {}),
  ...(o.tabRight ? { tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_DXA }] } : {}),
});
const spacer = (pt = 6) => new Paragraph({ children: [new TextRun({ text: '', size: pt })], spacing: { after: 0, before: 0 } });

function dayBar(text) {
  return new Table({
    width: { size: CONTENT_DXA, type: WidthType.DXA },
    columnWidths: [CONTENT_DXA],
    borders: NO_BORDERS,
    rows: [new TableRow({
      children: [new TableCell({
        width: { size: CONTENT_DXA, type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, color: 'auto', fill: NAVY },
        margins: { top: 60, bottom: 60, left: 160, right: 140 },
        children: [P(run(text, { bold: true, size: 12.5, color: WHITE }), { spacing: { before: 0, after: 0 } })],
      })],
    })],
  });
}

function imageStrip(imgs) {
  const n = imgs.length;
  const cols = ({ 1: 1, 2: 2, 3: 3, 4: 2 })[n] || 3;
  const rows = Math.ceil(n / cols);
  const cellDxa = Math.floor(CONTENT_DXA / cols);
  const imgW = Math.floor(cellDxa / 15) - 8;
  const imgH = Math.round(imgW / 1.5);
  const trows = [];
  let idx = 0;
  for (let r = 0; r < rows; r++) {
    const cells = [];
    for (let c = 0; c < cols; c++) {
      const children = [];
      if (idx < n) {
        const im = imgs[idx];
        children.push(new Paragraph({
          alignment: AlignmentType.CENTER, spacing: { after: 0, before: 0 },
          children: [new ImageRun({ type: im.ext === 'png' ? 'png' : 'jpg', data: im.data, transformation: { width: imgW, height: imgH } })],
        }));
      } else {
        children.push(new Paragraph({ children: [] }));
      }
      cells.push(new TableCell({ width: { size: cellDxa, type: WidthType.DXA }, borders: NO_BORDERS, verticalAlign: VerticalAlign.CENTER, children }));
      idx++;
    }
    trows.push(new TableRow({ children: cells }));
  }
  return new Table({ width: { size: CONTENT_DXA, type: WidthType.DXA }, columnWidths: Array(cols).fill(cellDxa), borders: NO_BORDERS, alignment: AlignmentType.CENTER, rows: trows });
}

// Price table per the confirmed template: a single "twin room price" column,
// left blank with a writing line so the price can be filled in by hand.
function priceTable(dep, labels) {
  const w0 = 3969, w1 = CONTENT_DXA - w0;   // ~7cm / rest
  const border = { style: BorderStyle.SINGLE, size: 4, color: '808080' };
  const borders = { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border };
  const cell = (txt, w, opts) => new TableCell({
    width: { size: w, type: WidthType.DXA }, borders,
    shading: opts.fill ? { type: ShadingType.CLEAR, color: 'auto', fill: opts.fill } : undefined,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    children: [P(run(txt, opts.run), { align: AlignmentType.CENTER })],
  });
  return new Table({
    width: { size: CONTENT_DXA, type: WidthType.DXA }, columnWidths: [w0, w1], alignment: AlignmentType.CENTER,
    rows: [
      new TableRow({ children: [
        cell(labels.priceCol0, w0, { fill: LIGHTBLUE, run: { bold: true, size: 11, color: NAVY } }),
        cell(labels.priceCol1, w1, { fill: LIGHTBLUE, run: { bold: true, size: 11, color: NAVY } }),
      ] }),
      new TableRow({ children: [
        cell(dep, w0, { run: { bold: true, size: 12, color: NAVY } }),
        cell('Rp  _______________________', w1, { run: { bold: true, size: 12, color: NAVY } }),
      ] }),
    ],
  });
}

// Overview strip under the title: period / duration / hotel star.
function overviewTable(content, labels) {
  const w = Math.floor(CONTENT_DXA / 3);
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'B9CBE3' };
  const borders = { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border };
  const cell = (head, val) => new TableCell({
    width: { size: w, type: WidthType.DXA }, borders,
    shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F4F8FD' },
    margins: { top: 70, bottom: 70, left: 100, right: 100 },
    children: [
      P(run(head, { bold: true, size: 9, color: BLUE }), { align: AlignmentType.CENTER, spacing: { after: 20 } }),
      P(run(val, { bold: true, size: 11.5, color: NAVY }), { align: AlignmentType.CENTER }),
    ],
  });
  const n = (content.days || []).length;
  return new Table({
    width: { size: CONTENT_DXA, type: WidthType.DXA }, columnWidths: [w, w, w], alignment: AlignmentType.CENTER,
    rows: [new TableRow({ children: [
      cell(labels.overviewPeriod, content.departure_label || '«TANGGAL»'),
      cell(labels.overviewDuration, n ? labels.durationFmt(n) : '-'),
      cell(labels.overviewHotel, hotelStarSummary(content)),
    ] })],
  });
}

function numberedSection(heading, items) {
  const out = [P(run(heading, { bold: true, size: 12, color: BLUE }), { spacing: { before: 240 } })];
  items.forEach((it, i) => out.push(P([run(`${i + 1}. `, { bold: true, size: 10.5, color: NAVY }), run(it, { size: 10.5, color: GREY })], { indentCm: 0.6, spacing: { after: 40 } })));
  return out;
}

async function buildQuoteDocx(content, { logo, images, lang } = {}) {
  const L = DOC_LABELS[lang] || DOC_LABELS[content.lang] || DOC_LABELS.id;
  const body = [];

  // title block
  body.push(P(run(content.trip.title, { bold: true, size: 20, color: NAVY }), { align: AlignmentType.CENTER, spacing: { before: 120 } }));
  body.push(P(run(content.trip.subtitle, { bold: true, size: 14, color: BLUE }), { align: AlignmentType.CENTER }));
  body.push(spacer(6));

  // overview strip: period / duration / hotel star
  body.push(overviewTable(content, L));
  body.push(spacer(6));

  // highlights
  if (content.highlights && content.highlights.length) {
    body.push(P(run(L.highlights, { bold: true, size: 13, color: NAVY }), { spacing: { before: 60, after: 40 } }));
    for (const hl of content.highlights) {
      body.push(P([run('▸  ', { bold: true, size: 11, color: BLUE }), run(hl, { size: 11, color: GREY })], { indentCm: 0.4, spacing: { after: 30 } }));
    }
    body.push(spacer(8));
  }

  // days
  for (const d of content.days) {
    let title = `DAY ${d.dayNo} : ${d.routeTitle}`;
    if (d.mealCode) title += `  (${d.mealCode})`;
    body.push(spacer(8));
    body.push(dayBar(title));
    body.push(spacer(2));

    // RULE: no sightseeing (empty attractions) -> no photo
    if (d.attractions && d.attractions.length) {
      const imgs = [];
      const seen = new Set();
      for (const name of (d.imageNames || [])) {
        const im = images && images[name];
        if (im && !seen.has(name)) { seen.add(name); imgs.push(im); }
      }
      if (imgs.length) { body.push(imageStrip(imgs)); body.push(spacer(2)); }
    }

    if (d.intro) body.push(P(run(d.intro, { size: 11, color: GREY })));

    if (d.attractions && d.attractions.length) {
      body.push(P(run(L.dest, { bold: true, size: 11, color: NAVY }), { spacing: { before: 40 } }));
      for (const a of d.attractions) {
        body.push(P(run(a.name, { bold: true, size: 11, color: NAVY }), { indentCm: 0.4, spacing: { after: 20 } }));
        body.push(P(run(a.desc, { size: 10.5, color: GREY }), { indentCm: 0.4, spacing: { after: 80 } }));
      }
    }

    for (const o of (d.optional || [])) {
      body.push(P([run(L.optional, { bold: true, size: 10, color: ORANGE }), run(`${o.name} — ${o.price}`, { size: 10, color: GREY })], { indentCm: 0.4, spacing: { after: 40 } }));
    }
    if (d.shopping) {
      body.push(P([run(L.shopping, { bold: true, size: 10, color: SHOP }), run(d.shopping, { size: 10, color: GREY })], { indentCm: 0.4, spacing: { after: 40 } }));
    }
    if (d.closing) body.push(P(run(d.closing, { size: 11, color: GREY })));
    if (d.hotel) body.push(P([run(L.hotel, { bold: true, size: 11, color: NAVY }), run(d.hotel, { bold: true, size: 11, color: GREY })], { spacing: { before: 40 } }));
  }

  // pricing page
  body.push(new Paragraph({ children: [new PageBreak()] }));
  body.push(P(run(L.priceHeading, { bold: true, size: 15, color: NAVY })));
  body.push(spacer(2));
  body.push(priceTable(content.departure_label || '«TANGGAL»', L));

  body.push(P(run(L.noted, { bold: true, size: 10.5, color: RED }), { spacing: { before: 160 } }));
  for (const it of (content.noted || [])) body.push(P([run('· ', { size: 10.5, color: RED }), run(it, { size: 10.5, color: RED })], { indentCm: 0.4, spacing: { after: 20 } }));

  numberedSection(L.includes, content.termasuk || []).forEach(p => body.push(p));
  numberedSection(L.excludes, content.tidak || []).forEach(p => body.push(p));

  body.push(spacer(10));
  body.push(P(run(L.disclaimer, { bold: true, size: 11, color: GREY }), { align: AlignmentType.CENTER }));

  // header (every page): centered WeBuy logo only — no DMC / agency info ever
  const headerChildren = logo
    ? [new ImageRun({ type: 'png', data: logo, transformation: { width: 128, height: 47 } })]
    : [run('WEBUY Tour & Travel', { bold: true, size: 14, color: NAVY })];
  const header = new Header({
    children: [new Paragraph({
      children: headerChildren,
      alignment: AlignmentType.CENTER,
      border: { bottom: { style: BorderStyle.SINGLE, size: 14, color: NAVY, space: 1 } },
    })],
  });

  // footer (every page): WeBuy Tour & Travel | www.webuy.travel | year
  const footer = new Footer({
    children: [P(run(`WeBuy Tour & Travel | www.webuy.travel | ${new Date().getFullYear()}`, { size: 9, color: '8A94A6' }), { align: AlignmentType.CENTER })],
  });

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: 22 } } } },
    sections: [{
      properties: { page: { size: { width: PAGE_W, height: PAGE_H }, margin: { top: MARGIN_Y, right: MARGIN_X, bottom: MARGIN_Y, left: MARGIN_X } } },
      headers: { default: header },
      footers: { default: footer },
      children: body,
    }],
  });
  return Packer.toBuffer(doc);
}

module.exports = { buildQuoteDocx };
