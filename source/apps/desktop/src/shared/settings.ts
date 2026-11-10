export type MapLanguage = "auto" | "local" | "zh" | "en";

export const DEFAULT_CACHE_LIMIT_MB = 4096;

export interface AppSettings {
  maptilerApiKey: string;
  mapLanguage: MapLanguage;
  cacheLimitMB: number;
  buildingCacheLimitMB: number;
}
