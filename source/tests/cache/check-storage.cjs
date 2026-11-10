const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');

function load(file) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { exports: module.exports, Buffer, console,
    require: name => name.startsWith('.') ? load(path.resolve(path.dirname(file), name + '.ts')) : require(name),
  }, { filename: file });
  return module.exports;
}

const { AppStorage } = load(path.resolve('apps/desktop/src/main/storage/index.ts'));
const { LocalCache } = load(path.resolve('apps/desktop/src/main/storage/snapshots.ts'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'replaymod-storage-'));
try {
  const home = path.join(root, 'home');
  const appData = path.join(home, 'Library/Application Support');
  const data = path.join(appData, 'ReplayMod Reality');
  // Existing data is converted without deleting the previous copy.
  const previous = new LocalCache(path.join(data, 'settings-v1'));
  previous.writeSync('maptiler-key', 'existing-test-key');
  const first = new AppStorage('darwin', home, appData, {});
  assert.equal(first.settings.read().maptilerApiKey, 'existing-test-key');
  assert.equal(first.settings.read().mapLanguage, 'auto');
  first.state.writeSync('workspace', { draft: 'saved' });
  first.settings.save({ maptilerApiKey: 'shared-test-key', mapLanguage: 'zh' });
  const before = process.cwd();
  try {
    process.chdir(root);
    const otherLaunch = new AppStorage('darwin', home, appData, {});
    assert.equal(otherLaunch.paths.config, first.paths.config);
    assert.equal(otherLaunch.paths.cache, first.paths.cache);
    assert.equal(otherLaunch.settings.read().maptilerApiKey, 'shared-test-key');
    assert.equal(otherLaunch.settings.read().mapLanguage, 'zh');
  } finally { process.chdir(before); }
  fs.mkdirSync(first.paths.cache);
  fs.rmSync(first.paths.cache, { recursive: true });
  const restarted = new AppStorage('darwin', home, appData, {});
  assert.equal(restarted.settings.read().maptilerApiKey, 'shared-test-key');
  assert.equal(restarted.state.readSync('workspace').draft, 'saved');
  // Clearing a key must never revive the previous format's key.
  restarted.settings.save({ maptilerApiKey: '', mapLanguage: 'local' });
  assert.equal(new AppStorage('darwin', home, appData, {}).settings.read().maptilerApiKey, '');
  fs.writeFileSync(first.paths.config, '{invalid');
  assert.throws(() => restarted.settings.read());
  assert.equal(fs.readFileSync(first.paths.config, 'utf8'), '{invalid');
  assert.equal(previous.readSync('maptiler-key'), 'existing-test-key');
  console.log('Storage checks passed: fixed paths, upgrade, shared config, cache deletion, cleared key, corrupt config preservation.');
} finally { fs.rmSync(root, { recursive: true, force: true }); }

async function checkResourceCache() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'replaymod-resource-cache-'));
  try {
    const home = path.join(root, 'home');
    const appData = path.join(home, 'Library/Application Support');
    const storage = new AppStorage('darwin', home, appData, {});
    const oldMaps = new LocalCache(path.join(storage.paths.legacyCache, 'maps-v1'));
    const oldSnapshots = new LocalCache(path.join(storage.paths.data, 'cache', 'snapshots-v1'));
    const snapshotKey = 'a'.repeat(64);
    const snapshot = { altitude: NaN, payload: Buffer.alloc(1500) };
    oldMaps.writeSync('old-tile', { at: 123, data: Buffer.alloc(1500) });
    oldSnapshots.writeSync(snapshotKey, snapshot);
    oldSnapshots.writeSync('workspace', { draft: 'historical' });

    const cache = storage.openResourceCache(1);
    assert(Number.isNaN((await cache.read('snapshots', snapshotKey)).altitude));
    assert.equal((await cache.read('maps', 'old-tile')).at, 123);
    assert.equal(await cache.read('snapshots', 'workspace'), null);
    await Promise.all([
      cache.write('buildings', 'provider-footprints', '[]'),
      cache.write('screening', 'last-run', { throughTimestamp: 123 }),
      cache.write('maps', 'airport-zh-zbaa', { name: '北京首都国际机场' }),
    ]);
    assert.equal(await cache.read('maps', 'airport-zh-zbaa').then(value => value.name), '北京首都国际机场');
    const buildingDir = path.join(storage.paths.cache, 'buildings-v1');
    fs.writeFileSync(path.join(buildingDir, 'interrupted.bin.tmp'), 'partial write');
    await cache.drain();

    const restart = new AppStorage('darwin', home, appData, {}).openResourceCache(1);
    assert.equal((await restart.usage()).entries, 5);
    assert(!fs.existsSync(path.join(buildingDir, 'interrupted.bin.tmp')));
    assert.deepEqual(Array.from(await restart.recentKeys('buildings', 'provider-', 100)), ['footprints']);
    assert.equal(await restart.read('buildings', 'provider-footprints'), '[]');
    assert.equal((await restart.read('screening', 'last-run')).throughTimestamp, 123);
    assert.equal((await restart.read('maps', 'old-tile')).at, 123);

    // The map hit happened most recently. Persisted recency survives a restart
    // even when the next launch must evict entries from other namespaces.
    const smaller = new AppStorage('darwin', home, appData, {}).openResourceCache(2000 / (1024 * 1024));
    assert((await smaller.usage()).bytes <= 2000);
    assert.equal(await smaller.read('snapshots', snapshotKey), null);
    assert.equal((await smaller.read('maps', 'old-tile')).at, 123);
    assert.equal(await smaller.write('maps', 'old-tile', Buffer.alloc(3000)), false);
    assert.equal((await smaller.read('maps', 'old-tile')).at, 123);
    fs.writeFileSync(path.join(storage.paths.cache, 'maps-v1', 'old-tile.bin'), 'corrupt');
    assert.equal(await smaller.read('maps', 'old-tile'), null);
    assert(!fs.existsSync(path.join(storage.paths.cache, 'maps-v1', 'old-tile.bin')));

    fs.rmSync(storage.paths.cache, { recursive: true });
    const cleared = new AppStorage('darwin', home, appData, {}).openResourceCache(1);
    assert.equal((await cleared.usage()).entries, 0);
    assert.equal(oldSnapshots.readSync('workspace').draft, 'historical');
    console.log('Resource cache checks passed: migration, durable recency, cross-type eviction, recovery, and clearing.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
checkResourceCache().catch(error => { console.error(error); process.exitCode = 1; });
