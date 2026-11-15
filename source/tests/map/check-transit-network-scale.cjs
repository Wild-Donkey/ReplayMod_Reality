const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript'), assert = require('node:assert/strict');
const target = {exports: {}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/desktop/src/renderer/features/map/transitNetworkScale.ts', 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText, {exports: target.exports});
const {networkHull, networkFillsViewport} = target.exports;
// A 600x800 viewport has a 1000px diagonal. Check both sides of 1/2.
assert(!networkFillsViewport([[0, 0], [499, 0]], 600, 800));
assert(networkFillsViewport([[0, 0], [500, 0]], 600, 800));
assert(networkFillsViewport([[0, 0], [300, 400]], 600, 800), 'Longest direction includes diagonal networks');
assert(!networkFillsViewport([[0, 0], [500, 0]], 1200, 1600), 'Resizing changes the screen occupancy threshold');
assert(networkFillsViewport([[0, 0], [0, 500]], 800, 600), 'Rotation preserves longest extent');
const hull = networkHull([[0, 0], [500, 0], [300, 0], [0, 0]]);
assert.equal(hull.length, 2, 'Duplicate tiles and interior points do not inflate extent');
assert(networkFillsViewport(hull, 600, 800));
assert(!networkFillsViewport([], 600, 800));
assert(!networkFillsViewport([[0, 0]], 600, 800));
assert(!networkFillsViewport([[0, 0], [100, 0]], 0, 0));
console.log('Transit network scale passed: diagonal threshold, rotation, resize and duplicate/interior geometry.');
