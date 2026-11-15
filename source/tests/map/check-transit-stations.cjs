const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript'), assert = require('node:assert/strict');
const moduleUnderTest = {exports: {}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/desktop/src/renderer/features/map/transitStations.ts', 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText, {exports: moduleUnderTest.exports});
const {transitStationPoints} = moduleUnderTest.exports;
const station = {
  source: 'metro', properties: {stationLabel: 'Station'},
  geometry: {type: 'Polygon', coordinates: [[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]]},
};
const route = (name, color, coordinates, sourceLayer = 'inner-connections') => ({
  source: 'metro', sourceLayer, properties: {line: name, color, 'line-color': color},
  geometry: {type: 'LineString', coordinates},
});
const red = route('1', 'ff0000', [[0, 0.0005], [0.001, 0.0005]]);
const crossing = route('2', '0000ff', [[0.0005, -1], [0.0005, 1]], 'lines');
const blue = route('2', '0000ff', [[0.0005, 0], [0.0005, 0.001]]);
const outline = {...blue, properties: {...blue.properties, color: '000000'}};
const single = transitStationPoints([station, station], [red, red, crossing, outline]);
assert.equal(single.features.length, 1, 'Duplicate tiles create one station dot');
assert.equal(single.features[0].geometry.type, 'Point', 'Station polygons become fixed-size point symbols');
assert.equal(single.features[0].properties.color, '#ff0000');
assert.equal(single.features[0].properties.interchange, false, 'An unrelated crossing and casing do not create a transfer');
const transfer = transitStationPoints([station], [red, blue]);
assert.equal(transfer.features[0].properties.interchange, true);
assert.equal(transitStationPoints([station], [red, {...blue, properties: {...red.properties, line: '2'}}]).features[0].properties.interchange, true,
  'Two routes with the same color still make a transfer');
assert.equal(transitStationPoints([station], [route('1', 'ff0000', [[-1, 0.0005], [0, 0.0005]], 'lines')]).features.length, 1,
  'Terminus endpoints supply their route color');
const otherNetwork = {...station, source: 'commuter'};
assert.equal(transitStationPoints([station, otherNetwork], [red, {...blue, source: 'commuter'}]).features.length, 1);
assert.equal(transitStationPoints([station, otherNetwork], [red, {...blue, source: 'commuter'}]).features[0].properties.interchange, true);
assert.equal(transitStationPoints([station], [route('empty', 'ff0000', [])]).features.length, 0);
console.log('Transit stations passed: compact point anchors, route colors, real interchanges, termini, same-color routes, crossings and duplicate/cross-network sites.');
