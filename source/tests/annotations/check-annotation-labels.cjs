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
// A long name can move left rather than absorbing a nearby marker.
const avoid = [point('a', 200, 100, '一段比较长的地名'), point('b', 270, 100)];
const avoided = layoutAnnotationLabels(avoid, measure, 800);
assert.equal(avoided.length, 2);
assert.equal(avoided.find(group => group.items[0].id === 'a').side, 'left');
assert.equal(JSON.stringify(avoided), JSON.stringify(layoutAnnotationLabels([...avoid].reverse(), measure, 800)));
const edge = layoutAnnotationLabels([point('edge', 790, 100, '边缘地点')], measure, 800)[0];
assert.equal(edge.side, 'left');
assert(edge.right <= 800);

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
  const textBounds = g => ({left: g.left + (g.side === 'right' ? (g.items.length > 1 ? 10 : 8) : 0), right: g.right - (g.side === 'left' ? (g.items.length > 1 ? 10 : 8) : 0)});
  const at = textBounds(a), bt = textBounds(b);
  assert(!(at.left < bt.right + 3 && at.right + 3 > bt.left && a.top < b.bottom + 3 && a.bottom + 3 > b.top), 'final text must not overlap');
}
console.log('Label layout passed: separated, overlap, long names, vertical spacing, coincident points, transitive groups, real point count conservation.');

// Reproduce the render between hiding a place and the layout effect running.
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
let previousGroups = [];
const visibilityHook = {exports: {}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/desktop/src/renderer/render-engine/useReplayVisibility.ts', 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText, {exports: visibilityHook.exports, require});
const annotationsHook = {exports: {}}, geometryModule = {exports: {}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/desktop/src/renderer/render-engine/useReplayAnnotations.ts', 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText, {exports: annotationsHook.exports, require});
vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/desktop/src/renderer/render-engine/AnnotationGeometry.ts', 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText, {exports: geometryModule.exports, require: name => name === '../features/annotations/annotations' ? {} : require(name)});
const scene = {current: {visibility: {annotations: true}}, subscribe: () => () => {}};
const labelComponent = {exports: {}};
const componentCode = ts.transpileModule(fs.readFileSync('apps/desktop/src/renderer/features/annotations/AnnotationLabels.tsx', 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX},
}).outputText;
vm.runInNewContext(componentCode, {exports: labelComponent.exports, require: name => {
  if (name === 'react') return {...React, useState: () => [previousGroups, () => {}], useEffect: () => {}};
  if (name === './annotation-label-layout') return mod.exports;
  if (name === '../../render-engine/useReplayVisibility') return visibilityHook.exports;
  if (name === '../../render-engine/useReplayAnnotations') return annotationsHook.exports;
  if (name === '../../render-engine/AnnotationGeometry') return geometryModule.exports;
  if (name === 'maplibre-gl') return {};
  return require(name);
}});
const renderLabels = points => {
  scene.current = {...scene.current, annotationGeometry: {type:'FeatureCollection',features:points.map(point=>({type:'Feature',id:point.id,properties:{id:point.id,name:point.name,color:point.color,selected:false},geometry:{type:'Point',coordinates:point.coordinates[0]}}))}};
  return renderToStaticMarkup(React.createElement(labelComponent.exports.AnnotationLabels, {
    scene, map: {}, drawing: false, onSelect: () => {},
  }));
};
const visiblePoint = {id:'a', name:'保留地点', coordinates:[[0,0]], color:'#ffffff'};
previousGroups = layoutAnnotationLabels([point('a',0,0)], measure);
assert.match(renderLabels([visiblePoint]), /保留地点/);
scene.current = {visibility: {annotations: false}};
assert.equal(renderLabels([visiblePoint]), '', 'Scene visibility hides labels before layout effects run');
scene.current = {visibility: {annotations: true}};
assert.match(renderLabels([visiblePoint]), /保留地点/, 'Scene visibility restores labels');
assert.doesNotThrow(() => renderLabels([]));
assert(!renderLabels([]).includes('annotation-map-label'));
previousGroups = overlap;
assert(!renderLabels([visiblePoint]).includes('annotation-map-group'));
assert.doesNotThrow(() => renderLabels([]));
console.log('Label rendering passed: hiding/deleting places and folders with stale single/cluster layouts.');

for (const total of [4, 5, 6, 120]) {
  const members = Array.from({length: total}, (_, i) => point(String(i), 50, 50, `地点${i}`));
  previousGroups = layoutAnnotationLabels(members, measure);
  const markup = renderLabels(members.map(item => ({...visiblePoint, ...item})));
  assert.equal((markup.match(/<button/g) || []).length, 3);
  assert(markup.includes(`+${total - 3}</b>`));
}
console.log('Label updates passed: left-side avoidance, viewport edge, stable ordering, three rows with +N.');

// Nearby peaks: marker hit areas overlap vertically, but text fits on opposite sides.
for (const dx of [-6, 0, 6]) {
  const peaks = [point('everest', 600, 300, '珠穆朗玛峰｜8848.86m'), point('lhotse', 600 + dx, 313, '洛子峰｜8516m')];
  const result = layoutAnnotationLabels(peaks, measure, 1200);
  assert.equal(result.length, 2, 'nearby peaks must remain separate');
  assert.equal(new Set(result.map(group => group.side)).size, 2, 'peaks must use opposite sides');
}
console.log('Nearby peak regression passed: overlapping marker bounds allow left/right text.');
