export type MapLanguage = "auto" | "local" | "zh" | "en";

export interface AppSettings {
  maptilerApiKey: string;
  mapLanguage: MapLanguage;
  buildingCacheLimitMB: number;
}
