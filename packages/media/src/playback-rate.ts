import type {
  OrientationSample,
  PlaybackRateOptions,
  PlaybackRateSample,
  TimelineMetadataTrack,
} from "./types";

export const defaultPlaybackRateOptions: PlaybackRateOptions = {
  minimumRate: 1,
  maximumRate: 8,
  angularSpeedPivot: 18,
  curvePower: 2.4,
  windowSeconds: 1,
  sampleIntervalSeconds: 0.5,
  stableAngularSpeedThreshold: 16,
  fullRotationAngularSpeedThreshold: 30,
  stableHoldSeconds: 4,
  transientMaximumRate: 1.5,
  speedUpTimeSeconds: 2,
  slowDownTimeSeconds: 0.1,
};

const quaternionAngularSpeed = (
  left: OrientationSample,
  right: OrientationSample,
): number => {
  const elapsed = right.timeSeconds - left.timeSeconds;
  if (elapsed <= 0) return 0;
  let dot = left.quaternion.reduce(
    (sum, value, index) => sum + value * right.quaternion[index],
    0,
  );
  dot = Math.min(1, Math.max(-1, Math.abs(dot)));
  return (2 * Math.acos(dot) * 180) / Math.PI / elapsed;
};

const smoothRates = (
  samples: PlaybackRateSample[],
  speedUpTimeSeconds: number,
  slowDownTimeSeconds: number,
) => {
  if (samples.length < 2) return samples;
  const interval = samples[1].timeSeconds - samples[0].timeSeconds;
  const forward = samples.map((sample) => ({ ...sample }));
  for (let index = 1; index < forward.length; index += 1) {
    const isSpeedingUp = forward[index].rate > forward[index - 1].rate;
    const timeConstant = isSpeedingUp ? speedUpTimeSeconds : slowDownTimeSeconds;
    const alpha = timeConstant <= 0 ? 1 : 1 - Math.exp(-interval / timeConstant);
    forward[index] = {
      ...forward[index],
      rate: forward[index - 1].rate + alpha * (forward[index].rate - forward[index - 1].rate),
    };
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
  const samples: PlaybackRateSample[] = [];
  let stableDuration = 0;

  for (let time = 0; time < durationSeconds; time += options.sampleIntervalSeconds) {
    const values = angularSpeeds
      .filter((sample) => Math.abs(sample.timeSeconds - time) <= halfWindow)
      .map((sample) => sample.value);
    const rms = values.length
      ? Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length)
      : 0;
    const normalized = Math.pow(rms / options.angularSpeedPivot, options.curvePower);
    const unconstrainedRate = options.minimumRate +
      (options.maximumRate - options.minimumRate) / (1 + normalized);
    stableDuration = rms <= options.stableAngularSpeedThreshold
      ? stableDuration + options.sampleIntervalSeconds
      : 0;
    const sustainedStableSeconds = Math.max(0, stableDuration - options.stableHoldSeconds);
    const stableBlend = 1 - Math.exp(-sustainedStableSeconds / options.speedUpTimeSeconds);
    const transientRate = Math.min(unconstrainedRate, options.transientMaximumRate);
    const rate = rms >= options.fullRotationAngularSpeedThreshold
      ? options.minimumRate
      : transientRate + stableBlend * (unconstrainedRate - transientRate);
    samples.push({
      timeSeconds: time,
      rate,
      angularSpeedDegreesPerSecond: rms,
    });
  }

  return {
    id: "playback-rate",
    name: "播放倍率",
    timeBase: "source",
    samples: smoothRates(
      samples,
      options.speedUpTimeSeconds,
      options.slowDownTimeSeconds,
    ),
  };
};
