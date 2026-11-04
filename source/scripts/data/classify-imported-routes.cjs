const fs = require("node:fs");
const path = require("node:path");
const { formatAnnotationJson } = require("./format-annotation-json.cjs");

const projectPath = path.resolve(__dirname, "../../../RawData/annotations/annotations.json");
const project = JSON.parse(fs.readFileSync(projectPath, "utf8"));

const distanceMeters = (a, b) => {
  const radius = 6371000;
  const radians = (value) => value * Math.PI / 180;
  const dLat = radians(b[1] - a[1]);
  const dLon = radians(b[0] - a[0]);
  const value = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(a[1])) * Math.cos(radians(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(value));
};

const routeLengthMeters = (coordinates) => {
  let length = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    length += distanceMeters(coordinates[index - 1], coordinates[index]);
  }
  return length;
};

const groups = new Map();
for (const node of project.nodes) {
  if (node.kind !== "route" || (!node.name.includes("道路路径") && !(node.description ?? "").includes("类型：导入道路"))) continue;
  const siblings = groups.get(node.parentId) ?? [];
  siblings.push(node);
  groups.set(node.parentId, siblings);
}

const counts = { "主线": 0, "支线": 0, "缺口段": 0, "独立段": 0 };
const classifications = new Map();
for (const siblings of groups.values()) {
  if (siblings.length < 2) continue;
  for (const route of siblings) {
    let endpointDistance = Infinity;
    let interiorDistance = Infinity;
    let interiorHost = null;
    for (const other of siblings) {
      if (other === route) continue;
      for (const endpoint of [route.coordinates[0], route.coordinates.at(-1)]) {
        for (const otherEndpoint of [other.coordinates[0], other.coordinates.at(-1)]) {
          endpointDistance = Math.min(endpointDistance, distanceMeters(endpoint, otherEndpoint));
        }
        for (let index = 1; index < other.coordinates.length - 1; index += 1) {
          const distance = distanceMeters(endpoint, other.coordinates[index]);
          if (distance < interiorDistance) {
            interiorDistance = distance;
            interiorHost = other;
          }
        }
      }
    }

    const routeLength = routeLengthMeters(route.coordinates);
    const hostLength = interiorHost ? routeLengthMeters(interiorHost.coordinates) : 0;
    const isBranch = interiorDistance <= 25
      && routeLength < Math.min(hostLength * 0.5, 100000);
    const classification = isBranch
      ? "支线"
      : endpointDistance <= 250 ? "缺口段" : "独立段";

    classifications.set(route.id, classification);
    counts[classification] += 1;
  }
}

for (const siblings of groups.values()) {
  const sequence = new Map();
  for (const route of siblings) {
    const previousDescription = route.description ?? "";
    const classification = classifications.get(route.id)
      ?? previousDescription.match(/分类：(主线|支线|缺口段|独立段)/)?.[1]
      ?? "主线";
    const number = (sequence.get(classification) ?? 0) + 1;
    sequence.set(classification, number);

    const length = route.name.match(/约([\d.]+)km/)?.[1]
      ?? previousDescription.match(/长度：约 ([\d.]+) km/)?.[1]
      ?? (routeLengthMeters(route.coordinates) / 1000).toFixed(1);
    const mergedSegments = route.name.match(/合并(\d+)段/)?.[1]
      ?? previousDescription.match(/合并分段：(\d+)/)?.[1];
    const originalSegment = route.name.match(/分段(\d+)/)?.[1]
      ?? previousDescription.match(/原始分段：(\d+)/)?.[1];

    route.name = `${classification} ${String(number).padStart(2, "0")}`;
    route.description = "";
  }
  if (siblings.length === 1) counts["主线"] += 1;
}

let removedImportDescriptions = 0;
for (const node of project.nodes) {
  if (!/OpenStreetMap|ODbL|已转换为真正的Google Earth路径对象/.test(node.description ?? "")) continue;
  node.description = "";
  removedImportDescriptions += 1;
}
for (const node of project.nodes) if (node.style) delete node.style.iconHref;

fs.writeFileSync(projectPath, formatAnnotationJson(project));
console.log(JSON.stringify({ ...counts, removedImportDescriptions }, null, 2));
