import { readFileSync, writeFileSync, renameSync } from "node:fs";
import type { AppSettings } from "../../shared/settings";

export class SettingsStore {
  constructor(private readonly file: string) {}

  read(): AppSettings {
    try { return this.validate(JSON.parse(readFileSync(this.file, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { maptilerApiKey: "" };
      throw new Error("无法读取应用配置，请检查 config.json；原文件未覆盖。", { cause: error });
    }
  }

  save(value: unknown): void {
    const settings = this.validate(value);
    writeFileSync(`${this.file}.tmp`, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }

  private validate(value: unknown): AppSettings {
    if (!value || typeof value !== "object" || !("maptilerApiKey" in value) ||
        typeof value.maptilerApiKey !== "string" || value.maptilerApiKey.length > 4096) {
      throw new Error("应用配置格式无效");
    }
    return { maptilerApiKey: value.maptilerApiKey.trim() };
  }
}
