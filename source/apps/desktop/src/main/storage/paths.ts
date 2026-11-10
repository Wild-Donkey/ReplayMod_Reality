import path from "node:path";

const APP_DIRECTORY = "ReplayMod Reality";

export function storagePaths(platform: NodeJS.Platform, home: string, appData: string, env: NodeJS.ProcessEnv) {
  const data = path.join(appData, APP_DIRECTORY);
  const legacyCache = systemCacheDirectory(platform, home, appData, env);
  const cache = path.join(data, "resource-cache-v1");
  return Object.freeze({
    data, cache, legacyCache,
    config: path.join(data, "config.json"),
    archive: path.join(data, "user-archive.json"),
    state: path.join(data, "state-v1"),
    annotations: path.join(data, "annotations.json"),
    session: path.join(legacyCache, "browser", "session"),
  });
}

export function systemCacheDirectory(platform: NodeJS.Platform, home: string, appData: string, env: NodeJS.ProcessEnv) {
  if (platform === "darwin") return path.join(home, "Library", "Caches", "ReplayMod Reality");
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.resolve(appData, "../Local"), "ReplayMod Reality", "Cache");
  const xdg = env.XDG_CACHE_HOME;
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".cache"), "ReplayMod Reality");
}
