#!/usr/bin/env node
// One startup flow shared by the platform-specific double-click entry points.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const root = path.resolve(__dirname, '../..');
process.chdir(root);
const toolDirectories = [
  path.dirname(process.execPath),
  '../.tools/ffmpeg-native/bin', '../.tools/ffmpeg',
  '../.tools/gpac-package/tmppkg.pkg/Payload/GPAC.app/Contents/MacOS',
].map(directory => path.resolve(root, directory));
process.env.PATH = [...toolDirectories, process.env.PATH || ''].join(path.delimiter);

const windows = process.platform === 'win32';
let stopping;
let requestStop;
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
function onSignal(signal) {
  if (stopping) return;
  stopping = signal;
  requestStop?.();
}

function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function run(command, args, {stopFile, ...options} = {}) {
  if (stopping) return;
  // Keep Ctrl+C in the launcher. Forge's own SIGINT handler exits immediately.
  const child = spawn(command, args, {
    cwd: root, env: process.env, stdio: [windows ? 'ignore' : 'inherit', 'inherit', 'inherit'],
    detached: true, windowsHide: true, ...options,
  });
  let deadline;
  let forceSent = false;
  function forceStop() {
    if (!child.pid || forceSent) return;
    forceSent = true;
    if (!windows) { signalGroup(child.pid, 'SIGKILL'); return; }
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {timeout: 3000, windowsHide: true, stdio: 'ignore'}); }
    catch { child.kill('SIGKILL'); }
  }
  requestStop = () => {
    deadline = setTimeout(forceStop, stopFile ? 8000 : 1500);
    if (stopFile) {
      try { fs.writeFileSync(stopFile, ''); }
      catch (error) { console.error('Unable to request application shutdown:', error.message); }
    } else if (!windows && child.pid) {
      signalGroup(child.pid, 'SIGTERM');
    } else {
      forceStop();
    }
  };
  try {
    const {code, signal} = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({code, signal}));
    });
    if (!stopping && code !== 0) throw new Error(`${path.basename(command)} stopped (${signal || code}).`);
  } finally {
    clearTimeout(deadline);
    requestStop = undefined;
    // Forge can leave helpers alive even after its own process has exited.
    if (!windows && child.pid && !forceSent && signalGroup(child.pid, 'SIGTERM')) {
      const gracePeriod = stopFile ? 6500 : 1500;
      const expires = Date.now() + gracePeriod;
      while (Date.now() < expires && signalGroup(child.pid, 0)) await delay(100);
      forceStop();
    }
  }
}

function logDirectory() {
  const home = os.homedir();
  const appData = {
    darwin: path.join(home, 'Library', 'Application Support'),
    win32: process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
  }[process.platform] || process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(appData, 'ReplayMod Reality');
}

async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (!((major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22)) {
    throw new Error('Node.js 20.19+ or 22.12+ is required. Install a current Node.js LTS release.');
  }
  const electronBinary = process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron'
    : process.platform === 'win32' ? 'electron.exe' : 'electron';
  const forgeCli = path.join(root, 'node_modules/@electron-forge/cli/dist/electron-forge.js');
  const manifest = require(path.join(root, 'package.json'));
  const dependencies = Object.keys({...manifest.dependencies, ...manifest.devDependencies});
  const missing = dependencies.filter(name => !fs.existsSync(path.join(root, 'node_modules', name, 'package.json')));
  const installed = missing.length === 0 && fs.existsSync(forgeCli);
  const electronInstalled = fs.existsSync(path.join(root, 'node_modules/electron/dist', electronBinary));
  console.log(`ReplayMod Reality | ${process.platform}/${process.arch} | Node ${process.versions.node}`);
  console.log(`Project: ${root}`);
  if (process.argv.includes('--check')) {
    if (installed && electronInstalled) console.log('Startup prerequisites found.');
    else if (installed) console.log('npm dependencies found. Electron will be installed on first launch.');
    else console.log('Dependencies will be installed on first launch (network required).');
    if (missing.length) console.log(`Missing packages: ${missing.join(', ')}`);
    return;
  }
  if (!installed) {
    console.log('Installing project dependencies for this computer (network required)...');
    // Windows requires a command shell to execute npm.cmd.
    await run(windows ? 'npm.cmd' : 'npm', ['ci'], {shell: windows});
  }
  if (stopping) return;
  if (windows) {
    try { require('../native/build-hdr.cjs')(); }
    catch (error) { console.warn(`Windows HDR helper: ${error.message} ReplayMod Reality can still start in SDR.`); }
  }
  const directory = logDirectory();
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const logPath = path.join(directory, 'desktop-start.log');
  console.log(`Desktop startup log: ${logPath}`);
  const controlDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-launch-'));
  const stopFile = path.join(controlDirectory, 'stop');
  let log;
  try {
    log = fs.openSync(logPath, 'a', 0o600);
    fs.writeSync(log, `\n[${new Date().toISOString()}] Starting ReplayMod Reality\n`);
    // Give Forge and Electron a file descriptor that survives terminal closure.
    await run(process.execPath, [forgeCli, 'start', ...process.argv.slice(2)], {
      stopFile, stdio: [windows ? 'ignore' : 'inherit', log, log], env: {...process.env, REPLAYMOD_STOP_FILE: stopFile},
    });
  } catch (error) {
    throw new Error(`${error.message} See ${logPath}`, {cause: error});
  } finally {
    if (log !== undefined) fs.closeSync(log);
    fs.rmSync(controlDirectory, {recursive: true, force: true});
  }
}
for (const signal of signals) process.on(signal, onSignal);
main().catch(error => {
  console.error(`\nUnable to start: ${error.message}`);
  process.exitCode = 1;
}).finally(() => {
  for (const signal of signals) process.off(signal, onSignal);
  if (stopping) process.exitCode = 128 + os.constants.signals[stopping];
});
