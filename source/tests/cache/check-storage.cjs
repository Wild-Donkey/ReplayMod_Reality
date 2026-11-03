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
  first.state.writeSync('workspace', { draft: 'saved' });
  first.settings.save({ maptilerApiKey: 'shared-test-key' });
  const before = process.cwd();
  try {
    process.chdir(root);
    const otherLaunch = new AppStorage('darwin', home, appData, {});
    assert.equal(otherLaunch.paths.config, first.paths.config);
    assert.equal(otherLaunch.paths.cache, first.paths.cache);
    assert.equal(otherLaunch.settings.read().maptilerApiKey, 'shared-test-key');
  } finally { process.chdir(before); }
  fs.rmSync(first.paths.cache, { recursive: true });
  const restarted = new AppStorage('darwin', home, appData, {});
  assert.equal(restarted.settings.read().maptilerApiKey, 'shared-test-key');
  assert.equal(restarted.state.readSync('workspace').draft, 'saved');
  // Clearing a key must never revive the previous format's key.
  restarted.settings.save({ maptilerApiKey: '' });
  assert.equal(new AppStorage('darwin', home, appData, {}).settings.read().maptilerApiKey, '');
  fs.writeFileSync(first.paths.config, '{invalid');
  assert.throws(() => restarted.settings.read());
  assert.equal(fs.readFileSync(first.paths.config, 'utf8'), '{invalid');
  assert.equal(previous.readSync('maptiler-key'), 'existing-test-key');
  console.log('Storage checks passed: fixed paths, upgrade, shared config, cache deletion, cleared key, corrupt config preservation.');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
