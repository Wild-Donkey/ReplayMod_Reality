import type { ReplayMetricViewId } from "../MetricSeries";
import type { Layer } from "@deck.gl/core";
import { ReplayLayerRegistry } from "../LayerRegistry";
import { buildFootprintDensityLayer } from "../layers/FootprintDensityLayer";
import { buildPhotoPointLayer } from "../layers/PhotoPointLayer";
import { buildTimelineDensityLayer } from "../layers/TimelineDensityLayer";
import { buildSynchronizedPointLayer } from "../layers/SynchronizedPointLayer";
import { buildTrajectoryPickingLayer } from "../layers/TrajectoryLayer";
import { buildMetricPickingLayer, buildMetricVisualLayers } from "../layers/MetricLineLayer";
import { buildAnnotationHandleLayer, buildAnnotationPickingLayer, buildAnnotationVisualLayer, buildAnnotationRouteVisualLayer } from "../layers/AnnotationLayer";

export function createDeckLayerRegistry(options: {annotations?: boolean; annotationPoints?: boolean; annotationHandles?: boolean; photos?: boolean; footprint?: boolean; metrics?: boolean | readonly ReplayMetricViewId[]; picking?: boolean} = {}) {
  const registry = new ReplayLayerRegistry<Layer>();
  if (options.picking !== false) {
  registry.register({id:"trajectory-picking", views:["map"], order:100, visibilityGroup:"trajectory", build:buildTrajectoryPickingLayer});
  registry.register({id:"annotation-picking", views:["map"], order:200, visibilityGroup:"annotations", build:buildAnnotationPickingLayer});
  registry.register({id:"timeline-metric-picking", views:["timeline"], order:300, visibilityGroup:"trajectory", build:buildMetricPickingLayer("timeline")});
  registry.register({id:"elevation-metric-picking", views:["elevation"], order:300, visibilityGroup:"annotations", build:buildMetricPickingLayer("elevation")});
  }
  if (options.footprint) registry.register({id:"footprint-visual", views:["map"], order:340, visibilityGroup:"trajectory", build:buildFootprintDensityLayer});
  if (options.photos) registry.register({id:"photo-visual", views:["map"], order:350, visibilityGroup:"trajectory", build:buildPhotoPointLayer});
  if (options.annotations) registry.register({id:"annotation-visual", views:["map"], order:400, visibilityGroup:"annotations", build:options.annotationPoints === false ? buildAnnotationRouteVisualLayer : buildAnnotationVisualLayer});
  if (options.annotationHandles) registry.register({id:"annotation-handles", views:["map"], order:950, visibilityGroup:"annotations", build:buildAnnotationHandleLayer});
  if (options.metrics === true || Array.isArray(options.metrics) && options.metrics.includes("timeline")) {
    registry.register({id:"timeline-density", views:["timeline-density"], order:500, build:buildTimelineDensityLayer});
    registry.register({id:"timeline-metric-visual", views:["timeline"], order:500, build:buildMetricVisualLayers("timeline")});
  }
  if (options.metrics === true || Array.isArray(options.metrics) && options.metrics.includes("elevation")) {
    registry.register({id:"elevation-metric-visual", views:["elevation"], order:500, visibilityGroup:"annotations", build:buildMetricVisualLayers("elevation")});
  }
  registry.register({id:"synchronized-point", views:["map"], order:1000, build:buildSynchronizedPointLayer});
  return registry;
}
