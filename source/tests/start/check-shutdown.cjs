const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const root = path.resolve(__dirname, '../..');

function processes() {
  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,command='], { encoding: 'utf8' });
  return output.trim().split('\n').map(line => {
    const [, pid, parent, group, status, command] = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    return { pid: Number(pid), parent: Number(parent), group: Number(group), status, command };
  }).filter(process => !process.status.startsWith('Z'));
}

function tree(rows, pid) {
  const pids = new Set([pid]);
  for (let previousSize = 0; previousSize !== pids.size;) {
    previousSize = pids.size;
    for (const process of rows) if (pids.has(process.parent)) pids.add(process.pid);
  }
  return rows.filter(process => pids.has(process.pid));
}

async function until(label, callback, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await callback();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function evaluate(url, expression, timeoutMs = 5000) {
  const socket = new WebSocket(url);
  let timeout;
  try {
    return await new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Electron inspector request timed out')), timeoutMs);
      socket.addEventListener('error', () => reject(new Error('Could not connect to Electron inspector')), { once: true });
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
      }, { once: true });
      socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.id !== 1) return;
        if (message.error || message.result.exceptionDetails) {
          reject(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)));
        } else resolve(message.result.result.value);
      });
    });
  } finally {
    clearTimeout(timeout);
    socket.close();
  }
}

function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

async function checkTypedCsvExport(url, electron, profile, readLog, withTrajectory) {
  const destination = path.join(profile, 'fixture.webm');
  await evaluate(url, `{
    ${electron}.dialog.showSaveDialog = async () => ({ canceled: false, filePath: ${JSON.stringify(destination)} });
    globalThis.testExportRates = [];
    ${electron}.ipcMain.on('media:post-gps', (_event, _id, request) => {
      if (request?.precision === 'export') globalThis.testExportRates.push(request.sampleRateHz);
    });
    true;
  }`);
  const renderer = `(async () => {
    const button = (root, label) => [...root.querySelectorAll('button')].find(item => item.textContent.trim() === label);
    const deadline = performance.now() + 5000;
    const until = async (name, find) => {
      let value;
      while (!(value = find())) {
        if (performance.now() >= deadline) throw new Error('Missing export control: ' + name);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return value;
    };
    const tab = [...document.querySelectorAll('button')].find(item =>
      item.getAttribute('aria-label') === '视频与导出' || item.textContent.trim() === '视频与导出');
    tab?.click();
    const opener = await until('export button', () => document.querySelector('.overlay-export button'));
    opener.click();
    const dialog = await until('settings dialog', () => document.querySelector('[aria-label="导出设置"]'));
    const select = (label, value) => {
      const control = [...dialog.querySelectorAll('label')].find(item => item.textContent.startsWith(label))?.querySelector('select');
      if (!control) throw new Error('Missing setting: ' + label);
      control.value = value;
      control.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const map = [...dialog.querySelectorAll('label')].find(item => item.textContent.includes('轨迹小地图'))?.querySelector('input');
    if (map?.checked) map.click();
    select('导出格式', 'transparent');
    select('分辨率', '1280x720');
    select('帧率', '24');
    const start = await until('start export', () => {
      const control = button(dialog, '导出');
      return control && !control.disabled ? control : null;
    });
    start.click();
    return true;
  })()`;
  await evaluate(url, `${electron}.BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(${JSON.stringify(renderer)})`);
  const timing = await until('finished transparent export', () =>
    readLog().match(/\[offline-export\] complete frames=(\d+) elapsed_ms=(\d+) render_ms=(\d+) readback_ms=(\d+) write_ms=(\d+) finalize_ms=(\d+)/),
  60_000);
  if (withTrajectory) assert.deepEqual(await evaluate(url, 'globalThis.testExportRates'), [24]);
  const { streams: [stream] } = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames',
    '-show_entries', 'stream=width,height,avg_frame_rate,nb_read_frames:stream_tags=alpha_mode', '-of', 'json', destination],
  { encoding: 'utf8', timeout: 15_000 }));
  assert.equal(stream.width, 1280);
  assert.equal(stream.height, 720);
  assert.equal(stream.nb_read_frames, '24');
  assert.equal(stream.avg_frame_rate, '24/1');
  assert.equal(stream.tags.alpha_mode, '1');
  const decoder = [...new Set((process.env.PATH ?? '').split(path.delimiter))]
    .filter(Boolean).map(directory => path.join(directory, 'ffmpeg'))
    .find(file => fs.existsSync(file) &&
      /\blibvpx-vp9\b/.test(execFileSync(file, ['-hide_banner', '-decoders'], { encoding: 'utf8', timeout: 5000 })));
  assert(decoder, 'Select an FFmpeg with a libvpx-vp9 decoder to check encoded alpha');
  const pixels = execFileSync(decoder, ['-v', 'error', '-c:v', 'libvpx-vp9', '-i', destination,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
  { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(pixels.length, 1280 * 720 * 4);
  let visible = 0;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 16) visible++;
  assert(visible > 100 && visible < 1280 * 720, 'First encoded frame should contain the visible stats and transparent background');
  console.log(timing[0] + ` first_frame_visible_pixels=${visible}`);
}

async function check(mode) {
  const djiVideo = mode === 'window' && process.env.REPLAYMOD_CHECK_DJI_VIDEO;
  const djiFootprint = mode === 'window' && process.env.REPLAYMOD_CHECK_DJI_FOOTPRINT;
  assert.equal(Boolean(djiVideo), Boolean(djiFootprint), 'Provide both DJI video and footprint paths');
  const checkExport = mode === 'window' && process.env.REPLAYMOD_CHECK_TYPED_EXPORT === '1';
  assert(!checkExport || !djiVideo, 'The export test uses the bundled synthetic CSV fixture');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-shutdown-test-'));
  const config = path.join(profile, '.config');
  const logRoot = process.platform === 'darwin' ? path.join(profile, 'Library', 'Application Support') : config;
  const log = path.join(logRoot, 'ReplayMod Reality', 'desktop-start.log');
  const checkNativeTrajectory = mode === 'window' && (Boolean(djiVideo) || process.env.REPLAYMOD_CHECK_NATIVE_TRAJECTORY === '1');
  const csvStart = checkExport && checkNativeTrajectory ? 1577836800 : 0;
  const video = djiVideo ? path.resolve(root, djiVideo) : path.join(profile, 'fixture.mp4');
  if (checkNativeTrajectory && !djiVideo) {
    try {
      execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=size=32x32:rate=10',
        '-t', '2', '-c:v', 'mpeg4', '-metadata', 'creation_time=2020-01-01T00:00:00Z', video], { stdio: 'inherit' });
    } catch (error) {
      fs.rmSync(profile, { recursive: true, force: true });
      throw error;
    }
  }
  if (mode === 'window') {
    const footprint = path.join(profile, 'fixture.csv');
    const photo = path.join(profile, 'photo.csv');
    fs.writeFileSync(footprint, `dataTime,longitude,latitude,stepType\n${csvStart + 2},120,30,0\n${csvStart + 1},121,31,0\n`);
    fs.writeFileSync(photo, `dataTime,longitude,latitude\n${csvStart + 1},122,32\n`);
    const appData = path.dirname(log);
    fs.mkdirSync(appData, { recursive: true });
    fs.writeFileSync(path.join(appData, 'user-archive.json'), JSON.stringify({
      format: 'replaymod.user-archive',
      version: 1,
      settings: { maptilerApiKey: '' },
      workspace: {},
      services: {},
      lastDatasetSource: djiFootprint ? { mainFilePath: path.resolve(root, djiFootprint), photoFilePath: null }
        : { mainFilePath: footprint, photoFilePath: photo },
      ...(checkNativeTrajectory ? { lastMedia: { sourcePath: video } } : {}),
    }));
  }
  const readLog = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  const npm = spawn('npm', ['start', '--', '--', '--inspect=127.0.0.1:0', '--use-mock-keychain'], {
    cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, HOME: profile, CFFIXED_USER_HOME: profile, XDG_CONFIG_HOME: config,
      XDG_CACHE_HOME: path.join(profile, 'cache'),
      REPLAYMOD_NATIVE_CSV: mode !== 'window' ? '0' : process.platform === 'darwin' && process.arch === 'arm64' ? undefined : '1'},
  });
  let output = '';
  npm.stdout.on('data', chunk => { output += chunk; });
  npm.stderr.on('data', chunk => { output += chunk; });
  let exited;
  npm.once('exit', (code, signal) => { exited = {code, signal}; });
  npm.once('error', error => { exited = {error}; });
  let forge;
  let owned = [];
  let finished = false;
  try {
    forge = await until('the Forge process', () => {
      if (exited) throw new Error('npm exited before Forge started');
      return tree(processes(), npm.pid).find(row => row.command.includes('electron-forge.js start'));
    });
    const url = await until('the Electron inspector', () => {
      if (exited) throw new Error('npm exited before Electron started');
      return readLog().match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)?.[1];
    });
    const electron = 'process.mainModule.require("electron")';
    const app = await until('the app window', () => evaluate(url, `(() => {
      const { app, BrowserWindow } = ${electron};
      const [window] = BrowserWindow.getAllWindows();
      return window && !window.webContents.isLoading() && window.webContents.getURL().startsWith('http://')
        && {pid: process.pid, data: app.getPath("userData")};
    })()`));
    assert.equal(fs.realpathSync(app.data), fs.realpathSync(path.join(logRoot, 'ReplayMod Reality')));
    await until('the C++ core process', () => processes().some(row =>
      row.parent === app.pid && row.command.endsWith('/native/build/replaymod-core')
    ));
    owned = tree(processes(), npm.pid);
    assert(owned.some(process => process.pid === app.pid), 'Electron must belong to this test launch');

    const started = Date.now();
    if (mode === 'window') {
      const imported = await evaluate(url, `
        ${electron}.BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
          '(async () => { const data = await window.replaymod.loadDefaultLocationCsv(); ' +
          'return {name: data.sourceName, time: Array.from(data.timelineTimestamps.slice(0, 3)), points: Array.from(data.timelineCoordinates.slice(0, 6)), ' +
          'binary: data.timelineTimestamps instanceof Float64Array && data.timelineCoordinates instanceof Float64Array}; })()')
      `);
      if (djiFootprint) {
        assert.equal(imported.name, path.basename(djiFootprint));
        assert.equal(imported.binary, true);
      } else {
        assert.deepEqual(imported, { name: 'fixture.csv + photo.csv', time: [1, 1, 2].map(offset => (csvStart + offset) * 1000),
          points: [121, 31, 122, 32, 120, 30], binary: true });
      }
      assert.doesNotMatch(readLog(), /Native CSV import failed/);
      const workerCheck = `(async () => {
        const { default: WorkerEntry } = await import('/features/timeline/speedCurveWorker.ts?worker');
        const worker = new WorkerEntry();
        try {
          return await new Promise((resolve, reject) => {
            worker.onmessage = ({ data }) => resolve({ id: data.id, moving: data.values?.every(value => value > 0) });
            worker.onerror = error => reject(new Error(error.message));
            const footprintTimestamps = new Float64Array([1000, 2000]);
            const footprintCoordinates = new Float64Array([121, 31, 120, 30]);
            worker.postMessage({ id: 1, start: 1000, end: 2000, count: 8,
              raw: { footprintTimestamps, footprintCoordinates } },
              [footprintTimestamps.buffer, footprintCoordinates.buffer]);
          });
        } finally { worker.terminate(); }
      })()`;
      const worker = await evaluate(url, `
        ${electron}.BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(${JSON.stringify(workerCheck)})
      `);
      assert.deepEqual(worker, { id: 1, moving: true });
      if (checkNativeTrajectory) {
        const trajectoryCheck = `(async () => {
          const bridge = window.replaymod;
          const media = await bridge.loadCachedMedia();
          if (!Number.isFinite(media?.creationTimeSeconds)) throw new Error('Fixture has no creation time');
          const {durationSeconds, creationTimeSeconds} = media;
          const points = ${djiVideo ? `(await import('/features/timeline/processedTrajectory.ts')).motionInputPoints(
            await bridge.loadDefaultLocationCsv(), creationTimeSeconds, durationSeconds)` :
            '[0, 1, 2].map(offset => ({ timeSeconds: creationTimeSeconds + offset, latitude: 30, longitude: 120 + offset * .0001 }))'};
          const fit = (precision, sampleRateHz) => new Promise((resolve, reject) => {
            const started = performance.now();
            const progress = [];
            const unsubscribeProgress = bridge.onMediaGpsProgress(update => {
              if (update.id === 'native-fit-fixture') progress.push({ completed: update.completed, total: update.total });
            });
            const unsubscribe = bridge.onMediaGpsResult(update => {
              if (update.id !== 'native-fit-fixture') return;
              unsubscribe();
              unsubscribeProgress();
              if (update.error) { reject(new Error(update.error)); return; }
              resolve({ points: update.result.points.length, windows: update.result.fittedWindows,
                start: update.result.points[0].timeSeconds, end: update.result.points.at(-1).timeSeconds,
                constraints: update.result.attitudeConstraints, expected: Math.ceil((creationTimeSeconds + durationSeconds - creationTimeSeconds) * (precision === 'preview' ? 5 : Math.min(60, sampleRateHz))) + 1,
                progress, ms: performance.now() - started });
            });
            bridge.postMediaGps('native-fit-fixture', { sourcePath: media.sourcePath,
              creationTimeSeconds, offsetSeconds: 0, precision, sampleRateHz, points });
          });
          const result = await fit('export', 10);
          if (${Boolean(djiVideo)}) return result;
          const preview = await fit('preview');
          const highRate = await fit('export', 120);
          return { ...result, previewPoints: preview.points, highRatePoints: highRate.points, previewProgress: preview.progress };
        })()`;
        const result = await evaluate(url, `
          ${electron}.BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(${JSON.stringify(trajectoryCheck)})
        `, djiVideo ? 30_000 : 15_000);
        assert.deepEqual(result.progress, Array.from({length: result.windows}, (_, index) => ({
          completed: index + 1, total: result.windows,
        })));
        if (djiVideo) {
          assert.equal(result.points, result.expected);
          assert(result.points > 1 && result.constraints > 0, 'Expected a track fitted with DJI orientation');
          console.log(`DJI IPC: ${result.points} points, ${result.constraints} attitude constraints, ${result.ms.toFixed(1)} ms from request to renderer result.`);
        } else {
          const { points, windows, start, end, previewPoints, highRatePoints } = result;
          assert.deepEqual({ points, windows, start, end, previewPoints, highRatePoints },
            { points: 21, windows: 1, start: 1577836800, end: 1577836802, previewPoints: 11, highRatePoints: 121 });
          assert.deepEqual(result.previewProgress, [{completed: 1, total: 1}]);
        }
      }
      if (checkExport) await checkTypedCsvExport(url, electron, profile, readLog, checkNativeTrajectory);
      await evaluate(url, `{
        const window = ${electron}.BrowserWindow.getAllWindows()[0];
        window.on('closed', () => process.mainModule.require('node:fs').writeFileSync(${JSON.stringify(path.join(profile, 'closed'))}, ''));
        setTimeout(() => window.close(), 100);
        true;
      }`);
    } else if (mode === 'Ctrl+C') {
      await evaluate(url, `{
        const fs = process.mainModule.require('node:fs');
        ${electron}.app.on('will-quit', () => fs.appendFileSync(${JSON.stringify(path.join(profile, 'quit'))}, 'quit'));
        true;
      }`);
      signalGroup(npm.pid, 'SIGINT');
    } else if (mode === 'app timeout') {
      await evaluate(url, `{
        const {app} = ${electron};
        app.on('will-quit', event => event.preventDefault());
        setTimeout(() => app.quit(), 100);
        true;
      }`);
    } else {
      // A stuck main thread cannot poll the quit request or run the app's timer.
      await evaluate(url, `setTimeout(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000), 50); true`);
      await delay(250);
      signalGroup(npm.pid, 'SIGTERM');
    }
    await until('npm and the entire app tree to exit', () =>
      exited && !processes().some(row => row.group === forge.group || owned.some(process => process.pid === row.pid)),
    15000);
    assert.ifError(exited.error);
    if (mode === 'window') {
      assert.equal(exited.code, 0);
      assert(fs.existsSync(path.join(profile, 'closed')), 'The app window must close');
      assert.doesNotMatch(readLog(), /Timed out waiting for the desktop app to shut down/);
    }
    if (mode === 'Ctrl+C') {
      assert(exited.code === 130 || exited.signal === 'SIGINT', JSON.stringify(exited));
      assert(fs.existsSync(path.join(profile, 'quit')), 'Ctrl+C must reach Electron’s graceful quit path');
    }
    if (mode === 'app timeout') {
      assert.match(readLog(), /Timed out waiting for the desktop app to shut down/);
      assert(Date.now() - started >= 5500, 'The app should get the grace period');
    }
    if (mode === 'launcher timeout') {
      assert(exited.code === 143 || exited.signal === 'SIGTERM', JSON.stringify(exited));
      assert(Date.now() - started >= 7500, 'A stuck Electron process should get the grace period');
    }
    finished = true;
    console.log(`${mode}: launcher, Forge, Electron and helpers exited.`);
  } catch (error) {
    const remaining = forge ? processes().filter(row => row.group === forge.group || owned.some(process => process.pid === row.pid)) : [];
    throw new Error(`${mode}: ${error.message}\n${output}\n${readLog().slice(-6000)}\nRemaining processes: ${JSON.stringify(remaining)}`, {cause: error});
  } finally {
    if (!finished) {
      if (forge) signalGroup(forge.group, 'SIGKILL');
      if (npm.pid) signalGroup(npm.pid, 'SIGKILL');
    }
    fs.rmSync(profile, {recursive: true, force: true});
  }
}

(async () => {
  if (process.platform === 'win32') {
    console.log('The desktop process-group integration test requires macOS or Linux.');
    return;
  }
  assert(!processes().some(row => row.command.includes('electron-forge.js start') && row.command.includes(root)), 'Close the existing development session before running this integration test.');
  const modes = ['window', 'Ctrl+C', 'app timeout', 'launcher timeout'];
  const requested = process.argv.slice(2);
  assert(requested.every(mode => modes.includes(mode)), 'Unknown shutdown test mode');
  for (const mode of requested.length ? requested : modes) await check(mode);
})().catch(error => { console.error(error); process.exitCode = 1; });
