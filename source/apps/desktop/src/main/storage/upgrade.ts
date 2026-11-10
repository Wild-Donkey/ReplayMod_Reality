import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, stat, utimes } from "node:fs/promises";
import type { storagePaths } from "./paths";
import path from "node:path";
import { LocalCache } from "./snapshots";
import type { SettingsStore } from "./settings";

// Conversion of previous on-disk formats belongs here, never in the renderer
// or in normal settings reads. Existing canonical files always take precedence.
export function upgradeStorage(data: string, config: string, state: LocalCache, settings: SettingsStore) {
  if (!existsSync(config)) {
    const oldSettings = path.join(data, "settings-v1");
    const key = existsSync(oldSettings) ? new LocalCache(oldSettings).readSync<string>("maptiler-key") : null;
    settings.save({ maptilerApiKey: key ?? "", mapLanguage: "auto" });
  }
  const marker = "storage-format-v2";
  if (state.readSync(marker)) return;
  const oldSnapshots = path.join(data, "cache", "snapshots-v1");
  if (existsSync(oldSnapshots)) {
    const old = new LocalCache(oldSnapshots);
    for (const key of ["workspace", "last-media", "last-dataset-source"]) {
      if (state.readSync(key) !== null) continue;
      const value = old.readSync(key);
      if (value !== null) state.writeSync(key, value);
    }
  }
  state.writeSync(marker, true);
}

// Move an intact directory when possible. A cross-volume or interrupted
// upgrade merges entries individually and preserves existing newer resources.
export async function migrateResourceCache(paths: ReturnType<typeof storagePaths>, state: LocalCache) {
  const marker = "resource-cache-v1";
  if (state.readSync(marker)) return;
  for (const name of ["maps-v1", "snapshots-v1"]) {
    const target = path.join(paths.cache, name);
    for (const root of [paths.legacyCache, path.join(paths.data, "cache")]) {
      const source = path.join(root, name);
      if (!existsSync(source)) continue;
      if (root === paths.legacyCache && !existsSync(target)) {
        try {
          await rename(source, target);
          continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        }
      }
      await mkdir(target, { recursive: true, mode: 0o700 });
      for (const file of await readdir(source, { withFileTypes: true })) {
        if (!file.isFile() || !/^[a-z0-9-]+\.bin$/.test(file.name)) continue;
        if (name === "snapshots-v1" && !/^[a-f0-9]{64}\.bin$/.test(file.name)) continue;
        const from = path.join(source, file.name);
        const to = path.join(target, file.name);
        if (existsSync(to)) continue;
        const info = await stat(from);
        await copyFile(from, `${to}.tmp`);
        await utimes(`${to}.tmp`, info.atime, info.mtime);
        await rename(`${to}.tmp`, to);
      }
    }
  }
  state.writeSync(marker, true);
}
