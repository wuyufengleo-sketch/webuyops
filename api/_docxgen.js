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
  Header, AlignmentType, BorderStyle, WidthType, ShadingType, VerticalAlign,
  TabStopType, PageBreak,
} = require('docx');

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

function priceTable(dep, price) {
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
        cell('DEPARTURE', w0, { fill: LIGHTBLUE, run: { bold: true, size: 11, color: NAVY } }),
        cell('ADLT / CHLD / TWIN / DBL', w1, { fill: LIGHTBLUE, run: { bold: true, size: 11, color: NAVY } }),
      ] }),
      new TableRow({ children: [
        cell(dep, w0, { run: { bold: true, size: 12, color: NAVY, highlight: true } }),
        cell(price, w1, { run: { bold: true, size: 12, color: NAVY, highlight: true } }),
      ] }),
    ],
  });
}

function numberedSection(heading, items) {
  const out = [P(run(heading, { bold: true, size: 12, color: BLUE }), { spacing: { before: 240 } })];
  items.forEach((it, i) => out.push(P([run(`${i + 1}. `, { bold: true, size: 10.5, color: NAVY }), run(it, { size: 10.5, color: GREY })], { indentCm: 0.6, spacing: { after: 40 } })));
  return out;
}

async function buildQuoteDocx(content, { logo, images } = {}) {
  const body = [];

  // title block
  body.push(P(run(content.trip.title, { bold: true, size: 20, color: NAVY }), { align: AlignmentType.CENTER, spacing: { before: 120 } }));
  body.push(P(run(content.trip.subtitle, { bold: true, size: 14, color: BLUE }), { align: AlignmentType.CENTER }));
  body.push(spacer(4));

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
      body.push(P(run('Destinasi hari ini:', { bold: true, size: 11, color: NAVY }), { spacing: { before: 40 } }));
      for (const a of d.attractions) {
        body.push(P(run(a.name, { bold: true, size: 11, color: NAVY }), { indentCm: 0.4, spacing: { after: 20 } }));
        body.push(P(run(a.desc, { size: 10.5, color: GREY }), { indentCm: 0.4, spacing: { after: 80 } }));
      }
    }

    for (const o of (d.optional || [])) {
      body.push(P([run('✨ Acara Pilihan (opsional, biaya sendiri): ', { bold: true, size: 10, color: ORANGE }), run(`${o.name} — ${o.price}`, { size: 10, color: GREY })], { indentCm: 0.4, spacing: { after: 40 } }));
    }
    if (d.shopping) {
      body.push(P([run('🛍️ Kunjungan Toko: ', { bold: true, size: 10, color: SHOP }), run(d.shopping, { size: 10, color: GREY })], { indentCm: 0.4, spacing: { after: 40 } }));
    }
    if (d.closing) body.push(P(run(d.closing, { size: 11, color: GREY })));
    if (d.hotel) body.push(P([run('🏨  Hotel: ', { bold: true, size: 11, color: NAVY }), run(d.hotel, { bold: true, size: 11, color: GREY })], { spacing: { before: 40 } }));
  }

  // pricing page
  body.push(new Paragraph({ children: [new PageBreak()] }));
  body.push(P(run('INFORMASI HARGA', { bold: true, size: 15, color: NAVY })));
  body.push(spacer(2));
  body.push(priceTable(content.departure_label || '«TANGGAL»', content.price_label || '«Rp ____________»'));

  body.push(P(run('Noted :', { bold: true, size: 10.5, color: RED }), { spacing: { before: 160 } }));
  for (const it of (content.noted || [])) body.push(P([run('· ', { size: 10.5, color: RED }), run(it, { size: 10.5, color: RED })], { indentCm: 0.4, spacing: { after: 20 } }));

  numberedSection('HARGA PAKET TERMASUK :', content.termasuk || []).forEach(p => body.push(p));
  numberedSection('HARGA PAKET TIDAK TERMASUK :', content.tidak || []).forEach(p => body.push(p));

  body.push(spacer(10));
  body.push(P(run('**Demi kelancaran Tour, flight detail dan tour masih bisa berubah sewaktu waktu tanpa mengurangi destinasi **', { bold: true, size: 11, color: GREY }), { align: AlignmentType.CENTER }));

  // header (every page)
  const headerChildren = [run('WEBUY Tour & Travel', { bold: true, size: 14, color: NAVY })];
  if (logo) {
    headerChildren.push(new TextRun({ text: '\t' }));
    headerChildren.push(new ImageRun({ type: 'png', data: logo, transformation: { width: 128, height: 47 } }));
  }
  const header = new Header({ children: [P(headerChildren, { tabRight: true, border: { bottom: { style: BorderStyle.SINGLE, size: 14, color: NAVY, space: 1 } } })] });

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: 22 } } } },
    sections: [{
      properties: { page: { size: { width: PAGE_W, height: PAGE_H }, margin: { top: MARGIN_Y, right: MARGIN_X, bottom: MARGIN_Y, left: MARGIN_X } } },
      headers: { default: header },
      children: body,
    }],
  });
  return Packer.toBuffer(doc);
}

module.exports = { buildQuoteDocx };
