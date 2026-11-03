const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const code = ts.transpileModule(fs.readFileSync('apps/desktop/src/main/storage/snapshots.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const mod = { exports: {} };
vm.runInNewContext(code, { exports: mod.exports, require, Buffer, console });
const { LocalCache } = mod.exports;
const storageModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/desktop/src/main/storage/paths.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, { exports: storageModule.exports, require });
const { systemCacheDirectory } = storageModule.exports;
assert.equal(systemCacheDirectory('darwin', '/Users/test', '/Users/test/Library/Application Support', {}), '/Users/test/Library/Caches/ReplayMod Reality');
assert.equal(systemCacheDirectory('linux', '/home/test', '/home/test/.config', { XDG_CACHE_HOME: '/cache' }), '/cache/ReplayMod Reality');
assert.equal(systemCacheDirectory('linux', '/home/test', '/home/test/.config', { XDG_CACHE_HOME: 'relative' }), '/home/test/.cache/ReplayMod Reality');
(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'replaymod-cache-'));
  try {
    const cache = new LocalCache(directory);
    assert.equal(await cache.read('missing'), null);
    await cache.write('dataset', { altitude: NaN, coordinates: [12, 34] });
    const restored = new LocalCache(directory).readSync('dataset');
    assert(Number.isNaN(restored.altitude));
    assert.equal(restored.coordinates[1], 34);
    await Promise.all(Array.from({length: 20}, (_, i) => cache.write('queued', i)));
    assert.equal(await cache.read('queued'), 19);
    cache.writeSync('workspace', { time: 123, draft: [[1, 2, 3]] });
    assert.equal(new LocalCache(directory).readSync('workspace').time, 123);
    fs.writeFileSync(path.join(directory, 'workspace.bin'), 'damaged snapshot');
    assert.equal(cache.readSync('workspace'), null);
    assert.throws(() => cache.writeSync('../escape', {}));
    assert(!fs.readdirSync(directory).some(name => name.endsWith('.tmp')));
    const settings = new LocalCache(path.join(directory, 'app-data/settings'));
    const state = new LocalCache(path.join(directory, 'app-data/state'));
    const disposable = new LocalCache(path.join(directory, 'system-cache'));
    settings.writeSync('maptiler-key', 'test-key');
    state.writeSync('workspace', { draft: 'keep' });
    disposable.writeSync('tile', [1, 2]);
    fs.rmSync(disposable.directory, { recursive: true });
    assert.equal(new LocalCache(settings.directory).readSync('maptiler-key'), 'test-key');
    assert.equal(new LocalCache(state.directory).readSync('workspace').draft, 'keep');
    console.log('Cache checks passed: restart, NaN preservation, queued writes, corrupt snapshot, path validation.');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });

// MapLibre custom protocols must decode JSON themselves; binary tiles remain buffers.
(async () => {
  let protocol;
  let resource = Buffer.from('{"version":8,"sources":{},"layers":[]}');
  const renderer = {exports: {}};
  const rendererCode = ts.transpileModule(fs.readFileSync('apps/desktop/src/renderer/shared/cache.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(rendererCode, {
    exports: renderer.exports, TextDecoder, Uint8Array, AbortController, setTimeout, clearTimeout,
    window: { addEventListener() {}, replaymod: {workspaceState: {}, loadMapResource: async url => {
      assert(url.startsWith('https://api.maptiler.com/'));
      return resource;
    }}},
    require: name => name === 'react' ? {} : { addProtocol: (_name, handler) => { protocol = handler; } },
  });
  const json = await protocol({url:'replaymap://api.maptiler.com/style.json', type:'json'}, new AbortController());
  assert.equal(json.data.version, 8);
  resource = Buffer.from([1, 2, 3]);
  const binary = await protocol({url:'replaymap://api.maptiler.com/tile.pbf', type:'arrayBuffer'}, new AbortController());
  assert.equal(new Uint8Array(binary.data)[2], 3);
  assert.equal(renderer.exports.cachedMapRequest('https://api.maptiler.com/a').url, 'replaymap://api.maptiler.com/a');
  assert.equal(renderer.exports.cachedMapRequest('https://example.com/a').url, 'https://example.com/a');
  console.log('Map protocol checks passed: JSON styles, binary tiles, URL scope.');
})().catch(error => { console.error(error); process.exitCode = 1; });
