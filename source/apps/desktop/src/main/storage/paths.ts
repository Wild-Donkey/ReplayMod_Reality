import path from "node:path";

const APP_DIRECTORY = "ReplayMod Reality";

export function storagePaths(platform: NodeJS.Platform, home: string, appData: string, env: NodeJS.ProcessEnv) {
  const filesystem = platform === "win32" ? path.win32 : path.posix;
  const data = filesystem.join(appData, APP_DIRECTORY);
  const legacyCache = systemCacheDirectory(platform, home, appData, env);
  const cache = filesystem.join(data, "resource-cache-v1");
  return Object.freeze({
    data, cache, legacyCache,
    recordings: filesystem.join(data, "audio-recordings"),
    localSpeech: filesystem.join(data,"local-speech"),
    config: filesystem.join(data, "config.json"),
    archive: filesystem.join(data, "user-archive.json"),
    state: filesystem.join(data, "state-v1"),
    annotations: filesystem.join(data, "annotations.json"),
    session: filesystem.join(legacyCache, "browser", "session"),
  });
}

export function systemCacheDirectory(platform: NodeJS.Platform, home: string, appData: string, env: NodeJS.ProcessEnv) {
  if (platform === "darwin") return path.posix.join(home, "Library", "Caches", APP_DIRECTORY);
  if (platform === "win32") return path.win32.join(env.LOCALAPPDATA || path.win32.resolve(appData, "../Local"), APP_DIRECTORY, "Cache");
  const xdg = env.XDG_CACHE_HOME;
  return path.posix.join(xdg && path.posix.isAbsolute(xdg) ? xdg : path.posix.join(home, ".cache"), APP_DIRECTORY);
}
