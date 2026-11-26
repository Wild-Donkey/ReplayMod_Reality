import {processMotionGps, type MotionGpsResult, type MotionPoint} from "./gps-motion";
import type {OrientationSample} from "./types";

const RADIANS = Math.PI / 180;
const METRES = 6_371_000 * RADIANS;
const WINDOW_SECONDS = 300;
const OVERLAP_SECONDS = 60;
const CONTEXT_SECONDS = 4;
const BANDWIDTH = 7; // Four neighboring spline coefficients with interleaved x and y.
const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

export function normalizeTrajectorySampleRate(rate = 10) {
  return Number.isFinite(rate) ? Math.max(1, Math.min(60, Math.round(rate))) : 10;
}

interface Row {
  start: number;
  values: number[];
  target: number;
  weight: number;
  huber?: number;
}
type Position = readonly [east: number, north: number];
interface Attitude {
  time: number;
  yaw: number;
}

function upperBound<T>(items: readonly T[], time: number, timestamp: (item: T) => number) {
  let low = 0, high = items.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (timestamp(items[mid]) <= time) low = mid + 1;
    else high = mid;
  }
  return low;
}

function basis(time: number, firstKnot: number) {
  const cell = Math.floor(time);
  const u = time - cell, u2 = u * u, u3 = u2 * u;
  return {
    start: 2 * (cell - firstKnot - 1),
    weights: [(1-u)**3/6, (4-6*u2+3*u3)/6, (1+3*u+3*u2-3*u3)/6, u3/6],
    derivative: [-.5*(1-u)**2, -2*u+1.5*u2, .5+u-1.5*u2, .5*u2],
  };
}

function axisWeights(values: readonly number[], east: number, north: number) {
  return values.flatMap(value => [value * east, value * north]);
}

function evaluate(coefficients: Float64Array, start: number, values: readonly number[]) {
  return values.reduce((sum, value, index) => sum + value * coefficients[start + index], 0);
}

/** Banded normal equations with three Huber reweighting passes. */
function solve(rows: readonly Row[], seed: Float64Array) {
  let coefficients = seed;
  const size = seed.length, stride = BANDWIDTH + 1;
  for (let iteration = 0; iteration < 3; iteration++) {
    const band = new Float64Array(size * stride), rhs = new Float64Array(size);
    for (const row of rows) {
      const error = Math.abs(evaluate(coefficients, row.start, row.values) - row.target);
      const weight = row.weight * (row.huber === undefined || error <= row.huber ? 1 : row.huber / error);
      for (let i = 0; i < row.values.length; i++) {
        const index = row.start + i;
        const value = row.values[i] * weight;
        rhs[index] += value * row.target;
        for (let j = 0; j <= i; j++) band[index * stride + i - j] += value * row.values[j];
      }
    }
    for (let i = 0; i < size; i++) {
      for (let j = Math.max(0, i - BANDWIDTH); j <= i; j++) {
        let value = band[i * stride + i - j];
        for (let k = Math.max(0, i - BANDWIDTH); k < j; k++) {
          value -= band[i * stride + i - k] * band[j * stride + j - k];
        }
        if (i === j && !(value > 0)) return seed;
        band[i * stride + i - j] = i === j ? Math.sqrt(value) : value / band[j * stride];
      }
      for (let j = Math.max(0, i - BANDWIDTH); j < i; j++) rhs[i] -= band[i * stride + i - j] * rhs[j];
      rhs[i] /= band[i * stride];
    }
    for (let i = size - 1; i >= 0; i--) {
      for (let j = i + 1; j < Math.min(size, i + stride); j++) rhs[i] -= band[j * stride + j - i] * rhs[j];
      rhs[i] /= band[i * stride];
    }
    if (!rhs.every(Number.isFinite)) return seed;
    coefficients = rhs;
  }
  return coefficients;
}

function cameraYaw(samples: readonly OrientationSample[]): Attitude[] {
  return samples.flatMap(sample => {
    const [w, x, y, z] = sample.quaternion;
    const length = Math.hypot(w, x, y, z);
    if (!(length > 1e-8) || !Number.isFinite(length) || !Number.isFinite(sample.timeSeconds)) return [];
    return [{time: sample.timeSeconds, yaw: Math.atan2(2 * (w*z+x*y), length**2-2*(y*y+z*z))}];
  }).sort((a,b) => a.time-b.time);
}

function yawAt(attitude: readonly Attitude[], time: number) {
  const right = upperBound(attitude, time, item => item.time);
  const a = attitude[right - 1], b = attitude[right];
  if (a?.time === time) return a.yaw;
  if (!a || !b || b.time - a.time > .25) return null;
  return a.yaw + wrap(b.yaw-a.yaw) * (time-a.time) / (b.time-a.time);
}

/** Infer the camera-to-course angle from GPS chords, including bracketed long gaps. */
function calibrate(attitude: readonly Attitude[], anchors: readonly {time: number; position: Position}[]) {
  const observations: {course: number; camera: number; weight: number}[] = [];
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i-1], b = anchors[i], duration = b.time-a.time;
    const east = b.position[0]-a.position[0], north = b.position[1]-a.position[1];
    if (duration < 1 || Math.hypot(east,north) / duration < .75) continue;
    const lower = upperBound(attitude, a.time, item => item.time);
    const upper = upperBound(attitude, b.time, item => item.time);
    if (upper - lower < 2 || attitude[lower].time - a.time > .25 || b.time - attitude[upper-1].time > .25) continue;
    let x = 0, y = 0, covered = 0;
    for (let j = lower + 1; j < upper; j++) {
      const dt = attitude[j].time-attitude[j-1].time;
      if (dt > .25) continue;
      const yaw = attitude[j-1].yaw + wrap(attitude[j].yaw-attitude[j-1].yaw) / 2;
      x += Math.cos(yaw)*dt;
      y += Math.sin(yaw)*dt;
      covered += dt;
    }
    const coherence = Math.hypot(x,y) / duration;
    if (covered / duration >= .85 && coherence >= .35) {
      observations.push({course: Math.atan2(east,north), camera: Math.atan2(y,x), weight: coherence * Math.min(duration, 10)});
    }
  }
  if (!observations.length) return null;
  const candidates = [-1, 1].map(sign => {
    let x = 0, y = 0, sum = 0;
    for (const observation of observations) {
      const offset = observation.course-sign*observation.camera;
      x += Math.cos(offset)*observation.weight;
      y += Math.sin(offset)*observation.weight;
      sum += observation.weight;
    }
    return {sign, offset: Math.atan2(y,x), agreement: Math.hypot(x,y)/sum};
  });
  const best = candidates[1].agreement > candidates[0].agreement + .03 ? candidates[1] : candidates[0];
  if (best.agreement < .65) return null;
  return {...best, weight: Math.min(1, observations.length / 3) * best.agreement};
}

function fitWindow(start: number, end: number, anchors: readonly {time: number; position: Position}[],
  attitude: readonly Attitude[], seedPosition: (time: number) => Position) {
  const firstKnot = Math.floor(start)-1, lastKnot = Math.ceil(end)+2;
  const seed = new Float64Array((lastKnot-firstKnot+1)*2);
  const rows: Row[] = [];
  for (let time = firstKnot; time <= lastKnot; time++) {
    const index = (time-firstKnot)*2, position = seedPosition(time);
    seed[index] = position[0];
    seed[index+1] = position[1];
    for (let axis = 0; axis < 2; axis++) {
      rows.push({start: index+axis, values: [1], target: position[axis], weight: .015});
      if (time >= firstKnot+2) rows.push({start: index+axis-4, values: [1,0,-2,0,1], target: 0, weight: .5});
    }
  }
  const fixes = anchors.filter(anchor => anchor.time >= start && anchor.time <= end);
  for (const {time, position} of fixes) {
    const {start: index, weights} = basis(time, firstKnot);
    rows.push({start: index, values: axisWeights(weights,1,0), target: position[0], weight: 15, huber: 4});
    rows.push({start: index, values: axisWeights(weights,0,1), target: position[1], weight: 15, huber: 4});
  }
  const calibration = calibrate(attitude, fixes);
  let attitudeConstraints = 0;
  if (calibration) {
    for (let time = Math.ceil(start); time <= end; time++) {
      const yaw = yawAt(attitude,time), before = yawAt(attitude,time-.5), after = yawAt(attitude,time+.5);
      if (yaw === null || before === null || after === null || Math.abs(wrap(after-before)) > 1.2) continue;
      const {start: index, derivative} = basis(time,firstKnot);
      const initialEast = evaluate(seed,index,axisWeights(derivative,1,0));
      const initialNorth = evaluate(seed,index,axisWeights(derivative,0,1));
      const heading = yaw * calibration.sign + calibration.offset;
      const forward = initialEast*Math.sin(heading)+initialNorth*Math.cos(heading);
      if (Math.hypot(initialEast,initialNorth) < .75 || forward < -2) continue;
      // Fit a zero lateral velocity in the camera-derived direction. A weak
      // longitudinal prior discourages reversals without fixing the speed.
      rows.push({start: index, values: axisWeights(derivative,Math.cos(heading),-Math.sin(heading)), target: 0, weight: 7*calibration.weight, huber: 3});
      rows.push({start: index, values: axisWeights(derivative,Math.sin(heading),Math.cos(heading)), target: Math.max(0,forward), weight: .12});
      attitudeConstraints++;
    }
  }
  const coefficients = solve(rows,seed);
  return {start, end, attitudeConstraints: coefficients === seed ? 0 : attitudeConstraints, evaluate(time: number): Position {
    const {start: index, weights} = basis(time,firstKnot);
    return [evaluate(coefficients,index,axisWeights(weights,1,0)),evaluate(coefficients,index,axisWeights(weights,0,1))];
  }};
}

export function fitMotionTrajectory(samples: readonly OrientationSample[], input: readonly MotionPoint[], start: number, end: number, sampleRateHz = 10): MotionGpsResult {
  const baseline = processMotionGps([],input,start,end);
  const fixes = [...input].filter(point => Number.isFinite(point.timeSeconds) && Number.isFinite(point.latitude) && Number.isFinite(point.longitude) &&
    Math.abs(point.latitude)<=90 && Math.abs(point.longitude)<=180).sort((a,b) => a.timeSeconds-b.timeSeconds)
    .filter((point,index,items) => !index || point.timeSeconds>items[index-1].timeSeconds);
  if (!fixes.length || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return baseline;
  if ((end-start+2*CONTEXT_SECONDS)*10 > 500_000) throw new Error("轨迹处理范围过大，请缩短视频片段。");
  const origin = fixes[0];
  const longitudeScale = METRES * Math.max(.001, Math.cos(origin.latitude*RADIANS));
  const project = (point: MotionPoint): Position => [wrap((point.longitude-origin.longitude)*RADIANS)/RADIANS*longitudeScale,(point.latitude-origin.latitude)*METRES];
  const anchors = fixes.map(point => ({time: point.timeSeconds-start, position: project(point)}));
  const seedPoints = [...fixes,...baseline.contextPoints,...baseline.points].sort((a,b) => a.timeSeconds-b.timeSeconds)
    .map(point => ({time: point.timeSeconds-start, position: project(point), altitude: point.altitude}));
  const seedAt = (time: number) => {
    const right = upperBound(seedPoints,time,point => point.time);
    const a = seedPoints[Math.max(0,right-1)], b = seedPoints[Math.min(right,seedPoints.length-1)];
    const ratio = b.time>a.time ? Math.max(0,Math.min(1,(time-a.time)/(b.time-a.time))) : 0;
    const position: Position = [a.position[0]+ratio*(b.position[0]-a.position[0]),a.position[1]+ratio*(b.position[1]-a.position[1])];
    const altitude = a.altitude !== undefined && b.altitude !== undefined ? a.altitude+ratio*(b.altitude-a.altitude) : undefined;
    return {position, altitude};
  };
  const attitude = cameraYaw(samples);
  const last = end-start+CONTEXT_SECONDS;
  const windows: ReturnType<typeof fitWindow>[] = [];
  for (let left = -CONTEXT_SECONDS; left < last; left += WINDOW_SECONDS-OVERLAP_SECONDS) {
    const right = Math.min(left+WINDOW_SECONDS,last);
    windows.push(fitWindow(left,right,anchors,attitude,time => seedAt(time).position));
    if (right === last) break;
  }
  let index = 0;
  const sample = (time: number): MotionPoint => {
    while (index+1 < windows.length && time >= windows[index].end) index++;
    const current = windows[index], next = windows[index+1];
    let [east,north] = current.evaluate(time);
    if (next && time >= next.start) {
      const u = (time-next.start)/(current.end-next.start), weight = u*u*(3-2*u);
      const [nextEast,nextNorth] = next.evaluate(time);
      east += weight*(nextEast-east);
      north += weight*(nextNorth-north);
    }
    const {altitude} = seedAt(time);
    return {timeSeconds: start+time, longitude: wrap((origin.longitude+east/longitudeScale)*RADIANS)/RADIANS,
      latitude: Math.max(-90,Math.min(90,origin.latitude+north/METRES)), ...(altitude === undefined ? {} : {altitude})};
  };
  const rate = normalizeTrajectorySampleRate(sampleRateHz);
  const duration = end-start, steps = Math.ceil(duration*rate);
  const contextPoints = Array.from({length: CONTEXT_SECONDS*rate},(_,step) => sample(-CONTEXT_SECONDS+step/rate));
  const points = Array.from({length: steps+1},(_,step) => sample(duration*step/steps));
  for (let step = 1; step <= CONTEXT_SECONDS*rate; step++) contextPoints.push(sample(duration+step/rate));
  const attitudeConstraints = windows.reduce((count,window) => count+window.attitudeConstraints,0);
  return {...baseline, points, contextPoints, fittedWindows: windows.length, attitudeConstraints,
    reason: attitudeConstraints ? "使用 DJI 姿态约束轨迹方向。" : "使用 GPS 和运动平滑约束拟合轨迹。"};
}
