// Screen-space level-of-detail policy for the footprint density layer.
//
// Three levels, chosen by how far apart consecutive track samples land on
// screen:
//   "line"    - zoomed in, samples separate: smoothed mitered ribbon.
//   "points"  - every raw sample drawn as a point sprite.
//   "coarse"  - zoomed out, raw samples pile onto the same pixels and a single
//               traversal would stack into fake density. Samples are greedily
//               thinned against the last kept anchor: a sample is dropped only
//               when BOTH its time gap and its distance from the anchor are
//               small. A long time gap is always kept, so returning to the same
//               place on another day still accumulates density.

export type FootprintLod = "line" | "points" | "coarse";

// Tracks split at long recording gaps; shared by route smoothing, the coarse
// thinning anchor walk and the spacing measurement.
import { FOOTPRINT_BREAK_DURATION } from "../../render-engine/FootprintGeometry";
export { FOOTPRINT_BREAK_DURATION };
// Within this gap, nearby samples count as the same traversal and may merge.
export const FOOTPRINT_LOD_TIME_GAP_MS = 30_000;

// LOD band edges in CSS pixels, expressed relative to the point sprite diameter
// at the current zoom (2 * footprintRadius): once anchored samples separate by
// a full diameter the sprites no longer touch, so the route ribbon takes over;
// below ~0.45 diameter the sprites stack several samples deep and the coarse
// thinning kicks in. Fixed pixel thresholds drifted with the zoom-interpolated
// sprite size and could strand dense, slow tracks as tiny dots when zoomed in.
export function footprintLodBandPoints(pointDiameterPx: number) {
  return {
    lineEnter: pointDiameterPx,
    lineExit: 0.7 * pointDiameterPx,
    coarseEnter: 0.45 * pointDiameterPx,
    coarseExit: 0.6 * pointDiameterPx,
  };
}

// Coarse anchors keep sprites just touching at the current zoom, with a floor
// so far-zoom sprites never collapse below a pixel.
export function footprintCoarseTargetPx(pointDiameterPx: number) {
  return Math.max(1.2, pointDiameterPx * 0.75);
}

const WORLD_PIXEL_ZOOM_0 = 512;
const EARTH_CIRCUMFERENCE = 40_075_016.686;

// Web Mercator metres per screen pixel at the given latitude and zoom.
export function footprintMetersPerPixel(zoom: number, latitude: number) {
  const cosine = Math.max(0.1, Math.cos((latitude * Math.PI) / 180));
  return (
    (EARTH_CIRCUMFERENCE * cosine) /
    (WORLD_PIXEL_ZOOM_0 * Math.pow(2, zoom))
  );
}

// Equirectangular great-circle approximation, accurate at the viewport scales
// used for LOD decisions.
function distanceMeters(
  lng1: number,
  lat1: number,
  lng2: number,
  lat2: number,
) {
  const meanLatitude = (((lat1 + lat2) / 2) * Math.PI) / 180;
  const dx =
    ((((lng2 - lng1 + 540) % 360) - 180) / 360) *
    EARTH_CIRCUMFERENCE *
    Math.cos(meanLatitude);
  const dy = ((lat2 - lat1) / 360) * EARTH_CIRCUMFERENCE;
  return Math.hypot(dx, dy);
}

// Walks the track in timestamp order, invoking the callback for every anchor
// (kept sample). A sample becomes an anchor when it starts a new recording
// segment, when the time since the last anchor exceeds the gap, or when it has
// moved beyond minMeters from the last anchor.
function forEachAnchor(
  coordinates: readonly number[],
  timestamps: readonly number[],
  minMeters: number,
  maxTimeGapMs: number,
  callback: (index: number, previousIndex: number) => void,
) {
  const count = Math.min(
    timestamps.length,
    Math.floor(coordinates.length / 2),
  );
  if (count === 0) return;
  callback(0, -1);
  let anchor = 0;
  for (let index = 1; index < count; index += 1) {
    const sinceAnchor = timestamps[index] - timestamps[anchor];
    const sincePrevious = timestamps[index] - timestamps[index - 1];
    let keep =
      sincePrevious > FOOTPRINT_BREAK_DURATION ||
      sinceAnchor > maxTimeGapMs;
    if (!keep) {
      keep =
        distanceMeters(
          coordinates[anchor * 2],
          coordinates[anchor * 2 + 1],
          coordinates[index * 2],
          coordinates[index * 2 + 1],
        ) > minMeters;
    }
    if (keep) {
      callback(index, anchor);
      anchor = index;
    }
  }
}

// Flat [lng, lat, ...] coordinates kept for the coarse LOD. Ownership of the
// returned array stays with the caller; it only feeds a GPU buffer upload.
export function decimateFootprintCoordinates(
  coordinates: readonly number[],
  timestamps: readonly number[],
  minMeters: number,
  maxTimeGapMs: number = FOOTPRINT_LOD_TIME_GAP_MS,
): number[] {
  const result: number[] = [];
  forEachAnchor(
    coordinates,
    timestamps,
    minMeters,
    maxTimeGapMs,
    index => {
      result.push(coordinates[index * 2], coordinates[index * 2 + 1]);
    },
  );
  return result;
}

export interface FootprintViewBounds {
  west: number;
  east: number;
  south: number;
  north: number;
}

// Median on-screen distance between successive anchors whose both ends lie in
// the viewport. Merging sub-pixel / short-gap samples first prevents dense
// dwell stacks and high-rate GPS traces from reading as "points overlap",
// while long-gap revisits remain separate anchors. Null when no anchored pair
// is fully visible (the caller keeps the current LOD).
export function medianAnchoredScreenSpacing(
  coordinates: readonly number[],
  timestamps: readonly number[],
  zoom: number,
  centerLatitude: number,
  bounds: FootprintViewBounds,
): number | null {
  const worldPixels = WORLD_PIXEL_ZOOM_0 * Math.pow(2, zoom);
  const cosine = Math.max(0.1, Math.cos((centerLatitude * Math.PI) / 180));
  const onePixelMeters = footprintMetersPerPixel(zoom, centerLatitude);
  const distances: number[] = [];
  const east = bounds.east < bounds.west ? bounds.east + 360 : bounds.east;
  const containsLongitude = (longitude: number) => {
    if (east - bounds.west >= 360) return true;
    const wrapped = bounds.west + ((longitude - bounds.west) % 360 + 360) % 360;
    return wrapped <= east;
  };
  forEachAnchor(
    coordinates,
    timestamps,
    onePixelMeters,
    FOOTPRINT_LOD_TIME_GAP_MS,
    (index, previous) => {
      if (previous < 0) return;
      const lng1 = coordinates[previous * 2];
      const lat1 = coordinates[previous * 2 + 1];
      const lng2 = coordinates[index * 2];
      const lat2 = coordinates[index * 2 + 1];
      if (
        !containsLongitude(lng1) ||
        !containsLongitude(lng2) ||
        lat1 < bounds.south ||
        lat1 > bounds.north ||
        lat2 < bounds.south ||
        lat2 > bounds.north
      ) {
        return;
      }
      const px = ((((lng2 - lng1 + 540) % 360) - 180) / 360) * worldPixels;
      const py = ((lat2 - lat1) / 360) * worldPixels / cosine;
      distances.push(Math.hypot(px, py));
    },
  );
  if (distances.length === 0) return null;
  distances.sort((a, b) => a - b);
  const middle = Math.floor(distances.length / 2);
  return distances.length % 2
    ? distances[middle]
    : (distances[middle - 1] + distances[middle]) / 2;
}

// Three-state hysteresis driven by the anchored spacing. pointDiameterPx is
// the on-screen sprite diameter (2 * footprintRadius) at the current zoom.
// Null spacing (no visible pair) keeps the current level.
export function selectFootprintLod(
  current: FootprintLod,
  medianSpacingPx: number | null,
  pointDiameterPx: number,
): FootprintLod {
  if (medianSpacingPx === null) return current;
  const {lineEnter, lineExit, coarseEnter, coarseExit} =
    footprintLodBandPoints(pointDiameterPx);
  // Strong signals may jump across a level (e.g. a direct zoom from world view
  // to street level); the exit-side thresholds only provide gradual hysteresis
  // inside the middle band.
  if (medianSpacingPx >= lineEnter) return "line";
  if (medianSpacingPx <= coarseEnter) return "coarse";
  if (current === "line") {
    return medianSpacingPx <= lineExit ? "points" : "line";
  }
  if (current === "coarse") {
    return medianSpacingPx >= coarseExit ? "points" : "coarse";
  }
  return "points";
}
