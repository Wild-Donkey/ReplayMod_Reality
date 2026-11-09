import type { Deck, PickingInfo } from "@deck.gl/core";
import type { ReplaySceneSnapshot } from "./ReplayScene";
import type { ReplayPickQuery, ReplayPickResult } from "./ReplayPicking";
import { metricSegments, metricXAt, type ReplayMetricViewId } from "./MetricSeries";
import { isCurrentAnnotationFeature } from "./layers/AnnotationLayer";
export type { ReplayPickResult } from "./ReplayPicking";

export class PickingController {
  constructor(private readonly deck: Deck<any>, private readonly snapshot: () => ReplaySceneSnapshot) {}

  pick(query: ReplayPickQuery): ReplayPickResult | null {
    if (!this.deck.isInitialized) return null;
    const scene = this.snapshot();
    if (query.viewId === "timeline-density") return null;
    if (query.viewId !== "map") return this.pickMetric(query, scene);
    if (query.target === "metric") return null;
    const layerIds: string[] = [];
    if (scene.visibility.trajectory && query.target !== "annotation") layerIds.push("map/trajectory-picking");
    if (scene.visibility.annotations && query.target !== "trajectory") layerIds.push("map/annotation-picking");
    if (!layerIds.length) return null;
    const info = this.deck.pickObject({x: query.x, y: query.y, radius: query.radius ?? 12, layerIds}) as PickingInfo | null;
    if (!info?.picked || info.viewport?.id !== query.viewId || !Number.isInteger(info.index) || info.index < 0) return null;
    if (info.layer?.id.startsWith("map/annotation-picking")) {
      if (!scene.visibility.annotations || query.target === "trajectory" || !isCurrentAnnotationFeature(scene.annotationGeometry, info.object)) return null;
      const feature = info.object;
      const annotationId = String(feature.properties?.id ?? feature.id ?? "");
      if (!annotationId || annotationId === "draft") return null;
      return {viewId: query.viewId, objectId: `annotation/${annotationId}`, kind: "annotation", annotationId, object: feature, index: info.index, trajectoryIndex: null, timestamp: null, distance: null, coordinate: info.coordinate};
    }
    const trajectory = scene.trajectory;
    if (!info.layer?.id.startsWith("map/trajectory-picking") || !trajectory || !scene.visibility.trajectory || query.target === "annotation" || info.index >= trajectory.length) return null;
    // Deck processes new layer props on its own frame. Never decode a hit
    // from the previous dataset against the replacement trajectory buffer.
    const data = info.layer?.props.data as {attributes?: {getPosition?: {value?: unknown}}} | undefined;
    if (data?.attributes?.getPosition?.value !== trajectory.positions) return null;
    const index = info.index;
    return {
      viewId: query.viewId, objectId: `trajectory/${index}`, kind: "trajectory", object: info.object, index, trajectoryIndex: index,
      timestamp: trajectory.timestamps[index], distance: trajectory.distances[index],
      coordinate: [trajectory.positions[index * 2], trajectory.positions[index * 2 + 1]],
    };
  }
  private pickMetric(query: ReplayPickQuery, scene: ReplaySceneSnapshot): ReplayPickResult | null {
    if (query.target && query.target !== "metric") return null;
    const viewId = query.viewId as ReplayMetricViewId;
    const series = scene.metricSeries[viewId];
    const group = viewId === "timeline" ? "trajectory" : "annotations";
    // Flight interpolation changes geometry while retaining the same time axis.
    if (!series || !scene.visibility[group] || (series.sourceTrajectory && series.sourceTrajectory.timestamps !== scene.trajectory?.timestamps)) return null;
    const data = metricSegments(series), layerId = `${viewId}/metric-picking/${series.id}`;
    const info = this.deck.pickObject({x: query.x, y: query.y, radius: query.radius ?? 5, layerIds: [layerId]}) as PickingInfo | null;
    if (!info?.picked || info.viewport?.id !== viewId || info.layer?.id !== layerId || !Number.isInteger(info.index) || info.index < 0 || info.index >= data.length || !Number.isFinite(info.coordinate?.[0])) return null;
    const rendered = info.layer.props.data as {attributes?: {getSourcePosition?: {value?: unknown}}} | undefined;
    if (rendered?.attributes?.getSourcePosition?.value !== data.positions) return null;
    const left = data.sampleIndices[info.index], right = left + 1;
    const x = Math.max(series.x[left], Math.min(series.x[right], metricXAt(series, info.coordinate![0])));
    const sampleIndex = x - series.x[left] <= series.x[right] - x ? left : right;
    const sample = series.space === "timeline" ? scene.trajectory?.sample(x) : null;
    const coordinate = series.coordinates ? Array.from(series.coordinates.subarray(sampleIndex * 2, sampleIndex * 2 + 2)) : sample?.position;
    return {viewId, kind: "metric", objectId: `metric/${series.id}/${sampleIndex}`, seriesId: series.id, sampleIndex, object: {seriesId: series.id, sampleIndex}, index: info.index, timestamp: series.space === "timeline" ? x : null, distance: series.space === "distanceProfile" ? series.x[sampleIndex] : sample && scene.trajectory ? scene.trajectory.distances[sample.index] : null, trajectoryIndex: sample?.index ?? null, coordinate};
  }

}
