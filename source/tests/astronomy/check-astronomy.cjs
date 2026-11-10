const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const file = path.resolve(__dirname, "../../apps/desktop/src/renderer/features/astronomy/astronomy.ts");
const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const exportsObject = {};
vm.runInNewContext(outputText, { exports: exportsObject, require, Date }, { filename: file });
const { observationDay, observationStart, minutesPerDay, sunVector } = exportsObject;

assert.equal(new Date(observationStart("2026-11-10", 480)).toISOString(), "2026-11-09T16:00:00.000Z");
assert.equal(new Date(observationStart("2026-11-10", -210)).toISOString(), "2026-11-10T03:30:00.000Z");

const equinox = observationStart("2026-03-20", 0);
const equator = observationDay([0, 0], equinox);
assert.equal(equator.samples.length, minutesPerDay / 5 + 1);
assert(equator.samples[0].sun.altitude < -85);
assert(equator.samples[144].sun.altitude > 85);
assert(equator.samples.at(-1).sun.altitude < -85);
const [sunrise, sunset] = equator.events.map(event => event.value);
assert(sunrise.minute > 340 && sunrise.minute < 390 && Math.abs(sunrise.azimuth - 90) < 2);
assert(sunset.minute > 1060 && sunset.minute < 1110 && Math.abs(sunset.azimuth - 270) < 2);
for (const { value } of equator.events.slice(2)) {
  assert(value && value.minute >= 0 && value.minute < minutesPerDay && value.azimuth >= 0 && value.azimuth < 360);
}
assert(Math.abs(equator.samples[0].galacticCenter.altitude - equator.samples.at(-1).galacticCenter.altitude) < 1.1);
const galacticAltitudes = equator.samples.map(sample => sample.galacticCenter.altitude);
assert(Math.max(...galacticAltitudes) > 60 && Math.min(...galacticAltitudes) < -60);

const [x, y, z] = sunVector(new Date(equinox + 12 * 3_600_000));
assert(x > 0.999 && Math.abs(y) < 0.04 && Math.abs(z) < 0.02);
assert(Math.abs(Math.hypot(x, y, z) - 1) < 1e-12);

for (const [date, aboveHorizon] of [["2026-06-21", true], ["2026-12-21", false]]) {
  const polarDay = observationDay([15.63, 78.22], observationStart(date, 120));
  assert(polarDay.samples.every(sample => (sample.sun.altitude > 0) === aboveHorizon));
  assert.equal(polarDay.events[0].value, null);
  assert.equal(polarDay.events[1].value, null);
}
console.log("Astronomy checks passed: 24-hour UTC-offset day, equinox directions, solar vector, Galactic Centre and polar rise/set.");
