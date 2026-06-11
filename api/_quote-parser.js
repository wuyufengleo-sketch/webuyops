const CN_ATTRACTIONS = [
  ['奥帆中心', 'Qingdao Olympic Sailing Center', 'Landmark tepi laut Qingdao dengan marina, panorama kota pesisir, dan suasana santai.', 'Qingdao Olympic Sailing Center seaside marina travel photography'],
  ['大鲍岛', 'Dabao Island Cultural Street', 'Kawasan historis Qingdao dengan bangunan klasik, jalan santai, dan suasana lokal.', 'Qingdao Dabao Island cultural leisure street travel photography'],
  ['青岛啤酒博物馆', 'Tsingtao Beer Museum', 'Museum ikonik Qingdao yang menampilkan sejarah bir Tsingtao dan pengalaman budaya kota.', 'Qingdao Tsingtao Beer Museum travel photography'],
  ['栈桥', 'Zhanqiao Pier', 'Dermaga klasik Qingdao yang menghadap laut dan menjadi ikon foto kota.', 'Qingdao Zhanqiao Pier seaside travel photography'],
  ['信号山', 'Signal Hill Park', 'Titik panorama Qingdao untuk melihat kota tua, laut, dan atap merah khas pesisir.', 'Qingdao Signal Hill Park red roof city panorama photography'],
  ['八大关', 'Badaguan Scenic Area', 'Kawasan vila klasik Qingdao dengan jalan rindang dan arsitektur Eropa.', 'Qingdao Badaguan Scenic Area autumn street travel photography'],
  ['明水古城', 'Mingshui Ancient City', 'Kota kuno bernuansa klasik dengan mata air, jalan tua, dan pertunjukan malam.', 'Jinan Mingshui Ancient City night travel photography'],
  ['李清照故居', 'Li Qingzhao Former Residence', 'Situs budaya yang mengenang penyair terkenal dengan taman dan arsitektur tradisional.', 'Jinan Li Qingzhao Former Residence garden photography'],
  ['大明湖', 'Daming Lake', 'Danau terkenal di Jinan dengan paviliun, willow, dan pemandangan air yang tenang.', 'Jinan Daming Lake scenic travel photography'],
  ['黑虎泉', 'Black Tiger Spring', 'Mata air terkenal Jinan dengan aliran jernih dan suasana kota tua.', 'Jinan Black Tiger Spring travel photography'],
  ['芙蓉街', 'Furong Street', 'Jalan kuliner populer Jinan dengan jajanan lokal dan suasana ramai.', 'Jinan Furong Street food street photography'],
  ['泰山风景区', 'Mount Tai Scenic Area', 'Gunung suci bersejarah dengan jalur megah, gerbang batu, dan panorama puncak.', 'Mount Tai Shandong sunrise mountain scenic photography'],
  ['泰山', 'Mount Tai', 'Gunung suci bersejarah dengan jalur megah, gerbang batu, dan panorama puncak.', 'Mount Tai Shandong sunrise mountain scenic photography'],
  ['南天门', 'Nantianmen Gate', 'Gerbang ikonik di puncak Mount Tai dengan lanskap pegunungan yang megah.', 'Mount Tai Nantianmen Gate scenic photography'],
  ['天街', 'Tianjie Street', 'Jalur puncak Mount Tai dengan suasana klasik di atas pegunungan.', 'Mount Tai Tianjie Heavenly Street photography'],
  ['玉皇顶', 'Jade Emperor Peak', 'Puncak utama Mount Tai untuk menikmati panorama luas dari ketinggian.', 'Mount Tai Jade Emperor Peak sunrise photography'],
  ['岱庙', 'Dai Temple', 'Kuil bersejarah di kaki Mount Tai dengan arsitektur kekaisaran.', 'Taian Dai Temple Shandong travel photography'],
  ['尼山圣境', 'Nishan Sacred Land', 'Kawasan budaya Konfusius dengan patung besar dan pertunjukan megah.', 'Qufu Nishan Sacred Land Confucius statue night photography'],
  ['孔府', 'Confucius Mansion', 'Kompleks kediaman bersejarah keluarga Konfusius dengan arsitektur klasik.', 'Qufu Confucius Mansion Shandong travel photography'],
  ['泡泡玛特城市乐园', 'Pop Mart City Park', 'Taman hiburan tematik modern dengan instalasi karakter dan spot foto penuh warna.', 'Beijing Pop Mart City Park travel photography'],
  ['天安门广场', 'Tiananmen Square', 'Alun-alun ikonik Beijing dengan landmark nasional dan suasana monumental.', 'Beijing Tiananmen Square travel photography'],
  ['故宫', 'Forbidden City', 'Kompleks istana klasik Beijing dengan gerbang merah, aula megah, dan sejarah kekaisaran.', 'Beijing Forbidden City palace travel photography'],
  ['王府井', 'Wangfujing Street', 'Jalan belanja terkenal Beijing dengan suasana kota dan kuliner populer.', 'Beijing Wangfujing street night photography'],
  ['居庸关长城', 'Juyongguan Great Wall', 'Bagian Great Wall yang megah dengan benteng dan panorama pegunungan.', 'Beijing Juyongguan Great Wall scenic photography'],
  ['鸟巢', 'Bird Nest Stadium', 'Stadion ikonik Olimpiade Beijing dengan arsitektur modern.', 'Beijing Bird Nest Stadium night photography'],
  ['水立方', 'Water Cube', 'Landmark Olimpiade Beijing dengan fasad biru yang futuristik.', 'Beijing Water Cube night photography'],
  ['海洪湿地公园', 'Haigeng Wetland Park', 'Taman wetland di tepi Danau Dianchi dengan suasana santai dan panorama air yang luas.', 'Kunming Haigeng Wetland Park Dianchi Lake travel photography'],
  ['滇池', 'Dianchi Lake', 'Danau besar ikon Kunming dengan pemandangan air dan pegunungan yang menenangkan.', 'Kunming Dianchi Lake scenic travel photography'],
  ['杏林大观园', 'Xinglin Grand View Garden', 'Area wisata bertema alam dan budaya dengan lanskap batu hitam yang khas.', 'Yunnan Xinglin Grand View Garden Black Stone Forest travel photo'],
  ['黑石林', 'Black Stone Forest', 'Formasi batu gelap yang unik, memberi nuansa dramatis untuk foto perjalanan.', 'Yunnan Black Stone Forest scenic travel photography'],
  ['金马碧鸡坊', 'Jinma Biji Archway', 'Gerbang bersejarah Kunming yang populer untuk berjalan santai dan berfoto.', 'Kunming Jinma Biji Archway night travel photography'],
  ['南屏步行街', 'Nanping Pedestrian Street', 'Kawasan pedestrian ramai di pusat kota Kunming untuk kuliner dan belanja ringan.', 'Kunming Nanping Pedestrian Street night market photography'],
  ['南强街巷', 'Nanqiang Night Market', 'Area kuliner malam dengan suasana lokal yang hidup.', 'Kunming Nanqiang Night Market street food photography'],
  ['理想邦', 'Ideal State Santorini Dali', 'Spot foto bergaya Santorini dengan panorama Danau Erhai dan bangunan putih yang fotogenik.', 'Dali Ideal State Santorini Erhai Lake travel photography'],
  ['圣托里尼', 'Ideal State Santorini Dali', 'Spot foto bergaya Santorini dengan panorama Danau Erhai dan bangunan putih yang fotogenik.', 'Dali Ideal State Santorini Erhai Lake travel photography'],
  ['大理古城', 'Dali Ancient Town', 'Kota tua Dali dengan jalan klasik, budaya Bai, dan suasana santai khas Yunnan.', 'Dali Ancient Town Yunnan travel photography'],
  ['洋人街', 'Foreigner Street', 'Jalan populer di Dali Ancient Town dengan toko kecil, kafe, dan nuansa kota tua.', 'Dali Foreigner Street Ancient Town travel photography'],
  ['喜洲古镇', 'Xizhou Ancient Town', 'Kota tua etnis Bai dengan arsitektur tradisional dan sudut foto klasik.', 'Dali Xizhou Ancient Town Bai architecture photography'],
  ['转角楼', 'Corner Building', 'Bangunan sudut ikonik di Xizhou yang sering menjadi spot foto perjalanan.', 'Dali Xizhou Corner Building travel photography'],
  ['花语牧场', 'Flower Language Ranch', 'Area taman bunga musiman yang cocok untuk foto warna-warni.', 'Dali Flower Language Ranch flower field photography'],
  ['洱海生态廊道', 'Erhai Ecological Corridor', 'Jalur tepi Danau Erhai dengan pemandangan air biru, desa, dan pegunungan.', 'Dali Erhai Ecological Corridor lake travel photography'],
  ['S湾', 'Erhai S-Bay', 'Tikungan tepi Danau Erhai yang terkenal untuk foto perjalanan.', 'Dali Erhai S Bay road lake photography'],
  ['音乐车唱游洱海', 'Music Bus Around Erhai Lake', 'Pengalaman berkeliling Danau Erhai dengan musik, foto grup, dan suasana ceria.', 'Dali Erhai Lake music bus travel photography'],
  ['沙溪古镇', 'Shaxi Ancient Town', 'Kota kuno di jalur Tea Horse Road dengan jalan batu, panggung kuno, dan nuansa tenang.', 'Shaxi Ancient Town Yunnan Tea Horse Road photography'],
  ['古戏台', 'Ancient Theatre Stage', 'Panggung kuno khas Shaxi yang menjadi ikon kota tua.', 'Shaxi Ancient Theatre Stage Yunnan photography'],
  ['寺登街', 'Sideng Street', 'Jalan tua utama Shaxi dengan bangunan kayu dan suasana klasik.', 'Shaxi Sideng Street ancient town photography'],
  ['玉津桥', 'Yujin Bridge', 'Jembatan batu klasik di Shaxi dengan lanskap desa dan sungai.', 'Shaxi Yujin Bridge Yunnan travel photography'],
  ['玉龙雪山', 'Jade Dragon Snow Mountain', 'Pegunungan salju ikonik Lijiang dengan panorama alpine yang megah.', 'Lijiang Jade Dragon Snow Mountain scenic travel photography'],
  ['冰川公园', 'Glacier Park', 'Area tinggi di Jade Dragon Snow Mountain dengan pemandangan gletser dan puncak salju.', 'Jade Dragon Snow Mountain Glacier Park photography'],
  ['甘海子', 'Ganhaizi Meadow', 'Padang rumput terbuka dengan latar Jade Dragon Snow Mountain.', 'Lijiang Ganhaizi Meadow Jade Dragon Snow Mountain photography'],
  ['白水河', 'Baishui River', 'Aliran air jernih di kaki pegunungan dengan warna biru kehijauan.', 'Lijiang Baishui River Jade Dragon Snow Mountain photography'],
  ['蓝月谷', 'Blue Moon Valley', 'Lembah air biru turquoise yang menjadi salah satu spot tercantik di Lijiang.', 'Lijiang Blue Moon Valley turquoise water photography'],
  ['印象丽江', 'Impression Lijiang', 'Pertunjukan outdoor berskala besar dengan latar Jade Dragon Snow Mountain.', 'Impression Lijiang show Jade Dragon Snow Mountain photography'],
  ['丽江古城', 'Lijiang Ancient Town', 'Kota tua warisan budaya dengan kanal, jalan batu, dan suasana malam yang indah.', 'Lijiang Ancient Town night travel photography'],
  ['四方街', 'Sifang Street', 'Alun-alun pusat Lijiang Ancient Town yang ramai dan klasik.', 'Lijiang Sifang Street ancient town photography'],
  ['长江第一湾', 'First Bend of Yangtze River', 'Panorama lekukan Sungai Yangtze yang terkenal di rute menuju Shangri-La.', 'First Bend of Yangtze River Yunnan photography'],
  ['虎跳峡', 'Tiger Leaping Gorge', 'Ngarai spektakuler dengan tebing tinggi dan arus sungai yang kuat.', 'Tiger Leaping Gorge Yunnan canyon photography'],
  ['独克宗古城', 'Dukezong Ancient Town', 'Kota tua Tibet di Shangri-La dengan arsitektur khas dan suasana budaya yang kuat.', 'Shangri-La Dukezong Ancient Town night photography'],
  ['龟山公园', 'Guishan Park', 'Taman ikonik dengan prayer wheel raksasa dan panorama kota tua.', 'Shangri-La Guishan Park giant prayer wheel photography'],
  ['巴拉格宗', 'Balagezong Grand Canyon', 'Kawasan ngarai megah dengan desa Bala, tebing tinggi, dan panorama pegunungan.', 'Balagezong Grand Canyon Shangri-La travel photography'],
  ['巴拉村', 'Bala Village', 'Desa pegunungan di Balagezong dengan lanskap alam dan budaya Tibet.', 'Balagezong Bala Village Shangri-La photography'],
  ['格宗神山', 'Gezong Snow Mountain', 'Pemandangan gunung suci bersalju di area Balagezong.', 'Balagezong Gezong Snow Mountain photography'],
  ['回音壁', 'Echo Wall', 'Tebing tinggi di Balagezong dengan lanskap dramatis.', 'Balagezong Echo Wall cliff photography'],
  ['高空栈道', 'High-altitude Plank Road', 'Jalur tebing tinggi dengan pengalaman panorama ngarai yang menegangkan.', 'Balagezong high altitude plank road photography'],
  ['悬崖玻璃观景台', 'Glass Viewing Platform', 'Platform kaca di tebing Balagezong untuk melihat panorama ngarai.', 'Balagezong glass viewing platform canyon photography'],
  ['望仙谷', 'Wangxian Valley', 'Lembah wisata bergaya kuno dengan tebing, rumah gantung, lampu malam, dan suasana Jiangnan yang dramatis.', 'Wangxian Valley Jiangxi dusk night cliff village lantern bridge panorama travel photography'],
  ['解放碑', 'Jiefangbei Pedestrian Street', 'Landmark pusat kota Chongqing yang ramai dengan area belanja dan suasana urban.', 'Chongqing Jiefangbei Pedestrian Street night city photography'],
  ['洪崖洞', 'Hongyadong', 'Kompleks bangunan panggung ikonik Chongqing yang paling memukau saat malam dengan lampu keemasan di tepi sungai.', 'Chongqing Hongyadong night view illuminated stilted buildings riverside panorama travel photography'],
  ['洪亚洞', 'Hongyadong', 'Kompleks bangunan panggung ikonik Chongqing yang paling memukau saat malam dengan lampu keemasan di tepi sungai.', 'Chongqing Hongyadong night view illuminated stilted buildings riverside panorama travel photography'],
  ['洪崖洞民俗风貌区', 'Hongyadong', 'Kompleks bangunan panggung ikonik Chongqing yang paling memukau saat malam dengan lampu keemasan di tepi sungai.', 'Chongqing Hongyadong night view illuminated stilted buildings riverside panorama travel photography'],
  ['千厮门大桥', 'Qiansimen Bridge', 'Jembatan ikonik Chongqing yang menampilkan panorama sungai dan skyline kota, terutama indah saat malam.', 'Chongqing Qiansimen Bridge Hongyadong night skyline photography'],
  ['陆家嘴空中连廊', 'Lujiazui Skywalk', 'Jalur pejalan kaki futuristik di distrik finansial Shanghai dengan panorama gedung pencakar langit.', 'Shanghai Lujiazui Skywalk cityscape photography'],
  ['东方明珠', 'Oriental Pearl Tower', 'Menara ikonik Shanghai yang menjadi simbol skyline Pudong.', 'Shanghai Oriental Pearl Tower skyline photography'],
  ['外滩', 'The Bund', 'Kawasan waterfront klasik Shanghai dengan pemandangan gedung kolonial dan skyline Pudong.', 'Shanghai The Bund night skyline photography'],
  ['南京路', 'Nanjing Road', 'Jalan belanja terkenal di Shanghai dengan lampu kota dan suasana urban yang ramai.', 'Shanghai Nanjing Road night street photography'],
  ['武康路', 'Wukang Road', 'Jalan bersejarah Shanghai dengan bangunan bergaya Eropa, kafe, dan spot foto populer.', 'Shanghai Wukang Road travel photography'],
  ['田子坊', 'Tianzifang', 'Area lorong kreatif Shanghai dengan butik kecil, kafe, dan suasana seni lokal.', 'Shanghai Tianzifang alley travel photography'],
  ['安福路', 'Anfu Road', 'Jalan trendi Shanghai dengan kafe, butik, dan nuansa lifestyle kota.', 'Shanghai Anfu Road cafe street photography'],
  ['城隍庙', 'City God Temple', 'Kawasan klasik Shanghai dengan arsitektur tradisional, kuliner, dan toko suvenir.', 'Shanghai City God Temple old town photography'],
  ['成都天府机场', 'Chengdu Tianfu International Airport', 'Bandara modern Chengdu sebagai titik kedatangan untuk memulai perjalanan.', 'Chengdu Tianfu International Airport travel photography'],
  ['SKP商场', 'Chengdu SKP', 'Kompleks belanja modern Chengdu dengan arsitektur kontemporer dan area lifestyle.', 'Chengdu SKP shopping mall architecture photography'],
  ['生命之塔', 'Tower of Life', 'Landmark malam Chengdu dengan pencahayaan modern dan suasana kota yang hidup.', 'Chengdu Tower of Life night photography'],
  ['双子塔', 'Chengdu Twin Towers', 'Ikon skyline Chengdu yang populer untuk foto malam kota.', 'Chengdu Twin Towers night skyline photography'],
  ['熊猫基地', 'Chengdu Research Base of Giant Panda Breeding', 'Area konservasi panda raksasa yang menjadi ikon wisata Chengdu.', 'Chengdu Research Base of Giant Panda Breeding panda photography'],
  ['宽窄巷子', 'Kuanzhai Alley', 'Kawasan jalan tua Chengdu dengan arsitektur tradisional, kafe, dan kuliner lokal.', 'Chengdu Kuanzhai Alley old street travel photography'],
  ['锦里古街', 'Jinli Ancient Street', 'Jalan kuno bergaya Sichuan dengan suasana budaya, jajanan, dan lampion malam.', 'Chengdu Jinli Ancient Street night travel photography'],
  ['熊猫爬墙雕塑', 'IFS Panda Sculpture', 'Patung panda ikonik yang memanjat gedung, spot foto populer di pusat Chengdu.', 'Chengdu IFS Panda climbing wall sculpture photography'],
];

const ROUTE_ALIASES = [
  ['印尼/青岛', 'INDONESIA - QINGDAO'],
  ['青岛/济南', 'QINGDAO - JINAN'],
  ['济南/泰安', 'JINAN - TAIAN'],
  ['泰安/曲阜', 'TAIAN - QUFU'],
  ['曲阜/青岛', 'QUFU - QINGDAO'],
  ['曲阜/开封', 'QUFU - KAIFENG'],
  ['青岛送机', 'QINGDAO - DEPARTURE'],
  ['奥帆中心', 'QINGDAO CITY TOUR'],
  ['青岛啤酒博物馆', 'QINGDAO - JINAN'],
  ['大明湖', 'JINAN - TAIAN'],
  ['泰山', 'TAIAN - QUFU'],
  ['三孔', 'QUFU - QINGDAO'],
  ['北京机场接机', 'ARRIVAL - BEIJING'],
  ['泡泡玛特城市乐园', 'BEIJING CITY TOUR'],
  ['天安门广场', 'BEIJING CITY TOUR'],
  ['居庸关长城', 'BEIJING GREAT WALL TOUR'],
  ['北京送高铁', 'BEIJING - DEPARTURE'],
  ['北京-上饶', 'BEIJING - SHANGRAO'],
  ['北京/上饶', 'BEIJING - SHANGRAO'],
  ['望仙谷一日游', 'SHANGRAO - WANGXIAN VALLEY - SHANGRAO'],
  ['前往上海', 'SHANGRAO - SHANGHAI'],
  ['洪崖洞', 'CHONGQING - HONGYADONG NIGHT VIEW'],
  ['洪亚洞', 'CHONGQING - HONGYADONG NIGHT VIEW'],
  ['武康路', 'SHANGHAI CITY TOUR'],
  ['上海送机', 'SHANGHAI - DEPARTURE'],
  ['印尼/昆明', 'INDONESIA - KUNMING'],
  ['昆明/石林县', 'KUNMING - SHILIN - KUNMING'],
  ['昆明/大理', 'KUNMING - DALI'],
  ['大理一地', 'DALI'],
  ['大理/沙溪古镇', 'DALI - SHAXI ANCIENT TOWN - LIJIANG'],
  ['玉龙雪山', 'LIJIANG - JADE DRAGON SNOW MOUNTAIN'],
  ['丽江/虎跳峡/香格里拉', 'LIJIANG - TIGER LEAPING GORGE - SHANGRI-LA'],
  ['香格里拉/巴拉格宗', 'SHANGRI-LA - BALAGEZONG - SHANGRI-LA'],
  ['乘坐（动车）：香格里拉/昆明', 'SHANGRI-LA - KUNMING'],
  ['昆明/印尼', 'KUNMING - INDONESIA'],
  ['成都天府机场', 'INDONESIA - CHENGDU'],
  ['接站', 'ARRIVAL - CHENGDU'],
  ['成都市内', 'CHENGDU CITY TOUR'],
  ['熊猫基地', 'CHENGDU CITY TOUR'],
  ['送机', 'CHENGDU - DEPARTURE'],
];

const MONTH_ID = {
  1: 'Januari', 2: 'Februari', 3: 'Maret', 4: 'April', 5: 'Mei', 6: 'Juni',
  7: 'Juli', 8: 'Agustus', 9: 'September', 10: 'Oktober', 11: 'November', 12: 'Desember',
};

const HOTEL_ALIASES = [
  [/维居|金鹰/i, 'Weiju Jinying Hotel Kunming atau setara Ctrip 4 Diamond'],
  [/兰林阁|万达美/i, 'Lanlinge Hotel Dali / Wanda Meihua Hotel Dali atau setara Ctrip 4 Diamond'],
  [/亚俪|拾光/i, 'Yali Hotel Lijiang / Shiguang Chengjing Hotel Lijiang atau setara Ctrip 4 Diamond'],
  [/蜀锦|兰欧/i, 'Shujin Hotel Shangri-La / Lanou Hotel Shangri-La atau setara Ctrip 4 Diamond'],
  [/饶派数字文创/i, 'Raopai Digital Cultural Creative Hotel Shangrao atau setara 4 Diamond'],
  [/上海瑞斯国际/i, 'Rezen International Hotel Shanghai Wildlife Park atau setara 4 Diamond'],
  [/浣花溪智选假日/i, 'Holiday Inn Express Chengdu Huanhuaxi atau setara 4 Diamond'],
];

function cleanText(s) {
  return String(s || '')
    .replace(/\u0007/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cnDayNumber(raw) {
  const s = String(raw || '').trim();
  if (/^\d+$/.test(s)) return Number(s);
  const map = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (s === '十') return 10;
  const m1 = s.match(/^十([一二两三四五六七八九])$/);
  if (m1) return 10 + map[m1[1]];
  const m2 = s.match(/^([一二两三四五六七八九])十$/);
  if (m2) return map[m2[1]] * 10;
  const m3 = s.match(/^([一二两三四五六七八九])十([一二两三四五六七八九])$/);
  if (m3) return map[m3[1]] * 10 + map[m3[2]];
  return map[s] || null;
}

function titleFromText(text) {
  const first = cleanText(text).split('\n').find(x => /昆明|大理|丽江|香格里拉|巴拉格宗|D|天|日/i.test(x)) || 'WEBUY Customer Itinerary';
  if (/山东|青岛|济南|泰安|曲阜|泰山/.test(text)) return 'Pesona Shandong';
  if (/昆明|大理|丽江|香格里拉|巴拉格宗/.test(first)) return 'Shangri-La Yang Memukau';
  if (/重庆|洪崖洞|洪亚洞|解放碑/.test(text)) return 'Pesona Chongqing';
  if (/成都|熊猫|宽窄巷子|锦里/.test(text)) return 'Pesona Chengdu';
  if (/江南|上饶|望仙谷|外滩|南京路/.test(text)) return 'Pesona Jiangnan & Shanghai';
  if (/北京|天安门|故宫|长城|王府井/.test(text)) return 'Pesona Beijing';
  return first.replace(/^[*#\d\s]+/, '').slice(0, 80);
}

function splitDays(text) {
  let src = cleanText(text);
  const stop = src.search(/团队接待标准|已含内容|未含内容|进店安排|团费报价|用餐说明|小费说明|报价说明/);
  if (stop > 0) src = src.slice(0, stop);

  const lines = src.split('\n');
  const explicitHits = [];
  const dateHits = [];
  const lineOffsets = [];
  let offset = 0;
  let dateSeq = 1;
  const dayLine = (line, allowDateFallback = false) => {
    const s = String(line || '').trim();
    if (!s) return null;
    let m = s.match(/^D\s*(\d{1,2})(?:\b|天|日)/i);
    if (m) return Number(m[1]);
    m = s.match(/^DAY\s*(\d{1,2})(?:\b|[:：.\-\s])/i);
    if (m) return Number(m[1]);
    m = s.match(/^第\s*([一二两三四五六七八九十\d]{1,3})\s*天/);
    if (m) return cnDayNumber(m[1]);
    m = s.match(/^([一二两三四五六七八九十]{1,3})天/);
    if (m) return cnDayNumber(m[1]);
    // Some land operators omit day labels and use date headings only.
    // Treat a standalone "10/05 成都..." style line as the next day, but avoid
    // generic year/month lines such as "出发日期：2026年10月".
    if (!allowDateFallback) return null;
    if (/^\d{1,2}[\/.\-]\d{1,2}(?:\s|$)/.test(s)) return dateSeq;
    if (/^\d{1,2}\s*月\s*\d{1,2}\s*日/.test(s)) return dateSeq;
    return null;
  };
  for (const line of lines) {
    lineOffsets.push(offset);
    const explicitNo = dayLine(line, false);
    if (explicitNo) explicitHits.push({ dayNo: explicitNo, index: offset });
    const dateNo = explicitNo ? null : dayLine(line, true);
    if (dateNo) {
      dateHits.push({ dayNo: dateNo, index: offset });
      dateSeq++;
    }
    offset += line.length + 1;
  }

  const standaloneHits = standaloneNumberDayHits(lines, lineOffsets);
  const hits = explicitHits.length ? chooseBestDayHitSequence(explicitHits, src) : (standaloneHits.length ? standaloneHits : dateHits);
  return hits.map((hit, i) => {
    const next = hits[i + 1] ? hits[i + 1].index : src.length;
    return { dayNo: hit.dayNo, text: src.slice(hit.index, next).trim() };
  }).filter(d => d.dayNo > 0 && d.text.length > 10);
}

function standaloneNumberDayHits(lines, offsets) {
  const raw = [];
  for (let i = 0; i < lines.length; i++) {
    const s = String(lines[i] || '').trim();
    if (!/^\d{1,2}$/.test(s)) continue;
    const n = Number(s);
    if (n < 1 || n > 30) continue;
    raw.push({ dayNo: n, index: offsets[i], lineIndex: i });
  }
  if (!raw.length) return [];
  const groups = [];
  let cur = [];
  for (const h of raw) {
    const prev = cur[cur.length - 1];
    if (prev && h.dayNo !== prev.dayNo + 1) {
      if (cur.length) groups.push(cur);
      cur = [];
    }
    cur.push(h);
  }
  if (cur.length) groups.push(cur);

  const viable = groups.filter(g => {
    if (g.length < 2 || g[0].dayNo !== 1) return false;
    return g.some(h => {
      const nextText = lines.slice(h.lineIndex + 1, h.lineIndex + 5).join(' ');
      return /[\/／]|机场|酒店|游览|早餐|午餐|晚餐|入住|前往|抵达|参观|送机|arrival|depart|visit|hotel/i.test(nextText);
    });
  });
  if (!viable.length) return [];
  return viable.sort((a, b) => b.length - a.length)[0].map(({ dayNo, index }) => ({ dayNo, index }));
}

function chooseBestDayHitSequence(hits, src) {
  if (!hits.length) return hits;
  const groups = [];
  let cur = [];
  for (const h of hits) {
    if (cur.length && h.dayNo <= cur[cur.length - 1].dayNo) {
      groups.push(cur);
      cur = [];
    }
    cur.push(h);
  }
  if (cur.length) groups.push(cur);
  if (groups.length === 1) return hits;
  const score = (group, groupIndex) => {
    const groupEnd = groups[groupIndex + 1] ? groups[groupIndex + 1][0].index : src.length;
    let chars = 0;
    for (let i = 0; i < group.length; i++) {
      const start = group[i].index;
      const next = group[i + 1] ? group[i + 1].index : groupEnd;
      chars += Math.max(0, next - start);
    }
    return chars + group.length * 100;
  };
  return groups
    .map((group, index) => ({ group, score: score(group, index) }))
    .sort((a, b) => b.score - a.score)[0].group;
}

function looksLikeJunk(s) {
  const t = String(s || '').trim();
  if (!t) return true;
  // pure punctuation / separators / very short → useless as a title
  return /^[\s,./·\-、，。:：;；|\\]+$/.test(t) || t.replace(/[\s,./·\-、，。:：;；|\\]/g, '').length < 2;
}

function stripDayHeading(s) {
  return String(s || '')
    .replace(/^\d{1,2}\s*$/i, '')
    .replace(/^D\s*\d+(?:天|日)?\s*[:：.\-]?\s*/i, '')
    .replace(/^DAY\s*\d+\s*[:：.\-]?\s*/i, '')
    .replace(/^第\s*[一二两三四五六七八九十\d]{1,3}\s*天\s*/i, '')
    .replace(/^[一二两三四五六七八九十]{1,3}天\s*/i, '')
    .replace(/^\d{1,2}[\/.\-]\d{1,2}\s*/, '')
    .replace(/^\d{1,2}\s*月\s*\d{1,2}\s*日\s*/, '')
    .trim();
}

function routeTitle(block) {
  if (/送机/.test(block)) {
    if (/TFU|天府|成都/i.test(block)) return 'CHENGDU - DEPARTURE';
    if (/PVG|SHA|浦东|虹桥|上海/i.test(block)) return 'SHANGHAI - DEPARTURE';
    return 'DEPARTURE';
  }
  for (const [needle, title] of ROUTE_ALIASES) if (block.includes(needle)) return title;
  const candidate = (block.split('\n').map(stripDayHeading).find(x => !looksLikeJunk(x)) || '')
    .replace(/^\d{1,2}[-/.]\d{1,2}日?\s*/, '')
    .replace(/^行程[：:]\s*/, '')
    .trim()
    .split(/AIR|BUS|DRIVER|GUIDE|MEALS?:|L：|D：|酒店|住宿|早餐：|中餐：|晚餐：|\((?:NO MEAL|B|L|D|BUFFET|LUNCH|[,/\s])+\)/i)[0]
    .trim().slice(0, 80);
  if (/[\u3400-\u9fff]/.test(candidate)) {
    const pieces = candidate
      .split(/[，,。；;、]/)
      .map(x => stripChinese(x))
      .map(x => x.replace(/[\/／]+/g, ' - ').replace(/\s+/g, ' ').trim())
      .filter(x => !looksLikeJunk(x));
    if (pieces.length) return pieces[0].toUpperCase();
  }
  return looksLikeJunk(candidate) ? '' : candidate;
}

function mealCode(block) {
  const meals = [];
  // The single-letter markers MUST be fully bounded (\bL\b, not L\b): a trailing
  // \b alone matches any uppercase word ending in L/D — "NO MEAL", "HOTEL",
  // "GRAND", "CHECK IN" — fabricating meals the source never listed.
  if (/早餐|酒店含早|\bB\b/.test(block)) meals.push('B');
  if (/L：|午[：:]|午餐|中餐|\bL\b/.test(block)) meals.push('L');
  if (/D：|晚[：:]|晚餐|\bD\b/.test(block)) meals.push('D');
  return [...new Set(meals)].join('/');
}

function hotel(block) {
  const lines = block.split('\n').map(x => x.trim()).filter(Boolean);
  const candidates = lines.filter(x =>
    /维居|金鹰|兰林阁|万达美|亚俪|拾光|蜀锦|兰欧|饶派数字文创|上海瑞斯国际|浣花溪智选假日|酒店|Hotel|hotel|同级携程|equivalent|star/i.test(x) &&
    x.length <= 120 &&
    !/报价|房费|酒店含早|安排入住|入住酒店|接机|休息|抵达|中心|选择|根据航班|行程|check into|visit|breakfast|lunch|dinner|after|transfer|pick you up|start the trip|arriving|stay overnight|overnight|price of extend/i.test(x)
  );
  const aliasLine = candidates.find(x => HOTEL_ALIASES.some(([re]) => re.test(x)));
  const englishLine = candidates.find(x => /[A-Za-z]/.test(x) && /(Hotel|hotel|equivalent|star)/i.test(x));
  const h = aliasLine || englishLine || candidates[0];
  if (!h) return '';
  for (const [re, label] of HOTEL_ALIASES) if (re.test(h)) return label;
  const cleaned = stripChinese(h.replace(/^或/, '').replace(/\s+/g, ' '));
  if (looksLikeJunk(cleaned) || /^[\d\s*★]+$/.test(cleaned)) return '';
  return cleaned;
}

function attractions(block) {
  const out = [];
  const seen = new Set();
  for (const [cn, name, desc, imageQuery] of CN_ATTRACTIONS) {
    if (!block.includes(cn)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name: `【${name}】`, desc, imageQuery });
  }
  return out.slice(0, 6);
}

function introFor(d) {
  if (/WANGXIAN/.test(d.routeTitle)) return 'Mengunjungi Wangxian Valley, area wisata bergaya kuno yang terkenal dengan pemandangan tebing, bangunan tradisional, dan suasana malam yang fotogenik.';
  if (/SHANGRAO - SHANGHAI/.test(d.routeTitle)) return 'Perjalanan menuju Shanghai dan menikmati landmark kota modern, kawasan waterfront, serta jalan belanja ikonik.';
  if (/SHANGHAI CITY TOUR/.test(d.routeTitle)) return 'City tour Shanghai mengunjungi area lifestyle, kawasan kreatif, dan spot klasik kota.';
  if (/ARRIVAL - CHENGDU|INDONESIA - CHENGDU/.test(d.routeTitle)) return 'Tiba di Chengdu, kemudian mengikuti pengaturan kedatangan dan beristirahat di hotel. Bila waktu memungkinkan, peserta dapat menikmati area kota sesuai kondisi operasional.';
  if (/CHENGDU CITY TOUR/.test(d.routeTitle)) return 'City tour Chengdu mengunjungi ikon panda, kawasan jalan tua, dan spot foto populer kota.';
  if (/CHENGDU - DEPARTURE/.test(d.routeTitle)) return 'Sarapan di hotel, kemudian transfer ke bandara sesuai jadwal penerbangan untuk perjalanan berikutnya.';
  if (/DEPARTURE/.test(d.routeTitle)) return 'Sarapan di hotel, kemudian transfer ke bandara sesuai jadwal penerbangan.';
  if (/BEIJING - SHANGRAO/.test(d.routeTitle)) return 'Berangkat dari Beijing menuju Shangrao dengan kereta cepat, kemudian check-in hotel dan beristirahat.';
  if (d.dayNo === 1) return 'Tiba di Kunming, kota yang dikenal sebagai Spring City. Setibanya di bandara, peserta akan disambut dan diantar menuju hotel untuk check-in serta beristirahat.';
  if (/INDONESIA|KUNMING - INDONESIA/.test(d.routeTitle)) return 'Transfer ke bandara sesuai jadwal penerbangan. Tour selesai dengan kenangan indah dari Yunnan.';
  if (/TRAIN|KUNMING/.test(d.routeTitle) && d.text.includes('动车')) return 'Naik kereta cepat dari Shangri-La menuju Kunming dengan kursi kelas dua. Bagasi akan diatur menggunakan kendaraan terpisah sesuai operasional.';
  const spots = d.attractions.slice(0, 3).map(a => a.name.replace(/[【】]/g, '')).filter(Boolean);
  if (spots.length) return `Perjalanan hari ini mengunjungi ${spots.join(', ')}.`;
  if (d.routeTitle && !looksLikeJunk(d.routeTitle)) return `Hari ini mengikuti program ${d.routeTitle} sesuai pengaturan operasional. Detail akan dikonfirmasi pemandu sebelum keberangkatan.`;
  return 'Hari ini mengikuti pengaturan operasional ground handler. Urutan acara, restoran, dan waktu pemberangkatan dapat menyesuaikan kondisi lapangan dan akan dikonfirmasi pemandu.';
}

function shopping(block) {
  const shops = [];
  if (/珠宝/.test(block)) shops.push('jewelry store');
  if (/虾青素店/.test(block)) shops.push('astaxanthin store');
  if (/药材店|同仁堂/.test(block)) shops.push('herbal medicine store');
  if (/丝绸店/.test(block)) shops.push('silk store');
  if (/车贩产品|土特产|旅游纪念品|珍珠膏/.test(block)) shops.push('souvenir products on bus, optional purchase');
  return shops.join(', ');
}

function departureLabel(text) {
  const m = text.match(/(20\d{2})年\s*(\d{1,2})月/);
  if (m) return `${MONTH_ID[Number(m[2])] || 'Bulan'} ${m[1]}`;
  return '«TANGGAL»';
}

function stripChinese(value) {
  return String(value || '')
    .replace(/[\u3400-\u9fff]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function removeChineseDeep(value) {
  if (Array.isArray(value)) return value.map(removeChineseDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = removeChineseDeep(v);
    return out;
  }
  return typeof value === 'string' ? stripChinese(value) : value;
}

function parseRuleBasedQuote(landText) {
  const text = cleanText(landText);
  const rawDays = splitDays(text);
  const days = rawDays.map(d => {
    const day = {
      dayNo: d.dayNo,
      routeTitle: routeTitle(d.text),
      mealCode: mealCode(d.text),
      intro: '',
      attractions: attractions(d.text),
      optional: [],
      shopping: shopping(d.text),
      hotel: hotel(d.text),
      closing: '',
    };
    day.intro = introFor({ ...day, text: d.text });
    return day;
  });

  const title = titleFromText(text);
  const maxDay = days.reduce((m, d) => Math.max(m, Number(d.dayNo) || 0), 0);
  return removeChineseDeep({
    trip: {
      title,
      subtitle: /昆明|大理|丽江|香格里拉|巴拉格宗/.test(text)
        ? 'Kunming - Dali - Shaxi Ancient Town - Lijiang - Shangri-La - Balagezong · 10 Hari 9 Malam'
        : /山东|青岛|济南|泰安|曲阜|泰山/.test(text)
          ? `Qingdao - Jinan - Taian - Qufu - Kaifeng · ${maxDay || 6} Hari ${Math.max((maxDay || 6) - 1, 1)} Malam`
        : /重庆|洪崖洞|洪亚洞|解放碑/.test(text)
          ? `Chongqing City Tour · ${maxDay || 5} Hari ${Math.max((maxDay || 5) - 1, 1)} Malam`
        : /成都|熊猫|宽窄巷子|锦里/.test(text)
          ? `Chengdu City Tour · ${maxDay || 3} Hari ${Math.max((maxDay || 3) - 1, 1)} Malam`
        : /江南|上饶|望仙谷|外滩|南京路/.test(text)
          ? 'Shangrao - Wangxian Valley - Shanghai · 5 Hari 4 Malam'
        : /北京|天安门|故宫|长城|王府井/.test(text)
          ? `Beijing City Tour · ${maxDay || 4} Hari ${Math.max((maxDay || 4) - 1, 1)} Malam`
          : 'Customer itinerary draft',
    },
    departure_label: departureLabel(text),
    days,
    termasuk: [
      'Akomodasi hotel sesuai program atau setara.',
      'Makan sesuai jadwal perjalanan.',
      'Tiket masuk objek wisata pertama sesuai itinerary.',
      'Bus pariwisata ber-AC selama perjalanan.',
      'Kereta cepat satu arah Shangri-La - Kunming, kursi kelas dua, bila tercantum pada program.',
      'Pemandu lokal sesuai pengaturan.',
      'Air mineral 1 botol per orang per hari.',
      'Asuransi perjalanan group sesuai ketentuan supplier.',
    ],
    tidak: [
      'Tiket pesawat internasional dan airport tax, kecuali bila tertulis termasuk pada penawaran final.',
      'Visa, tipping, dan pengeluaran pribadi.',
      'Biaya single room supplement.',
      'Optional tour atau aktivitas yang tertulis tidak termasuk.',
      'Biaya lain yang tidak tercantum pada bagian Harga Termasuk.',
    ],
    noted: [
      'Draft ini dibuat otomatis dari dokumen supplier dan perlu review OPS sebelum dikirim ke customer.',
      'Urutan perjalanan, hotel, transportasi, dan restoran dapat berubah mengikuti kondisi operasional.',
      'Harga final mengikuti tanggal, jumlah peserta, kurs, dan ketersediaan saat booking.',
    ],
  });
}

function makeImageSearches(content) {
  const seen = new Set();
  const out = [];
  for (const d of content.days || []) {
    for (const a of d.attractions || []) {
      const query = String(a.imageQuery || a.name || d.routeTitle || '').replace(/[【】]/g, '').trim();
      if (!query) continue;
      const key = query.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        dayNo: d.dayNo,
        name: a.name,
        query,
        xhsUrl: 'https://www.xiaohongshu.com/search_result?keyword=' + encodeURIComponent(query),
        googleImagesUrl: 'https://www.google.com/search?tbm=isch&q=' + encodeURIComponent(query),
      });
    }
  }
  return out.slice(0, 24);
}

function auditQuoteContent(content) {
  const issues = [];
  if (!content || typeof content !== 'object') return { ok: false, issues: ['content missing'] };
  if (!content.trip || looksLikeJunk(content.trip.title)) issues.push('judul perjalanan kosong / tidak valid');
  const days = Array.isArray(content.days) ? content.days : [];
  if (!days.length) issues.push('tidak ada hari');
  days.forEach((d, i) => {
    const tag = `D${d && d.dayNo != null ? d.dayNo : i + 1}`;
    if (looksLikeJunk(d && d.routeTitle)) issues.push(`${tag}: route title kosong / tanda baca saja`);
    if (looksLikeJunk(d && d.intro)) issues.push(`${tag}: intro kosong`);
    const atts = (d && d.attractions) || [];
    if (atts.some(a => looksLikeJunk(a && a.name))) issues.push(`${tag}: ada attraction tanpa nama`);
  });
  return { ok: issues.length === 0, issues };
}

module.exports = { parseRuleBasedQuote, makeImageSearches, auditQuoteContent, looksLikeJunk };
