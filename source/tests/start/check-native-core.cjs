const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const { buildCore } = require('../../scripts/native/build-core.cjs');

require.extensions['.ts'] = (module, file) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  module._compile(outputText, file);
};
const { NativeCore } = require('../../apps/desktop/src/main/nativeCore.ts');
const { readLocationCsv } = require('../../apps/desktop/src/main/locationCsv.ts');
const { readNativeLocationCsv } = require('../../apps/desktop/src/main/nativeLocationCsv.ts');
const { fitNativeTrajectory } = require('../../apps/desktop/src/main/nativeTrajectoryFit.ts');
const { unpackMotionGpsResult } = require('../../apps/desktop/src/shared/motionGpsWire.ts');
const { fitMotionTrajectory } = require('../../packages/media/src/trajectory-fit.ts');

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
    for (const row of ['2,11,20,,1,0', '"2",11,20,,0,0', '2,0x10,20,,0,0', '2,11,20,,0']) {
      fs.writeFileSync(filename, [header, '1,0,0,,0,0', row].join('\n'));
      assert.equal(await readNativeLocationCsv(executable, filename), null, row);
    }
    const photos = path.join(directory, 'photos.csv');
    fs.writeFileSync(filename, [header, '2,12,20,,0,3', '1,11,20,,0,1', '1,10,20,,1,2'].join('\n'));
    fs.writeFileSync(photos, [header, '1,10,20,,0,4', '2,13,20,,0,5'].join('\n'));
    const merged = await readLocationCsv(filename, photos);
    assert.deepEqual(merged.timelineTimestamps, [1000, 1000, 2000, 2000]);
    assert.deepEqual(merged.timelineCoordinates, [11, 20, 10, 20, 12, 20, 13, 20]);
    assert.deepEqual(merged.timelineAltitudes, [1, 4, 3, 5]);
    fs.writeFileSync(filename, header + '\n');
    const photoOnly = await readLocationCsv(filename, photos);
    assert.equal(photoOnly.footprintPointCount, 0);
    assert.strictEqual(photoOnly.timelineCoordinates, photoOnly.photoCoordinates);
    const footprintOnly = await readLocationCsv(sample, null);
    assert.strictEqual(footprintOnly.timelineTimestamps, footprintOnly.footprintTimestamps);
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
}

async function check() {
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
  console.log('Native core handshake, ping, EOF shutdown and missing executable checks passed.');
  console.log('Native CSV matches the reference dataset and declines unsupported records.');
}

async function checkTrajectory(executable) {
  const start = 1_800_000_000.125;
  const fixtures = [];
  const samples = [];
  const curved = [];
  let east = 0, north = 0;
  const scale = 6371000 * Math.PI / 180;
  for (let i = 0; i <= 2400; i++) {
    const time = i / 40, heading = .7 * Math.sin(time / 10) + .3 * Math.sin(time / 3);
    samples.push({ timeSeconds: time, quaternion: [Math.cos(heading / 2), 0, 0, -Math.sin(heading / 2)] });
    if (i % 80 === 0 && (time <= 12 || time >= 50)) {
      curved.push({ timeSeconds: start + time, longitude: east / scale, latitude: north / scale, altitude: 10 + time });
    }
    east += Math.sin(heading) * .25;
    north += Math.cos(heading) * .25;
  }
  fixtures.push({ samples, points: curved, seconds: 60, rate: 10, attitude: true });
  fixtures.push({ samples: [], points: Array.from({ length: 81 }, (_, i) => ({
    timeSeconds: start + i * 10,
    longitude: ((179.99 + i * .01 + 540) % 360) - 180,
    latitude: 40 + i * .0001,
    altitude: i % 3 === 0 ? undefined : i * 2,
  })), seconds: 800, rate: 10 });
  fixtures.push({ samples: [], points: [], seconds: 20, rate: 10 });

  for (const { samples, points, seconds, rate, attitude } of fixtures) {
    const legacy = fitMotionTrajectory(samples, points, start, start + seconds);
    const native = unpackMotionGpsResult(await fitNativeTrajectory(executable, samples, points, start, start + seconds, rate));
    const { points: expected, contextPoints: context, ...summary } = legacy;
    const { points: actual, contextPoints: nativeContext, ...nativeSummary } = native;
    assert.deepEqual(nativeSummary, summary);
    if (attitude) assert(legacy.attitudeConstraints > 0);
    for (const [expectedRows, actualRows] of [[expected, actual], [context, nativeContext]]) {
      assert.equal(actualRows.length, expectedRows.length);
      for (let i = 0; i < expectedRows.length; i++) {
        const a = expectedRows[i], b = actualRows[i];
        assert.equal(b.timeSeconds, a.timeSeconds);
        assert.equal(b.altitude, a.altitude);
        const lonError = ((b.longitude - a.longitude + 540) % 360) - 180;
        assert(Math.abs(lonError) < 1e-9 && Math.abs(b.latitude - a.latitude) < 1e-9, `point ${i}`);
      }
    }
  }
  const controller = new AbortController();
  const active = fitNativeTrajectory(executable, [], fixtures[1].points, start, start + 800, 60, controller.signal);
  controller.abort();
  await assert.rejects(active, { name: 'AbortError' });
  console.log('Native trajectory fit matches the reference for attitude, overlapping windows, dateline and missing altitude.');
}

check().catch(error => { console.error(error); process.exitCode = 1; });
