const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript'), assert = require('node:assert/strict');
const target = {exports: {}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/desktop/src/renderer/features/map/currentTransitStations.ts', 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText, {exports: target.exports});
const {currentTransitStationPoints, operationalTransit} = target.exports;
const station = {source: 'v4', properties: {name: 'New station', subclass: 'subway'}, geometry: {type: 'Point', coordinates: [117, 36.65]}};
const line = (ref, colour, extra = {}) => ({source: 'v4', properties: {ref, colour, main: true, network: 'Jinan', ...extra},
  geometry: {type: 'LineString', coordinates: [[116.99, 36.65], [117.01, 36.65]]}});
const red = line('4', '#ff0000');
assert.equal(currentTransitStationPoints([station, station], [red]).features.length, 1);
assert.equal(currentTransitStationPoints([station], [red]).features[0].properties.color, '#ff0000');
assert(!currentTransitStationPoints([station], [red, line('9', '#0000ff', {construction: true})]).features[0].properties.interchange);
assert(!currentTransitStationPoints([station], [red, line('6', '#0000ff', {service: 'yard'})]).features[0].properties.interchange);
assert(!currentTransitStationPoints([station], [red, line('4', '#ff0000')]).features[0].properties.interchange, 'Duplicate route directions are one line');
assert(currentTransitStationPoints([station], [red, line('6', '#ff0000')]).features[0].properties.interchange, 'Same-colour routes remain distinct');
assert.equal(currentTransitStationPoints([{...station, properties: {...station.properties, construction: true}}], [red]).features.length, 0);
assert.equal(currentTransitStationPoints([{...station, geometry: {type: 'Point', coordinates: [117, 36.7]}}], [red]).features.length, 0, 'A distant route does not colour a station');
assert(!operationalTransit({construction: 'true'}));
console.log('Current transit passed: new station colours, duplicate routes, interchange detection and construction/service filtering.');
