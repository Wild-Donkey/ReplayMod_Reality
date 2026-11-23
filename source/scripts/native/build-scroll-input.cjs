const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
function buildScrollInput() {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return;
  const target = path.join(root, 'native/build');
  fs.mkdirSync(target, { recursive: true });
  if (process.platform === 'win32') {
    const source = path.join(root, 'native/scroll-input-win.cpp');
    const output = path.join(target, 'scroll-input-win.node');
    if (fs.existsSync(output) && fs.statSync(output).mtimeMs >= Math.max(fs.statSync(source).mtimeMs, fs.statSync(__filename).mtimeMs)) return;
    execFileSync('g++.exe', ['-std=c++17', '-O2', '-shared', '-static', source, '-o', output, '-lole32', '-lcomctl32', '-luser32'], { stdio: 'inherit', windowsHide: true });
    return;
  }
  const nodeInclude = path.resolve(root, '../.tools/node/include/node');
  execFileSync('/usr/bin/clang++', [
    '-std=c++17', '-fobjc-arc', '-bundle', '-undefined', 'dynamic_lookup',
    '-framework', 'AppKit', '-mmacosx-version-min=11.0', `-I${nodeInclude}`,
    path.join(root, 'native/scroll-input.mm'),
    '-o', path.join(target, 'scroll-input.node'),
  ], { stdio: 'inherit' });
}
module.exports = buildScrollInput;
if (require.main === module) buildScrollInput();

