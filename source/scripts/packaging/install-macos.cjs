const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
  child.on('error', reject);
  child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command}: ${signal || code}`)));
});

async function main() {
  if (process.platform !== 'darwin') throw new Error('此安装入口仅用于 macOS。');
  process.env.PATH = [path.dirname(process.execPath), process.env.PATH || ''].join(path.delimiter);
  try { await fs.access(path.join(root, 'node_modules/@electron-forge/core')); }
  catch { await run('npm', ['ci']); }
  await run(process.execPath, [path.join(__dirname, 'package.cjs')]);
  const name = 'ReplayMod Reality.app';
  const source = path.join(root, '../out', `ReplayMod Reality-darwin-${process.arch}`, name);
  const applications = path.join(os.homedir(), 'Applications');
  await fs.mkdir(applications, { recursive: true });
  const staging = await fs.mkdtemp(path.join(applications, '.replaymod-install-'));
  const target = path.join(applications, name);
  const backup = path.join(staging, 'previous.app');
  let hasBackup = false;
  try {
    await run('/usr/bin/ditto', [source, path.join(staging, name)]);
    try { await fs.rename(target, backup); hasBackup = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await fs.rename(path.join(staging, name), target); }
    catch (error) {
      if (hasBackup) { await fs.rename(backup, target); hasBackup = false; }
      throw error;
    }
    hasBackup = false;
    console.log(`安装完成：${target}\n请退出旧版后，从 Applications 打开 ReplayMod Reality。`);
    await run('/usr/bin/open', ['-R', target]);
  } finally {
    if (!hasBackup) await fs.rm(staging, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
