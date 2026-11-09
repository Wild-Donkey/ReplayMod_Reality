import { installDisplayHDR } from "./displayHDR";
import { AppStorage } from "./storage";
import { windowBackgroundOptions } from "./windowBackground";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { app, BrowserWindow, dialog, ipcMain, shell, net, Menu } from "electron";
import { installScrollInput } from "./scrollInput";
import { MENU_ACTION_CHANNEL, MENU_STATE_CHANNEL, type MenuAction, type MenuState } from "../shared/menu";
import { buildAirportNameZhQueryUrl, pickChineseNameFromCsv } from "../shared/airportNameZh";
import { defaultUserArchive, type UserArchive } from "../shared/userArchive";
import path from "node:path";
import { parse } from "csv-parse";
import type {
  CoordinateBounds,
  PointDataset,
  TimeBounds,
} from "../../../../packages/data/src";
import {
  probeMediaFile,
  serializeSrt,
  transcribeMedia,
} from "../../../../packages/media/src";
import type {
  MediaSource,
  SavedSubtitleTrack,
  SubtitleTrack,
} from "../../../../packages/media/src";

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

const OPEN_LOCATION_CSV_CHANNEL = "data:open-location-csv";
const LOAD_DEFAULT_LOCATION_CSV_CHANNEL = "data:load-default-location-csv";
const AIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv";
const AIRPORTS_CACHE_KEY = "airports-ourairports-v1";
const OPEN_MEDIA_CHANNEL = "media:open";
const TRANSCRIBE_MEDIA_CHANNEL = "media:transcribe";
const SAVE_SUBTITLES_CHANNEL = "media:save-subtitles";

app.setName("ReplayMod Reality");
process.title = "ReplayMod Reality";

const storage = new AppStorage(process.platform, app.getPath("home"), app.getPath("appData"), process.env);
app.setPath("userData", storage.paths.data);
app.setPath("sessionData", storage.paths.session);
app.commandLine.appendSwitch("disk-cache-dir", storage.paths.http);
app.commandLine.appendSwitch("disk-cache-size", String(512 * 1024 * 1024));
const legacySettings = storage.settings.read();
let userArchive: UserArchive = storage.archive.read() ?? {
  ...defaultUserArchive(legacySettings),
  workspace: storage.state.readSync<Record<string, unknown>>("workspace") ?? {},
  lastDatasetSource: storage.state.readSync("last-dataset-source") ?? undefined,
  lastMedia: storage.state.readSync("last-media") ?? undefined,
  migrations: {legacyImportedAt:new Date().toISOString()},
};
if (!storage.archive.read()) storage.archive.write(userArchive);
const updateUserArchive = (change: (current: UserArchive) => UserArchive) => {
  userArchive = change(userArchive);
  storage.archive.write(userArchive);
};
ipcMain.on("storage:bootstrap", event => {
  event.returnValue = { state: userArchive.workspace, directory: storage.paths.cache, settings: userArchive.settings };
});
ipcMain.on("settings:save", (event, value: unknown) => {
  try {
    const settings=storage.settings.validate(value);
    updateUserArchive(current=>({...current,settings}));
    event.returnValue = null;
  } catch { event.returnValue = "配置保存失败，请检查配置格式及应用数据目录权限。"; }
});
ipcMain.on("workspace:save", (event, state: Record<string, unknown>) => {
  try {
    if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("缓存状态无效");
    updateUserArchive(current=>({...current,workspace:state}));
    event.returnValue = null;
  } catch (error) { event.returnValue = String(error); }
});
ipcMain.handle("cache:open", () => shell.openPath(storage.paths.cache));
const mapRequests = new Map<string, Promise<Uint8Array>>();
// All MapLibre instances share Chromium's network service. Bound downloads
// globally, including body consumption, rather than per map or per hostname.
let activeMapDownloads = 0;
const mapDownloadQueue: Array<() => void> = [];
async function downloadMap(url: string): Promise<Uint8Array> {
  if (activeMapDownloads >= 8) {
    if (mapDownloadQueue.length >= 256) throw new Error("地图请求繁忙，请稍后重试");
    await new Promise<void>(resolve => mapDownloadQueue.push(resolve));
  } else {
    activeMapDownloads++;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await net.fetch(url, { signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`地图请求失败 (${response.status})`);
    }
    return new Uint8Array(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
    const next = mapDownloadQueue.shift();
    if (next) next(); // Transfer this slot directly to the next waiter.
    else activeMapDownloads--;
  }
}
async function downloadMapDirect(url: string): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await net.fetch(url, { signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`地图请求失败 (${response.status})`);
    }
    return new Uint8Array(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

const validatedMapUrl = (rawUrl: string): URL => {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || url.hostname !== "api.maptiler.com" || url.port || url.username || url.password) {
    throw new Error("不支持的地图资源地址");
  }
  return url;
};

const loadMapResource = async (rawUrl: string, direct = false): Promise<Uint8Array> => {
  const url = validatedMapUrl(rawUrl);
  const key = createHash("sha256").update(url.href).digest("hex");
  let request = mapRequests.get(key);
  if (!request) {
    request = (async () => {
      const saved = await storage.maps.read<{ at: number; data: Uint8Array }>(key);
      // 飞行识别的批处理图块是可重用的离线计算输入：只要磁盘缓存存在就不重拉。
      // 交互地图资源仍保留 7 天刷新周期。
      if (saved && (direct || Date.now() - saved.at < 7 * 86400_000)) return saved.data;
      try {
        const data = await (direct ? downloadMapDirect(url.href) : downloadMap(url.href));
        if (data.byteLength <= 32 * 1024 * 1024) {
          await storage.maps.write(key, { at: Date.now(), data }).catch(console.warn);
        }
        return data;
      } catch (error) {
        if (saved) return saved.data;
        throw error;
      }
    })();
    mapRequests.set(key, request);
    void request.finally(() => mapRequests.delete(key)).catch(() => {});
  }
  return request;
};

ipcMain.handle("cache:map", async (_event, rawUrl: string) => loadMapResource(rawUrl));
ipcMain.handle("cache:map-batch", async (_event, rawUrls: readonly string[]) => {
  if (!Array.isArray(rawUrls) || rawUrls.length > 64 || rawUrls.some(url => typeof url !== "string")) {
    throw new Error("地形图块批次无效");
  }
  const unique = [...new Set(rawUrls)];
  const results = new Map<string, Uint8Array>();
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, unique.length) }, async () => {
    while (cursor < unique.length) {
      const url = unique[cursor++];
      results.set(url, await loadMapResource(url, true));
    }
  });
  await Promise.all(workers);
  return rawUrls.map(url => results.get(url)!);
});

// 固定拉取 OurAirports 全量机场 CSV（Public Domain）。成功后写入地图磁盘
// 缓存，离线或请求失败时回退缓存；force 用于用户手动更新。内置临时表在
// 渲染进程，这里只负责在线全量数据。
ipcMain.handle("data:airports", async (_event, force = false) => {
  const saved = await storage.maps.read<{ at: number; data: Uint8Array }>(AIRPORTS_CACHE_KEY);
  if (saved && !force && Date.now() - saved.at < 30 * 86400_000) {
    return new TextDecoder().decode(saved.data);
  }
  try {
    const response = await net.fetch(AIRPORTS_URL);
    if (!response.ok) throw new Error(`机场数据请求失败 (${response.status})`);
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength <= 32 * 1024 * 1024) {
      await storage.maps.write(AIRPORTS_CACHE_KEY, { at: Date.now(), data }).catch(console.warn);
    }
    return new TextDecoder().decode(data);
  } catch (error) {
    if (saved) return new TextDecoder().decode(saved.data);
    throw error;
  }
});

// 随用随拉单个机场的中文名（Wikidata，CC0）。仅当界面显示到缺少内置中文名
// 的机场时才请求，一个 ICAO 一条缓存，绝不批量拉取。查无结果做短期负缓存，
// 网络错误不缓存并抛出，由界面静默回退英文名。
const AIRPORT_ZH_TTL_MS = 30 * 86400_000;
const AIRPORT_ZH_NEGATIVE_TTL_MS = 7 * 86400_000;
ipcMain.handle("data:airport-name-zh", async (_event, icao: string) => {
  const key = `airport-zh:${icao}`;
  const saved = await storage.maps.read<{ at: number; name: string | null }>(key).catch(() => null);
  if (saved) {
    const ttl = saved.name === null ? AIRPORT_ZH_NEGATIVE_TTL_MS : AIRPORT_ZH_TTL_MS;
    if (Date.now() - saved.at < ttl) return saved.name;
  }
  const response = await net.fetch(buildAirportNameZhQueryUrl(icao), {
    headers: { Accept: "text/csv", "User-Agent": "replaymod-reality" },
  });
  if (!response.ok) throw new Error(`机场中文名请求失败 (${response.status})`);
  const name = pickChineseNameFromCsv(await response.text());
  await storage.maps.write(key, { at: Date.now(), name }).catch(console.warn);
  return name;
});

const openedMediaPaths = new Set<string>();

const firstExistingPath = async (candidates: readonly string[]) => {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue through platform and development/install locations.
    }
  }
  return null;
};

const resolveSpeechResources = async () => {
  const roots = [path.resolve(process.cwd(), ".."), process.cwd(), app.getAppPath(), path.dirname(app.getPath("exe"))];
  const whisperPath = await firstExistingPath(roots.flatMap((root) => [
    path.join(root, ".tools/whisper.cpp/build/bin/whisper-cli"),
    path.join(root, ".tools/whisper.cpp/build/bin/Release/whisper-cli.exe"),
  ]));
  const modelPath = await firstExistingPath(roots.flatMap((root) => [
    path.join(root, ".tools/whisper.cpp/models/ggml-small.bin"),
    path.join(root, ".tools/whisper.cpp/models/ggml-base.bin"),
  ]));
  const vadModelPath = await firstExistingPath(roots.map((root) =>
    path.join(root, ".tools/whisper.cpp/models/ggml-silero-v6.2.0.bin")));
  if (!whisperPath || !modelPath) {
    throw new Error("未找到本地 Whisper 识别器或模型，请先完成语音识别环境安装。");
  }
  return { whisperPath, modelPath, vadModelPath: vadModelPath ?? undefined };
};

interface TimedCoordinate {
  readonly timestamp: number;
  readonly longitude: number;
  readonly latitude: number;
  readonly altitude: number;
}

interface CsvPair {
  readonly mainFilePath: string;
  readonly photoFilePath: string | null;
}

interface CachedDatasetSource {
  readonly mainFilePath: string;
  readonly photoFilePath: string | null;
}

const rememberDatasetSource = async (
  mainFilePath: string,
  photoFilePath: string | null,
) => {
  updateUserArchive(current=>({...current,lastDatasetSource:{mainFilePath,photoFilePath}}));
};

const isPhotoDataFile = (filePath: string) =>
  path.basename(filePath).toLowerCase().includes("photo");

const pointKey = (point: TimedCoordinate) =>
  `${point.timestamp}|${point.longitude.toFixed(6)}|${point.latitude.toFixed(6)}`;

const readLocationCsv = async (
  mainFilePath: string,
  photoFilePath: string | null = null,
): Promise<PointDataset> => {
  const signature = ["point-parser-v2-accuracy-100m", ...await Promise.all([mainFilePath, photoFilePath].map(async file => {
    if (!file) return null;
    const info = await stat(file);
    return [file, info.size, info.mtimeMs];
  }))];
  const key = createHash("sha256").update(JSON.stringify(signature)).digest("hex");
  const saved = await storage.snapshots.read<PointDataset>(key);
  if (saved) {
    await storage.state.write("last-dataset", saved).catch(console.warn);
    await rememberDatasetSource(mainFilePath, photoFilePath);
    return saved;
  }
  const footprintPoints: TimedCoordinate[] = [];
  const photoPointsByKey = new Map<string, TimedCoordinate>();
  let skippedRowCount = 0;
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  let startTime = Number.POSITIVE_INFINITY;
  let endTime = Number.NEGATIVE_INFINITY;

  const readFile = async (filePath: string, forcePhoto: boolean) => {
    const records = createReadStream(filePath).pipe(
      parse({
        bom: true,
        columns: true,
        skip_empty_lines: true,
        trim: true,
      }),
    );

    for await (const rawRecord of records) {
      const record = rawRecord as Record<string, string>;
      const longitude = Number(record.longitude);
      const latitude = Number(record.latitude);
      const stepType = Number(record.stepType);
      const timestamp = Number(record.dataTime) * 1000;
      const rawAccuracy = record.accuracy?.trim() ?? "";
      const accuracy = Number(rawAccuracy);

      if (
        !Number.isFinite(longitude) ||
        !Number.isFinite(latitude) ||
        longitude < -180 ||
        longitude > 180 ||
        latitude < -90 ||
        latitude > 90 ||
        record.dataTime.trim() === "" ||
        !Number.isFinite(timestamp)
      ) {
        skippedRowCount += 1;
        continue;
      }
      // accuracy 是水平定位误差（米）；大于 100 m 的点不进入显示与识别时间线。
      // 缺失、0 或负值是不同数据源的“未知”哨兵值，不因此删除。
      if (rawAccuracy !== "" && Number.isFinite(accuracy) && accuracy > 100) {
        skippedRowCount += 1;
        continue;
      }

      const rawAltitude =
        record.altitude ?? record.elevation ?? record.height ?? record.alt ?? "";
      const parsedAltitude = Number(rawAltitude);
      const point = {
        timestamp,
        longitude,
        latitude,
        altitude:
          rawAltitude.trim() !== "" && Number.isFinite(parsedAltitude)
            ? parsedAltitude
            : Number.NaN,
      };

      if (forcePhoto || stepType === 1) {
        photoPointsByKey.set(pointKey(point), point);
      } else {
        footprintPoints.push(point);
      }

      west = Math.min(west, longitude);
      south = Math.min(south, latitude);
      east = Math.max(east, longitude);
      north = Math.max(north, latitude);
      startTime = Math.min(startTime, timestamp);
      endTime = Math.max(endTime, timestamp);
    }
  };

  await readFile(mainFilePath, false);

  if (photoFilePath) {
    await readFile(photoFilePath, true);
  }

  const photoPoints = [...photoPointsByKey.values()];
  const timelinePoints = [...footprintPoints, ...photoPoints];

  const pointCount = footprintPoints.length + photoPoints.length;

  if (pointCount === 0) {
    throw new Error("CSV 中没有找到有效的 longitude / latitude 坐标。");
  }

  const bounds: CoordinateBounds = [west, south, east, north];
  const timeBounds: TimeBounds = [startTime, endTime];
  footprintPoints.sort((left, right) => left.timestamp - right.timestamp);
  photoPoints.sort((left, right) => left.timestamp - right.timestamp);
  timelinePoints.sort((left, right) => left.timestamp - right.timestamp);

  const footprintCoordinates = footprintPoints.flatMap((point) => [
    point.longitude,
    point.latitude,
  ]);
  const photoCoordinates = photoPoints.flatMap((point) => [
    point.longitude,
    point.latitude,
  ]);
  const footprintTimestamps = footprintPoints.map((point) => point.timestamp);
  const photoTimestamps = photoPoints.map((point) => point.timestamp);
  const timelineCoordinates = timelinePoints.flatMap((point) => [
    point.longitude,
    point.latitude,
  ]);
  const timelineTimestamps = timelinePoints.map((point) => point.timestamp);
  const timelineAltitudes = timelinePoints.map((point) => point.altitude);

  const dataset: PointDataset = {
    sourceName: photoFilePath
      ? `${path.basename(mainFilePath)} + ${path.basename(photoFilePath)}`
      : path.basename(mainFilePath),
    footprintCoordinates,
    photoCoordinates,
    footprintTimestamps,
    photoTimestamps,
    timelineCoordinates,
    timelineTimestamps,
    timelineAltitudes,
    pointCount,
    footprintPointCount: footprintPoints.length,
    photoPointCount: photoPoints.length,
    skippedRowCount,
    bounds,
    timeBounds,
  };
  await storage.snapshots.write(key, dataset).catch(console.warn);
  await storage.state.write("last-dataset", dataset).catch(console.warn);
  await rememberDatasetSource(mainFilePath, photoFilePath);
  return dataset;
};

const findCsvPairInDirectory = async (
  directory: string,
): Promise<CsvPair | null> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const csvFiles: { filePath: string; modifiedAt: number }[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".csv") {
      continue;
    }

    const filePath = path.join(directory, entry.name);
    const fileStats = await stat(filePath);
    csvFiles.push({
      filePath,
      modifiedAt: fileStats.mtimeMs,
    });
  }

  const mainFiles = csvFiles
    .filter((file) => !isPhotoDataFile(file.filePath))
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
  const photoFiles = csvFiles
    .filter((file) => isPhotoDataFile(file.filePath))
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
  const mainFilePath = mainFiles[0]?.filePath;

  return mainFilePath
    ? {
        mainFilePath,
        photoFilePath: photoFiles[0]?.filePath ?? null,
      }
    : null;
};

const findLatestRawDataCsvPair = async (): Promise<CsvPair | null> => {
  const candidateDirectories = [
    path.resolve(process.cwd(), "../RawData"),
    path.resolve(process.cwd(), "RawData"),
    path.resolve(app.getAppPath(), "RawData"),
    path.resolve(path.dirname(app.getPath("exe")), "RawData"),
  ];
  const uniqueDirectories = [...new Set(candidateDirectories.map(directory => path.join(directory, "footprint")))];
  const pairs: {
    pair: CsvPair;
    mainModifiedAt: number;
  }[] = [];

  for (const directory of uniqueDirectories) {
    try {
      const pair = await findCsvPairInDirectory(directory);

      if (pair) {
        const mainStats = await stat(pair.mainFilePath);
        pairs.push({
          pair,
          mainModifiedAt: mainStats.mtimeMs,
        });
      }
    } catch {
      // RawData is optional. Manual file selection remains available.
    }
  }

  pairs.sort((left, right) => right.mainModifiedAt - left.mainModifiedAt);
  return pairs[0]?.pair ?? null;
};

let defaultDatasetPromise: Promise<PointDataset | null> | null = null;

const findDefaultCsvPair = async (): Promise<CsvPair | null> => {
  const source = userArchive.lastDatasetSource;

  if (source?.mainFilePath) {
    try {
      await access(source.mainFilePath);
      if (source.photoFilePath) await access(source.photoFilePath);
      return source;
    } catch {
      try {
        const latestInSourceDirectory = await findCsvPairInDirectory(
          path.dirname(source.mainFilePath),
        );
        if (latestInSourceDirectory) return latestInSourceDirectory;
      } catch {
        // The former source directory may have moved or been removed.
      }
    }
  }

  // Older caches did not retain the opened path. In that case, use the newest
  // CSV in the standard RawData/footprint directory instead of stale data.
  return findLatestRawDataCsvPair();
};

ipcMain.handle(
  LOAD_DEFAULT_LOCATION_CSV_CHANNEL,
  (): Promise<PointDataset | null> => {
    defaultDatasetPromise ??= (async () => {
      const pair = await findDefaultCsvPair();
      return pair
        ? readLocationCsv(pair.mainFilePath, pair.photoFilePath)
        : null;
    })();

    return defaultDatasetPromise;
  },
);

ipcMain.handle(
  OPEN_LOCATION_CSV_CHANNEL,
  async (): Promise<PointDataset | null> => {
    const result = await dialog.showOpenDialog({
      title: "载入位置数据",
      properties: ["openFile"],
      filters: [
        {
          name: "CSV 位置数据",
          extensions: ["csv"],
        },
      ],
    });

    const selectedFilePath = result.filePaths[0];

    if (result.canceled || !selectedFilePath) {
      return null;
    }

    const directoryPair = await findCsvPairInDirectory(
      path.dirname(selectedFilePath),
    );

    if (isPhotoDataFile(selectedFilePath)) {
      return directoryPair
        ? readLocationCsv(directoryPair.mainFilePath, selectedFilePath)
        : readLocationCsv(selectedFilePath);
    }

    // The selected footprint file is authoritative. Previously this reused the
    // directory's newest main CSV, which made selecting the full table reopen a
    // newer Example_footprint.csv instead.
    return readLocationCsv(
      selectedFilePath,
      directoryPair?.photoFilePath ?? null,
    );
  },
);

ipcMain.handle("cache:media", async () => {
  const source = userArchive.lastMedia as MediaSource | undefined;
  if (!source) return null;
  try { await access(source.sourcePath); } catch { return null; }
  openedMediaPaths.add(source.sourcePath);
  return source;
});

ipcMain.handle(OPEN_MEDIA_CHANNEL, async (): Promise<MediaSource | null> => {
  const result = await dialog.showOpenDialog({
    title: "载入 DJI 视频",
    properties: ["openFile"],
    filters: [{ name: "视频", extensions: ["mp4", "mov"] }],
  });
  const selectedFilePath = result.filePaths[0];

  if (result.canceled || !selectedFilePath) return null;
  openedMediaPaths.add(selectedFilePath);
  const source = await probeMediaFile(selectedFilePath);
  updateUserArchive(current=>({...current,lastMedia:source}));
  return source;
});

ipcMain.handle(
  TRANSCRIBE_MEDIA_CHANNEL,
  async (_event, sourcePath: string): Promise<SubtitleTrack> => {
    if (!openedMediaPaths.has(sourcePath)) throw new Error("请先在当前工程中载入该视频。");
    const resources = await resolveSpeechResources();
    return transcribeMedia(sourcePath, { ...resources, language: "auto" });
  },
);

ipcMain.handle(
  SAVE_SUBTITLES_CHANNEL,
  async (
    _event,
    sourcePath: string,
    track: SubtitleTrack,
  ): Promise<SavedSubtitleTrack> => {
    if (!openedMediaPaths.has(sourcePath)) throw new Error("请先在当前工程中载入该视频。");
    const basePath = sourcePath.replace(/\.[^.]+$/, "");
    const jsonPath = `${basePath}.subtitles.json`;
    const srtPath = `${basePath}.subtitles.srt`;
    await writeFile(jsonPath, JSON.stringify(track, null, 2));
    await writeFile(srtPath, serializeSrt(track.cues));
    return { jsonPath, srtPath };
  },
);

// Annotation documents are stored as JSON; KML is only an import/export format.
ipcMain.handle("annotations:load", async () => {
  const saved = storage.paths.annotations;
  const source = app.isPackaged
    ? path.resolve(app.getAppPath(), "RawData/annotations/Example_annotations.json")
    : path.resolve(app.getAppPath(), "../RawData/annotations/Example_annotations.json");
  let sourceContent: string | null = null;
  try {
    sourceContent = await readFile(source, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (sourceContent !== null) {
    const signature = createHash("sha256").update(sourceContent).digest("hex");
    const previousSignature = userArchive.migrations?.annotationsSourceSignature;
    if (signature !== previousSignature) {
      updateUserArchive(current=>({...current,migrations:{...current.migrations,annotationsSourceSignature:signature}}));
      return { name: "摩旅/自驾", content: sourceContent };
    }
  }

  try {
    return { name: "我的地图", content: await readFile(saved, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return sourceContent === null ? null : { name: "摩旅/自驾", content: sourceContent };
});
ipcMain.handle("annotations:open", async () => {
  const result = await dialog.showOpenDialog({title:"导入地图标注", properties:["openFile"], filters:[{name:"KML / 地图项目", extensions:["kml","json"]}]});
  if(result.canceled || !result.filePaths[0]) return null;
  const filePath = result.filePaths[0];
  if ((await stat(filePath)).size > 40 * 1024 * 1024) throw new Error("地图文件超过 40 MB。");
  return {name:path.basename(filePath),content:await readFile(filePath,"utf8")};
});
let annotationSaveQueue: Promise<void> = Promise.resolve();
ipcMain.handle("annotations:save", async (_event, content: string) => {
  if(typeof content !== "string" || Buffer.byteLength(content) > 40 * 1024 * 1024) throw new Error("地图项目过大或无效。");
  const parsed = JSON.parse(content);
  if(parsed.format !== "replaymod.annotations" || parsed.version !== 1 || !Array.isArray(parsed.nodes)) throw new Error("地图项目格式无效。");
  const target = storage.paths.annotations;
  const save = annotationSaveQueue.catch(() => {}).then(async () => {
    const temporary = `${target}.tmp`;
    await writeFile(temporary, content, "utf8");
    await rename(temporary, target);
  });
  annotationSaveQueue = save;
  await save;
});
ipcMain.handle("annotations:export", async (_event, content: string, format: string) => {
  if(typeof content !== "string" || Buffer.byteLength(content) > 40 * 1024 * 1024 || !["kml","json"].includes(format)) throw new Error("导出内容无效。");
  const result = await dialog.showSaveDialog({title:"导出地图标注",defaultPath:`我的地图.${format}`,filters:[{name:format.toUpperCase(),extensions:[format]}]});
  if(result.canceled || !result.filePath) return null;
  await writeFile(result.filePath,content,"utf8");
  return result.filePath;
});

const installMacMenu = () => {
  if (process.platform !== "darwin") return;
  const command = (id: MenuAction, label: string, accelerator: string) => ({
    id, label, accelerator, enabled: false,
    click: () => BrowserWindow.getFocusedWindow()?.webContents.send(MENU_ACTION_CHANNEL, id),
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "ReplayMod Reality", submenu: [
      { role: "about", label: "关于 ReplayMod Reality" },
      { type: "separator" },
      { label: "打开缓存目录", click: () => { void shell.openPath(storage.paths.cache); } },
      { type: "separator" }, { role: "services", label: "服务" },
      { type: "separator" }, { role: "hide", label: "隐藏 ReplayMod Reality" },
      { role: "hideOthers", label: "隐藏其他" }, { role: "unhide", label: "显示全部" },
      { type: "separator" }, { role: "quit", label: "退出 ReplayMod Reality" },
    ] },
    { label: "项目", submenu: [
      command("open-location", "载入位置数据…", "Cmd+O"),
      command("open-media", "载入 DJI 视频…", "Cmd+Shift+O"),
      { type: "separator" }, { role: "close", label: "关闭窗口" },
    ] },
    { label: "编辑", submenu: [
      { role: "undo", label: "撤销" }, { role: "redo", label: "重做" },
      { type: "separator" }, { role: "cut", label: "剪切" },
      { role: "copy", label: "复制" }, { role: "paste", label: "粘贴" },
      { role: "selectAll", label: "全选" },
    ] },
    { label: "视图", submenu: [
      command("open-subtitles", "打开字幕编辑器", "Cmd+Shift+T"),
      { type: "separator" }, { role: "resetZoom", label: "实际大小" },
      { role: "zoomIn", label: "放大界面" }, { role: "zoomOut", label: "缩小界面" },
      { type: "separator" }, { role: "togglefullscreen", label: "切换全屏" },
    ] },
    { label: "输出", submenu: [
      command("set-in", "将播放头设为入点", "Cmd+Alt+I"),
      command("set-out", "将播放头设为出点", "Cmd+Alt+O"),
    ] },
    { role: "windowMenu", label: "窗口" },
  ]));
};

ipcMain.on(MENU_STATE_CHANNEL, (event, state: MenuState) => {
  if (process.platform !== "darwin" || !state || typeof state !== "object") return;
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window !== BrowserWindow.getFocusedWindow()) return;
  const menu = Menu.getApplicationMenu();
  for (const [id, enabled] of Object.entries({
    "open-location": state.openLocation, "open-media": state.openMedia,
    "open-subtitles": state.subtitles, "set-in": state.range, "set-out": state.range,
  })) {
    const item = menu?.getMenuItemById(id);
    if (item) item.enabled = enabled === true;
  }
});

const createWindow = (): void => {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    ...windowBackgroundOptions(),
    title: "ReplayMod Reality",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setUserAgent(
    `ReplayModReality/${app.getVersion()} (${process.platform}; Electron)`,
  );
  const removeScrollInput = installScrollInput(mainWindow);
  mainWindow.once("closed", removeScrollInput);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) {
      void shell.openExternal(url);
    }

    return { action: "deny" };
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(
      path.join(
        __dirname,
        `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
      ),
    );
  }
};

void app.whenReady().then(() => {
  try { storage.settings.read(); }
  catch {
    dialog.showErrorBox("无法读取应用配置", `请检查配置文件：${storage.paths.config}\n原文件已保留，未重置配置。`);
    app.quit();
    return;
  }
  installDisplayHDR();
  installMacMenu();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
