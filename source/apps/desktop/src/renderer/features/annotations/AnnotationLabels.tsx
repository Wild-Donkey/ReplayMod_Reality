import { useEffect, useMemo, useState } from "react";
import type maplibregl from "maplibre-gl";
import { layoutAnnotationLabels, pointLabelText, type LabelGroup } from "./annotation-label-layout";

import { annotationLabelPoints } from "../../render-engine/AnnotationGeometry";
import { useReplayAnnotations } from "../../render-engine/useReplayAnnotations";
import type { ReplayScene } from "../../render-engine/ReplayScene";
import { useReplayVisibility } from "../../render-engine/useReplayVisibility";

interface Props {
  scene: ReplayScene;
  map: maplibregl.Map;
  drawing: boolean;
  onSelect: (id: string) => void;
}
const FONT = '400 11px "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
export function AnnotationLabels({scene, map, drawing, onSelect}: Props) {
  const geometry = useReplayAnnotations(scene);
  const points = useMemo(() => annotationLabelPoints(geometry), [geometry]);
  const { annotations: visible } = useReplayVisibility(scene);
  const [groups, setGroups] = useState<LabelGroup[]>([]);
  useEffect(() => {
    if (!visible) { setGroups([]); return; }
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return;
    context.font = FONT;
    let frame: number | null = null;
    const update = () => {
      frame = null;
      const width = map.getContainer().clientWidth;
      const height = map.getContainer().clientHeight;
      const center = map.getCenter().lng;
      const origin = map.getCanvas().getBoundingClientRect(), project = scene.projection.forView("map");
      const projected = points.map(node => {
        const coordinate = node.coordinate;
        const lng = coordinate[0] + Math.round((center - coordinate[0]) / 360) * 360;
        const screen = project?.([lng, coordinate[1]]);
        const point = project === undefined ? map.project([lng, coordinate[1]]) : screen ? {x: screen.x - origin.left, y: screen.y - origin.top} : null;
        return point ? {id: node.id, name: node.name, x: point.x, y: point.y} : null;
      }).filter((point): point is NonNullable<typeof point> => point !== null).filter(point => point.x >= -250 && point.x <= width + 250 && point.y >= -20 && point.y <= height + 20);
      setGroups(layoutAnnotationLabels(projected, text => context.measureText(text).width, width));
    };
    const schedule = () => { if (frame === null) frame = requestAnimationFrame(update); };
    update();
    const unsubscribeProjection = scene.projection.subscribe(schedule);
    map.on("move", schedule); map.on("resize", schedule);
    return () => {
      unsubscribeProjection();
      if (frame !== null) cancelAnimationFrame(frame);
      map.off("move", schedule); map.off("resize", schedule);
    };
  }, [map, points, visible, scene]);
  if (!visible) return null;
  const pointById = new Map(points.map(point => [point.id, point]));
  return <div className={`annotation-label-overlay ${drawing ? "drawing" : ""}`} aria-label="地图地名">
    {groups.map(group => {
      // Props change before the layout effect replaces last frame's groups.
      // Hidden/deleted places must not be dereferenced during that render.
      if (group.items.some(item => !pointById.has(item.id))) return null;
      const single = group.items.length === 1;
      const node = pointById.get(group.items[0].id);
      if (!node) return null;
      const key = group.items.map(item => item.id).sort().join("|");
      if (!single) return <div key={key} className={`annotation-map-group ${group.side}`} role="group"
        aria-label={`${group.items.length} 个重叠地点`}
        style={{left: group.left, top: group.top, width: group.width, height: group.bottom - group.top}}
      >
        <i className="annotation-centroid-dot" style={{top: group.y - group.top - 2, left: group.x - group.left - 2}} title={`${group.items.length} 个地点的重心`}/>
        <div className="annotation-place-list">
          {group.items.slice(0, 3).map((item, index) => <button type="button" key={item.id}
            className={pointById.get(item.id)?.selected ? "selected" : ""}
            aria-label={`地标 ${item.name}`} title={item.name}
            onClick={event => { event.stopPropagation(); onSelect(item.id); }}
          ><span>{item.name}</span>{index === 2 && group.items.length > 3 && <b className="annotation-more" title={group.items.slice(3).map(item => item.name).join("、")}>+{group.items.length - 3}</b>}</button>)}
        </div>
      </div>;
      return <button type="button" key={key}
        className={`annotation-map-label place ${group.side} ${node.selected ? "selected" : ""}`}
        style={{left: group.left, top: group.top, width: group.width}}
        title={node.name} aria-label={`地标 ${node.name}`}
        onClick={event => { event.stopPropagation(); onSelect(node.id); }}
      ><i style={{backgroundColor: node.color??"#55cfff"}}/>{pointLabelText(group.items[0])}</button>;
    })}
  </div>;
}
