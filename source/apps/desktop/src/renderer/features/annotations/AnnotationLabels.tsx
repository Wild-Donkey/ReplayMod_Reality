import { useEffect, useState } from "react";
import maplibregl from "maplibre-gl";
import type { AnnotationNode } from "../../../../../../packages/data/src";
import { layoutAnnotationLabels, pointLabelText, type LabelGroup } from "./annotation-label-layout";

interface Props {
  map: maplibregl.Map;
  points: AnnotationNode[];
  selectedId: string | null;
  drawing: boolean;
  onSelect: (id: string) => void;
}
const FONT = '400 11px "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
export function AnnotationLabels({map, points, selectedId, drawing, onSelect}: Props) {
  const [groups, setGroups] = useState<LabelGroup[]>([]);
  useEffect(() => {
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return;
    context.font = FONT;
    let frame: number | null = null;
    const update = () => {
      frame = null;
      const width = map.getContainer().clientWidth;
      const height = map.getContainer().clientHeight;
      const center = map.getCenter().lng;
      const projected = points.map(node => {
        const coordinate = node.coordinates[0];
        const lng = coordinate[0] + Math.round((center - coordinate[0]) / 360) * 360;
        const point = map.project([lng, coordinate[1]]);
        return {id: node.id, name: node.name, x: point.x, y: point.y};
      }).filter(point => point.x >= -250 && point.x <= width + 250 && point.y >= -20 && point.y <= height + 20);
      setGroups(layoutAnnotationLabels(projected, text => context.measureText(text).width));
    };
    const schedule = () => { if (frame === null) frame = requestAnimationFrame(update); };
    update();
    map.on("move", schedule); map.on("resize", schedule);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      map.off("move", schedule); map.off("resize", schedule);
    };
  }, [map, points]);
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
      if (!single) return <div key={key} className="annotation-map-group" role="group"
        aria-label={`${group.items.length} 个重叠地点`}
        style={{left: group.left, top: group.top, width: group.width, height: group.bottom - group.top}}
      >
        <i className="annotation-centroid-dot" style={{top: group.y - group.top - 2}} title={`${group.items.length} 个地点的重心`}/>
        <div className="annotation-place-list">
          {group.items.map(item => <button type="button" key={item.id}
            className={item.id === selectedId ? "selected" : ""}
            aria-label={`地标 ${item.name}`} title={item.name}
            onClick={event => { event.stopPropagation(); onSelect(item.id); }}
          >{item.name}</button>)}
        </div>
      </div>;
      return <button type="button" key={key}
        className={`annotation-map-label place ${node.id === selectedId ? "selected" : ""}`}
        style={{left: group.left, top: group.top, width: group.width}}
        title={node.name} aria-label={`地标 ${node.name}`}
        onClick={event => { event.stopPropagation(); onSelect(node.id); }}
      ><i style={{backgroundColor: node.style.color, opacity: node.style.opacity}}/>{pointLabelText(group.items[0])}</button>;
    })}
  </div>;
}
