const fs = require('node:fs');
const assert = require('node:assert/strict');
const ts = require('typescript');
const vm = require('node:vm');
const compiled = ts.transpileModule(fs.readFileSync('apps/desktop/src/renderer/features/annotations/annotation-label-layout.ts', 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText;
const mod = {exports: {}};
vm.runInNewContext(compiled, {exports: mod.exports});
const {layoutAnnotationLabels, pointLabelText} = mod.exports;
const measure = text => [...text].length * 11;
const point = (id, x, y, name = '地点') => ({id, x, y, name});
const separated = [point('a', 0, 0), point('b', 200, 0)];
assert.equal(layoutAnnotationLabels(separated, measure).length, 2);
const overlap = layoutAnnotationLabels([point('a', 0, 0), point('b', 10, 0)], measure);
assert.equal(overlap.length, 1); assert.equal(overlap[0].items.length, 2);
assert.equal(overlap[0].x, 5); assert.equal(overlap[0].y, 0);
assert.equal(overlap[0].bottom - overlap[0].top, 28);
// Labels overlap even when the point markers themselves do not.
assert.equal(layoutAnnotationLabels([point('a', 0, 0, '一段比较长的地名'), point('b', 70, 0)], measure).length, 1);
assert.equal(layoutAnnotationLabels([point('a', 0, 0), point('b', 0, 40)], measure).length, 2);
const coincident = Array.from({length: 120}, (_, i) => point(String(i), 50, 50));
assert.equal(layoutAnnotationLabels(coincident, measure)[0].items.length, 120);
assert.equal(layoutAnnotationLabels(coincident, measure)[0].bottom - layoutAnnotationLabels(coincident, measure)[0].top, 42);
assert.equal(pointLabelText(point('x', 0, 0, '未命名地标')), '');
const chain = [point('a', 0, 0), point('b', 25, 0), point('c', 50, 0)];
assert.equal(layoutAnnotationLabels(chain, measure).length, 1);
const realPath = '../RawData/annotations/annotations.json';
const real = fs.existsSync(realPath) ? JSON.parse(fs.readFileSync(realPath, 'utf8')) : {nodes: []};
const items = real.nodes.filter(n => n.kind === 'point').map(n => point(n.id, n.coordinates[0][0] * 20, -n.coordinates[0][1] * 20, n.name));
const groups = layoutAnnotationLabels(items, measure);
assert.equal(groups.reduce((sum, group) => sum + group.items.length, 0), items.length);
assert.equal(new Set(groups.flatMap(group => group.items.map(item => item.id))).size, items.length);
for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
  const a = groups[i], b = groups[j];
  assert(!(a.left < b.right + 3 && a.right + 3 > b.left && a.top < b.bottom + 3 && a.bottom + 3 > b.top), 'final labels must not overlap');
}
console.log('Label layout passed: separated, overlap, long names, vertical spacing, coincident points, transitive groups, real point count conservation.');

// Reproduce the render between hiding a place and the layout effect running.
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
let previousGroups = [];
const labelComponent = {exports: {}};
const componentCode = ts.transpileModule(fs.readFileSync('apps/desktop/src/renderer/features/annotations/AnnotationLabels.tsx', 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX},
}).outputText;
vm.runInNewContext(componentCode, {exports: labelComponent.exports, require: name => {
  if (name === 'react') return {...React, useState: () => [previousGroups, () => {}], useEffect: () => {}};
  if (name === './annotation-label-layout') return mod.exports;
  if (name === 'maplibre-gl') return {};
  return require(name);
}});
const renderLabels = points => renderToStaticMarkup(React.createElement(labelComponent.exports.AnnotationLabels, {
  map: {}, points, selectedId: null, drawing: false, onSelect: () => {},
}));
const visiblePoint = {id:'a', name:'保留地点', coordinates:[[0,0]], style:{color:'#ffffff', opacity:1}};
previousGroups = layoutAnnotationLabels([point('a',0,0)], measure);
assert.match(renderLabels([visiblePoint]), /保留地点/);
assert.doesNotThrow(() => renderLabels([]));
assert(!renderLabels([]).includes('annotation-map-label'));
previousGroups = overlap;
assert(!renderLabels([visiblePoint]).includes('annotation-map-group'));
assert.doesNotThrow(() => renderLabels([]));
console.log('Label rendering passed: hiding/deleting places and folders with stale single/cluster layouts.');
