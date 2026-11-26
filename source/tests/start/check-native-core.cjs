const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const ts = require('typescript');
const { buildCore } = require('../../scripts/native/build-core.cjs');

require.extensions['.ts'] = (module, file) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  module._compile(outputText, file);
};
const { NativeCore } = require('../../apps/desktop/src/main/nativeCore.ts');

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
  console.log('Native core handshake, ping, EOF shutdown and missing executable checks passed.');
}

check().catch(error => { console.error(error); process.exitCode = 1; });
