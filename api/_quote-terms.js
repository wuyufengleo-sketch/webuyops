// ============================================================================
//  _quote-terms.js — FIXED WeBuy package terms (价格包含/不含/温馨提示).
//
//  These three blocks are standardised company copy, NOT LLM-generated, so the
//  wording is consistent and can't drift (e.g. an LLM inventing extra flight
//  legs). Only the pax count is dynamic ({PAX}, from the supplier quote).
//
//  Hotel & meals are intentionally NOT listed here — they already appear on the
//  per-day itinerary cards. Flight is "Jakarta round-trip" (no city) on purpose.
//
//  applyStdTerms(obj, lang, pax) overwrites obj.termasuk / obj.tidak / obj.noted.
// ============================================================================

const STD_TERMS = {
  zh: {
    termasuk: [
      '经济舱国际机票（雅加达往返），含符合航空公司规定的行李额度',
      '提供私人巴士',
      '行程中所列景点门票',
      'local guide',
      '中国团体签证',
      '旅行保险',
      '给导游和司机的小费',
      '增值税 1.1%',
    ],
    tidak: [
      '可选自费游览',
      '个人开支（电话费、迷你吧消费、洗衣费等）',
      '超重行李',
      '单人房附加费',
      '项目外的餐饮费用',
      '护照及其他个人证件费用',
      '套餐内未列出的任何项目',
    ],
    noted: [
      '以上价格仅适用于奖励旅游／私人定制旅游',
      '该报价自发出之日起有效期 3 天',
      '价格基于 {PAX} 人',
      '行程中旅游景点的参观顺序可根据实际情况调整，但不会减少参观景点的数量',
      '所列价格均为预估价格，在正式确认和付款之前不具约束力',
      '本文件并非预订证明或旅行确认函',
    ],
  },
  id: {
    termasuk: [
      'Tiket penerbangan internasional kelas ekonomi (Jakarta PP), termasuk bagasi sesuai ketentuan maskapai',
      'Bus pribadi',
      'Tiket masuk objek wisata sesuai program',
      'Local guide',
      'Visa rombongan Tiongkok',
      'Asuransi perjalanan',
      'Tipping untuk pemandu & sopir',
      'PPN 1,1%',
    ],
    tidak: [
      'Acara pilihan / optional tour',
      'Pengeluaran pribadi (telepon, mini bar, laundry, dll)',
      'Kelebihan bagasi',
      'Selisih kamar single',
      'Biaya makan di luar program',
      'Paspor dan dokumen pribadi lainnya',
      'Hal apa pun yang tidak tercantum dalam paket',
    ],
    noted: [
      'Harga di atas hanya berlaku untuk incentive / private tour',
      'Harga berlaku 3 hari sejak tanggal dikeluarkan',
      'Harga berdasarkan {PAX} Pax',
      'Urutan kunjungan objek wisata dapat berubah sesuai kondisi, tanpa mengurangi jumlah objek wisata',
      'Harga yang tercantum adalah estimasi dan tidak mengikat sebelum konfirmasi & pembayaran resmi',
      'Dokumen ini bukan bukti booking atau surat konfirmasi perjalanan',
    ],
  },
  en: {
    termasuk: [
      'International economy-class flight (Jakarta round-trip), incl. baggage per airline policy',
      'Private bus',
      'Entrance tickets for attractions listed in the itinerary',
      'Local guide',
      'China group visa',
      'Travel insurance',
      'Tipping for guide & driver',
      'VAT 1.1%',
    ],
    tidak: [
      'Optional tours',
      'Personal expenses (phone, mini bar, laundry, etc.)',
      'Excess baggage',
      'Single-room supplement',
      'Meals outside the program',
      'Passport and other personal documents',
      'Anything not listed in the package',
    ],
    noted: [
      'The above price applies to incentive / private tours only',
      'This quote is valid for 3 days from the date of issue',
      'Price based on {PAX} pax',
      'The order of sightseeing may change according to actual conditions, without reducing the number of attractions',
      'Listed prices are estimates and not binding before official confirmation & payment',
      'This document is not a booking proof or travel confirmation',
    ],
  },
  'zh-en': {
    termasuk: [
      '经济舱国际机票（雅加达往返），含航司规定行李额 (International economy-class flight, Jakarta round-trip, incl. baggage per airline policy)',
      '提供私人巴士 (Private bus)',
      '行程中所列景点门票 (Entrance tickets for listed attractions)',
      'local guide',
      '中国团体签证 (China group visa)',
      '旅行保险 (Travel insurance)',
      '给导游和司机的小费 (Tipping for guide & driver)',
      '增值税 1.1% (VAT 1.1%)',
    ],
    tidak: [
      '可选自费游览 (Optional tours)',
      '个人开支（电话、迷你吧、洗衣等）(Personal expenses: phone, mini bar, laundry, etc.)',
      '超重行李 (Excess baggage)',
      '单人房附加费 (Single-room supplement)',
      '项目外的餐饮费用 (Meals outside the program)',
      '护照及其他个人证件费用 (Passport and other personal documents)',
      '套餐内未列出的任何项目 (Anything not listed in the package)',
    ],
    noted: [
      '以上价格仅适用于奖励旅游／私人定制旅游 (The above price applies to incentive / private tours only)',
      '该报价自发出之日起有效期 3 天 (This quote is valid for 3 days from the date of issue)',
      '价格基于 {PAX} 人 (Price based on {PAX} pax)',
      '景点参观顺序可按实际调整，但不减少景点数量 (Sightseeing order may change, without reducing the number of attractions)',
      '所列价格为预估价，正式确认付款前不具约束力 (Listed prices are estimates, not binding before official confirmation & payment)',
      '本文件并非预订证明或旅行确认函 (This document is not a booking proof or travel confirmation)',
    ],
  },
};

// Pull the "based on N pax" figure from the supplier text, kept verbatim
// (e.g. "15", "7+1", "7+1/8+1", "20+1"). Returns '' if not found.
function extractPax(text) {
  const t = String(text || '');
  const pats = [
    /(\d+\s*\+\s*\d+(?:\s*\/\s*\d+\s*\+\s*\d+)*)\s*(?:人|pax)/i,   // 7+1人 / 7+1/8+1人
    /based\s*on\s*([\d+\/\s]+?)\s*pax/i,                            // based on 15 pax
    /成团人数[:：]?\s*(\d+)/,                                        // 成团人数:15
    /(\d+)\s*人(?:成团|起订|起)/,                                   // 15人成团
    /(\d+)\s*pax/i,                                                 // 15 pax
  ];
  for (const re of pats) {
    const m = t.match(re);
    if (m && m[1]) return m[1].replace(/\s+/g, '');
  }
  return '';
}

function normLang(lang) {
  return ['id', 'zh', 'en', 'zh-en'].includes(lang) ? lang : 'id';
}

// Overwrite the three terms blocks on `obj` with the fixed company copy for
// `lang`, filling the dynamic pax. `obj` is the base content or a translation.
function applyStdTerms(obj, lang, pax) {
  if (!obj) return obj;
  const t = STD_TERMS[normLang(lang)];
  const p = (pax && String(pax).trim()) || '____';
  obj.termasuk = t.termasuk.slice();
  obj.tidak = t.tidak.slice();
  obj.noted = t.noted.map(n => n.replace(/\{PAX\}/g, p));
  return obj;
}

module.exports = { STD_TERMS, extractPax, applyStdTerms };
