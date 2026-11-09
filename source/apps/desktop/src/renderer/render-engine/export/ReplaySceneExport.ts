import { ReplayScene } from "../ReplayScene";
import { committedAnnotationGeometry } from "../AnnotationGeometry";

// Immutable geometry/buffers are shared; cursor, camera and clock are owned by
// the export so stepping or cancelling it cannot alter interactive playback.
export function createExportScene(source: ReplayScene) {
  const scene = new ReplayScene(), snapshot = source.current;
  scene.setTrajectory(snapshot.trajectory);
  scene.setAnnotationGeometry(committedAnnotationGeometry(snapshot.annotationGeometry));
  scene.setVisibility({...snapshot.visibility});
  scene.setMapViewState({...snapshot.mapViewState});
  for (const viewId of ["timeline", "elevation"] as const) {
    const series = snapshot.metricSeries[viewId];
    if (series) scene.registerMetricSeries(viewId, series);
  }
  return scene;
}
