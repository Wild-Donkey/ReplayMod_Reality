const fs = require("node:fs");
const path = require("node:path");
const { formatAnnotationJson } = require("./format-annotation-json.cjs");

const projectPath = path.resolve(__dirname, "../../../RawData/annotations/annotations.json");
const project = JSON.parse(fs.readFileSync(projectPath, "utf8"));
const nodes = project.nodes;

// Exact second import of the standalone G214 dataset.
const duplicateRootId = "5FA450A291000001";
const removedIds = new Set([duplicateRootId]);
let expanded = true;
while (expanded) {
  expanded = false;
  for (const node of nodes) {
    if (node.parentId && removedIds.has(node.parentId) && !removedIds.has(node.id)) {
      removedIds.add(node.id);
      expanded = true;
    }
  }
}
const duplicateImportCount = nodes.filter((node) => removedIds.has(node.id)).length;

const distanceMeters = (a, b) => {
  const radius = 6371000;
  const radians = (value) => value * Math.PI / 180;
  const dLat = radians(b[1] - a[1]);
  const dLon = radians(b[0] - a[0]);
  const value = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(a[1])) * Math.cos(radians(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(value));
};

const routeLengthKm = (coordinates) => {
  let meters = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    meters += distanceMeters(coordinates[index - 1], coordinates[index]);
  }
  return meters / 1000;
};

// Only bridge small endpoint discrepancies from imported road geometry.
// Larger gaps remain separate, so no speculative straight road is created.
const joinToleranceMeters = 25;
const routesByParent = new Map();
for (const node of nodes) {
  if (removedIds.has(node.id) || node.kind !== "route") continue;
  const siblings = routesByParent.get(node.parentId) ?? [];
  siblings.push(node);
  routesByParent.set(node.parentId, siblings);
}

const merged = [];
for (const siblings of routesByParent.values()) {
  const remaining = [...siblings];
  while (remaining.length) {
    const chain = [remaining.shift()];
    let coordinates = [...chain[0].coordinates];
    let found = true;
    while (found) {
      found = false;
      let best = null;
      for (let index = 0; index < remaining.length; index += 1) {
        const candidate = remaining[index];
        const options = [
          { distance: distanceMeters(coordinates.at(-1), candidate.coordinates[0]), mode: "append" },
          { distance: distanceMeters(coordinates.at(-1), candidate.coordinates.at(-1)), mode: "append-reverse" },
          { distance: distanceMeters(coordinates[0], candidate.coordinates.at(-1)), mode: "prepend" },
          { distance: distanceMeters(coordinates[0], candidate.coordinates[0]), mode: "prepend-reverse" },
        ];
        for (const option of options) {
          if (option.distance <= joinToleranceMeters && (!best || option.distance < best.distance)) {
            best = { ...option, index, candidate };
          }
        }
      }
      if (!best) continue;
      const addition = [...best.candidate.coordinates];
      if (best.mode.endsWith("reverse")) addition.reverse();
      if (best.mode.startsWith("append")) {
        const left = coordinates.at(-1);
        const right = addition[0];
        coordinates[coordinates.length - 1] = [
          (left[0] + right[0]) / 2,
          (left[1] + right[1]) / 2,
        ];
        addition.shift();
        coordinates.push(...addition);
      } else {
        const left = addition.at(-1);
        const right = coordinates[0];
        coordinates[0] = [
          (left[0] + right[0]) / 2,
          (left[1] + right[1]) / 2,
        ];
        addition.pop();
        coordinates.unshift(...addition);
      }
      chain.push(best.candidate);
      remaining.splice(best.index, 1);
      found = true;
    }
    if (chain.length < 2) continue;
    const keeper = chain[0];
    keeper.coordinates = coordinates;
    keeper.name = keeper.name
      .replace(/\uff5c\u5206\u6bb5\d+/, "")
      .replace(/\uff5c\u5408\u5e76\d+\u6bb5/, "")
      .replace(/\uff5c\u7ea6[\d.]+km/, "");
    for (const route of chain.slice(1)) removedIds.add(route.id);
    merged.push({ keeper: keeper.id, segments: chain.length, name: keeper.name });
  }
}

const before = nodes.length;
project.nodes = nodes.filter((node) => !removedIds.has(node.id));
fs.writeFileSync(projectPath, formatAnnotationJson(project));

console.log(JSON.stringify({
  before,
  after: project.nodes.length,
  removedDuplicateImportNodes: duplicateImportCount,
  mergedChains: merged.length,
  mergedRouteNodes: merged.reduce((sum, item) => sum + item.segments - 1, 0),
  merged,
}, null, 2));
