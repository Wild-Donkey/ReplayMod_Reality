import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { DEFAULT_CACHE_LIMIT_MB, type AppSettings } from "../../shared/settings";

const defaultSettings: AppSettings = { maptilerApiKey: "", mapLanguage: "auto", buildingCacheLimitMB: 256, cacheLimitMB: DEFAULT_CACHE_LIMIT_MB };

export class SettingsStore {
  constructor(private readonly file: string) {}

  read(): AppSettings {
    try { return this.validate(JSON.parse(readFileSync(this.file, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultSettings;
      throw new Error("无法读取应用配置，请检查 config.json；原文件未覆盖。", { cause: error });
    }
  }

  save(value: unknown): void {
    const settings = this.validate(value);
    writeFileSync(`${this.file}.tmp`, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }

  validate(value: unknown): AppSettings {
    if (!value || typeof value !== "object" || !("maptilerApiKey" in value) ||
        typeof value.maptilerApiKey !== "string" || value.maptilerApiKey.length > 4096) {
      throw new Error("应用配置格式无效");
    }
    const mapLanguage = "mapLanguage" in value ? value.mapLanguage : "auto";
    if (!["auto", "local", "zh", "en"].includes(mapLanguage as string)) {
      throw new Error("应用配置格式无效");
    }
    const rawLimit = "buildingCacheLimitMB" in value ? value.buildingCacheLimitMB : 256;
    if (typeof rawLimit !== "number" || !Number.isFinite(rawLimit) || rawLimit < 32 || rawLimit > 4096) {
      throw new Error("应用配置格式无效");
    }
    const cacheLimitMB = "cacheLimitMB" in value ? value.cacheLimitMB : DEFAULT_CACHE_LIMIT_MB;
    if (typeof cacheLimitMB !== "number" || !Number.isFinite(cacheLimitMB) || cacheLimitMB < 256 || cacheLimitMB > 32768) {
      throw new Error("应用配置格式无效");
    }
    return { cacheLimitMB: Math.round(cacheLimitMB), maptilerApiKey: value.maptilerApiKey.trim(), mapLanguage: mapLanguage as AppSettings["mapLanguage"], buildingCacheLimitMB: Math.round(rawLimit) };
  }
}
