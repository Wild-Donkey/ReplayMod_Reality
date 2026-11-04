const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
function buildHDR() {
  if (process.platform !== 'darwin') return;
  const target = path.join(root, 'native/build');
  fs.mkdirSync(target, { recursive: true });
  execFileSync('/usr/bin/clang', ['-fobjc-arc', '-framework', 'AppKit',
    '-mmacosx-version-min=11.0', path.join(root, 'native/hdr-display.m'),
    '-o', path.join(target, 'hdr-display')], { stdio: 'inherit' });
}
module.exports = buildHDR;
if (require.main === module) buildHDR();
