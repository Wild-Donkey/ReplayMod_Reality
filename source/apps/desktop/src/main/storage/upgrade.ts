import { existsSync } from "node:fs";
import path from "node:path";
import { LocalCache } from "./snapshots";
import type { SettingsStore } from "./settings";

// Conversion of previous on-disk formats belongs here, never in the renderer
// or in normal settings reads. Existing canonical files always take precedence.
export function upgradeStorage(data: string, config: string, state: LocalCache, settings: SettingsStore) {
  if (!existsSync(config)) {
    const oldSettings = path.join(data, "settings-v1");
    const key = existsSync(oldSettings) ? new LocalCache(oldSettings).readSync<string>("maptiler-key") : null;
    settings.save({ maptilerApiKey: key ?? "" });
  }
  const marker = "storage-format-v2";
  if (state.readSync(marker)) return;
  const oldSnapshots = path.join(data, "cache", "snapshots-v1");
  if (existsSync(oldSnapshots)) {
    const old = new LocalCache(oldSnapshots);
    for (const key of ["workspace", "last-media", "last-dataset"]) {
      if (state.readSync(key) !== null) continue;
      const value = old.readSync(key);
      if (value !== null) state.writeSync(key, value);
    }
  }
  state.writeSync(marker, true);
}
