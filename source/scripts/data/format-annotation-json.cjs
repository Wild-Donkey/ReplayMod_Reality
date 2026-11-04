const formatAnnotationJson = (project) => {
  project = {...project, nodes: project.nodes.map(node => {
    const {style, color, ...rest} = node;
    if (node.kind === "folder") return rest;
    return {...rest, color: color ?? style?.color ?? "#55cfff"};
  })};
  const coordinateSequences = [];
  const tokenPrefix = "__REPLAYMOD_COORDINATE_SEQUENCE_";
  let output = JSON.stringify(project, function replacer(key, value) {
    if (key === "description" && typeof value === "string") {
      const description = value.split(/\r?\n/).filter(line =>
        !/^\s*(?:WGS84(?:参考坐标)?|坐标来源|来源)\s*[：:]/i.test(line)
        && !/https?:\/\//i.test(line)
      ).join("\n").trim();
      return description || undefined;
    }
    if (key === "coordinates" && Array.isArray(value) && value.length === 0) return undefined;
    if (key === "open" && (value === false || this.kind !== "folder")) return undefined;
    if (key === "altitudeMode") return undefined;
    if (key !== "coordinates" || !Array.isArray(value)) return value;
    const coordinates2d = value.map(coordinate => [coordinate[0], coordinate[1]]);
    const index = coordinateSequences.push(JSON.stringify(coordinates2d)) - 1;
    return `${tokenPrefix}${index}__`;
  }, 2);

  coordinateSequences.forEach((coordinates, index) => {
    output = output.replace(`"${tokenPrefix}${index}__"`, coordinates);
  });
  return `${output}\n`;
};

module.exports = { formatAnnotationJson };

if (require.main === module) {
  const fs = require("node:fs");
  const path = require("node:path");
  const projectPath = path.resolve(__dirname, "../../../RawData/annotations/annotations.json");
  const project = JSON.parse(fs.readFileSync(projectPath, "utf8"));
  fs.writeFileSync(projectPath, formatAnnotationJson(project));
}
