import type { AnnotationNode, AnnotationProject, MapCoordinate } from "../../../../../../packages/data/src";

export const emptyAnnotations = (): AnnotationProject => ({format: "replaymod.annotations", version: 1, name: "我的地图", nodes: []});
const children = (el: Element, tag: string) => Array.from(el.children).filter(child => child.localName === tag);
const child = (el: Element, tag: string) => children(el, tag)[0];
const value = (el: Element, tag: string) => child(el, tag)?.textContent?.trim() ?? "";
const defaultColor = "#55cfff";
type LegacyAnnotationNode = AnnotationNode & {style?: {color?:string}};
const annotationColor = (node: LegacyAnnotationNode) => node.color ?? node.style?.color ?? defaultColor;
export const sanitizeAnnotationDescription = (description = "") => description.split(/\r?\n/).filter(line =>
  !/^\s*(?:WGS84(?:参考坐标)?|坐标来源|来源)\s*[：:]/i.test(line)
  && !/https?:\/\//i.test(line)
).join("\n").trim();
const xml = (text: string) => {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("不支持含 DTD 或实体声明的 KML。");
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("KML XML 格式无效。");
  return doc;
};
/** Strip legacy XML payloads when reading an existing JSON project. */
export function compactAnnotationProject(project: AnnotationProject): AnnotationProject {
  return {
    format: project.format, version: project.version, name: project.name,
    nodes: project.nodes.map(node => {
      const common = {id:node.id,parentId:node.parentId,name:node.name,description:sanitizeAnnotationDescription(node.description),visible:node.visible,coordinates:(node.coordinates??[]).map(coordinate => [coordinate[0],coordinate[1]] as MapCoordinate)};
      return node.kind === "folder"
        ? {...common,kind:"folder" as const,open:node.open??false}
        : {...common,kind:node.kind,open:false,color:annotationColor(node as LegacyAnnotationNode)};
    }),
  };
}
export function importKml(text: string, fileName = "导入地图"): AnnotationProject {
  const doc = xml(text);
  if (doc.documentElement.localName !== "kml") throw new Error("文件不是 KML。");
  const elements = Array.from(doc.getElementsByTagName("*"));
  const ids = new Map(elements.flatMap(el => {
    const id = el.getAttribute("id") ?? el.getAttributeNS("http://www.opengis.net/kml/2.2", "id");
    return id ? [[id, el] as const] : [];
  }));
  const resolveColor = (el: Element, seen = new Set<Element>()): string => {
    if (seen.has(el)) return defaultColor;
    seen.add(el);
    const ref = value(el, "styleUrl");
    let color = ref.startsWith("#") && ids.has(ref.slice(1)) ? resolveColor(ids.get(ref.slice(1))!, seen) : defaultColor;
    if (el.localName === "StyleMap") {
      const normal = children(el, "Pair").find(pair => value(pair, "key") === "normal");
      if (normal) color = resolveColor(normal, seen);
    }
    const own = el.localName === "Style" ? el : child(el, "Style");
    if (own) {
      const line = child(own, "LineStyle");
      const kmlColor = line ? value(line, "color") : "";
      if (/^[a-f\d]{8}$/i.test(kmlColor)) color = `#${kmlColor.slice(6,8)}${kmlColor.slice(4,6)}${kmlColor.slice(2,4)}`;
    }
    return color;
  };
  const nodes: AnnotationNode[] = [];
  const usedIds = new Set<string>();
  const walk = (el: Element, parentId: string | null) => {
    if (["Document", "kml"].includes(el.localName)) {
      for (const c of Array.from(el.children)) walk(c, parentId);
      return;
    }
    if (!["Folder", "Placemark"].includes(el.localName)) return;
    let id = el.getAttribute("id") || crypto.randomUUID();
    if (usedIds.has(id)) id = crypto.randomUUID();
    usedIds.add(id);
    const folder = el.localName === "Folder";
    const geometry = child(el, "Point") ?? child(el, "LineString");
    if (!folder && !geometry) throw new Error("该 KML 包含暂不支持的几何类型，请使用点或 LineString 路线。");
    const coordinates = geometry ? value(geometry, "coordinates").split(/\s+/).filter(Boolean).map(tuple => {
      const numbers = tuple.split(",").map(Number);
      if (numbers.length < 2 || numbers.length > 3 || numbers.some(n => !Number.isFinite(n)) || Math.abs(numbers[0]) > 180 || Math.abs(numbers[1]) > 90) throw new Error("KML 中存在无效坐标。");
      return [numbers[0],numbers[1]] as MapCoordinate;
    }) : [];
    const kind = folder ? "folder" : geometry!.localName === "Point" ? "point" : "route";
    if ((kind === "point" && coordinates.length !== 1) || (kind === "route" && coordinates.length < 2)) throw new Error("点或路线的坐标数量无效。");

    const common={id,parentId,name:value(el,"name")||(folder?"未命名分组":"未命名地标"),description:sanitizeAnnotationDescription(value(el,"description")),visible:value(el,"visibility")!=="0",coordinates};
    nodes.push(folder
      ? {...common,kind:"folder",open:value(el,"open")==="1"}
      : {...common,kind:geometry!.localName==="Point"?"point":"route",open:false,color:resolveColor(el)});
    if (folder) for (const c of Array.from(el.children)) walk(c, id);
  };
  walk(doc.documentElement, null);
  const documentEl = elements.find(el => el.localName === "Document");
  return {format:"replaymod.annotations", version:1, name: documentEl ? value(documentEl,"name") || fileName : fileName, nodes};
}
export function parseAnnotationProject(text: string, name?: string): AnnotationProject {
  if (text.trimStart().startsWith("<")) return importKml(text, name);
  const p = JSON.parse(text) as AnnotationProject;
  if (p.format !== "replaymod.annotations" || p.version !== 1 || typeof p.name !== "string" || !Array.isArray(p.nodes)) throw new Error("不支持的地图项目格式或版本。");
  const ids = new Map<string, AnnotationNode>();
  for (const n of p.nodes) {
    const color=(n as LegacyAnnotationNode).color ?? (n as LegacyAnnotationNode).style?.color;
    if (!n || typeof n.id !== "string" || ids.has(n.id) || !["folder","point","route"].includes(n.kind) || typeof n.name !== "string" || !(n.description === undefined || typeof n.description === "string") || typeof n.visible !== "boolean" || !(n.open === undefined || typeof n.open === "boolean") || !(n.parentId === null || typeof n.parentId === "string") || !(n.coordinates === undefined || Array.isArray(n.coordinates)) || (n.kind !== "folder" && !/^#[0-9a-f]{6}$/i.test(color ?? ""))) throw new Error("地图项目包含无效属性。");
    const coordinates = n.coordinates ?? [];
    for (const c of coordinates) if (!Array.isArray(c) || c.length < 2 || c.length > 3 || c.some(v => typeof v !== "number" || !Number.isFinite(v)) || Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90) throw new Error("地图项目包含无效坐标。");
    if ((n.kind === "point" && coordinates.length !== 1) || (n.kind === "route" && coordinates.length < 2) || (n.kind === "folder" && coordinates.length)) throw new Error("地图几何无效。");
    ids.set(n.id,n);
  }
  for (const n of p.nodes) {
    const seen = new Set([n.id]); let parent = n.parentId;
    while (parent !== null) {
      if (seen.has(parent) || ids.get(parent)?.kind !== "folder") throw new Error("地图目录层级无效。");
      seen.add(parent); parent = ids.get(parent)!.parentId;
    }
  }
  return compactAnnotationProject(p);
}
export function visibleAnnotations(project: AnnotationProject) {
  const nodes = new Map(project.nodes.map(n => [n.id,n]));
  return project.nodes.filter(n => {
    let current: AnnotationNode | undefined = n;
    while (current) { if (!current.visible) return false; current = current.parentId ? nodes.get(current.parentId) : undefined; }
    return n.kind !== "folder";
  });
}
export function serializeAnnotationProject(project: AnnotationProject): string {
  const coordinateSequences: string[] = [];
  const tokenPrefix = "__REPLAYMOD_COORDINATE_SEQUENCE_";
  let output = JSON.stringify(project, function replacer(key, value) {
    if (key === "description" && typeof value === "string") return sanitizeAnnotationDescription(value) || undefined;
    if (key === "coordinates" && Array.isArray(value) && value.length === 0) return undefined;
    if (key === "open" && (value === false || this.kind !== "folder")) return undefined;
    if (key !== "coordinates" || !Array.isArray(value)) return value;
    const index = coordinateSequences.push(JSON.stringify(value.map(coordinate => [coordinate[0], coordinate[1]]))) - 1;
    return `${tokenPrefix}${index}__`;
  }, 2);
  coordinateSequences.forEach((coordinates, index) => {
    output = output.replace(`"${tokenPrefix}${index}__"`, coordinates);
  });
  return `${output}\n`;
}
export function exportKml(project: AnnotationProject): string {
  const doc = xml('<kml xmlns="http://www.opengis.net/kml/2.2"><Document/></kml>');
  const root = doc.documentElement.children[0];
  const add = (parent: Element, tag: string, text: string) => { const e = doc.createElementNS(root.namespaceURI,tag); e.textContent=text; parent.appendChild(e); return e; };
  add(root,"name",project.name);
  const write = (parentId: string | null, parent: Element) => {
    for (const n of project.nodes.filter(n => n.parentId === parentId)) {
      const el = doc.createElementNS(root.namespaceURI,n.kind === "folder" ? "Folder" : "Placemark");
      el.setAttribute("id",n.id);
      add(el,"name",n.name);
      if(n.description) add(el,"description",n.description);
      if(!n.visible) add(el,"visibility","0");
      if(n.kind === "folder" && n.open) add(el,"open","1");
      if (n.kind !== "folder") {
        const style=doc.createElementNS(root.namespaceURI,"Style"); el.appendChild(style);
        const line=doc.createElementNS(root.namespaceURI,"LineStyle"); style.appendChild(line);
        const color=(n.color ?? defaultColor).slice(1); const kmlColor="ff"+color.slice(4,6)+color.slice(2,4)+color.slice(0,2);
        add(line,"color",kmlColor);
        const geom=doc.createElementNS(root.namespaceURI,n.kind === "point" ? "Point" : "LineString"); el.appendChild(geom);
        add(geom,"coordinates",n.coordinates.map(c=>c.join(",")).join(" "));
      }
      parent.appendChild(el); if(n.kind === "folder") write(n.id,el);
    }
  };
  write(null,root);
  return '<?xml version="1.0" encoding="UTF-8"?>\n'+new XMLSerializer().serializeToString(doc);
}
