import type { ReplayCamera } from "./ReplayCamera";
import { ReplayClock } from "./ReplayClock";
import type { TrajectoryBuffer } from "./buffers/TrajectoryBuffer";
import { sameReplayCursor, type ReplayCursor, type ReplayCursorSource } from "./ReplayCursor";
import { defaultLayerVisibility, type LayerVisibility } from "./LayerVisibility";
import type { FeatureCollection, Geometry } from "geojson";
import type { ReplayMetricSeries, ReplayMetricViewId } from "./MetricSeries";
import { ReplayProjection } from "./ReplayProjection";
import { VisualOwnership } from "./VisualOwnership";
import { ReplayPicking } from "./ReplayPicking";

import type { FootprintDensityData } from "./FootprintDensityPass";
import type { PhotoPoints } from "./PhotoPoints";
import type { TimelineDensity } from "./TimelineDensity";

export type ReplayViewId = "map" | "timeline" | "elevation" | "timeline-density";

export interface ReplaySceneSnapshot {
  readonly trajectory: TrajectoryBuffer | null;
  readonly footprint: FootprintDensityData | null;
  readonly photos: PhotoPoints | null;
  readonly timelineDensity: TimelineDensity | null;
  readonly metricSeries: Readonly<Partial<Record<ReplayMetricViewId, ReplayMetricSeries>>>;
  readonly annotationHandles: readonly (readonly [number, number])[];
  readonly annotationGeometry: FeatureCollection<Geometry>;
  readonly mapViewState: ReplayCamera;
  readonly cursor: ReplayCursor | null;
  readonly visibility: Readonly<LayerVisibility>;
  readonly revision: number;
  readonly contentRevision: number;
}

type Listener = (snapshot: ReplaySceneSnapshot) => void;

export class ReplayScene {
  readonly clock = new ReplayClock();
  readonly picking = new ReplayPicking();
  readonly visuals = new VisualOwnership();
  readonly projection = new ReplayProjection();
  private snapshot: ReplaySceneSnapshot = {trajectory: null, footprint: null, photos: null, timelineDensity: null, metricSeries: {}, annotationHandles: [], annotationGeometry:{type:"FeatureCollection",features:[]}, mapViewState:{longitude:0,latitude:0,zoom:0,bearing:0,pitch:0}, cursor:null, visibility:{...defaultLayerVisibility}, revision: 0, contentRevision: 0};
  private readonly listeners = new Set<Listener>();
  private readonly metricOwners = new Map<ReplayMetricViewId, object>();

  get current() { return this.snapshot; }

  registerMetricSeries(viewId: ReplayMetricViewId, series: ReplayMetricSeries) {
    if ((viewId === "timeline") !== (series.space === "timeline")) throw new Error("Metric coordinate space does not match its view");
    const owner = {};
    this.metricOwners.set(viewId, owner);
    if (this.snapshot.metricSeries[viewId] !== series) this.update({...this.snapshot, metricSeries: {...this.snapshot.metricSeries, [viewId]: series}});
    return () => {
      if (this.metricOwners.get(viewId) !== owner) return;
      this.metricOwners.delete(viewId);
      const metricSeries = {...this.snapshot.metricSeries};
      delete metricSeries[viewId];
      this.update({...this.snapshot, metricSeries});
    };
  }

  registerTimelineDensity(timelineDensity: TimelineDensity) {
    this.update({...this.snapshot, timelineDensity});
    return () => {
      if (this.snapshot.timelineDensity === timelineDensity) this.update({...this.snapshot, timelineDensity: null});
    };
  }

  setFootprint(footprint: FootprintDensityData | null) {
    if (this.snapshot.footprint !== footprint) this.update({...this.snapshot, footprint});
  }

  setPhotos(photos: PhotoPoints | null) {
    if (this.snapshot.photos !== photos) this.update({...this.snapshot, photos});
  }

  setAnnotationHandles(annotationHandles: ReplaySceneSnapshot["annotationHandles"]) {
    if (this.snapshot.annotationHandles === annotationHandles || !this.snapshot.annotationHandles.length && !annotationHandles.length) return;
    this.update({...this.snapshot, annotationHandles});
  }

  setAnnotationGeometry(annotationGeometry: FeatureCollection<Geometry>) {
    if (this.snapshot.annotationGeometry === annotationGeometry) return;
    this.update({...this.snapshot, annotationGeometry});
  }

  setVisibility(visibility: LayerVisibility) {
    if ((Object.keys(defaultLayerVisibility) as (keyof LayerVisibility)[]).every(id => this.snapshot.visibility[id] === visibility[id])) return;
    this.update({...this.snapshot, visibility: {...visibility}});
  }

  setTrajectory(trajectory: TrajectoryBuffer | null) {
    if (this.snapshot.trajectory === trajectory) return;
    const timestamp = this.snapshot.cursor?.timestamp ?? null;
    this.update({...this.snapshot, trajectory, cursor: timestamp === null ? this.snapshot.cursor : this.cursorAtTime(this.snapshot.cursor!.source, timestamp, trajectory)});
  }

  setMapViewState(mapViewState: ReplayCamera) {
    if ((Object.keys(mapViewState) as (keyof ReplayCamera)[]).every(key => this.snapshot.mapViewState[key] === mapViewState[key])) return;
    this.update({...this.snapshot, mapViewState}, false);
  }

  setCursor(cursor: ReplayCursor | null) {
    if (sameReplayCursor(this.snapshot.cursor, cursor)) return;
    this.update({...this.snapshot, cursor});
  }

  setCursorTime(source: ReplayCursorSource, timestamp: number | null) {
    this.setCursor(timestamp === null ? null : this.cursorAtTime(source, timestamp, this.snapshot.trajectory));
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  private update(snapshot: ReplaySceneSnapshot, contentChanged = true) {
    this.snapshot = {...snapshot, revision: this.snapshot.revision + 1, contentRevision: this.snapshot.contentRevision + (contentChanged ? 1 : 0)};
    for (const listener of this.listeners) listener(this.snapshot);
  }

  private cursorAtTime(source: ReplayCursorSource, timestamp: number, trajectory: TrajectoryBuffer | null): ReplayCursor {
    const sample = trajectory?.sample(timestamp) ?? null;
    return {source, timestamp, trajectoryIndex: sample?.index ?? null, coordinate: sample?.position ?? null};
  }
}
