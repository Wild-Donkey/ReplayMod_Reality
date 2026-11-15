export const TRANSIT_TILE_ORIGIN = "https://loom.cs.uni-freiburg.de";
export const TRANSIT_NETWORKS = ["subway-lightrail", "tram", "rail-commuter"] as const;
export const TRANSIT_MIN_ZOOM = 6;
// The public service publishes the geographic tiles through z17. MapLibre
// reuses those tiles when zooming in further.
export const TRANSIT_MAX_ZOOM = 17;

export function isTransitTileUrl(url: URL): boolean {
  if (url.origin !== TRANSIT_TILE_ORIGIN || url.username || url.password || url.search || url.hash) return false;
  const match = /^\/tiles\/([^/]+)\/geo\/(\d{1,2})\/(0|[1-9]\d{0,5})\/(0|[1-9]\d{0,5})\.mvt$/.exec(url.pathname);
  if (!match || !TRANSIT_NETWORKS.some(network => network === match[1])) return false;
  const [zoom, x, y] = match.slice(2).map(Number);
  return zoom >= TRANSIT_MIN_ZOOM && zoom <= TRANSIT_MAX_ZOOM && x < 2 ** zoom && y < 2 ** zoom;
}
