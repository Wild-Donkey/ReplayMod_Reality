export type ReplayColor = readonly [number, number, number, number];
export function parseReplayColor(value: string): ReplayColor | null {
  const color = value.trim();
  const hex = color.startsWith("#") ? color.slice(1) : "";
  if (/^(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) {
    const full = hex.length < 5 ? [...hex].map(channel => channel + channel).join("") : hex;
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16), full.length === 8 ? parseInt(full.slice(6, 8), 16) : 255];
  }
  const rgb = /^rgba?\((.*)\)$/i.exec(color);
  if (!rgb) return null;
  const parts = rgb[1].split(/[\s,\/]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;
  const channels = parts.map((part, index) => Number.parseFloat(part) * (part.endsWith("%") ? 255 / 100 : index === 3 ? 255 : 1));
  if (!channels.every(Number.isFinite)) return null;
  return [Math.max(0, Math.min(255, channels[0])), Math.max(0, Math.min(255, channels[1])), Math.max(0, Math.min(255, channels[2])), Math.max(0, Math.min(255, channels[3] ?? 255))];
}
