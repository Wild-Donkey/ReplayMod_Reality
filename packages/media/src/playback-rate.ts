import type {
  OrientationSample,
  PlaybackRateOptions,
  PlaybackRateSample,
  TimelineMetadataTrack,
} from "./types";

export const defaultPlaybackRateOptions: PlaybackRateOptions = {
  minimumRate: 1,
  maximumRate: 5,
  angularSpeedForMaximumRate: 30,
  angularSpeedForMinimumRate: 150,
  featureMinimumDurationSeconds: 0.05,
  analysisWindowSeconds: [8, 4, 2, 1, 0.5, 0.25, 0.1],
  minimumRotationDegrees: 10,
  minimumAverageAngularSpeedAtOneSecond: 10,
  shortWindowThresholdPower: 0.5,
  minimumDirectionCoherence: 0.65,
  sampleIntervalSeconds: 0.1,
  speedUpTimeSeconds: 0.5,
  slowDownLookAheadSeconds: 0.2,
};

const quaternionAngle = (
  left: OrientationSample,
  right: OrientationSample,
): number => {
  let dot = left.quaternion.reduce(
    (sum, value, index) => sum + value * right.quaternion[index],
    0,
  );
  dot = Math.min(1, Math.max(-1, Math.abs(dot)));
  return (2 * Math.acos(dot) * 180) / Math.PI;
};

// DJI 姿态在这份样片中约为 40 ms 一个样本。只替换“偏离后立即回到原位”
// 的单样本尖峰，避免把真实的快速转动也当成噪声。
const removeSubDurationFeatures = (
  orientation: readonly OrientationSample[],
  minimumDurationSeconds: number,
): OrientationSample[] => orientation.map((sample, index) => {
  const previous = orientation[index - 1];
  const next = orientation[index + 1];
  if (!previous || !next) return sample;
  const beforeDuration = sample.timeSeconds - previous.timeSeconds;
  const afterDuration = next.timeSeconds - sample.timeSeconds;
  if (beforeDuration > minimumDurationSeconds || afterDuration > minimumDurationSeconds) {
    return sample;
  }
  const excursion = Math.min(
    quaternionAngle(previous, sample),
    quaternionAngle(sample, next),
  );
  const residual = quaternionAngle(previous, next);
  return excursion > 0 && residual < excursion * 0.25
    ? { ...sample, quaternion: previous.quaternion }
    : sample;
});

const lowerBoundTime = (
  samples: readonly OrientationSample[],
  timeSeconds: number,
): number => {
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (samples[middle].timeSeconds < timeSeconds) low = middle + 1;
    else high = middle;
  }
  return Math.min(low, samples.length - 1);
};

const rateForAngularSpeed = (
  angularSpeed: number,
  options: PlaybackRateOptions,
): number => {
  const range = options.angularSpeedForMinimumRate - options.angularSpeedForMaximumRate;
  if (range <= 0) {
    throw new Error("最低倍率的角速度阈值必须高于最高倍率的阈值。");
  }
  const blend = Math.min(1, Math.max(0,
    (angularSpeed - options.angularSpeedForMaximumRate) / range,
  ));
  return options.maximumRate - blend * (options.maximumRate - options.minimumRate);
};

const prioritizeLowerRates = (
  samples: PlaybackRateSample[],
  options: PlaybackRateOptions,
): PlaybackRateSample[] => {
  if (samples.length < 2) return samples;
  const interval = options.sampleIntervalSeconds;
  const lookAheadSamples = Math.ceil(options.slowDownLookAheadSeconds / interval);
  const anticipated = samples.map((sample, index) => ({
    ...sample,
    rate: Math.min(...samples
      .slice(index, index + lookAheadSamples + 1)
      .map((candidate) => candidate.rate)),
  }));
  const maximumRisePerSample = options.speedUpTimeSeconds <= 0
    ? Number.POSITIVE_INFINITY
    : (options.maximumRate - options.minimumRate) * interval /
      options.speedUpTimeSeconds;
  for (let index = 1; index < anticipated.length; index += 1) {
    anticipated[index].rate = Math.min(
      anticipated[index].rate,
      anticipated[index - 1].rate + maximumRisePerSample,
    );
  }
  return anticipated;
};

export const buildPlaybackRateTrack = (
  rawOrientation: readonly OrientationSample[],
  durationSeconds: number,
  options: PlaybackRateOptions = defaultPlaybackRateOptions,
): TimelineMetadataTrack<PlaybackRateSample> => {
  if (rawOrientation.length < 2) {
    throw new Error("至少需要两个姿态样本才能计算播放倍率。");
  }
  const orientation = removeSubDurationFeatures(
    rawOrientation,
    options.featureMinimumDurationSeconds,
  );

  // 前缀和记录实际走过的旋转路径。窗口的净转角由端点四元数 O(1)
  // 求得，路径长由前缀和 O(1) 求得；二者的比值用来拒绝点头后回正的整体窗口。
  const pathPrefix = [0];
  for (let index = 1; index < orientation.length; index += 1) {
    pathPrefix.push(
      pathPrefix[index - 1] + quaternionAngle(orientation[index - 1], orientation[index]),
    );
  }

  const samples: PlaybackRateSample[] = [];
  for (let time = 0; time < durationSeconds; time += options.sampleIntervalSeconds) {
    samples.push({
      timeSeconds: time,
      rate: options.maximumRate,
      angularSpeedDegreesPerSecond: 0,
      rotationAmplitudeDegrees: 0,
    });
  }

  const windows = [...options.analysisWindowSeconds].sort((left, right) => right - left);
  for (const windowSeconds of windows) {
    const minimumAverageSpeed = options.minimumAverageAngularSpeedAtOneSecond /
      Math.pow(windowSeconds, options.shortWindowThresholdPower);
    for (
      let startTime = 0;
      startTime + windowSeconds <= durationSeconds;
      startTime += options.sampleIntervalSeconds
    ) {
      const startIndex = lowerBoundTime(orientation, startTime);
      const endIndex = lowerBoundTime(orientation, startTime + windowSeconds);
      if (endIndex <= startIndex) continue;
      const elapsed = orientation[endIndex].timeSeconds - orientation[startIndex].timeSeconds;
      if (elapsed <= 0) continue;
      const netRotation = quaternionAngle(orientation[startIndex], orientation[endIndex]);
      const pathRotation = pathPrefix[endIndex] - pathPrefix[startIndex];
      const coherence = pathRotation > 0 ? netRotation / pathRotation : 0;
      const averageSpeed = netRotation / elapsed;
      if (
        netRotation < options.minimumRotationDegrees ||
        averageSpeed < minimumAverageSpeed ||
        coherence < options.minimumDirectionCoherence
      ) continue;

      const expectedRate = rateForAngularSpeed(averageSpeed, options);
      const firstSample = Math.max(0, Math.floor(startTime / options.sampleIntervalSeconds));
      const lastSample = Math.min(
        samples.length - 1,
        Math.ceil((startTime + windowSeconds) / options.sampleIntervalSeconds),
      );
      for (let sampleIndex = firstSample; sampleIndex <= lastSample; sampleIndex += 1) {
        // 长窗口先建立整段期望；后续短窗口只能以更低倍率覆盖。
        if (expectedRate <= samples[sampleIndex].rate) {
          samples[sampleIndex] = {
            ...samples[sampleIndex],
            rate: expectedRate,
            angularSpeedDegreesPerSecond: averageSpeed,
            rotationAmplitudeDegrees: netRotation,
          };
        }
      }
    }
  }

  return {
    id: "playback-rate",
    name: "播放倍率",
    timeBase: "source",
    samples: prioritizeLowerRates(samples, options),
  };
};
