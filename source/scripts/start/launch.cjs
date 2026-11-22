#!/usr/bin/env node
// One startup flow shared by the platform-specific double-click entry points.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
process.chdir(root);
const toolDirectories = [
  path.dirname(process.execPath),
  '../.tools/ffmpeg-native/bin', '../.tools/ffmpeg',
  '../.tools/gpac-package/tmppkg.pkg/Payload/GPAC.app/Contents/MacOS',
].map(directory => path.resolve(root, directory));
process.env.PATH = [...toolDirectories, process.env.PATH || ''].join(path.delimiter);

const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {cwd: root, env: process.env, stdio: 'inherit', ...options});
  child.on('error', reject);
  child.on('exit', (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(`${path.basename(command)} stopped (${signal || code}).`));
  });
});

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
  const installed = fs.existsSync(path.join(root, 'node_modules/electron/dist', electronBinary)) && fs.existsSync(forgeCli);
  console.log(`ReplayMod Reality | ${process.platform}/${process.arch} | Node ${process.versions.node}`);
  console.log(`Project: ${root}`);
  if (process.argv.includes('--check')) {
    console.log(installed ? 'Startup prerequisites found.' : 'Dependencies will be installed on first launch (network required).');
    return;
  }
  if (!installed) {
    console.log('Installing project dependencies for this computer (network required)...');
    // Windows requires a command shell to execute npm.cmd.
    const windows = process.platform === 'win32';
    await run(windows ? 'npm.cmd' : 'npm', ['ci'], {shell: windows});
  }
  const directory = logDirectory();
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const logPath = path.join(directory, 'desktop-start.log');
  console.log(`Desktop startup log: ${logPath}`);
  const log = fs.openSync(logPath, 'a', 0o600);
  try {
    fs.writeSync(log, `\n[${new Date().toISOString()}] Starting ReplayMod Reality\n`);
    // Give Forge and Electron a file descriptor that survives terminal closure.
    await run(process.execPath, [forgeCli, 'start', ...process.argv.slice(2)], {stdio: ['inherit', log, log]});
  } catch (error) {
    throw new Error(`${error.message} See ${logPath}`, {cause: error});
  } finally {
    fs.closeSync(log);
  }
}
main().catch(error => {
  console.error(`\nUnable to start: ${error.message}`);
  console.error('Check that Node.js and npm are installed. First launch requires internet access.');
  process.exitCode = 1;
});
