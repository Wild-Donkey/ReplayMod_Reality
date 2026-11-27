const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { on } = require('node:events');
const { Worker } = require('node:worker_threads');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const { buildCore } = require('../../scripts/native/build-core.cjs');

function installLoader(fs, ts) {
  require.extensions['.ts'] = (module, file) => {
    const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    });
    module._compile(outputText, file);
  };
}
installLoader(fs, ts);
const { NativeCore } = require('../../apps/desktop/src/main/nativeCore.ts');
const { readLocationCsv, restorePointColumns } = require('../../apps/desktop/src/main/locationCsv.ts');
const { readNativeLocationCsv } = require('../../apps/desktop/src/main/nativeLocationCsv.ts');
const { fitNativeTrajectory } = require('../../apps/desktop/src/main/nativeTrajectoryFit.ts');
const { unpackMotionGpsResult } = require('../../apps/desktop/src/shared/motionGpsWire.ts');

function checkMissingCompiler() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-native-toolchain-'));
  try {
    const source = path.resolve(__dirname, '../..');
    const script = path.join(directory, 'scripts/native/build-core.cjs');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.copyFileSync(path.join(source, 'scripts/native/build-core.cjs'), script);
    fs.cpSync(path.join(source, 'native/core'), path.join(directory, 'native/core'), { recursive: true });
    const check = `
      const assert = require('node:assert/strict');
      const { buildCore } = require(${JSON.stringify(script)});
      assert.throws(() => buildCore(), /compiler not found/);
    `;
    const result = spawnSync(process.execPath, ['-e', check], {
      env: { ...process.env, CXX: path.join(directory, 'unavailable-compiler') },
      encoding: 'utf8', timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readdirSync(path.join(directory, 'native/build')), []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

async function checkCsv(executable) {
  const sample = path.resolve(__dirname, '../../../RawData/footprint/Example_footprint.csv');
  assert.deepEqual(await readNativeLocationCsv(executable, sample), await readLocationCsv(sample, null));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-native-csv-'));
  try {
    const filename = path.join(directory, '测试轨迹.csv');
    await assert.rejects(readLocationCsv(filename, null), { code: 'ENOENT' });
    const header = '\uFEFFdataTime,longitude,latitude,accuracy,stepType,elevation';
    fs.writeFileSync(filename, [header, '3,10,20,120,0,8', '2,11,20,,0,', '1,12,20,0,0,-2',
      '2,13,20,100,0,4', '4,180.01,20,,0,', '', '5,15,20,,-1,'].join('\r\n'));
    assert.deepEqual(await readNativeLocationCsv(executable, filename), await readLocationCsv(filename, null));
    for (const row of ['2,11.0000005,20,,1,0', '2,0x10,20,,0,0', '2,11,20,,0', '"2"x,11,20,,0,0']) {
      fs.writeFileSync(filename, [header, '1,0,0,,0,0', row].join('\n'));
      assert.equal(await readNativeLocationCsv(executable, filename), null, row);
    }
    const quotedHeader = '\uFEFF"dataTime","longitude","latitude",accuracy,stepType,"elevation",note';
    fs.writeFileSync(filename, [quotedHeader, '"2","11",20," 100 ",0," \t ","commas, and ""quotes"""',
      '"1"," 12 ",20,"",1,"-2",""', '" ",0,0,,0,,', '"3",0,0,"101",0,,'].join('\r\n'));
    assert.deepEqual(await readNativeLocationCsv(executable, filename), await readLocationCsv(filename, null));
    fs.writeFileSync(filename, [quotedHeader, '2,11,20,,0,0,"a\r\nb"'].join('\r\n'));
    assert.equal((await readLocationCsv(filename, null)).pointCount, 1);
    assert.equal(await readNativeLocationCsv(executable, filename), null);
    const photos = path.join(directory, 'photos.csv');
    fs.writeFileSync(filename, [header, '2,12,20,,0,3', '1,11,20,,0,1', '1,10,20,,1,2'].join('\n'));
    fs.writeFileSync(photos, [header, '1,10,20,,0,4', '2,13,20,,0,5'].join('\n'));
    const merged = await readLocationCsv(filename, photos);
    assert.deepEqual(await readNativeLocationCsv(executable, filename, photos), merged);
    assert.deepEqual(Array.from(merged.timelineTimestamps), [1000, 1000, 2000, 2000]);
    assert.deepEqual(Array.from(merged.timelineCoordinates), [11, 20, 10, 20, 12, 20, 13, 20]);
    assert.deepEqual(Array.from(merged.timelineAltitudes), [1, 4, 3, 5]);
    fs.writeFileSync(filename, header + '\n');
    const photoOnly = await readLocationCsv(filename, photos);
    assert.equal(photoOnly.footprintPointCount, 0);
    assert.strictEqual(photoOnly.timelineCoordinates, photoOnly.photoCoordinates);
    assert.deepEqual(await readNativeLocationCsv(executable, filename, photos), photoOnly);
    fs.writeFileSync(filename, [header, '1,0.0000001,20,,1,1', '1,-0.0000001,20,,1,2',
      '1,0.0000002,20,,1,3', '2,120,21,,0,'].join('\n'));
    assert.deepEqual(await readNativeLocationCsv(executable, filename), await readLocationCsv(filename, null));
    const footprintOnly = await readLocationCsv(sample, null);
    assert.strictEqual(footprintOnly.timelineTimestamps, footprintOnly.footprintTimestamps);
    const oldTimes = Array.from(footprintOnly.footprintTimestamps);
    const restored = restorePointColumns({ ...footprintOnly, footprintTimestamps: oldTimes, timelineTimestamps: oldTimes });
    assert(restored.timelineTimestamps instanceof Float64Array);
    assert.strictEqual(restored.timelineTimestamps, restored.footprintTimestamps);
    assert.deepEqual(restored, footprintOnly);
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
}

async function check() {
  checkMissingCompiler();
  const executable = buildCore();
  const { status, stdout, error } = spawnSync(executable, [], {
    input: 'hello 2\nping\nhello 1\nping\n',
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.ifError(error);
  assert.equal(status, 0);
  assert.deepEqual(stdout.trim().split(/\r?\n/), ['error unsupported-command', 'error unsupported-command', 'ready 1', 'pong']);

  const core = new NativeCore(executable);
  try {
    await Promise.all([core.ping(), core.ping()]);
    await core.ping();
  } finally {
    await core.close();
  }
  await assert.rejects(core.ping(), /closing/);
  const missing = new NativeCore(executable + '.missing');
  await assert.rejects(missing.ping(), { code: 'ENOENT' });
  await missing.close();
  await checkCsv(executable);
  await checkTrajectory(executable);
  await checkTrajectoryWorker(executable);
  console.log('Native core handshake, ping, EOF shutdown and missing executable checks passed.');
  console.log('Native CSV matches the reference dataset and declines unsupported records.');
}

async function checkTrajectoryWorker(executable) {
  const entry = require.resolve('../../apps/desktop/src/main/trajectoryWorker.ts');
  const worker = new Worker(`
    (${installLoader})(require('node:fs'), require(${JSON.stringify(require.resolve('typescript'))}));
    require(${JSON.stringify(entry)});
  `, { eval: true, workerData: executable });
  try {
    const start = 1_800_000_000;
    for (const [duration, sampleRateHz] of [[60, 5], [1800, 10]]) {
      const messages = on(worker, 'message', { signal: AbortSignal.timeout(15_000) });
      const points = Array.from({length: duration + 1}, (_, index) => ({
        timeSeconds: start + index, longitude: 120 + index * 0.0001, latitude: 30,
      }));
      worker.postMessage({
        exiftool: executable + '.missing', sourcePath: 'fixture.mp4', revision: 'test',
        start, end: start + duration, points, sampleRateHz,
      });
      const progress = [];
      for await (const [message] of messages) {
        if ('progress' in message) {
          progress.push(message.progress);
          continue;
        }
        assert(!message.error, message.error);
        assert.equal(message.result.pointCount, duration * sampleRateHz + 1);
        assert.equal(progress.at(-1)?.completed, message.result.fittedWindows);
        break;
      }
    }
  } finally { await worker.terminate(); }
}

async function checkTrajectory(executable) {
  const start = 1_800_000_000.125;
  const fixtures = [];
  const samples = [];
  const curved = [];
  const withheld = [];
  let east = 0, north = 0;
  const scale = 6371000 * Math.PI / 180;
  for (let i = 0; i <= 2400; i++) {
    const time = i / 40, heading = .7 * Math.sin(time / 10) + .3 * Math.sin(time / 3);
    samples.push({ timeSeconds: time, quaternion: [Math.cos(heading / 2), 0, 0, -Math.sin(heading / 2)] });
    if (i % 80 === 0) (time <= 12 || time >= 50 ? curved : withheld).push({
      timeSeconds: start + time, longitude: east / scale, latitude: north / scale, altitude: 10 + time,
    });
    east += Math.sin(heading) * .25;
    north += Math.cos(heading) * .25;
  }
  fixtures.push({ samples, points: curved, seconds: 60, rate: 10, attitude: true });
  fixtures.push({ samples: [], points: Array.from({ length: 81 }, (_, i) => ({
    timeSeconds: start + i * 10,
    longitude: ((179.99 + i * .01 + 540) % 360) - 180,
    latitude: 40 + i * .0001,
    altitude: i % 3 === 0 ? undefined : i * 2,
  })), seconds: 800, rate: 10, windows: 4 });
  fixtures.push({ samples: [], points: [
    { timeSeconds: start - 30, longitude: 100, latitude: 30 },
    { timeSeconds: start - 1, longitude: 100, latitude: 30, altitude: 48 },
    { timeSeconds: start + 1, longitude: 100.04, latitude: 30.04, altitude: 49 },
    { timeSeconds: start + 2, longitude: 100.0002, latitude: 30, altitude: 50 },
    { timeSeconds: start + 2, longitude: 100.01, latitude: 30.01, altitude: 80 },
    { timeSeconds: start + 20, longitude: 100.001, latitude: 30, altitude: 80 },
    { timeSeconds: start + 40, longitude: 100.01, latitude: 30, altitude: 60 },
  ], seconds: 27.03, rate: 10, corrected: 1 });
  for (const rate of [5, 24, 120]) fixtures.push({ ...fixtures[0], samples: [], seconds: 60, rate, attitude: false });

  for (const { samples, points, seconds, rate, attitude, corrected, windows = 1 } of fixtures) {
    const progress = [];
    const end = start + seconds;
    const native = unpackMotionGpsResult(await fitNativeTrajectory(executable, samples, points, start, end, rate,
      undefined, update => progress.push(update)));
    assert.equal(native.fittedWindows, windows);
    assert.deepEqual(progress, Array.from({length: windows}, (_, index) => ({completed: index + 1, total: windows})));
    const sampleRate = Math.min(rate, 60);
    assert.equal(native.points.length, Math.ceil((end - start) * sampleRate) + 1);
    assert.equal(native.points[0].timeSeconds, start);
    assert.equal(native.points.at(-1).timeSeconds, end);
    assert.equal(native.contextPoints.length, 8 * sampleRate);
    assert.equal(native.contextPoints[0].timeSeconds, start - 4);
    assert.equal(native.contextPoints.at(-1).timeSeconds, end + 4);
    for (const point of [...native.points, ...native.contextPoints]) {
      assert(Math.abs(point.latitude) <= 90 && Math.abs(point.longitude) <= 180);
    }
    if (corrected) assert.equal(native.correctedPoints, corrected);
    if (windows > 1) {
      assert(native.bridgedIntervals === 0 && native.points.some(point => point.longitude < -179));
      assert(native.points.some(point => point.altitude === undefined));
      for (const time of [236, 296, 476, 536, 716, 776]) {
        const i = time * sampleRate;
        const [a, b, c] = native.points.slice(i - 1, i + 2);
        assert(Math.abs(c.latitude - 2*b.latitude + a.latitude) * scale * sampleRate < .01);
      }
    }
    if (attitude) {
      assert(native.attitudeConstraints > 0);
      const gpsOnly = unpackMotionGpsResult(await fitNativeTrajectory(executable, [], points, start, end, rate));
      const rmse = fit => Math.sqrt(withheld.reduce((sum, point) => {
        const estimate = fit.points[Math.round((point.timeSeconds - start) * rate)];
        return sum + (scale * Math.hypot(estimate.longitude - point.longitude, estimate.latitude - point.latitude)) ** 2;
      }, 0) / withheld.length);
      assert(rmse(native) < rmse(gpsOnly) * .75, 'Attitude must improve the withheld 38 s gap');
    }
  }
  const parked = unpackMotionGpsResult(await fitNativeTrajectory(executable, [], [curved[0]], start, start + 15, 5));
  assert(parked.points.every(point => Math.abs(point.latitude) < 1e-10 && Math.abs(point.longitude) < 1e-10));
  await assert.rejects(fitNativeTrajectory(executable, [], [], start, start + 60, 5), /GPS/);
  await assert.rejects(fitNativeTrajectory(executable + '.missing', [], curved, start, start + 60, 5), {code: 'ENOENT'});
  const controller = new AbortController();
  const cancelledProgress = [];
  const active = fitNativeTrajectory(executable, [], fixtures[1].points, start, start + 800, 60, controller.signal,
    update => cancelledProgress.push(update));
  controller.abort();
  await assert.rejects(active, { name: 'AbortError' });
  assert.deepEqual(cancelledProgress, []);
  console.log('Native trajectory fit passed sampling, attitude, overlapping windows, dateline and missing altitude checks.');
}

check().catch(error => { console.error(error); process.exitCode = 1; });
