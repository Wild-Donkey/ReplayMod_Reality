const fs = require('node:fs');
const assert = require('node:assert/strict');
const ts = require('typescript');
const vm = require('node:vm');
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/desktop/src/renderer/features/map/flightDetection.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: exportsObject });
const {
  DEFAULT_FLIGHT_THRESHOLD_METERS,
  heightAboveGround,
  isFlyingHeight,
  detectFlight,
  detectTimelineFlight,
  flightMask,
} = exportsObject;

// 被测代码运行在独立 VM realm，数组/对象原型与主上下文不同，不能用
// deepStrictEqual；JSON 比较只看结构与值（两侧 NaN 都序列化为 null）。
const same = (actual, expected) => assert.equal(JSON.stringify(actual), JSON.stringify(expected));

assert.equal(DEFAULT_FLIGHT_THRESHOLD_METERS, 100);
assert.equal(heightAboveGround(150, 50), 100);
assert.ok(Number.isNaN(heightAboveGround(Number.NaN, 50)));
assert.ok(Number.isNaN(heightAboveGround(150, Number.NaN)));
// 阈值边界：严格大于 100 m 才算飞行，等于不算。
assert.equal(isFlyingHeight(100), false);
assert.equal(isFlyingHeight(100.1), true);
assert.equal(isFlyingHeight(99.9), false);
assert.equal(isFlyingHeight(Number.NaN), false);
assert.equal(isFlyingHeight(10, Number.NaN), false);

const timestamps = [0, 1000, 2000, 3000, 4000, 5000];
const coordinates = timestamps.flatMap((_, i) => [i * 0.001, i * 0.002]);
const ground = [50, 50, 50, 50, 50, 50];
// -10 / 99.9 / 恰好100 / 100.1 / 海拔缺失 / 250
const altitudes = [40, 149.9, 150, 150.1, Number.NaN, 300];
const result = detectFlight(coordinates, timestamps, altitudes, ground);
assert.equal(result.totalCount, 6);
assert.equal(result.resolvableCount, 5);
assert.equal(result.flyingCount, 2);
same(result.flyingIndexes, [3, 5]);
assert.equal(result.peakHeightAboveGround, 250);
assert.equal(result.thresholdMeters, 100);
same(
  result.samples.map(s => [s.resolvable, s.flying, s.heightAboveGround]),
  [
    [true, false, -10],
    [true, false, 99.9],
    [true, false, 100],
    [true, true, 100.1],
    [false, false, Number.NaN],
    [true, true, 250],
  ],
);
assert.equal(result.samples[2].coordinate[0], 0.002);
assert.equal(result.samples[2].coordinate[1], 0.004);
assert.equal(result.samples[3].timestamp, 3000);
// 两个孤立飞行点各自成段（中间隔着非飞行/不可判定点）。
assert.equal(result.segments.length, 2);
assert.equal(result.segments[0].startIndex, 3);
assert.equal(result.segments[0].endIndex, 3);
assert.equal(result.segments[0].startTime, 3000);
assert.equal(result.segments[0].endTime, 3000);
assert.equal(result.segments[0].pointCount, 1);
assert.equal(result.segments[0].maxHeightAboveGround, 100.1);
assert.equal(result.segments[1].startIndex, 5);
assert.equal(result.segments[1].endIndex, 5);
assert.equal(result.segments[1].pointCount, 1);
assert.equal(result.segments[1].maxHeightAboveGround, 250);

// 地面高程缺失同样不可判定，不能误判为飞行。
const missingGround = detectFlight([0, 0, 1, 1], [0, 1000], [300, 400], [Number.NaN, 50]);
assert.equal(missingGround.resolvableCount, 1);
same(missingGround.flyingIndexes, [1]);
assert.equal(missingGround.peakHeightAboveGround, 350);

// 连续飞行点合并为一个区段，并记录区段内最大离地高度。
const runTimes = [0, 1, 2, 3, 4];
const runCoords = runTimes.flatMap((_, i) => [i, i]);
const runGround = [0, 0, 0, 0, 0];
const runAltitudes = [0, 150, 260, 180, 0];
const run = detectFlight(runCoords, runTimes, runAltitudes, runGround);
same(run.flyingIndexes, [1, 2, 3]);
assert.equal(run.segments.length, 1);
assert.equal(run.segments[0].startIndex, 1);
assert.equal(run.segments[0].endIndex, 3);
assert.equal(run.segments[0].startTime, 1);
assert.equal(run.segments[0].endTime, 3);
assert.equal(run.segments[0].pointCount, 3);
assert.equal(run.segments[0].maxHeightAboveGround, 260);
// Uint8Array 经 Array.from 落到主 realm，与字面量严格比较。
same(Array.from(flightMask(run)), [0, 1, 1, 1, 0]);

// 自定义阈值生效。
const lowThreshold = detectFlight([0, 0], [0], [25], [0], 20);
same(lowThreshold.flyingIndexes, [0]);
const highThreshold = detectFlight([0, 0], [0], [25], [0], 30);
assert.equal(highThreshold.flyingCount, 0);

// 空输入安全返回空结果。
const empty = detectFlight([], [], [], []);
assert.equal(empty.totalCount, 0);
assert.equal(empty.flyingCount, 0);
assert.equal(empty.samples.length, 0);
assert.equal(empty.segments.length, 0);
assert.ok(Number.isNaN(empty.peakHeightAboveGround));

// 趟次聚类：巡航中的不可判定/低空点与无点间隙在桥接窗口内并入同一趟，
// 超出窗口（两趟航班之间的长时间接地）才切开。
// 0-29min 一串飞行点（含中间一个地面点），120min 后另起一趟。
const tripTimes = [0, 5 * 60, 10 * 60, 15 * 60, 29 * 60, 120 * 60, 150 * 60].map(v => v * 1000);
const tripCoords = tripTimes.flatMap((_, i) => [i, i]);
const tripGround = tripTimes.map(() => 0);
// 第 3 个点掉到 50m（非飞行），把连续段切碎，但时间上仍属同一趟；
// 高度达到巡航级以模拟真实航班。
const tripAltitudes = [5000, 9000, 50, 9500, 9000, 8000, 8500];
const tripsResult = detectFlight(tripCoords, tripTimes, tripAltitudes, tripGround, 100, 30 * 60 * 1000);
same(tripsResult.flyingIndexes, [0, 1, 3, 4, 5, 6]);
assert.equal(tripsResult.segments.length, 3, '连续段按 100m 阈值与长时间断档切开');
assert.equal(tripsResult.trips.length, 2, '时间间隙聚类成两趟');
assert.equal(tripsResult.trips[0].startIndex, 0);
assert.equal(tripsResult.trips[0].endIndex, 4, '29 分钟无飞行点仍在 30 分钟桥接窗口内');
assert.equal(tripsResult.trips[0].flyingPointCount, 4, '中间低空点不计入飞行点数');
assert.equal(tripsResult.trips[0].maxHeightAboveGround, 9500);
assert.equal(tripsResult.trips[0].cruisePointCount, 4);
assert.equal(tripsResult.trips[0].p90HeightAboveGround, 9500);
assert.equal(tripsResult.trips[1].startIndex, 5);
assert.equal(tripsResult.trips[1].flyingPointCount, 2);

// 允许桥接 30–90 分钟的合理空中断档；恢复后的首个飞行点只有 167m，
// 不得再用 2000m 门槛把同一趟航班拆开。
const cruiseGap = detectFlight(
  [103, 10, 100, 16, 100.5, 18],
  [0, 30 * 60_000, 50 * 60_000],
  [10_000, 0, 167], [0, 0, 0],
);
assert.equal(cruiseGap.trips.length, 1, '低空恢复点也应桥接到同一趟航班');

// 巡航途中密集但只持续 10 分钟的低海拔异常簇，不足以证明真实落地。
const noisyGroundCluster = detectFlight(
  [101.26,12.35, 98.20,16.55, 98.20,16.55, 98.20,16.55, 100.45,18.08],
  [0, 32*60_000, 37*60_000, 42*60_000, 50*60_000],
  [11_000, 100, 100, 100, 11_400], [0,0,0,0,0],
);
assert.equal(noisyGroundCluster.trips.length, 1, '10 分钟异常低点簇不应切断巡航');

// 桥接窗口为 0 时，只有同一时刻的飞行点才会同趟；时间戳各不相同则各自成趟。
const noBridge = detectFlight(tripCoords, tripTimes, tripAltitudes, tripGround, 100, 0);
assert.equal(noBridge.trips.length, 6);
assert.equal(noBridge.trips[0].endIndex, 0);

// 非法桥接窗口必须报错。
assert.throws(() => detectFlight([0, 0], [0], [5000], [0], 100, -1), /桥接间隙无效/);

// PointDataset 适配：读取 timeline* 字段并逐点对齐。
const dataset = {
  timelineCoordinates: [10, 20, 10.001, 20],
  timelineTimestamps: [0, 1000],
  timelineAltitudes: [500, 0],
};
const viaDataset = detectTimelineFlight(dataset, [300, 0]);
same(viaDataset.flyingIndexes, [0]);
assert.equal(viaDataset.samples[0].groundElevation, 300);
assert.equal(viaDataset.samples[0].heightAboveGround, 200);

// 数组长度不一致或阈值非法必须立即报错，而不是静默错位筛选。
assert.throws(() => detectFlight([0, 0, 1, 1], [0], [0], [0]), /坐标数量不匹配/);
assert.throws(() => detectFlight([0, 0, 1, 1], [0, 1], [0], [0, 1]), /海拔数量不匹配/);
assert.throws(() => detectFlight([0, 0, 1, 1], [0, 1], [0, 0], [0]), /地面高程数量不匹配/);
assert.throws(() => detectFlight([0, 0], [0], [0], [0], -1), /阈值无效/);
assert.throws(() => detectFlight([0, 0], [0], [0], [0], Number.NaN), /阈值无效/);

console.log('Flight detection passed: 100m threshold boundary, missing values, peak height, segments, trip clustering with time-gap bridging, mask, dataset alignment and input validation.');
