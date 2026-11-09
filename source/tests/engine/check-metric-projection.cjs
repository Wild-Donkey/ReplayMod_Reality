const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
(async () => {
  const {OrthographicViewport, WebMercatorViewport} = await import('@deck.gl/core');
  const {default: maplibre} = await import('maplibre-gl');
  const load = (name) => {
    const exports = {};
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/desktop/src/renderer/render-engine/' + name + '.ts', 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText, {exports});
    return exports;
  };
  const {metricSegments, metricXAt} = load('MetricSeries');
  const {timelineDensityBuffer} = load('TimelineDensity');
  const {footprintProjectionMatrix, normalizedMercator} = load('backends/FootprintProjection');
  const epoch = 1_800_000_000_000;
  const series = {id: 'speed', space: 'timeline', x: new Float64Array([epoch, epoch + 1, epoch + 2]), values: new Float64Array([0, 10, 20]), xDomain: [epoch, epoch + 2], yDomain: [0, 20]};
  const data = metricSegments(series);
  for (const [width, height] of [[320, 120], [1000, 150], [1, 1]]) {
    const viewport = new OrthographicViewport({id: 'timeline', x: 31, y: 47, width, height, target: [0.5, 0.5, 0], zoomX: Math.log2(width), zoomY: Math.log2(height)});
    const start = viewport.project(Array.from(data.positions.subarray(0, 3)));
    const end = viewport.project(Array.from(data.positions.subarray(3, 6)));
    assert(Math.abs(start[0]) < 1e-8); assert(Math.abs(start[1] - height) < 1e-8);
    assert(Math.abs(end[0] - width / 2) < 1e-8); assert(Math.abs(end[1] - height / 2) < 1e-8);
    const coordinate = viewport.unproject([width / 2, height / 2]);
    assert.equal(metricXAt(series, coordinate[0]), epoch + 1);
    assert.equal(metricSegments(series), data, 'Resizing the viewport must not recompile geometry');
  }
  const padded = {...series, padding: {left: 0.042, right: 0.012, top: 0.08, bottom: 0.16}};
  const curve = metricSegments(padded);
  assert(Math.abs(curve.positions[0] - 0.042) < 1e-7);
  assert(Math.abs(curve.positions[1] - 0.84) < 1e-7);
  assert.equal(metricXAt(padded, 0.042), epoch);
  assert.equal(metricXAt(padded, 0.988), epoch + 2);
  const density = {
    footprint: {counts: new Uint32Array([0, 1, 3]), peak: 3},
    photo: {counts: new Uint32Array([1, 0, 3]), peak: 3},
  };
  const bins = timelineDensityBuffer(density);
  assert.equal(timelineDensityBuffer(density), bins, 'Unchanged density bins reuse the binary attributes');
  const viewport = new OrthographicViewport({width: 300, height: 4, target: [0.5, 0.5, 0], zoomX: Math.log2(300), zoomY: 2});
  const positions = bins.attributes.getPolygon.value;
  const corners = [0, 5, 12, 22].map(index => viewport.project(Array.from(positions.subarray(index * 3, index * 3 + 3))).slice(0, 2).map(value => Math.round(value) || 0));
  assert.deepEqual(corners, [[0, 0], [200, 0], [0, 2], [300, 4]], 'Density bins map to the full width and two 2px rows');
  const colors = bins.attributes.getFillColor.value;
  assert.deepEqual([0, 1, 2, 3].map(index => Array.from(colors.subarray(index * 16, index * 16 + 4))), [[0, 0, 0, 255], [185, 245, 197, 255], [255, 255, 255, 255], [255, 227, 110, 255]]);
  console.log('Metric and density projection passed: real deck OrthographicViewport, exact plot bounds, 1 ms precision, chart insets and resize buffer reuse.');

  for (const [longitude, latitude, point, wrap] of [
    [114.3, 30.6, [114.301, 30.601], 0],
    [179.999, 20, [-179.999, 20.001], 1],
    [-179.999, -20, [179.999, -20.001], -1],
  ]) {
    const view = new WebMercatorViewport({width: 800, height: 600, longitude, latitude, zoom: 14, pitch: 55, bearing: 37});
    const normalizedMatrix = footprintProjectionMatrix(view.viewProjectionMatrix);
    const {x, y} = normalizedMercator(...point);
    const legacy = maplibre.MercatorCoordinate.fromLngLat(point);
    assert.equal(x, legacy.x);
    assert.equal(y, legacy.y);
    const clip = [0, 1, 2, 3].map(row => normalizedMatrix[row] * (x + wrap) + normalizedMatrix[row + 4] * y + normalizedMatrix[row + 12]);
    const screen = [(clip[0] / clip[3] + 1) * view.width / 2, (1 - clip[1] / clip[3]) * view.height / 2];
    const expected = view.project([point[0] + wrap * 360, point[1]]);
    assert(screen.every((value, index) => Math.abs(value - expected[index]) < 1e-6), 'Normalized footprint coordinates agree with Deck under pitch and world wrapping');
  }
  console.log('Footprint projection passed: MapLibre normalized Mercator coordinates match Deck with pitch, bearing and both antimeridian wraps.');
})().catch(error => {console.error(error); process.exitCode = 1;});
