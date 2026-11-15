const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript'), assert = require('node:assert/strict');
const mod = {exports: {}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/desktop/src/shared/transitEntrances.ts', 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText, {exports: mod.exports});
const {mergeTransitEntrances} = mod.exports;
const entrance = (longitude, ref) => ({
  type: 'Feature', geometry: {type: 'Point', coordinates: [longitude, 40]},
  properties: {subclass: 'subway_entrance', ...(ref === undefined ? {} : {ref})},
});
const base = entrance(116);
const numbered = entrance(116.000001, ' A1 ');
const unnamed = entrance(116.00002);
const remote = entrance(116.001);
const merged = mergeTransitEntrances([base, base, remote], [numbered, numbered, unnamed]);
assert.equal(merged.features.length, 3, 'Newer points replace old anonymous copies and tile duplicates');
assert.deepEqual(Array.from(merged.features, feature => feature.properties.ref).sort(), ['', '', 'A1']);
assert(merged.features.some(feature => feature.geometry.coordinates[0] === 116.00002),
  'A genuine nearby unnumbered entrance remains its own icon');
assert.equal(mergeTransitEntrances([base], []).features[0].properties.ref, '', 'Old tiles provide icon-only fallback');
assert.equal(mergeTransitEntrances([], [entrance(116, 'A'), entrance(116.00002, 'B')]).features.length, 2,
  'Neighboring numbered exits are distinct');
assert.equal(mergeTransitEntrances([{...base, properties: {subclass: 'parking_entrance'}}], []).features.length, 0);
assert.equal(mergeTransitEntrances([{...base, properties: {...base.properties, name: 'Station'}}], []).features[0].properties.ref, '',
  'An entrance name is never guessed to be its exit number');
console.log('Transit entrances passed: explicit numbering, unnumbered fallback, duplicate tiles, nearby distinct exits and non-subway filtering.');
