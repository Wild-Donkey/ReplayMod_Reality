const {app, BrowserWindow} = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const userData = fs.mkdtempSync('/tmp/replay-building-test-');
app.setPath('userData', userData);
const root = path.resolve(__dirname, '../../apps/desktop/src/renderer/features/map');
const sources = Object.fromEntries(['BuildingHeightOverlay', 'basemapStyle'].map(name => [name,
  ts.transpileModule(fs.readFileSync(path.join(root, name + '.ts'), 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true},
  }).outputText,
]));

app.whenReady().then(async () => {
  const {default: Pbf} = await import('pbf');
  const makeTile = (zoom, tallHeight) => {
    const pbf = new Pbf();
    pbf.writeMessage(3, (_, layer) => {
      layer.writeStringField(1, 'building');
      for (const [left, top, right, bottom, heightIndex] of [
        [1200, 1770, 2220, 2200, 0],
        [1950, 1770, 2750, 2200, 0],
        [1950, 2280, 2250, 2500, 1],
      ]) {
        const [x1, y1, x2, y2] = [left, top, right, bottom].map(value => Math.round(value / 2 ** (14 - zoom)));
        layer.writeMessage(2, (_, feature) => {
          const zigzag = value => value >= 0 ? value * 2 : -value * 2 - 1;
          feature.writePackedVarint(2, [0, heightIndex]);
          feature.writeVarintField(3, 3);
          feature.writePackedVarint(4, [
            9, zigzag(x1), zigzag(y1),
            26, zigzag(x2 - x1), 0, 0, zigzag(y2 - y1), zigzag(x1 - x2), 0,
            15,
          ]);
        });
      }
      layer.writeStringField(3, 'height');
      for (const height of [3, tallHeight]) layer.writeMessage(4, (_, value) => value.writeVarintField(5, height));
      layer.writeVarintField(5, 4096);
      layer.writeVarintField(15, 2);
    });
    return [...pbf.finish()];
  };
  const tiles = {12: makeTile(12, 60), 13: makeTile(13, 5), 14: makeTile(14, 60)};
  const window = new BrowserWindow({show: false});
  try {
    await window.loadURL('data:text/html,<html></html>');
    await window.webContents.executeJavaScript(fs.readFileSync(path.resolve(__dirname, '../../node_modules/maplibre-gl/dist/maplibre-gl.js'), 'utf8'));
    const result = await window.webContents.executeJavaScript(`(async () => {
      const sources = ${JSON.stringify(sources)}, loaded = {};
      function load(id) {
        if (id === 'maplibre-gl') return window.maplibregl;
        if (id === '../../shared/cache') return {cachedMapRequest: url => ({url})};
        id = id.startsWith('./') ? id.slice(2) : id;
        if (loaded[id]) return loaded[id];
        const exports = loaded[id] = {};
        new Function('exports', 'require', sources[id])(exports, load);
        return exports;
      }
      const {BuildingHeightOverlay} = load('BuildingHeightOverlay');
      const tiles = ${JSON.stringify(tiles)};
      const requested = new Set();
      maplibregl.addProtocol('building-fixture', async ({url}) => {
        const [zoom, x, y] = url.slice('building-fixture://'.length).split('/').map(Number);
        const center = 2 ** (zoom - 1);
        if (x !== center || y !== center) return {data: new ArrayBuffer(0)};
        requested.add(zoom);
        return {data: new Uint8Array(tiles[zoom]).buffer};
      });
      const container = document.createElement('div');
      Object.assign(container.style, {position: 'relative', width: '256px', height: '128px'});
      document.body.append(container);
      const position = (x, y) => [
        x / (4096 * 16384) * 360,
        Math.atan(Math.sinh(-y / (4096 * 16384) * 2 * Math.PI)) * 180 / Math.PI,
      ];
      const map = new maplibregl.Map({
        container, center: position(2048, 2048), zoom: 14, pixelRatio: 1,
        style: {version: 8, sources: {}, layers: [{id: 'black', type: 'background', paint: {'background-color': '#000'}}]},
        canvasContextAttributes: {preserveDrawingBuffer: true},
      });
      await new Promise(resolve => map.once('load', resolve));
      let remembered = 0;
      window.addEventListener('building-cache-stats', event => { remembered = event.detail.features; });
      const overlay = new BuildingHeightOverlay(map, {
        version: 8,
        sources: {planet: {type: 'vector', minzoom: 12, maxzoom: 14, tiles: ['building-fixture://{z}/{x}/{y}']}},
        layers: [{id: 'Building', type: 'fill', source: 'planet', 'source-layer': 'building'}],
      });
      const snapshot = document.createElement('canvas');
      snapshot.width = 256;
      snapshot.height = 128;
      const context = snapshot.getContext('2d', {willReadFrequently: true});
      const sample = () => {
        map.redraw();
        context.drawImage(map.getCanvas(), 0, 0);
        return [[1750, 2048], [2048, 2048], [2400, 2048], [2048, 2400], [2048, 1650]].map(([x,y]) => {
          const point = map.project(position(x,y));
          return context.getImageData(point.x, point.y, 1, 1).data[0];
        });
      };
      const until = async condition => {
        for (let i = 0; i < 150; i++) {
          if (condition()) return;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        throw new Error('Building mask did not settle: ' + JSON.stringify({remembered, pixels: sample()}));
      };
      await until(() => remembered >= 3 && overlay.map.loaded() && sample()[0] > 0);
      const current = sample();
      map.jumpTo({zoom: 13});
      await until(() => requested.has(13) && overlay.map.loaded() && sample()[3] > 0);
      const intermediate = sample();
      map.jumpTo({zoom: 12});
      await until(() => requested.has(12) && overlay.map.loaded() && sample()[3] > 0);
      const coarse = sample();
      map.jumpTo({zoom: 11});
      await until(() => overlay.map.loaded() && sample()[3] > 0);
      const cached = sample();
      overlay.setVisible(false);
      const hidden = sample();
      overlay.setVisible(true);
      const restored = sample();
      overlay.updateMemoryLimit(0);
      map.jumpTo({zoom: 14});
      await until(() => overlay.map.loaded() && sample()[3] > 0);
      const withoutCache = sample();
      overlay.dispose();
      const disposed = sample();
      map.remove();
      return {current, intermediate, coarse, cached, hidden, restored, withoutCache, disposed};
    })()`);
    assert(Math.abs(result.current[0] - 18) <= 1, 'original opacity for a low building');
    assert(Math.abs(result.current[3] - 87) <= 1, 'original opacity for a tall building');
    assert.equal(result.current[4], 0, 'background stays transparent');
    assert.deepEqual(result.current.slice(0, 3), Array(3).fill(result.current[0]), 'overlap keeps the same brightness as either single footprint');
    assert.deepEqual(result.intermediate, result.current, 'an intermediate tile with a placeholder height preserves the known building shade');
    assert.deepEqual(result.coarse, result.current, 'brightness is continuous across all three provider LODs');
    assert.deepEqual(result.cached, result.current, 'cached buildings keep their shade below the source minimum zoom');
    assert.deepEqual(result.hidden, [0, 0, 0, 0, 0]);
    assert.deepEqual(result.restored, result.cached);
    assert.deepEqual(result.withoutCache, result.current, 'the active provider footprints render with no memory budget');
    assert.deepEqual(result.disposed, result.hidden);
    console.log('Building composite passed:', result);
  } finally {
    window.destroy();
  }
  app.quit();
}).catch(error => {
  console.error(error);
  app.exit(1);
});
app.on('quit', () => fs.rmSync(userData, {recursive: true, force: true}));
