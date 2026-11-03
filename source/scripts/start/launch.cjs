#!/usr/bin/env node
// One startup flow shared by the platform-specific double-click entry points.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
process.chdir(root);
const toolDirectories = [
  path.dirname(process.execPath),
  '../.tools/ffmpeg-native/bin', '../.tools/ffmpeg',
  '../.tools/gpac-package/tmppkg.pkg/Payload/GPAC.app/Contents/MacOS',
].map(directory => path.resolve(root, directory));
process.env.PATH = [...toolDirectories, process.env.PATH || ''].join(path.delimiter);

const runNpm = args => new Promise((resolve, reject) => {
  // All arguments are fixed by this file; cmd.exe is required for npm.cmd.
  const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd: root, env: process.env, stdio: 'inherit', shell: process.platform === 'win32',
  });
  child.on('error', reject);
  child.on('exit', (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(`npm ${args.join(' ')} stopped (${signal || code}).`));
  });
});

async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (!((major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22)) {
    throw new Error('Node.js 20.19+ or 22.12+ is required. Install a current Node.js LTS release.');
  }
  const electronBinary = process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron'
    : process.platform === 'win32' ? 'electron.exe' : 'electron';
  const installed = fs.existsSync(path.join(root, 'node_modules/electron/dist', electronBinary))
    && fs.existsSync(path.join(root, 'node_modules/@electron-forge/cli/dist/electron-forge.js'));
  console.log(`ReplayMod Reality | ${process.platform}/${process.arch} | Node ${process.versions.node}`);
  console.log(`Project: ${root}`);
  if (process.argv.includes('--check')) {
    console.log(installed ? 'Startup prerequisites found.' : 'Dependencies will be installed on first launch (network required).');
    return;
  }
  if (!installed) {
    console.log('Installing project dependencies for this computer (network required)...');
    await runNpm(['ci']);
  }
  console.log('Starting desktop app. Keep this terminal open while using the app.');
  await runNpm(['start']);
}
main().catch(error => {
  console.error(`\nUnable to start: ${error.message}`);
  console.error('Check that Node.js and npm are installed. First launch requires internet access.');
  process.exitCode = 1;
});
