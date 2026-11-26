const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const root = path.resolve(__dirname, '../..');

function processes() {
  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,command='], { encoding: 'utf8' });
  return output.trim().split('\n').map(line => {
    const [, pid, parent, group, status, command] = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    return { pid: Number(pid), parent: Number(parent), group: Number(group), status, command };
  }).filter(process => !process.status.startsWith('Z'));
}

function tree(rows, pid) {
  const pids = new Set([pid]);
  for (let previousSize = 0; previousSize !== pids.size;) {
    previousSize = pids.size;
    for (const process of rows) if (pids.has(process.parent)) pids.add(process.pid);
  }
  return rows.filter(process => pids.has(process.pid));
}

async function until(label, callback, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await callback();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function evaluate(url, expression) {
  const socket = new WebSocket(url);
  let timeout;
  try {
    return await new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Electron inspector request timed out')), 5000);
      socket.addEventListener('error', () => reject(new Error('Could not connect to Electron inspector')), { once: true });
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
      }, { once: true });
      socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.id !== 1) return;
        if (message.error || message.result.exceptionDetails) {
          reject(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)));
        } else resolve(message.result.result.value);
      });
    });
  } finally {
    clearTimeout(timeout);
    socket.close();
  }
}

function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

async function check(mode) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-shutdown-test-'));
  const config = path.join(profile, '.config');
  const logRoot = process.platform === 'darwin' ? path.join(profile, 'Library', 'Application Support') : config;
  const log = path.join(logRoot, 'ReplayMod Reality', 'desktop-start.log');
  const readLog = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  const npm = spawn('npm', ['start', '--', '--', '--inspect=127.0.0.1:0', '--use-mock-keychain'], {
    cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, HOME: profile, CFFIXED_USER_HOME: profile, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: path.join(profile, 'cache')},
  });
  let output = '';
  npm.stdout.on('data', chunk => { output += chunk; });
  npm.stderr.on('data', chunk => { output += chunk; });
  let exited;
  npm.once('exit', (code, signal) => { exited = {code, signal}; });
  npm.once('error', error => { exited = {error}; });
  let forge;
  let owned = [];
  let finished = false;
  try {
    forge = await until('the Forge process', () => {
      if (exited) throw new Error('npm exited before Forge started');
      return tree(processes(), npm.pid).find(row => row.command.includes('electron-forge.js start'));
    });
    const url = await until('the Electron inspector', () => {
      if (exited) throw new Error('npm exited before Electron started');
      return readLog().match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)?.[1];
    });
    const electron = 'process.mainModule.require("electron")';
    const app = await until('the app window', () => evaluate(url, `(() => {
      const { app, BrowserWindow } = ${electron};
      const [window] = BrowserWindow.getAllWindows();
      return window && !window.webContents.isLoading() && window.webContents.getURL().startsWith('http://')
        && {pid: process.pid, data: app.getPath("userData")};
    })()`));
    assert.equal(fs.realpathSync(app.data), fs.realpathSync(path.join(logRoot, 'ReplayMod Reality')));
    await until('the C++ core process', () => processes().some(row =>
      row.parent === app.pid && row.command.endsWith('/native/build/replaymod-core')
    ));
    owned = tree(processes(), npm.pid);
    assert(owned.some(process => process.pid === app.pid), 'Electron must belong to this test launch');

    const started = Date.now();
    if (mode === 'window') {
      await evaluate(url, `{
        const window = ${electron}.BrowserWindow.getAllWindows()[0];
        window.on('closed', () => process.mainModule.require('node:fs').writeFileSync(${JSON.stringify(path.join(profile, 'closed'))}, ''));
        setTimeout(() => window.close(), 100);
        true;
      }`);
    } else if (mode === 'Ctrl+C') {
      await evaluate(url, `{
        const fs = process.mainModule.require('node:fs');
        ${electron}.app.on('will-quit', () => fs.appendFileSync(${JSON.stringify(path.join(profile, 'quit'))}, 'quit'));
        true;
      }`);
      signalGroup(npm.pid, 'SIGINT');
    } else if (mode === 'app timeout') {
      await evaluate(url, `{
        const {app} = ${electron};
        app.on('will-quit', event => event.preventDefault());
        setTimeout(() => app.quit(), 100);
        true;
      }`);
    } else {
      // A stuck main thread cannot poll the quit request or run the app's timer.
      await evaluate(url, `setTimeout(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000), 50); true`);
      await delay(250);
      signalGroup(npm.pid, 'SIGTERM');
    }
    await until('npm and the entire app tree to exit', () =>
      exited && !processes().some(row => row.group === forge.group || owned.some(process => process.pid === row.pid)),
    15000);
    assert.ifError(exited.error);
    if (mode === 'window') {
      assert.equal(exited.code, 0);
      assert(fs.existsSync(path.join(profile, 'closed')), 'The app window must close');
      assert.doesNotMatch(readLog(), /Timed out waiting for the desktop app to shut down/);
    }
    if (mode === 'Ctrl+C') {
      assert(exited.code === 130 || exited.signal === 'SIGINT', JSON.stringify(exited));
      assert(fs.existsSync(path.join(profile, 'quit')), 'Ctrl+C must reach Electron’s graceful quit path');
    }
    if (mode === 'app timeout') {
      assert.match(readLog(), /Timed out waiting for the desktop app to shut down/);
      assert(Date.now() - started >= 5500, 'The app should get the grace period');
    }
    if (mode === 'launcher timeout') {
      assert(exited.code === 143 || exited.signal === 'SIGTERM', JSON.stringify(exited));
      assert(Date.now() - started >= 7500, 'A stuck Electron process should get the grace period');
    }
    finished = true;
    console.log(`${mode}: launcher, Forge, Electron and helpers exited.`);
  } catch (error) {
    const remaining = forge ? processes().filter(row => row.group === forge.group || owned.some(process => process.pid === row.pid)) : [];
    throw new Error(`${mode}: ${error.message}\n${output}\n${readLog().slice(-6000)}\nRemaining processes: ${JSON.stringify(remaining)}`, {cause: error});
  } finally {
    if (!finished) {
      if (forge) signalGroup(forge.group, 'SIGKILL');
      if (npm.pid) signalGroup(npm.pid, 'SIGKILL');
    }
    fs.rmSync(profile, {recursive: true, force: true});
  }
}

(async () => {
  if (process.platform === 'win32') {
    console.log('The desktop process-group integration test requires macOS or Linux.');
    return;
  }
  assert(!processes().some(row => row.command.includes('electron-forge.js start') && row.command.includes(root)), 'Close the existing development session before running this integration test.');
  const modes = ['window', 'Ctrl+C', 'app timeout', 'launcher timeout'];
  const requested = process.argv.slice(2);
  assert(requested.every(mode => modes.includes(mode)), 'Unknown shutdown test mode');
  for (const mode of requested.length ? requested : modes) await check(mode);
})().catch(error => { console.error(error); process.exitCode = 1; });
