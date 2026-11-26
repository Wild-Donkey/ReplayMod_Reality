const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const rowCount = 500_000;

function createFootprint(file) {
  const handle = fs.openSync(file, 'w');
  try {
    fs.writeSync(handle, 'dataTime,longitude,latitude,stepType\n');
    for (let start = 0; start < rowCount; start += 10_000) {
      const rows = Array.from({ length: 10_000 }, (_, index) =>
        `${1700000000 + rowCount - start - index},${120 + index / 100000},30.25,0\n`);
      fs.writeSync(handle, rows.join(''));
    }
  } finally { fs.closeSync(handle); }
}

function processTreeRss(rootPid) {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' })
    .trim().split('\n').map(row => row.trim().split(/\s+/).map(Number));
  const pids = new Set([rootPid]);
  for (let count = 0; count !== pids.size;) {
    count = pids.size;
    for (const [pid, parent] of rows) if (pids.has(parent)) pids.add(pid);
  }
  return rows.reduce((sum, [pid, , rss]) => sum + (pids.has(pid) ? rss : 0), 0);
}

async function evaluate(socketUrl, expression) {
  const socket = new WebSocket(socketUrl);
  try {
    return await new Promise((resolve, reject) => {
      const wait = setTimeout(() => reject(new Error('Timed out evaluating packaged Electron app')), 15_000);
      const settle = (callback, value) => { clearTimeout(wait); callback(value); };
      socket.addEventListener('error', () => settle(reject, new Error('Could not attach to packaged Electron app')), { once: true });
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
      }, { once: true });
      socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.id !== 1) return;
        if (message.error || message.result?.exceptionDetails) {
          settle(reject, new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)));
        } else {
          settle(resolve, message.result.result.value);
        }
      });
    });
  } finally { socket.close(); }
}

async function measure(executable, footprint, native) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-csv-profile-'));
  let child, sampling, exit;
  try {
    const dataDir = path.join(profile, 'Library', 'Application Support', 'ReplayMod Reality');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'user-archive.json'), JSON.stringify({
      format: 'replaymod.user-archive', version: 1, settings: { maptilerApiKey: '' },
      workspace: {}, services: {}, lastDatasetSource: { mainFilePath: footprint, photoFilePath: null },
    }));
    const launch = performance.now();
    child = spawn(executable, ['--inspect=127.0.0.1:0', '--use-mock-keychain'], {
      cwd: profile, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, CFFIXED_USER_HOME: profile, REPLAYMOD_NATIVE_CSV: native ? '1' : '0' },
    });
    exit = once(child, 'close');
    void exit.catch(() => {});
    let log = '', peakRss = 0;
    child.stderr.on('data', chunk => { log += chunk; });
    sampling = setInterval(() => {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        peakRss = Math.max(peakRss, processTreeRss(child.pid));
      }
    }, 25);
    let socketUrl;
    while (!socketUrl && performance.now() - launch < 15_000 && child.exitCode === null && child.signalCode === null) {
      socketUrl = log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)?.[1];
      if (!socketUrl) await delay(25);
    }
    assert(socketUrl, 'Packaged app did not open its local inspector');
    const result = await evaluate(socketUrl, `(async () => {
      const { app, BrowserWindow } = process.mainModule.require('electron');
      await app.whenReady();
      const deadline = Date.now() + 12_000;
      let win;
      for (;;) {
        win = BrowserWindow.getAllWindows()[0];
        if (win && win.webContents.getURL() && !win.webContents.isLoading()) break;
        if (Date.now() >= deadline) throw new Error('Packaged renderer did not finish loading');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const data = await win.webContents.executeJavaScript(${JSON.stringify(`(async () => {
        const data = await window.replaymod.loadDefaultLocationCsv();
        return { count: data.pointCount, binary: data.timelineTimestamps instanceof Float64Array };
      })()`)});
      return { ...data, userData: app.getPath('userData') };
    })()`);
    const dataReadyMs = performance.now() - launch;
    assert.equal(fs.realpathSync(result.userData), fs.realpathSync(dataDir));
    assert.equal(result.count, rowCount);
    assert.equal(result.binary, true);
    assert.doesNotMatch(log, /Native CSV import failed/);
    peakRss = Math.max(peakRss, processTreeRss(child.pid));
    clearInterval(sampling);
    await evaluate(socketUrl, `setTimeout(() => process.mainModule.require('electron').app.quit(), 50); true`);
    assert.deepEqual(await Promise.race([exit, delay(10_000, 'timeout', { ref: false })]), [0, null]);
    return { dataReadyMs: Number(dataReadyMs.toFixed(1)), peakRssMiB: Number((peakRss / 1024).toFixed(1)) };
  } finally {
    clearInterval(sampling);
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (exit) await exit.catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

async function benchmarkPackagedCsv(packagedPath) {
  assert.equal(process.platform, 'darwin', 'Packaged CSV benchmark currently supports macOS');
  const executable = path.join(packagedPath, 'ReplayMod Reality.app', 'Contents', 'MacOS', 'ReplayMod Reality');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-packaged-csv-'));
  try {
    const footprint = path.join(fixture, 'footprint.csv');
    createFootprint(footprint);
    const results = [[], []];
    for (let run = 0; run < 3; run++) {
      for (const native of run % 2 ? [true, false] : [false, true]) {
        const result = await measure(executable, footprint, native);
        results[Number(native)].push(result);
        console.log(native ? 'C++' : 'TypeScript', result);
      }
    }
    const median = (runs, key) => runs.map(run => run[key]).sort((a, b) => a - b)[1];
    for (const [index, runs] of results.entries()) {
      console.log(index ? 'C++ median' : 'TypeScript median', {
        dataReadyMs: median(runs, 'dataReadyMs'), peakRssMiB: median(runs, 'peakRssMiB'),
      });
    }
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
}

module.exports = { benchmarkPackagedCsv };
