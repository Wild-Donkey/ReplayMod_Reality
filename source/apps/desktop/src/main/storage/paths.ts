import path from "node:path";

const APP_DIRECTORY = "ReplayMod Reality";

export function storagePaths(platform: NodeJS.Platform, home: string, appData: string, env: NodeJS.ProcessEnv) {
  const data = path.join(appData, APP_DIRECTORY);
  const cache = systemCacheDirectory(platform, home, appData, env);
  return Object.freeze({
    data, cache,
    config: path.join(data, "config.json"),
    state: path.join(data, "state-v1"),
    annotations: path.join(data, "annotations.json"),
    snapshots: path.join(cache, "snapshots-v1"),
    maps: path.join(cache, "maps-v1"),
    session: path.join(cache, "browser", "session"),
    http: path.join(cache, "browser", "http"),
  });
}

export function systemCacheDirectory(platform: NodeJS.Platform, home: string, appData: string, env: NodeJS.ProcessEnv) {
  if (platform === "darwin") return path.join(home, "Library", "Caches", "ReplayMod Reality");
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.resolve(appData, "../Local"), "ReplayMod Reality", "Cache");
  const xdg = env.XDG_CACHE_HOME;
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".cache"), "ReplayMod Reality");
}
