const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
function buildHDR() {
  const target = path.join(root, 'native/build');
  if (process.platform === 'win32') {
    const source = path.join(root, 'native/hdr-display-win.c');
    const output = path.join(target, 'hdr-display.exe');
    if (fs.existsSync(output) && fs.statSync(output).mtimeMs >= fs.statSync(source).mtimeMs) return;
    fs.mkdirSync(target, {recursive: true});
    try {
      execFileSync('gcc.exe', [source, '-O2', '-o', output, '-ldxgi', '-ldxguid', '-luser32'], {stdio: 'inherit', windowsHide: true});
    } catch (error) {
      throw new Error(error.code === 'ENOENT' ? 'Windows HDR helper requires MinGW-w64 GCC on PATH.' : 'Could not build the Windows HDR helper.', {cause: error});
    }
    return;
  }
  if (process.platform !== 'darwin') return;
  fs.mkdirSync(target, { recursive: true });
  execFileSync('/usr/bin/clang', ['-fobjc-arc', '-framework', 'AppKit',
    '-mmacosx-version-min=11.0', path.join(root, 'native/hdr-display.m'),
    '-o', path.join(target, 'hdr-display')], { stdio: 'inherit' });
}
module.exports = buildHDR;
if (require.main === module) buildHDR();
