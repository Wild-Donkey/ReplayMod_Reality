const fs = require('node:fs');
const assert = require('node:assert/strict');
const ts = require('typescript');
const vm = require('node:vm');
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/desktop/src/renderer/features/timeline/metrics.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: exportsObject });
const { interpolatedMotion, continuousSpeed, metricCurve, speedStepCurve } = exportsObject;
const dataset = (times, coordinates) => ({ footprintTimestamps: times, footprintCoordinates: coordinates });
const route = dataset([0, 1000, 3500, 6000], [0, 0, .001, 0, .002, .001, .004, .001]);
// Analytic velocity must match the derivative of POSITION, including turns.
for (const time of [200, 700, 1600, 3000, 4200, 5700]) {
  const motion = interpolatedMotion(route, time);
  const left = interpolatedMotion(route, time - .1);
  const right = interpolatedMotion(route, time + .1);
  motion.velocity.forEach((velocity, axis) => {
    const numerical = (right.position[axis] - left.position[axis]) / .0002;
    assert.ok(Math.abs(numerical - velocity) < .001);
  });
  assert.ok(Math.abs(continuousSpeed(route, time) - Math.hypot(...motion.velocity) * 3.6) < 1e-10);
}
// Position is continuous at knots; its derivative is allowed to jump.
for (const time of [1000, 3500]) {
  const left = interpolatedMotion(route, time - .000001).position;
  const right = interpolatedMotion(route, time + .000001).position;
  left.forEach((value, axis) => assert.ok(Math.abs(value - right[axis]) < .001));
}
const stationary = dataset([0, 1000, 2000], [12, 30, 12, 30, 12, 30]);
assert.equal(continuousSpeed(stationary, 500), 0);
assert.equal(continuousSpeed(route, -1), null);
const two = dataset([0, 1000], [0, 0, .001, 0]);
assert.ok(Math.abs(continuousSpeed(two, 500) - 400.3017) < .01);
const dates = dataset([0, 1000], [179.999, 0, -179.999, 0]);
assert.ok(continuousSpeed(dates, 500) < 1500); // no longitude wraparound jump
// A million-point dataset: only nearby positions may be accessed, and cache hits
// must not read any further coordinates. Timestamp lookup stays logarithmic.
let coordinateReads = 0;
let timestampReads = 0;
const length = 1_000_000;
const huge = dataset(new Proxy({ length }, { get(target, key) {
  if (key === 'length') return length;
  timestampReads++;
  return Number(key) * 1000;
} }), new Proxy({}, { get(target, key) {
  coordinateReads++;
  const index = Math.floor(Number(key) / 2);
  assert.ok(index >= 499998 && index <= 500003, `read distant point ${index}`);
  return Number(key) % 2 ? 0 : index * .000001;
} }));
const curve = metricCurve(huge, 'speed', 500000100, 500001900, 128, 0);
assert.ok(coordinateReads < 40);
assert.ok(timestampReads < 5000);
const reads = coordinateReads;
assert.strictEqual(metricCurve(huge, 'speed', 500000100, 500001900, 128, 0), curve);
assert.equal(coordinateReads, reads);
const zoom = metricCurve(huge, 'speed', 500000550, 500001450, 128, 0);
assert.equal(curve[64], zoom[64]);
console.log('Timeline metrics passed: position derivative, position continuity, stationary motion, units, dateline, window-local work, cache reuse and zoom invariance.');

const gestureExports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/desktop/src/renderer/features/timeline/gestures.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: gestureExports });
const { timelineWheelRange } = gestureExports;
const gesture = (deltaX, deltaY, ctrlKey = false, deltaMode = 0) => ({ deltaX, deltaY, ctrlKey, deltaMode });
const pan = timelineWheelRange([1000, 2000], [0, 10000], gesture(100, 1), 1000, 100, .5);
assert.equal(pan[0], 1100); assert.equal(pan[1], 2100);
const zoomed = timelineWheelRange([1000, 2000], [0, 10000], gesture(0, -100), 1000, 100, .25);
assert.ok(Math.abs((zoomed[1] - zoomed[0]) / 1000 - Math.exp(-.4)) < 1e-12);
assert.ok(Math.abs(zoomed[0] + (zoomed[1] - zoomed[0]) * .25 - 1250) < 1e-10);
const pinch = timelineWheelRange([1000, 2000], [0, 10000], gesture(1000, -100, true), 1000, 100, .25);
assert.equal(JSON.stringify(pinch), JSON.stringify(zoomed));
const line = timelineWheelRange([1000, 2000], [0, 10000], gesture(0, -1, false, 1), 1000, 100, .25);
const pixels = timelineWheelRange([1000, 2000], [0, 10000], gesture(0, -40), 1000, 100, .25);
assert.equal(JSON.stringify(line), JSON.stringify(pixels));
const bounded = timelineWheelRange([1000, 2000], [0, 10000], gesture(0, 1e9), 1000, 100, .5);
assert.equal(bounded[0], 0); assert.equal(bounded[1], 10000);
const tiny = timelineWheelRange([1000, 2000], [0, 10000], gesture(0, -1e9), 1000, 100, .5);
assert.equal(tiny[1] - tiny[0], 1);
console.log('Timeline gestures passed: horizontal pan, doubled vertical zoom, pinch, pointer anchoring, wheel units and bounds.');

// Arrival, a repeated-position pause, then departure: neighbouring movement
// must never introduce velocity or a positional loop into the pause.
for (const times of [[0, 1000, 2000, 3000], [0, 100, 60000, 65000]]) {
  const stop = dataset(times, [0, 0, .001, 0, .001, 0, .002, 0]);
  const fixed = interpolatedMotion(stop, times[1]).position;
  for (let i = 0; i < 100; i++) {
    const time = times[1] + (times[2] - times[1]) * i / 100;
    assert.equal(continuousSpeed(stop, time), 0);
    interpolatedMotion(stop, time).position.forEach((value, axis) => assert.equal(value, fixed[axis]));
  }
  assert.ok(continuousSpeed(stop, times[1] - .001) > 0);
  assert.equal(continuousSpeed(stop, times[2] - .001), 0);
  assert.ok(continuousSpeed(stop, times[2]) > 0);
}
console.log('Stationary interval regression passed: arrival/pause/departure with uniform and irregular timestamps stays exactly motionless.');

// Fast motion before/after a long gap must not affect the gap trajectory.
const gapStart = 1000, gapEnd = 3601000;
const gapOnly = dataset([gapStart, gapEnd], [10, 20, 10.001, 20]);
const fastNeighbours = dataset([0, gapStart, gapEnd, gapEnd + 1000], [0, 0, 10, 20, 10.001, 20, 30, 40]);
for (let i = 0; i < 100; i++) {
  const time = gapStart + (gapEnd - gapStart) * i / 100;
  assert.ok(Math.abs(continuousSpeed(gapOnly, time) - continuousSpeed(fastNeighbours, time)) < 1e-9);
  const p = interpolatedMotion(gapOnly, time).position;
  const q = interpolatedMotion(fastNeighbours, time).position;
  p.forEach((value, axis) => assert.ok(Math.abs(value - q[axis]) < 1e-8));
}
assert.ok(continuousSpeed(fastNeighbours, (gapStart + gapEnd) / 2) < 1);
const twiceAsLong = dataset([gapStart, gapStart + 2 * (gapEnd - gapStart)], [10, 20, 10.001, 20]);
assert.ok(Math.abs(continuousSpeed(gapOnly, (gapStart + gapEnd) / 2) / 2 - continuousSpeed(twiceAsLong, gapEnd)) < 1e-10);
console.log('Long gap regression passed: endpoint-only position interpolation, no inherited motion, inverse-duration speed scaling.');

// A one-second drift interval must have a FLAT speed plateau, not a dome.
const drift = dataset([0, 1000, 2000, 3000], [0, 0, 0, 0, .001, 0, .001, 0]);
const driftSpeed = continuousSpeed(drift, 1500);
for (const time of [1000, 1000.001, 1100, 1250, 1750, 1999.999]) assert.equal(continuousSpeed(drift, time), driftSpeed);
assert.equal(continuousSpeed(drift, 999.999), 0);
assert.equal(continuousSpeed(drift, 2000), 0);
const steps = speedStepCurve(drift, 500, 2500, 128);
assert.equal(JSON.stringify(steps), JSON.stringify([[500, 0], [1000, driftSpeed], [2000, 0], [2500, 0]]));
assert.strictEqual(speedStepCurve(drift, 500, 2500, 128), steps);
// Even a subpixel interval retains its real edges at detailed zoom.
const narrow = dataset([0, 1234, 1235, 3000], [0,0, 0,0, .001,0, .001,0]);
const narrowSteps = speedStepCurve(narrow, 0, 3000, 128);
assert.equal(narrowSteps[1][0], 1234); assert.equal(narrowSteps[2][0], 1235);
console.log('Drift regression passed: flat plateau, instantaneous edges, no forced stops, exact boundary rendering and step cache reuse.');

const { pixelDensity } = exportsObject;
const pointTimes = [-1, 0, 0, 9, 10, 20, 20, 20, 39, 40, 41];
const densityPixels = pixelDensity(pointTimes, 0, 40, 4);
assert.equal(JSON.stringify(Array.from(densityPixels.counts)), JSON.stringify([3, 1, 3, 2]));
assert.equal(densityPixels.peak, 3);
assert.strictEqual(pixelDensity(pointTimes, 0, 40, 4), densityPixels);
const emptyPixels = pixelDensity([], 0, 40, 4);
assert.equal(emptyPixels.peak, 0);
assert.ok(Array.from(emptyPixels.counts).every(count => count === 0));
const sparse = pixelDensity([0, 0, 30], 0, 40, 4);
assert.equal(sparse.counts[0] / sparse.peak, 1);
assert.equal(sparse.counts[1] / sparse.peak, 0);
assert.equal(sparse.counts[3] / sparse.peak, .5);
const localPixels = pixelDensity(pointTimes, 10, 20, 2);
assert.equal(Array.from(localPixels.counts).reduce((a,b)=>a+b,0), 4);
let histogramReads = 0;
const hugeTimes = new Proxy({ length: 1000000 }, {get(target, key) {
  if(key === 'length') return 1000000;
  histogramReads++;
  return Number(key);
}});
pixelDensity(hugeTimes, 400000, 600000, 500);
assert.ok(histogramReads < 15000); // binary searches per pixel, no full point scan
console.log('Pixel density passed: exact boundaries, duplicates, transparent empty bins, relative brightness, viewport counts, bounded lookups and cache reuse.');

const { smoothDisplayValues, smoothSpeedCurve } = exportsObject;
const plateau = new Float64Array(101).fill(0);
for (let i = 30; i <= 70; i++) plateau[i] = 100;
const blurred = smoothDisplayValues(plateau, 2);
assert.equal(plateau[29], 0); // immutable source
assert.ok(blurred[29] > 0 && blurred[29] < 100);
assert.ok(blurred[30] > blurred[29]);
assert.ok(Math.abs(blurred[50] - 100) < 1e-10);
blurred.forEach((value,i) => {
  assert.ok(value >= 0 && value <= 100 + 1e-10);
  assert.ok(Math.abs(value - blurred[100-i]) < 1e-10);
});
const missing = smoothDisplayValues(new Float64Array([1, 1, NaN, 1, 1]), 1);
assert.ok(Number.isNaN(missing[2]));
const display = smoothSpeedCurve(drift, 0, 3000, 400);
assert.strictEqual(smoothSpeedCurve(drift, 0, 3000, 400), display);
assert.equal(continuousSpeed(drift, 999.999), 0); // raw analytic speed is untouched
assert.equal(continuousSpeed(drift, 1500), driftSpeed);
assert.equal(display.length, 401);
console.log('Display smoothing passed: symmetric edges, flat interior, no overshoot, no mutation, missing values and cache reuse.');
