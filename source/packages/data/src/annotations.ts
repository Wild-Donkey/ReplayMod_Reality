/** Coordinates use KML / GeoJSON order: WGS84 longitude, latitude, optional altitude in metres. */
export type MapCoordinate = [number, number] | [number, number, number];
export interface AnnotationStyle {
  color: string;
  opacity: number;
  width: number;
  iconHref?: string;
}
export interface AnnotationNode {
  id: string;
  parentId: string | null;
  kind: "folder" | "point" | "route";
  name: string;
  description: string;
  visible: boolean;
  open: boolean;
  coordinates: MapCoordinate[];
  altitudeMode: string;
  style: AnnotationStyle;
}
export interface AnnotationProject {
  format: "replaymod.annotations";
  version: 1;
  name: string;
  nodes: AnnotationNode[];
}
