const { execFileSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, renameSync, rmSync, statSync } = require('node:fs');
const path = require('node:path');

const windows = process.platform === 'win32';
const resource = `native/build/replaymod-core${windows ? '.exe' : ''}`;

function buildCore() {
  const root = path.resolve(__dirname, '../..');
  const sources = ['main.cpp', 'location_csv.cpp'].map(file => path.join(root, 'native/core', file));
  const inputs = [...sources, path.join(root, 'native/core/location_csv.h'), __filename];
  const output = path.join(root, resource);
  const existing = statSync(output, { throwIfNoEntry: false });
  if (existing && existing.mtimeMs >= Math.max(...inputs.map(file => statSync(file).mtimeMs))) return output;

  const directory = path.dirname(output);
  mkdirSync(directory, { recursive: true });
  const staging = mkdtempSync(path.join(directory, 'core-build-'));
  const binary = path.join(staging, path.basename(output));
  const compiler = process.env.CXX || (windows ? 'g++.exe' : 'c++');
  const flags = windows ? ['-static'] : process.platform === 'darwin' ? ['-mmacosx-version-min=11.0'] : [];
  try {
    execFileSync(compiler, ['-std=c++17', '-O2', ...flags, ...sources, '-o', binary], { stdio: 'inherit', windowsHide: true });
    renameSync(binary, output);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return output;
}

module.exports = { buildCore, resource };
if (require.main === module) buildCore();
