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
  windowSeconds: 0.6,
  ignoredRotationAmplitudeDegrees: 10,
  fullRotationAmplitudeDegrees: 20,
  sampleIntervalSeconds: 0.25,
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

const quaternionAngularSpeed = (
  left: OrientationSample,
  right: OrientationSample,
): number => {
  const elapsed = right.timeSeconds - left.timeSeconds;
  return elapsed > 0 ? quaternionAngle(left, right) / elapsed : 0;
};

const prioritizeLowerRates = (
  samples: PlaybackRateSample[],
  speedUpTimeSeconds: number,
  slowDownLookAheadSeconds: number,
) => {
  if (samples.length < 2) return samples;
  const interval = samples[1].timeSeconds - samples[0].timeSeconds;
  const lookAheadSamples = Math.ceil(slowDownLookAheadSeconds / interval);
  const anticipated = samples.map((sample, index) => ({
    ...sample,
    rate: Math.min(
      ...samples
        .slice(index, index + lookAheadSamples + 1)
        .map((candidate) => candidate.rate),
    ),
  }));
  const forward = anticipated.map((sample) => ({ ...sample }));
  const fullRange = Math.max(0, Math.max(...samples.map((sample) => sample.rate)) - 1);
  const maximumRisePerSample = speedUpTimeSeconds <= 0
    ? Number.POSITIVE_INFINITY
    : fullRange * interval / speedUpTimeSeconds;
  for (let index = 1; index < forward.length; index += 1) {
    forward[index].rate = Math.min(
      forward[index].rate,
      forward[index - 1].rate + maximumRisePerSample,
    );
  }
  return forward;
};

export const buildPlaybackRateTrack = (
  orientation: readonly OrientationSample[],
  durationSeconds: number,
  options: PlaybackRateOptions = defaultPlaybackRateOptions,
): TimelineMetadataTrack<PlaybackRateSample> => {
  if (orientation.length < 2) throw new Error("至少需要两个姿态样本才能计算播放倍率。");
  const angularSpeeds = orientation.slice(1).map((sample, index) => ({
    timeSeconds: sample.timeSeconds,
    value: quaternionAngularSpeed(orientation[index], sample),
  }));
  const halfWindow = options.windowSeconds / 2;
  const metrics: {
    timeSeconds: number;
    rms: number;
    amplitude: number;
    effectiveRms: number;
  }[] = [];

  for (let time = 0; time < durationSeconds; time += options.sampleIntervalSeconds) {
    const values = angularSpeeds
      .filter((sample) => Math.abs(sample.timeSeconds - time) <= halfWindow)
      .map((sample) => sample.value);
    const rms = values.length
      ? Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length)
      : 0;
    const windowOrientation = orientation.filter(
      (sample) => Math.abs(sample.timeSeconds - time) <= halfWindow,
    );
    const reference = windowOrientation[0];
    const amplitude = reference
      ? Math.max(...windowOrientation.map((sample) => quaternionAngle(reference, sample)))
      : 0;
    const amplitudeBlend = Math.min(1, Math.max(0,
      (amplitude - options.ignoredRotationAmplitudeDegrees) /
        (options.fullRotationAmplitudeDegrees - options.ignoredRotationAmplitudeDegrees),
    ));
    const effectiveRms = rms * amplitudeBlend;
    metrics.push({ timeSeconds: time, rms, amplitude, effectiveRms });
  }

  const angularSpeedRange =
    options.angularSpeedForMinimumRate - options.angularSpeedForMaximumRate;
  if (angularSpeedRange <= 0) {
    throw new Error("最低倍率的角速度阈值必须高于最高倍率的阈值。");
  }
  const samples: PlaybackRateSample[] = metrics.map((metric) => {
    const { timeSeconds, amplitude, effectiveRms } = metric;
    const rotationBlend = Math.min(1, Math.max(0,
      (effectiveRms - options.angularSpeedForMaximumRate) / angularSpeedRange,
    ));
    const rate = options.maximumRate -
      rotationBlend * (options.maximumRate - options.minimumRate);
    return {
      timeSeconds,
      rate,
      angularSpeedDegreesPerSecond: effectiveRms,
      rotationAmplitudeDegrees: amplitude,
    };
  });

  return {
    id: "playback-rate",
    name: "播放倍率",
    timeBase: "source",
    samples: prioritizeLowerRates(
      samples,
      options.speedUpTimeSeconds,
      options.slowDownLookAheadSeconds,
    ),
  };
};
