export type IrKind =
  | "raw"
  | "points"
  | "tracks"
  | "project"
  | "viewer"
  | "render"
  | "export";

export interface IrArtifact<TPayload = unknown> {
  readonly kind: IrKind;
  readonly version: number;
  readonly contentHash: string;
  readonly payload: TPayload;
}
