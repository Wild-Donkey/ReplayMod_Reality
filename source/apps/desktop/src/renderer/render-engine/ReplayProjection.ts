import type { ReplayViewId } from "./ReplayScene";
export interface ReplayScreenPoint {readonly x: number; readonly y: number}
export type ReplayProjector = (coordinate: readonly number[]) => ReplayScreenPoint | null;
export type ReplayProjectionProvider = (view: ReplayViewId) => ReplayProjector | null | undefined;

// A projector is a coherent viewport snapshot. Callers can project a whole
// label batch without repeatedly measuring DOM origins or looking up views.
export class ReplayProjection {
  private provider: ReplayProjectionProvider | null = null;
  private owner: object | null = null;
  private readonly listeners = new Set<() => void>();
  attach(provider: ReplayProjectionProvider) {
    const owner = {}; this.owner = owner; this.provider = provider; this.invalidate();
    return () => { if (this.owner === owner) { this.owner = null; this.provider = null; this.invalidate(); } };
  }
  forView(view: ReplayViewId): ReplayProjector | null | undefined {
    const projector = this.provider?.(view);
    if (!projector) return projector;
    return coordinate => {
      if (!Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1])) return null;
      const point = projector(coordinate);
      return point && Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
    };
  }
  subscribe(notify: () => void) { this.listeners.add(notify); return () => { this.listeners.delete(notify); }; }
  invalidate() { for (const notify of this.listeners) notify(); }
}
