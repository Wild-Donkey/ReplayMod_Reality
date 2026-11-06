import type { MapCoordinate } from "../../../../../../packages/data/src";
import bundledAirportsTsv from "./airports-international.tsv?raw";
import { buildAirportNameZhQueryUrl, pickChineseNameFromCsv } from "../../../shared/airportNameZh";

/**
 * 机场库（数据源 OurAirports，Public Domain）。三层数据源共存、互不替换：
 * - bundled：仓库内置 airports-international.tsv，仅主要国际机场，首次离线
 *   即可用并始终保留；
 * - local：工作区内 airports-full.tsv（large+medium 全量总表，被
 *   .gitignore 忽略），存在时作为本地离线全量层叠加；
 * - online：在线拉取的全量 CSV，经主进程磁盘缓存，作为独立全量层叠加，
 *   失败不影响前两层。
 * 最近机场检索在去重后的并集上进行，在线/本地记录优先于内置记录，但内置
 * 层不会被丢弃或改写。
 */

export interface Airport {
  /** IATA 三字码，可能为空（少数机场无 IATA）。 */
  readonly iata: string;
  /** ICAO 四字码，缺失时退回 OurAirports ident。 */
  readonly icao: string;
  readonly name: string;
  /**
   * 中文名（Wikidata，CC0）。内置表构建时仅预填中国机场，其余多为空；
   * 界面需要中文且此处缺失时，对单个机场随用随拉（见 fetchAirportNameZh）。
   */
  readonly nameZh?: string;
  readonly municipality: string;
  readonly country: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly kind: "large" | "medium";
}

export interface AirportMatch extends Airport {
  readonly distanceKm: number;
}

export type AirportLayerSource = "bundled" | "local" | "online";
export interface AirportLayer {
  readonly source: AirportLayerSource;
  readonly label: string;
  readonly airports: readonly Airport[];
}

export interface AirportDatabase {
  readonly layers: readonly AirportLayer[];
  readonly label: string;
  nearest(coordinate: MapCoordinate, maxKm: number): AirportMatch | null;
  /** 按 IATA/ICAO 代码精确取机场（大小写不敏感）。 */
  byCode(code: string): Airport | null;
}

const EARTH_RADIUS_KM = 6371;
export function haversineKm(a: MapCoordinate, b: MapCoordinate): number {
  const toRad = (value: number) => value * Math.PI / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/** 最小 RFC4180 CSV 解析，支持引号、字段内逗号/换行/双引号。 */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += char;
    } else if (char === '"') inQuotes = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field); rows.push(row); field = ""; row = []; }
    else if (char !== "\r") field += char;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(cells => cells.some(value => value.length > 0));
}

const KIND_FROM_CSV: Record<string, Airport["kind"]> = {
  large_airport: "large",
  medium_airport: "medium",
};

/** 与生成脚本同口径：剔除无代码占位行与 (Duplicate)/[Duplicate] 重复行。 */
function isUsableAirportRow(name: string, icao: string, iata: string): boolean {
  if (!icao && !iata) return false;
  if (/^\s*[\[(]\s*duplicate\b/i.test(name)) return false;
  return true;
}

/** 解析 OurAirports 全量 CSV，保留 large/medium 且有代码的民用机场。 */
export function parseOurAirportsCsv(text: string): Airport[] {
  const rows = parseCsvRows(text);
  const header = rows[0];
  if (!header) return [];
  const col = (name: string) => header.indexOf(name);
  const c = {
    ident: col("ident"), type: col("type"), name: col("name"),
    latitude: col("latitude_deg"), longitude: col("longitude_deg"),
    country: col("iso_country"), municipality: col("municipality"),
    icao: col("icao_code"), iata: col("iata_code"),
  };
  const airports: Airport[] = [];
  for (let r = 1; r < rows.length; r += 1) {
    const cells = rows[r];
    const kind = KIND_FROM_CSV[cells[c.type]];
    if (!kind) continue;
    const latitude = Number(cells[c.latitude]);
    const longitude = Number(cells[c.longitude]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    const iata = (cells[c.iata] ?? "").trim();
    const icao = (cells[c.icao] || cells[c.ident] || "").trim();
    const name = cells[c.name] ?? "";
    if (!isUsableAirportRow(name, icao, iata)) continue;
    airports.push({
      iata,
      icao,
      name,
      municipality: cells[c.municipality] ?? "",
      country: cells[c.country] ?? "",
      latitude, longitude, kind,
    });
  }
  return airports;
}

/** 解析 build-airports-table.cjs 生成的 TSV（# 注释；kind 为 L/M；第 9 列 nameZh）。 */
export function parseTsvAirports(text: string): Airport[] {
  const airports: Airport[] = [];
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const [iata, icao, name, municipality, country, lat, lon, kind, nameZh] = line.split("\t");
    const latitude = Number(lat);
    const longitude = Number(lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    airports.push({
      iata: iata ?? "", icao: icao ?? "", name: name ?? "",
      municipality: municipality ?? "", country: country ?? "",
      latitude, longitude, kind: kind === "M" ? "medium" : "large",
      ...(nameZh ? { nameZh } : {}),
    });
  }
  return airports;
}

const airportKey = (airport: Airport) =>
  airport.icao || airport.iata || `${airport.latitude.toFixed(4)},${airport.longitude.toFixed(4)}`;

/**
 * 由共存的多个数据层构建检索库。按 bundled → local → online 顺序叠加并按
 * 稳定键去重，后层记录优先；任何一层都不会被替换或改写。在线 CSV 不带
 * nameZh，若后层记录缺少中文名而前层（内置/本地）有，则继承前层中文名，
 * 避免叠加在线层后丢失内置的中国机场中文名。
 */
export function createAirportDatabase(layers: readonly AirportLayer[]): AirportDatabase {
  const merged = new Map<string, Airport>();
  for (const layer of layers) {
    for (const airport of layer.airports) {
      const previous = merged.get(airportKey(airport));
      merged.set(airportKey(airport), previous && !airport.nameZh && previous.nameZh
        ? { ...airport, nameZh: previous.nameZh }
        : airport);
    }
  }
  const airports = [...merged.values()];

  // 按纬度分桶，最近邻只扫描附近桶，避免全表逐点计算。
  const bucketSizeDeg = 3;
  const buckets = new Map<number, Airport[]>();
  for (const airport of airports) {
    const key = Math.floor(airport.latitude / bucketSizeDeg);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(airport); else buckets.set(key, [airport]);
  }
  const nearest = (coordinate: MapCoordinate, maxKm: number): AirportMatch | null => {
    let best: AirportMatch | null = null;
    const centerBucket = Math.floor(coordinate[1] / bucketSizeDeg);
    // 一度纬度约 111 km；按最大匹配距离外扩扫描桶，跨经度也留足余量。
    const span = Math.max(1, Math.ceil(maxKm / 111 / bucketSizeDeg) + 1);
    for (let offset = -span; offset <= span; offset += 1) {
      const bucket = buckets.get(centerBucket + offset);
      if (!bucket) continue;
      for (const airport of bucket) {
        const distanceKm = haversineKm(coordinate, [airport.longitude, airport.latitude]);
        if (distanceKm <= maxKm && (!best || distanceKm < best.distanceKm)) {
          best = { ...airport, distanceKm };
        }
      }
    }
    return best;
  };

  // IATA/ICAO 精确代码索引：已确认记录保存了代码，按代码取机场坐标比拿漂移
  // 几十公里的地面锚点做最近邻可靠得多。
  const codeIndex = new Map<string, Airport>();
  for (const airport of airports) {
    if (airport.iata) codeIndex.set(airport.iata.toUpperCase(), airport);
    if (airport.icao) codeIndex.set(airport.icao.toUpperCase(), airport);
  }
  const byCode = (code: string): Airport | null =>
    codeIndex.get(code.trim().toUpperCase()) ?? null;

  const label = layers.map(layer => `${layer.label}（${layer.airports.length.toLocaleString("zh-CN")}）`).join(" · ");
  return { layers, label, nearest, byCode };
}

// 可选的本地全量总表：文件不存在时 glob 返回空对象，不影响构建（该文件被
// .gitignore 忽略，仅本地生成后存在）。
const localFullModules = import.meta.glob<string>("./airports-full.tsv", {
  query: "?raw", import: "default", eager: true,
});

/** 加载不依赖网络的层：内置国际表始终存在，本地全量表存在时叠加。 */
export function loadLocalAirportLayers(): AirportLayer[] {
  const layers: AirportLayer[] = [{
    source: "bundled",
    label: "内置国际机场",
    airports: parseTsvAirports(bundledAirportsTsv),
  }];
  const localTsv = Object.values(localFullModules)[0];
  if (localTsv) {
    layers.push({
      source: "local",
      label: "本地全量机场",
      airports: parseTsvAirports(localTsv),
    });
  }
  return layers;
}

let localDatabase: AirportDatabase | null = null;
export function loadLocalAirportDatabase(): AirportDatabase {
  if (!localDatabase) localDatabase = createAirportDatabase(loadLocalAirportLayers());
  return localDatabase;
}

/**
 * 在线拉取全量 CSV，返回独立的 online 数据层（不触碰内置/本地层）。桌面端
 * 走主进程磁盘缓存，离线自动回退缓存；浏览器预览直接 fetch。
 */
export async function fetchOnlineAirportLayer(signal: AbortSignal, force = false): Promise<AirportLayer> {
  const text = window.replaymod
    ? await window.replaymod.loadAirports(force)
    : await (await fetch("https://davidmegginson.github.io/ourairports-data/airports.csv", { signal })).text();
  signal.throwIfAborted();
  const airports = parseOurAirportsCsv(text);
  if (airports.length === 0) throw new Error("在线机场数据未解析出任何机场");
  return {
    source: "online",
    label: "在线全量机场",
    airports,
  };
}

// 会话内去重：同一 ICAO 的并发请求只发出一次；结果由主进程磁盘缓存保留。
const inflightNameZh = new Map<string, Promise<string | null>>();

/**
 * 随用随拉单个机场的中文名。仅在界面真正显示某机场、且内置数据缺少中文名
 * 时调用——一次一个 ICAO，绝不批量拉取。桌面端走主进程（磁盘缓存、离线
 * 可用），浏览器预览直接请求 Wikidata。查不到返回 null，失败时调用方静默
 * 回退英文名即可。
 */
export function fetchAirportNameZh(icao: string): Promise<string | null> {
  if (!icao) return Promise.resolve(null);
  const inflight = inflightNameZh.get(icao);
  if (inflight) return inflight;
  const task = (window.replaymod
    ? window.replaymod.loadAirportNameZh(icao)
    : fetch(buildAirportNameZhQueryUrl(icao))
        .then(response => {
          if (!response.ok) throw new Error(`机场中文名请求失败 (${response.status})`);
          return response.text();
        })
        .then(pickChineseNameFromCsv)
  ).finally(() => { inflightNameZh.delete(icao); });
  inflightNameZh.set(icao, task);
  return task;
}
