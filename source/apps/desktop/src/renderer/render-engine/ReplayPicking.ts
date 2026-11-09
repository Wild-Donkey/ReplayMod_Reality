import type { ReplayViewId } from "./ReplayScene";

export type ReplayPickKind = "trajectory" | "annotation" | "metric";

export interface ReplayPickQuery {
  /** Client coordinates in CSS pixels; hosts convert to their canvas origin. */
  readonly x: number;
  readonly y: number;
  readonly viewId: ReplayViewId;
  readonly radius?: number;
  readonly target?: ReplayPickKind;
}

export interface ReplayPickResult {
  readonly viewId: ReplayViewId;
  readonly objectId: string;
  readonly kind: ReplayPickKind;
  readonly annotationId?: string;
  readonly seriesId?: string;
  readonly sampleIndex?: number;
  readonly object: unknown;
  readonly index: number;
  readonly trajectoryIndex: number | null;
  readonly timestamp: number | null;
  readonly distance: number | null;
  readonly coordinate?: number[];
}

export type ReplayPicker = (query: ReplayPickQuery) => ReplayPickResult | null;

// A missing renderer is distinct from a completed query with no hit. This lets
// hosts retain their verified fallback while a replacement GPU device starts.
export class ReplayPicking {
  private picker: ReplayPicker | null = null;
  private owner: object | null = null;

  attach(picker: ReplayPicker) {
    const owner = {};
    this.owner = owner;
    this.picker = picker;
    return () => { if (this.owner === owner) { this.picker = null; this.owner = null; } };
  }

  pick(query: ReplayPickQuery): ReplayPickResult | null | undefined {
    if (!Number.isFinite(query.x) || !Number.isFinite(query.y) || !Number.isFinite(query.radius ?? 0) || (query.radius ?? 0) < 0) return null;
    return this.picker ? this.picker(query) : undefined;
  }
}
