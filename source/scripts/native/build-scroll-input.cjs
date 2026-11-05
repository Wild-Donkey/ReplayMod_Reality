const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
function buildScrollInput() {
  if (process.platform !== 'darwin') return;
  const target = path.join(root, 'native/build');
  fs.mkdirSync(target, { recursive: true });
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

