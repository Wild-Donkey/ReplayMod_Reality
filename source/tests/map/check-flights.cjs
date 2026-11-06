const fs = require('node:fs');
const assert = require('node:assert/strict');
const ts = require('typescript');
const vm = require('node:vm');

// flights.ts 仅以 import type 引用 flightDetection，转译为 CJS 后类型导入被
// 擦除；两个模块分别载入同一沙箱即可。
function loadModule(relativePath, globalName) {
  const code = ts.transpileModule(fs.readFileSync(relativePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const sandbox = {};
  vm.runInNewContext(`(function(exports){${code}})(globalThis.${globalName}={});`, { globalThis: sandbox });
  return sandbox[globalName];
}
const FD = loadModule('apps/desktop/src/renderer/features/map/flightDetection.ts', 'FD');
const FL = loadModule('apps/desktop/src/renderer/features/map/flights.ts', 'FL');
const ZH = loadModule('apps/desktop/src/shared/airportNameZh.ts', 'ZH');

// 时间线（秒）：
// 0,1 地面；2,3 巡航；4 短暂掉破阈值（巡航中断，时间上仍同趟）；5 巡航；
// 6,7 落地地面；8,9 低空地形噪声簇（离地 250 m，不应成为航班）；
// 10 单点高空尖峰（点数不足）；11 地面。
const lonLat = [
  [0.00, 0.00], [0.01, 0.01], [0.02, 0.02], [0.03, 0.03],
  [0.30, 0.30], [0.49, 0.49], [0.50, 0.50], [0.51, 0.51],
  [0.52, 0.52], [0.52, 0.52], [0.90, 0.90], [0.91, 0.91],
];
const timestamps = [0, 60, 120, 180, 600, 900, 960, 1020, 4000, 4060, 8000, 8060].map(v => v * 1000);
const coordinates = lonLat.flatMap(([lon, lat]) => [lon, lat]);
const ground = lonLat.map(() => 0);
const altitudes = [0, 0, 3000, 5000, 50, 6000, 0, 0, 250, 260, 4000, 0];
const detection = FD.detectFlight(coordinates, timestamps, altitudes, ground);
assert.equal(detection.segments.length, 4); // 巡航两段 + 低空簇 + 单点尖峰
assert.equal(detection.trips.length, 3);    // 时间聚类：巡航趟 / 低空噪声趟 / 单点趟

const airport = (iata, name, municipality, distanceKm, coord) => ({
  iata, icao: `${iata}C`, name, municipality, country: 'TS',
  latitude: coord[1], longitude: coord[0], distanceKm,
});
// 起飞锚点（index 1）附近有高可信机场；落地锚点（index 6）机场距离 80 km，
// 超出默认 40 km 搜索半径，应判未知。
const resolver = (coord) => {
  if (coord[0] === 0.01) return airport('DEP', 'Departure Intl', 'Depville', 5, coord);
  if (coord[0] === 0.50) return airport('FAR', 'Far Airfield', 'Farville', 80, coord);
  return null;
};

const flights = FL.inferFlights(detection, resolver);
assert.equal(flights.length, 1, '低空地形簇与单点尖峰都不应进入航行列表');
const flight = flights[0];
assert.equal(flight.ordinal, 1);
assert.equal(flight.departure.coordinate[0], 0.01, '起飞锚点取首飞行点前最后一个地面点');
assert.equal(flight.arrival.coordinate[0], 0.50, '落地锚点取末飞行点后第一个地面点（跨过巡航中断）');
assert.equal(flight.departure.confidence, 'high');
assert.equal(flight.departure.airport.iata, 'DEP');
assert.equal(flight.arrival.confidence, 'none');
assert.equal(flight.arrival.airport, null, '超出搜索半径不得臆造机场');
assert.equal(flight.pointCount, 3, '巡航趟含 3 个飞行点（中断处的低空点不计）');
const routes = FL.flightRoutePaths(flights);
assert.equal(routes.length, 1);
assert.equal(routes[0].length, 49, '航线应由起降端点生成平滑大圆弧线');
assert.ok(Math.abs(routes[0][0][0] - 0.01) < 1e-10 && Math.abs(routes[0][0][1] - 0.01) < 1e-10);
assert.ok(Math.abs(routes[0].at(-1)[0] - 0.5) < 1e-10 && Math.abs(routes[0].at(-1)[1] - 0.5) < 1e-10);
assert.equal(routes[0].some(point => point[0] === 0.02 && point[1] === 0.02), false,
  '航线不应穿过具体的飞行采样点');
const bowed = FL.stylizedFlightArc([0, 10], [90, 10]);
assert.ok(bowed[Math.floor(bowed.length / 2)][1] > 20, '中程应呈现明显的航线图弧度');
const pairedRoutes = FL.flightRoutePaths([flight, {...flight, ordinal: 2, departure: flight.arrival, arrival: flight.departure}]);
const chordMidLatitude = (flight.departure.coordinate[1] + flight.arrival.coordinate[1]) / 2;
assert.ok((pairedRoutes[0][24][1] - chordMidLatitude) * (pairedRoutes[1][24][1] - chordMidLatitude) < 0,
  '往返航班都向自己的左侧弯，应自然落在连线两侧');
const sameDirectionRoutes = FL.flightRoutePaths([flight, {...flight, ordinal: 2}]);
assert.notEqual(sameDirectionRoutes[0][24][1], sameDirectionRoutes[1][24][1],
  '同方向重复航线应轻微错开曲率，避免中段箭头重叠');
assert.equal(flight.maxHeightAboveGround, 6000);
assert.equal(flight.startTime, 120000);
assert.equal(flight.endTime, 900000);
assert.equal(flight.durationMs, 780000, '时长跨越被桥接的巡航中断');
const expectedDistance = FL.haversineKm([0.01, 0.01], [0.50, 0.50]);
assert.ok(Math.abs(flight.legDistanceKm - expectedDistance) < 1e-9);

// 巡航高度阈值可配：放到 0 时低空噪声簇也参与（仅用于验证过滤口径）。
assert.equal(FL.inferFlights(detection, resolver, {
  minCruiseHeightMeters: 0, minDurationMs: 0, minDisplacementKm: 0,
}).length, 2, '显式放宽高度、时长和位移后低空簇可参与');

// 只放宽点数也不能让单点高空尖峰变成航班。
const all = FL.inferFlights(detection, resolver, { minPoints: 1 });
assert.equal(all.length, 1);

// 数据起点即飞行：没有外侧地面点时回退首/末飞行点。
const startDetection = FD.detectFlight([1, 1, 2, 2], [0, 1000], [5200, 5260], [0, 0]);
assert.equal(startDetection.trips.length, 1);
const anchored = FL.inferFlights(startDetection, () => airport('ORI', 'Origin', 'Ori', 3, [1, 1]), {
  minPoints: 1, minCruisePoints: 1, minDurationMs: 0, minDisplacementKm: 0, minMotionConsistency: 0,
});
assert.equal(anchored[0].departure.coordinate[0], 1);
assert.equal(anchored[0].arrival.coordinate[0], 2);

// 整段航班无 GPS：相邻地面点分别在两个高可信机场，间隙速度合理时补成缺测航班。
const gapDetection = FD.detectFlight(
  [108.762, 34.442, 114.214, 30.775], [0, 76 * 60_000], [470, 45], [470, 45],
);
const gapResolver = coord => coord[0] < 110
  ? airport('XIY', "Xi'an", "Xi'an", 1, coord)
  : airport('WUH', 'Wuhan', 'Wuhan', 1, coord);
const gapFlights = FL.inferFlights(gapDetection, gapResolver);
assert.equal(gapFlights.length, 1, '机场间合理高速无点间隙应补成航班');
assert.equal(gapFlights[0].departure.airport.iata, 'XIY');
assert.equal(gapFlights[0].arrival.airport.iata, 'WUH');
assert.equal(gapFlights[0].pointCount, 0);

// 中可信：距离在近距阈值之外、搜索半径之内。
const medium = FL.inferFlights(detection, (coord) =>
  coord[0] === 0.01 ? airport('MED', 'Medium Field', 'Med', 20, coord) : null);
assert.equal(medium[0].departure.confidence, 'medium');

// 格式化。
assert.equal(FL.formatDuration(0), '0 分钟');
assert.equal(FL.formatDuration(60000), '1 分钟');
assert.equal(FL.formatDuration(3 * 3600_000 + 25 * 60000), '3 小时 25 分');
assert.equal(FL.airportLabel(null), '未知机场');
assert.ok(FL.airportLabel(flight.departure.airport).includes('DEP'));
assert.ok(FL.airportLabel(flight.departure.airport).includes('Depville'));
// 中国机场中文名优先，不再拼英文城市名。
const zhAirport = { ...flight.departure.airport, iata: 'PEK', name: 'Beijing Capital International Airport', nameZh: '北京首都国际机场', municipality: 'Beijing', country: 'CN' };
assert.equal(FL.airportLabel(zhAirport), 'PEK 北京首都国际机场');
// 显式不要中文（en 设置）时即使有中文名也回退英文。
assert.equal(FL.airportLabel(zhAirport, false), 'PEK Beijing Capital International Airport · Beijing，CN');

// 语言偏好与底图设置对齐。
assert.equal(FL.preferAirportChineseName('zh', 'JP', false), true, 'zh：所有机场都要中文');
assert.equal(FL.preferAirportChineseName('en', 'CN', true), false, 'en：一律英文');
assert.equal(FL.preferAirportChineseName('local', 'CN', false), true, 'local：中国机场用中文');
assert.equal(FL.preferAirportChineseName('local', 'JP', true), false, 'local：外国机场回退英文，与系统语言无关');
assert.equal(FL.preferAirportChineseName('auto', 'JP', true), true, 'auto：系统中文等同 zh');
assert.equal(FL.preferAirportChineseName('auto', 'JP', false), false, 'auto：系统非中文等同 local');
assert.equal(FL.preferAirportChineseName('auto', 'CN', false), true, 'auto：当地语言对中国机场始终为中文');

// 随用随拉：单 ICAO 请求 URL 与 SPARQL text/csv 名称选取（简中 > zh > 繁中）。
const url = ZH.buildAirportNameZhQueryUrl('RJTT');
assert.ok(url.startsWith('https://query.wikidata.org/sparql?query='));
assert.ok(decodeURIComponent(url.slice(url.indexOf('query=') + 6)).includes('wdt:P239 "RJTT"'));
assert.throws(() => ZH.buildAirportNameZhQueryUrl('bad icao'), /非法 ICAO/);
assert.equal(ZH.pickChineseNameFromCsv('hans,zh,hant\n北京首都国际机场,北京首都國際機場,北京首都國際機場\n'), '北京首都国际机场');
assert.equal(ZH.pickChineseNameFromCsv('hans,zh,hant\n,東京國際機場,東京國際機場\n'), '東京國際機場', '无简中时回退繁体');
assert.equal(ZH.pickChineseNameFromCsv('hans,zh,hant\n'), null, '只有表头视为查无中文名');
// 已确认匹配：重扫会让锚点漂移、时间边界移动，身份必须按物理航班容错识别。
const confirmedEndpoint = (iata, coord) => ({
  timestamp: 0, coordinate: coord, iata, icao: null, name: null,
});
const confirmedRecord = (id, startTime, endTime, dep, arr) => ({
  id, confirmedAt: '2026-01-01T00:00:00.000Z', startTime, endTime,
  departure: confirmedEndpoint(dep[0], dep[1]), arrival: confirmedEndpoint(arr[0], arr[1]),
  pointCount: 3, maxHeightAboveGround: 6000, distanceKm: 0,
});
const exactRecord = confirmedRecord(
  'exact', flight.startTime, flight.endTime,
  ['DEP', flight.departure.coordinate], [null, flight.arrival.coordinate],
);
assert.equal(FL.findConfirmedFlight(flight, [exactRecord]), exactRecord,
  '时间与端点一致时精确命中');
// 到达锚点漂移约 4.4 km、起飞边界晚 10 分钟（重叠仍 > 90%），仍应判为同一趟。
const driftedRecord = confirmedRecord(
  'drifted', flight.startTime + 10 * 60_000, flight.endTime,
  ['DEP', [flight.departure.coordinate[0] + 0.04, flight.departure.coordinate[1] + 0.01]],
  [null, [flight.arrival.coordinate[0] + 0.04, flight.arrival.coordinate[1]]],
);
assert.equal(FL.findConfirmedFlight(flight, [driftedRecord]), driftedRecord,
  '重扫锚点漂移数公里、时间边界移动十几分钟仍应匹配');
// 记录端 IATA 不同且坐标也远离锚点时，不得仅凭时间重叠匹配。
const iataRecord = confirmedRecord(
  'iata', flight.startTime, flight.endTime,
  ['DEP', flight.departure.coordinate],
  ['XXX', [flight.arrival.coordinate[0] + 0.3, flight.arrival.coordinate[1]]],
);
assert.equal(FL.findConfirmedFlight(flight, [iataRecord]), undefined,
  '到达端 IATA 为 XXX 且坐标漂移超过容限，不得仅凭时间匹配');
// 给候选到达端补一个机场后，IATA 相同即应命中。
const flightWithArrivalAirport = {
  ...flight,
  arrival: {
    ...flight.arrival,
    airport: airport('DST', 'Destination', 'Desttown', 2, flight.arrival.coordinate),
    confidence: 'high',
  },
};
const iataMatched = confirmedRecord(
  'iata2', flightWithArrivalAirport.startTime, flightWithArrivalAirport.endTime,
  ['DEP', [10, 10]], ['DST', [20, 20]],
);
assert.equal(FL.findConfirmedFlight(flightWithArrivalAirport, [iataMatched]), iataMatched,
  '两端 IATA 相同即同一趟，忽略坐标快照差异');
// 反例：时间不重叠 / 锚点漂移过远 / IATA 不同，都不得误配。
const noOverlap = confirmedRecord('no-overlap', flight.endTime + 86_400_000,
  flight.endTime + 86_400_000 + 3_600_000, ['DEP', flight.departure.coordinate], [null, flight.arrival.coordinate]);
assert.equal(FL.findConfirmedFlight(flight, [noOverlap]), undefined, '时间窗不重叠不得匹配');
const farDrift = confirmedRecord('far', flight.startTime, flight.endTime,
  ['DEP', flight.departure.coordinate], [null, [flight.arrival.coordinate[0] + 0.3, flight.arrival.coordinate[1]]]);
assert.equal(FL.findConfirmedFlight(flight, [farDrift]), undefined, '锚点漂移超过 10 km 不得匹配');
const wrongIata = confirmedRecord('wrong-iata', flightWithArrivalAirport.startTime,
  flightWithArrivalAirport.endTime, ['XXX', [10, 10]], ['DST', [20, 20]]);
assert.equal(FL.findConfirmedFlight(flightWithArrivalAirport, [wrongIata]), undefined,
  '起飞 Iata 不同不得匹配');
// 多条命中、重叠打平时，取端点漂移最小者。
const closer = confirmedRecord(
  'closer', flight.startTime + 60_000, flight.endTime,
  ['DEP', flight.departure.coordinate], [null, flight.arrival.coordinate],
);
assert.equal(FL.findConfirmedFlight(flight, [driftedRecord, closer]), closer,
  '重叠比例并列时取端点漂移最小的一条');

const text = FL.formatFlightList(flights);
assert.ok(text.includes('DEP Departure Intl'));
assert.ok(text.includes('未知机场'));
assert.equal(FL.formatFlightList([]), '未识别出航行。');

console.log('Flight inference passed: ground anchors, radius/confidence, unknown airports, noise filter, start fallback, distances, language preference, on-demand name fetch and formatting.');
