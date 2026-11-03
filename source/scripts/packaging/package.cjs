const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');

process.chdir(path.resolve(__dirname, '../..'));

// The JS ZIP extractor stalls with our local runtime. Use macOS's native
// extractor while retaining Forge's download checksum verification.
if (process.platform === 'darwin') {
  const run = promisify(execFile);
  require('@electron/packager/dist/unzip').extractElectronZip = (zip, directory) =>
    run('/usr/bin/ditto', ['-x', '-k', zip, directory]);
}

require('@electron-forge/core').api.package({ dir: process.cwd(), outDir: path.resolve(process.cwd(), "../out") }).then(() => {
  console.log('Package completed: ../out/');
}, error => {
  console.error(error);
  process.exitCode = 1;
});
