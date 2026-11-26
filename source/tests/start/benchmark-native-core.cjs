const assert = require('node:assert/strict');
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
const { readLocationCsv } = require('../../apps/desktop/src/main/locationCsv.ts');
const { readNativeLocationCsv } = require('../../apps/desktop/src/main/nativeLocationCsv.ts');
const { fitNativeTrajectory } = require('../../apps/desktop/src/main/nativeTrajectoryFit.ts');
const { fitMotionTrajectory } = require('../../packages/media/src/trajectory-fit.ts');
const { packMotionGpsResult } = require('../../apps/desktop/src/shared/motionGpsWire.ts');
const { metricCurve, pixelDensity, smoothSpeedCurve } = require('../../apps/desktop/src/renderer/features/timeline/metrics.ts');

const repetitions = 6;
function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  return Number(((sorted[middle - 1] + sorted[middle]) / 2).toFixed(2));
}

async function compare(reference, native, countOf) {
  const samples = [[], []];
  let count;
  for (let iteration = 0; iteration <= repetitions; iteration++) {
    for (const mode of iteration % 2 ? [1, 0] : [0, 1]) {
      const start = performance.now();
      const result = await (mode ? native() : reference());
      const elapsed = performance.now() - start;
      const actual = countOf(result);
      assert.equal(actual, count ?? actual);
      count = actual;
      if (iteration) samples[mode].push(elapsed);
    }
  }
  return { points: count, tsMs: median(samples[0]), cppMs: median(samples[1]) };
}

function fixture(directory, name, count) {
  const file = path.join(directory, name);
  const handle = fs.openSync(file, 'w');
  try {
    fs.writeSync(handle, 'dataTime,longitude,latitude,stepType,elevation\n');
    for (let offset = 0; offset < count; offset += 10_000) {
      const rows = Array.from({ length: Math.min(10_000, count - offset) }, (_, i) =>
        `${1700000000 + count - offset - i},${120 + (i % 100) / 10000},30.25,0,15\n`);
      fs.writeSync(handle, rows.join(''));
    }
  } finally { fs.closeSync(handle); }
  return file;
}

async function csvBench(core) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-csv-bench-'));
  try {
    const small = path.resolve(__dirname, '../../../RawData/footprint/Example_footprint.csv');
    const medium = fixture(directory, '100k.csv', 100_000);
    const large = fixture(directory, '500k.csv', 500_000);
    const photos = fixture(directory, 'photos.csv', 100_000);
    for (const [label, footprint, photo] of [
      ['example', small, null], ['100k', medium, null], ['500k', large, null], ['500k + 100k photos', large, photos],
    ]) {
      const result = await compare(
        () => readLocationCsv(footprint, photo),
        () => readNativeLocationCsv(core, footprint, photo),
        value => value.pointCount,
      );
      console.log(label, result);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

async function trajectoryBench(core) {
  for (const seconds of [60, 600, 3600]) {
    const base = 1800000000;
    const gps = Array.from({ length: seconds + 1 }, (_, i) => ({
      timeSeconds: base + i, longitude: 116 + Math.sin(i / 30) * .01, latitude: 40 + i / 12000,
    }));
    const imu = Array.from({ length: seconds * 40 + 1 }, (_, i) => {
      const yaw = Math.sin(i / 1200);
      return { timeSeconds: i / 40, quaternion: [Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)] };
    });
    const result = await compare(
      () => packMotionGpsResult(fitMotionTrajectory(imu, gps, base, base + seconds)),
      () => fitNativeTrajectory(core, imu, gps, base, base + seconds, 10),
      value => value.pointCount,
    );
    console.log(`${seconds} s / 10 Hz`, result);
  }
}

function timelineBench() {
  const start = 1800000000000, count = 500_000;
  const dataset = {
    footprintTimestamps: Array.from({ length: count }, (_, i) => start + i * 1000),
    footprintCoordinates: Array.from({ length: count * 2 }, (_, i) => i % 2 ? 30 : 120 + i / 1e8),
  };
  const queries = {
    speed: (a, b) => smoothSpeedCurve(dataset, a, b, 3840),
    density: (a, b) => metricCurve(dataset, 'density', a, b, 3840, 60_000),
    pixels: (a, b) => pixelDensity(dataset.footprintTimestamps, a, b, 1920),
  };
  for (const window of [600_000, 86_400_000]) {
    for (const [name, query] of Object.entries(queries)) {
      const samples = [];
      for (let i = 0; i <= repetitions; i++) {
        const a = start + i * window * .75, time = performance.now();
        query(a, a + window);
        if (i) samples.push(performance.now() - time);
      }
      console.log(name, { window, ms: median(samples) });
    }
  }
}

async function main() {
  const mode = process.argv[2] ?? 'all';
  assert(['all', 'csv', 'trajectory', 'timeline'].includes(mode), 'Expected all, csv, trajectory or timeline');
  const core = mode === 'timeline' ? undefined : buildCore();
  if (mode === 'all' || mode === 'csv') await csvBench(core);
  if (mode === 'all' || mode === 'trajectory') await trajectoryBench(core);
  if (mode === 'all' || mode === 'timeline') timelineBench();
}

main().catch(error => { console.error(error); process.exitCode = 1; });
