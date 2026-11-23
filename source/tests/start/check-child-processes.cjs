const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { Worker } = require('node:worker_threads');
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

async function checkTrajectoryWorker() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-worker-test-'));
  const marker = path.join(directory, 'pid');
  const executable = path.join(directory, 'exiftool');
  fs.writeFileSync(executable, `#!/usr/bin/env node
process.on("SIGTERM", () => {});
require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid));
setInterval(() => {}, 1000);
`, {mode: 0o700});
  const entry = require.resolve('../../apps/desktop/src/main/trajectoryWorker.ts');
  const worker = new Worker(`
    (${installLoader})(require('node:fs'), require(${JSON.stringify(require.resolve('typescript'))}));
    require(${JSON.stringify(entry)});
  `, {eval: true});
  const exited = once(worker, 'exit', {signal: AbortSignal.timeout(10000)});
  void exited.catch(() => {});
  let pid;
  try {
    worker.postMessage({sourcePath: 'fixture.mp4', exiftool: executable, revision: 'fixture', points: [], start: 0, end: 1});
    for (let attempt = 0; attempt < 100 && !pid; attempt++) {
      if (fs.existsSync(marker)) pid = Number(fs.readFileSync(marker, 'utf8'));
      if (!pid) await delay(50);
    }
    assert(pid > 0, 'The trajectory worker must be running ExifTool');
    worker.postMessage({shutdown: true});
    assert.deepEqual(await exited, [0]);
    assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'});
    pid = undefined;
    console.log('Trajectory worker shutdown passed: active ExifTool exited before its worker.');
  } finally {
    if (pid) {
      try { process.kill(pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await worker.terminate();
    fs.rmSync(directory, {recursive: true, force: true});
  }
}

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
  if (process.platform !== 'win32') await checkTrajectoryWorker();
})().catch(error => { console.error(error); process.exitCode = 1; });
