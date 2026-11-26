const assert = require('node:assert/strict');
const { execFile, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

async function check() {
  const source = path.resolve(__dirname, '../..');
  process.chdir(source);
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-package-check-'));
  try {
    if (process.platform === 'darwin') {
      require('@electron/packager/dist/unzip').extractElectronZip = (zip, directory) =>
        promisify(execFile)('/usr/bin/ditto', ['-x', '-k', zip, directory]);
    }
    await require('@electron-forge/core').api.package({ dir: source, outDir: output });
    const { platform, arch } = process;
    const targets = fs.readdirSync(output, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.endsWith(`-${platform}-${arch}`));
    assert.equal(targets.length, 1, 'Expected one package for the host platform and architecture');
    const packagedPath = path.join(output, targets[0].name);
    const resources = platform === 'darwin'
      ? path.join(packagedPath, 'ReplayMod Reality.app', 'Contents', 'Resources')
      : path.join(packagedPath, 'resources');
    const executable = path.join(resources, platform === 'win32' ? 'replaymod-core.exe' : 'replaymod-core');
    const run = spawnSync(executable, [], { input: 'hello 1\nping\n', encoding: 'utf8', timeout: 5000, windowsHide: true });
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^ready 1\r?\npong\r?\n$/);
    console.log(`Packaged ${platform}/${arch} core passed handshake, ping and EOF shutdown.`);
    if (process.argv.includes('--benchmark-csv')) {
      await require('./benchmark-packaged-csv.cjs').benchmarkPackagedCsv(packagedPath);
    }
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
}

check().catch(error => { console.error(error); process.exitCode = 1; });
