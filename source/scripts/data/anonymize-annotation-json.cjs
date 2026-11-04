const fs = require("node:fs");
const path = require("node:path");
const { formatAnnotationJson } = require("./format-annotation-json.cjs");

const annotationsDirectory = path.resolve(__dirname, "../../../RawData/annotations");
const sourcePath = path.join(annotationsDirectory, "annotations.json");
const examplePath = path.join(annotationsDirectory, "Example_annotations.json");
const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));

// Remove personal places, completed journeys and date-specific private plans.
// Their descendants are removed with them; public landmarks and road references
// keep their original names and coordinates so the example remains useful.
const privateRootIds = new Set([
  "015E4318B642A7C3545C", // 2027 graduation motorcycle itinerary
  "0DFD4C895442A7C17DB4", // school
  "0D07AE9B2942A7C183D4", // personal places
  "0DE80BA6B842A7C79F16", // historical personal journeys
  "5FA42D6FD8000002", // date-specific winter driving itinerary
  "5FA4318891000002", // winter reverse-route itinerary
]);
const removedIds = new Set(privateRootIds);
let changed = true;
while (changed) {
  changed = false;
  for (const node of source.nodes) {
    if (node.parentId && removedIds.has(node.parentId) && !removedIds.has(node.id)) {
      removedIds.add(node.id);
      changed = true;
    }
  }
}

const example = {
  format: source.format,
  version: source.version,
  name: "地图标注示例",
  nodes: source.nodes.filter((node) => !removedIds.has(node.id)),
};

fs.writeFileSync(examplePath, formatAnnotationJson(example));
console.log(`Removed ${removedIds.size} private nodes; wrote ${example.nodes.length} example nodes to ${examplePath}`);
