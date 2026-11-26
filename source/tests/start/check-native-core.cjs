const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const { buildCore } = require('../../scripts/native/build-core.cjs');

require.extensions['.ts'] = (module, file) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  module._compile(outputText, file);
};
const { NativeCore } = require('../../apps/desktop/src/main/nativeCore.ts');
const { readLocationCsv } = require('../../apps/desktop/src/main/locationCsv.ts');
const { readNativeLocationCsv } = require('../../apps/desktop/src/main/nativeLocationCsv.ts');

async function checkCsv(executable) {
  const sample = path.resolve(__dirname, '../../../RawData/footprint/Example_footprint.csv');
  assert.deepEqual(await readNativeLocationCsv(executable, sample), await readLocationCsv(sample, null));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-native-csv-'));
  try {
    const filename = path.join(directory, '测试轨迹.csv');
    await assert.rejects(readLocationCsv(filename, null), { code: 'ENOENT' });
    const header = '\uFEFFdataTime,longitude,latitude,accuracy,stepType,elevation';
    fs.writeFileSync(filename, [header, '3,10,20,120,0,8', '2,11,20,,0,', '1,12,20,0,0,-2',
      '2,13,20,100,0,4', '4,180.01,20,,0,', '', '5,15,20,,-1,'].join('\r\n'));
    assert.deepEqual(await readNativeLocationCsv(executable, filename), await readLocationCsv(filename, null));
    for (const row of ['2,11,20,,1,0', '"2",11,20,,0,0', '2,0x10,20,,0,0', '2,11,20,,0']) {
      fs.writeFileSync(filename, [header, '1,0,0,,0,0', row].join('\n'));
      assert.equal(await readNativeLocationCsv(executable, filename), null, row);
    }
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
}

async function check() {
  const executable = buildCore();
  const { status, stdout, error } = spawnSync(executable, [], {
    input: 'hello 2\nping\nhello 1\nping\n',
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.ifError(error);
  assert.equal(status, 0);
  assert.deepEqual(stdout.trim().split(/\r?\n/), ['error unsupported-command', 'error unsupported-command', 'ready 1', 'pong']);

  const core = new NativeCore(executable);
  try {
    await Promise.all([core.ping(), core.ping()]);
    await core.ping();
  } finally {
    await core.close();
  }
  await assert.rejects(core.ping(), /closing/);
  const missing = new NativeCore(executable + '.missing');
  await assert.rejects(missing.ping(), { code: 'ENOENT' });
  await missing.close();
  await checkCsv(executable);
  console.log('Native core handshake, ping, EOF shutdown and missing executable checks passed.');
  console.log('Native CSV matches the reference dataset and declines unsupported records.');
}

check().catch(error => { console.error(error); process.exitCode = 1; });
