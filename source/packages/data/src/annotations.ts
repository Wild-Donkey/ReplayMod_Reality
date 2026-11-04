/** Annotation coordinates use GeoJSON order: WGS84 longitude and latitude. */
export type MapCoordinate = [number, number];
interface AnnotationNodeBase {
  id: string;
  parentId: string | null;
  name: string;
  description: string;
  visible: boolean;
  open: boolean;
  coordinates: MapCoordinate[];
}
export interface AnnotationFolderNode extends AnnotationNodeBase { kind: "folder"; color?: never; }
export interface AnnotationFeatureNode extends AnnotationNodeBase { kind: "point" | "route"; color: string; }
export type AnnotationNode = AnnotationFolderNode | AnnotationFeatureNode;
export interface AnnotationProject {
  format: "replaymod.annotations";
  version: 1;
  name: string;
  nodes: AnnotationNode[];
}
