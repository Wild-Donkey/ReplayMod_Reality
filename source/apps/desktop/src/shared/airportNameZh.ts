/**
 * 单个机场中文名的随用随拉（Wikidata SPARQL，CC0）。这里只放与运行环境无关
 * 的纯逻辑：请求 URL 构建与 text/csv 响应解析，便于在 Node 下直接测试。
 * 网络请求与磁盘缓存由主进程完成。
 *
 * 与内置表构建时不同：这里一次只查界面上实际显示、且缺少中文名的单个
 * ICAO，绝不批量拉取全量机场。
 */

export const WIKIDATA_SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";
const ICAO_PATTERN = /^[A-Za-z0-9]{2,6}$/;

/** 单 ICAO 查询：简中（zh-hans）优先，其次无脚本 zh，最后繁中。 */
export function buildAirportNameZhSparql(icao: string): string {
  return `SELECT ?hans ?zh ?hant WHERE {
  ?airport wdt:P239 "${icao}" .
  OPTIONAL { ?airport rdfs:label ?hans FILTER(LANG(?hans)="zh-hans") }
  OPTIONAL { ?airport rdfs:label ?zh FILTER(LANG(?zh)="zh") }
  OPTIONAL { ?airport rdfs:label ?hant FILTER(LANG(?hant)="zh-hant") }
}`;
}

export function buildAirportNameZhQueryUrl(icao: string): string {
  if (!ICAO_PATTERN.test(icao)) throw new Error(`非法 ICAO：${icao}`);
  return `${WIKIDATA_SPARQL_ENDPOINT}?query=${encodeURIComponent(buildAirportNameZhSparql(icao))}`;
}

/** 解析 SPARQL text/csv 响应，按 hans → zh → hant 选取中文名；无结果返回 null。 */
export function pickChineseNameFromCsv(csv: string): string | null {
  const lines = csv.split(/\r?\n/).filter(line => line.length > 0);
  if (lines.length < 2) return null;
  const header = lines[0].split(",");
  const cells = lines[1].split(",");
  const at = (name: string) => header.indexOf(name);
  const unquote = (value: string | undefined): string => {
    if (!value) return "";
    const trimmed = value.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed.slice(1, -1).replace(/""/g, '"');
    }
    return trimmed;
  };
  const name = unquote(cells[at("hans")]) || unquote(cells[at("zh")]) || unquote(cells[at("hant")]);
  return name || null;
}
