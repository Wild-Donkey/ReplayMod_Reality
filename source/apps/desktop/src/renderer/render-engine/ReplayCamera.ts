// Geographic camera contract shared by carriers, independent of GPU libraries.
export interface ReplayCamera {
  readonly longitude: number;
  readonly latitude: number;
  readonly zoom: number;
  readonly bearing: number;
  readonly pitch: number;
}
