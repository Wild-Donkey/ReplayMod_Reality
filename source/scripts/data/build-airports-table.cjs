#!/usr/bin/env node
/**
 * 生成仓库内置数据（数据源 OurAirports airports.csv，Public Domain）：
 * - airports-international.tsv：仅 large_airport（主要国际机场），提交入库；
 * - airports-full.tsv：large+medium 全量总表，写入工作区但被 .gitignore
 *   忽略，供本地离线使用；在线全量数据则进入应用磁盘缓存。
 * 两份表都带第 9 列 nameZh：构建时仅预填中国机场中文名（Wikidata，CC0）。
 * 其余机场不在构建时批量拉取；应用运行时只对界面上实际显示、且缺少中文名
 * 的机场按单个 ICAO 随用随拉并缓存。
 *
 * OurAirports 中存在大量无代码占位行（如 CN-#### 空军基地、CA-#### 重复
 * 行），这些记录没有 ICAO/IATA 且名称含 (Duplicate)/[Duplicate]，生成时
 * 一律剔除：既无法用代码关联，也会污染最近邻匹配。
 *
 * 用法：
 *   node scripts/data/build-airports-table.cjs [本地 airports.csv] [本地 wikidata 中文名 csv]
 * 不传参数则分别从官方地址下载。
 */
const fs = require('node:fs');
const path = require('node:path');

const AIRPORTS_URL = 'https://davidmegginson.github.io/ourairports-data/airports.csv';
// P17=中国；P239=ICAO；P238=IATA；标签按简中 > zh > 繁中优先。
const WIKIDATA_SPARQL = `SELECT ?icao ?iata ?zh ?hans ?hant WHERE {
  ?airport wdt:P239 ?icao ; wdt:P17 wd:Q148 .
  OPTIONAL { ?airport wdt:P238 ?iata }
  OPTIONAL { ?airport rdfs:label ?zh FILTER(LANG(?zh)="zh") }
  OPTIONAL { ?airport rdfs:label ?hans FILTER(LANG(?hans)="zh-hans") }
  OPTIONAL { ?airport rdfs:label ?hant FILTER(LANG(?hant)="zh-hant") }
}`;
const WIKIDATA_ENDPOINT = 'https://query.wikidata.org/sparql';

const DIR = path.resolve(__dirname, '../../apps/desktop/src/renderer/features/map');
const OUTPUT_INTERNATIONAL = path.join(DIR, 'airports-international.tsv');
const OUTPUT_FULL = path.join(DIR, 'airports-full.tsv');

// 与 csv-parse 行为一致的最小 RFC4180 解析（支持引号、字段内逗号/换行/双引号）。
function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += char;
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field); field = '';
    } else if (char === '\n') {
      row.push(field); rows.push(row); field = ''; row = [];
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(cells => cells.some(value => value.length > 0));
}

const clean = value => value.replace(/[\t\n\r]+/g, ' ').trim();
const isDuplicate = name => /^\s*[\[(]\s*duplicate\b/i.test(name);

async function fetchWikidataChineseNames() {
  const url = `${WIKIDATA_ENDPOINT}?query=${encodeURIComponent(WIKIDATA_SPARQL)}`;
  const response = await fetch(url, {
    headers: {
      Accept: 'text/csv',
      'User-Agent': 'replaymod-reality-data-build/0.1 (airport table generator)',
    },
  });
  if (!response.ok) throw new Error(`Wikidata 请求失败 (${response.status})`);
  return response.text();
}

async function main() {
  const airportsCsv = process.argv[2]
    ? fs.readFileSync(process.argv[2], 'utf8')
    : await (await fetch(AIRPORTS_URL)).text();
  const zhCsv = process.argv[3]
    ? fs.readFileSync(process.argv[3], 'utf8')
    : await fetchWikidataChineseNames();

  const [header, ...records] = parseCsv(airportsCsv);
  const column = name => header.indexOf(name);
  const col = {
    ident: column('ident'), type: column('type'), name: column('name'),
    latitude: column('latitude_deg'), longitude: column('longitude_deg'),
    country: column('iso_country'), municipality: column('municipality'),
    icao: column('icao_code'), iata: column('iata_code'),
  };

  const today = new Date().toISOString().slice(0, 10);

  // 先收集有效机场记录，同时登记中国机场的 ICAO/IATA，供中文名关联。
  const collected = [];
  const cnIcaos = new Set();
  const cnIataToIcao = new Map();
  for (const cells of records) {
    const type = cells[col.type];
    if (type !== 'large_airport' && type !== 'medium_airport') continue;
    const icao = clean(cells[col.icao]);
    const iata = clean(cells[col.iata]);
    const name = clean(cells[col.name]);
    if (!icao && !iata) continue;          // 无代码占位行（多为空军基地）
    if (isDuplicate(name)) continue;       // (Duplicate)/[Duplicate] 重复行
    const latitude = Number(cells[col.latitude]);
    const longitude = Number(cells[col.longitude]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    const country = clean(cells[col.country]);
    const entry = {
      iata,
      icao: icao || clean(cells[col.ident]),
      name,
      municipality: clean(cells[col.municipality]),
      country,
      latitude, longitude,
      kind: type === 'large_airport' ? 'L' : 'M',
      nameZh: '',
    };
    collected.push(entry);
    if (country === 'CN') {
      if (icao) cnIcaos.add(icao);
      if (iata && icao) cnIataToIcao.set(iata, icao);
    }
  }

  // Wikidata 中文名：同一机场可能返回多条语言标签，按 ICAO 去重，简中优先。
  const [zhHeader, ...zhRows] = parseCsv(zhCsv);
  const zc = {
    icao: zhHeader.indexOf('icao'), iata: zhHeader.indexOf('iata'),
    zh: zhHeader.indexOf('zh'), hans: zhHeader.indexOf('hans'), hant: zhHeader.indexOf('hant'),
  };
  const ICAO_RE = /^[A-Z]{4}$/;
  const zhByIcao = new Map();
  for (const cells of zhRows) {
    const wdIcao = clean(cells[zc.icao]);
    const wdIata = clean(cells[zc.iata]);
    // 只保留能与 OurAirports 中国（CN）记录对上的名字：ICAO 直接命中，
    // 否则用 IATA 兜底映射到我们的 ICAO。
    const icao = ICAO_RE.test(wdIcao) && cnIcaos.has(wdIcao)
      ? wdIcao
      : (wdIata ? cnIataToIcao.get(wdIata) : undefined);
    if (!icao) continue;
    const name = clean(cells[zc.hans]) || clean(cells[zc.zh]) || clean(cells[zc.hant]);
    if (!name) continue;
    const existing = zhByIcao.get(icao);
    // 已有简体名时不被 zh/繁体覆盖。
    if (existing && existing.hans && !clean(cells[zc.hans])) continue;
    zhByIcao.set(icao, { name, hans: clean(cells[zc.hans]) });
  }
  for (const entry of collected) {
    if (zhByIcao.has(entry.icao)) entry.nameZh = zhByIcao.get(entry.icao).name;
  }

  const airportHeader = filter => [
    '# source=OurAirports airports.csv (public domain) https://ourairports.com/data/',
    '# nameZh=Wikidata (CC0), CN only at build time; missing names are fetched on demand at runtime',
    `# generated=${today} filter=${filter}`,
    '# columns=iata	icao	name	municipality	country	latitude	longitude	kind	nameZh',
  ];
  const serialize = entry => {
    const cells = [
    entry.iata, entry.icao, entry.name, entry.municipality, entry.country,
    entry.latitude.toFixed(5), entry.longitude.toFixed(5), entry.kind, entry.nameZh,
    ];
    while (cells.at(-1) === '') cells.pop();
    return cells.join('\t');
  };
  const internationalLines = airportHeader('type:large_airport;has-code;not-duplicate');
  const fullLines = airportHeader('type:large_airport+medium_airport;has-code;not-duplicate');
  let internationalWithZh = 0;
  for (const entry of collected) {
    fullLines.push(serialize(entry));
    if (entry.kind === 'L') {
      internationalLines.push(serialize(entry));
      if (entry.nameZh) internationalWithZh += 1;
    }
  }

  fs.writeFileSync(OUTPUT_INTERNATIONAL, `${internationalLines.join('\n')}\n`);
  fs.writeFileSync(OUTPUT_FULL, `${fullLines.join('\n')}\n`);
  console.log(`国际机场 ${internationalLines.length - 4} 个（含中文名 ${internationalWithZh}）-> ${path.relative(process.cwd(), OUTPUT_INTERNATIONAL)} (${fs.statSync(OUTPUT_INTERNATIONAL).size} 字节)`);
  console.log(`全量总表 ${fullLines.length - 4} 个 -> ${path.relative(process.cwd(), OUTPUT_FULL)} (${fs.statSync(OUTPUT_FULL).size} 字节，已 gitignore)`);
}

main().catch(error => { console.error(error); process.exit(1); });
