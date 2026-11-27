const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const { buildCore } = require('../../scripts/native/build-core.cjs');

require.extensions['.ts'] = (module, file) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  module._compile(outputText, file);
};
const { readNativeLocationCsv } = require('../../apps/desktop/src/main/nativeLocationCsv.ts');
const { fitNativeTrajectory } = require('../../apps/desktop/src/main/nativeTrajectoryFit.ts');
const { extractDjiOrientation } = require('../../packages/media/src/dji.ts');
const { unpackMotionGpsResult } = require('../../apps/desktop/src/shared/motionGpsWire.ts');
const { motionInputPoints } = require('../../apps/desktop/src/renderer/features/timeline/processedTrajectory.ts');
const { metricCurve, pixelDensity, smoothSpeedCurve } = require('../../apps/desktop/src/renderer/features/timeline/metrics.ts');

const repetitions = 6;
function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  return Number(((sorted[middle - 1] + sorted[middle]) / 2).toFixed(2));
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
      const result = await measureNative(() => readNativeLocationCsv(core, footprint, photo));
      console.log(label, result);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

async function measureNative(fit) {
  const samples = [];
  let result;
  for (let iteration = 0; iteration <= repetitions; iteration++) {
    const start = performance.now();
    result = await fit();
    if (iteration) samples.push(performance.now() - start);
  }
  return { points: result.pointCount, cppMs: median(samples) };
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
    const result = await measureNative(() => fitNativeTrajectory(core, imu, gps, base, base + seconds, 10));
    console.log(`${seconds} s / 10 Hz`, result);
  }
}

async function djiBench(core, video, csv) {
  assert(video && csv, 'Usage: npm run bench:native -- dji <video> <footprint CSV>');
  const probe = JSON.parse(execFileSync(process.env.REPLAYMOD_FFPROBE || 'ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration:format_tags=creation_time', '-of', 'json', video,
  ], { encoding: 'utf8', timeout: 30_000 }));
  const start = Date.parse(probe.format.tags?.creation_time) / 1000;
  const duration = Number(probe.format.duration);
  assert(Number.isFinite(start) && Number.isFinite(duration) && duration > 0, 'Missing video capture time or duration');
  const dataset = await readNativeLocationCsv(core, csv);
  const points = motionInputPoints(dataset, start, duration);
  const fixesInClip = points.filter(point => point.timeSeconds >= start && point.timeSeconds <= start + duration).length;
  assert(fixesInClip >= 2, 'Need at least two GPS fixes within the video capture time range');

  const extractStart = performance.now();
  const attitude = await extractDjiOrientation(video, process.env.REPLAYMOD_EXIFTOOL || 'exiftool');
  const extractMs = Number((performance.now() - extractStart).toFixed(2));
  assert(attitude.length, 'ExifTool found no valid DJI quaternions');
  const end = start + duration;
  const fit = () => fitNativeTrajectory(core, attitude, points, start, end, 10);
  const native = unpackMotionGpsResult(await fit());
  assert(native.attitudeConstraints > 0, 'The clip must exercise attitude constraints');
  assert.equal(native.points[0].timeSeconds, start);
  assert.equal(native.points.at(-1).timeSeconds, end);
  console.log({ duration, fixesInClip, quaternionCount: attitude.length, constraints: native.attitudeConstraints,
    extractMs, ...await measureNative(fit) });
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
  assert(['all', 'csv', 'trajectory', 'timeline', 'dji'].includes(mode), 'Expected all, csv, trajectory, timeline or dji');
  const core = mode === 'timeline' ? undefined : buildCore();
  if (mode === 'all' || mode === 'csv') await csvBench(core);
  if (mode === 'all' || mode === 'trajectory') await trajectoryBench(core);
  if (mode === 'all' || mode === 'timeline') timelineBench();
  if (mode === 'dji') await djiBench(core, process.argv[3], process.argv[4]);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
