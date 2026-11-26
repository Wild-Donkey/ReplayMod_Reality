export type TrajectoryBackend = "typescript" | "native" | "automatic";
export type TrajectoryBackendConfig = { readonly mode: TrajectoryBackend; readonly executable: string };

export function trajectoryBackendMode(setting: string | undefined, platform: NodeJS.Platform, arch: string): TrajectoryBackend {
  if (setting === "1") return "native";
  if (setting !== "0" && platform === "darwin" && arch === "arm64") return "automatic";
  return "typescript";
}

export function shouldFitNatively(mode: TrajectoryBackend, duration: number, sampleRate: number, attitudeSamples: number): boolean {
  if (mode !== "automatic") return mode === "native";
  if (!Number.isFinite(duration) || duration <= 0 || duration > 49_992) return false;
  const rate = Math.max(1, Math.min(60, Math.round(sampleRate)));
  const outputSamples = Math.ceil(duration * rate);
  // Keep short jobs and previews away from process startup overhead. At high
  // rates the work scales with both the output count and the attitude payload.
  return rate >= 10 && outputSamples >= 18_000 &&
    (attitudeSamples === 0 || (rate >= 30 && attitudeSamples <= outputSamples * 1.4));
}

export const trajectoryCacheNamespace: Record<TrajectoryBackend, string> = {
  typescript: "motion-gps-packed-v1:",
  native: "motion-gps-native-v2:",
  automatic: "motion-gps-auto-v1:",
};
