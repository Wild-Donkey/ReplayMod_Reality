const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const ts = require('typescript');

function installLoader(fs, ts) {
  require.extensions['.ts'] = (module, file) => {
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    module._compile(code, file);
  };
}
installLoader(fs, ts);

const { runChild, stopChildren, killChildren } = require('../../packages/media/src/childProcesses.ts');

(async () => {
  const commands = [
    'process.on("SIGTERM", () => process.exit(0)); console.log("ready"); setInterval(() => {}, 1000);',
    'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);',
  ];
  try {
    const jobs = commands.map(command => runChild(process.execPath, ['-e', command], {}));
    const settled = Promise.allSettled(jobs);
    await Promise.all(jobs.map(({child}) => once(child.stdout, 'data')));
    const cleanup = stopChildren();
    assert.throws(() => runChild(process.execPath, ['-v'], {}), /应用正在退出/);
    await cleanup;
    const [cooperative, stubborn] = await settled;
    if (process.platform !== 'win32') {
      assert.equal(cooperative.status, 'fulfilled');
      assert.equal(jobs[1].child.signalCode, 'SIGKILL');
    }
    assert.equal(stubborn.status, 'rejected');
    for (const job of jobs) assert.throws(() => process.kill(job.child.pid, 0), {code: 'ESRCH'});
    console.log('Child shutdown passed: graceful stop, forced stop and no new work during shutdown.');
  } finally { killChildren(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
