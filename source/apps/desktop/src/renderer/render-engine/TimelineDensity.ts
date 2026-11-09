export interface DensityBins {
  readonly counts: Uint32Array;
  readonly peak: number;
}

export interface TimelineDensity {
  readonly footprint: DensityBins;
  readonly photo: DensityBins;
}

const colors = {footprint: [185, 245, 197], photo: [255, 227, 110]} as const;

export function densityBinColor(count: number, peak: number, kind: keyof TimelineDensity) {
  const intensity = peak > 0 ? Math.log1p(count) / Math.log1p(peak) : 0;
  return colors[kind].map(channel => Math.round(intensity <= 0.5
    ? channel * intensity * 2
    : channel + (255 - channel) * (intensity * 2 - 1)));
}

const buffers = new WeakMap<TimelineDensity, ReturnType<typeof compileDensity>>();
export function timelineDensityBuffer(density: TimelineDensity) {
  const cached = buffers.get(density);
  if (cached) return cached;
  const data = compileDensity(density);
  buffers.set(density, data);
  return data;
}

function compileDensity(density: TimelineDensity) {
  const length = density.footprint.counts.length + density.photo.counts.length;
  const positions = new Float32Array(length * 12);
  const colors = new Uint8Array(length * 16);
  const indices = new Uint32Array(length * 6);
  const startIndices = Uint32Array.from({length: length + 1}, (_, index) => index * 4);
  let index = 0;
  for (const [row, kind] of (["footprint", "photo"] as const).entries()) {
    const {counts, peak} = density[kind];
    const top = row / 2, bottom = top + 0.5;
    for (let bin = 0; bin < counts.length; bin++, index++) {
      const left = bin / counts.length, right = (bin + 1) / counts.length;
      const vertex = index * 4;
      positions.set([left, top, 0, right, top, 0, right, bottom, 0, left, bottom, 0], vertex * 3);
      indices.set([vertex, vertex + 1, vertex + 2, vertex, vertex + 2, vertex + 3], index * 6);
      const [r, g, b] = densityBinColor(counts[bin], peak, kind);
      for (let corner = 0; corner < 4; corner++) colors.set([r, g, b, 255], (vertex + corner) * 4);
    }
  }
  return {length, startIndices, attributes: {
    getPolygon: {value: positions, size: 3},
    getFillColor: {value: colors, size: 4, normalized: true},
    indices: {value: indices, size: 1},
  }};
}
