export interface DisplayHDRInfo {
  displayId: number;
  label: string;
  colorDepth: number;
  depthPerComponent: number;
  colorSpace: string;
  // Linear multipliers relative to SDR white, not photographic stops or nits.
  currentHeadroom: number | null;
  potentialHeadroom: number | null;
  referenceHeadroom: number | null;
  hdrActive?: boolean;
  source: "macos-nsscreen" | "windows-dxgi" | "unavailable";
}

export function displayHeadroom(info: DisplayHDRInfo | null): number {
  const value = info?.currentHeadroom;
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? value : 1;
}
