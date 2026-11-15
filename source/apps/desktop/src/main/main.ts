import {processMotionGps} from "../../../../packages/media/src/gps-motion";
import {PROCESS_GPS_CHANNEL,type MotionGpsRequest,type MotionGpsResult} from "../shared/mediaAlignment";
import {restoreDataset,resolveDatasetSource} from "./restoreDataset";
import {LocalSpeech} from "./localSpeech";
import { renderAudioEdit, saveRecordedAudio } from "../../../../packages/media/src/audio-edit";
import { audioOutputCues, validateAudioBlocks, refineAudioBlock, coarseAudioBlocks, type AudioDocument, type AudioBlock } from "../../../../packages/media/src/audio-document";
import {registerMediaPreviewScheme,installMediaPreviewProtocol} from "./mediaPreviewProtocol";
import { OfflineExportManager } from "./offlineExport";
import { ALIGN_MEDIA_CHANNEL, type MediaAlignmentRequest, type MediaAlignmentResult } from "../shared/mediaAlignment";
import { refineMotionAlignment, type MotionAlignmentResult } from "../../../../packages/media/src/motion-alignment";
import { shiftVideoTimestamps } from "../../../../packages/media/src/video-timestamps";
import { extractDjiOrientation } from "../../../../packages/media/src/dji";
import { OfflineFramePlan, type OfflineExportOptions } from "../shared/overlayExport";
import { findTransparentVideoEncoder } from "../../../../packages/media/src/raw-video";
import { installDisplayHDR } from "./displayHDR";
import { AppStorage } from "./storage";
import { storagePaths } from "./storage/paths";
import { windowBackgroundOptions } from "./windowBackground";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, mkdirSync } from "node:fs";
import { access, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { app, BrowserWindow, dialog, ipcMain, shell, net, Menu } from "electron";
import { installScrollInput } from "./scrollInput";
import { MENU_ACTION_CHANNEL, MENU_STATE_CHANNEL, type MenuAction, type MenuState } from "../shared/menu";
import { buildAirportNameZhQueryUrl, pickChineseNameFromCsv } from "../shared/airportNameZh";
import { MapResources } from "./mapResources";
import type { ConfirmedFlightRecord, ConfirmedFlightsFile, FlightScreeningCache } from "../shared/confirmedFlight";
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
} from "../../../../packages/media/src";
import type {
  MediaSource,
  SavedSubtitleTrack,
  SubtitleTrack,
} from "../../../../packages/media/src";

registerMediaPreviewScheme();

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

const OPEN_LOCATION_CSV_CHANNEL = "data:open-location-csv";
const LOAD_DEFAULT_LOCATION_CSV_CHANNEL = "data:load-default-location-csv";
const AIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv";
const AIRPORTS_CACHE_KEY = "airports-ourairports-v1";
const OPEN_MEDIA_CHANNEL = "media:open";
const TRANSCRIBE_MEDIA_CHANNEL = "media:transcribe";
const SAVE_SUBTITLES_CHANNEL = "media:save-subtitles";

const offlineExports = new OfflineExportManager();
let offlineEncoder: Promise<string | null> | null = null;
const getOfflineEncoder = () => offlineEncoder ??= findTransparentVideoEncoder();
ipcMain.handle("export:offline-available", async () => Boolean(await getOfflineEncoder()));
ipcMain.handle("export:offline-begin", async (event, options: OfflineExportOptions) => {
  new OfflineFramePlan(options);
  const encoder = await getOfflineEncoder();
  if (!encoder) throw new Error("未找到支持透明 VP9 的 FFmpeg。");
  const result = await dialog.showSaveDialog({title: "导出透明 WebM", defaultPath: "轨迹叠加.webm", filters: [{name: "WebM", extensions: ["webm"]}]});
  if (result.canceled || !result.filePath || event.sender.isDestroyed()) return null;
  return offlineExports.begin(event.sender.id, options, result.filePath, encoder);
});
ipcMain.handle("export:offline-frame", (event, id: string, segment: number, frame: number, rgba: Uint8Array) => offlineExports.write(event.sender.id, id, segment, frame, rgba));
ipcMain.handle("export:offline-segment", (event, id: string, segment: number) => offlineExports.finishSegment(event.sender.id, id, segment));
ipcMain.handle("export:offline-complete", (event, id: string) => offlineExports.complete(event.sender.id, id));
ipcMain.handle("export:offline-cancel", (event, id: string) => offlineExports.cancel(event.sender.id, id));
app.on("web-contents-created", (_event, contents) => {
  const cancel = () => { void offlineExports.cancelOwner(contents.id); };
  contents.once("destroyed", cancel);
  contents.on("render-process-gone", cancel);
  contents.on("did-start-navigation", (_navigation, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) cancel(); });
});
let quittingOfflineExports = false;
app.on("before-quit", event => {
  if (quittingOfflineExports || !offlineExports.active) return;
  event.preventDefault(); quittingOfflineExports = true;
  void offlineExports.cancelAll().then(() => app.quit(), () => app.quit());
});

app.setName("ReplayMod Reality");
process.title = "ReplayMod Reality";

const { platform, env } = process;
const home = app.getPath("home");
const appData = app.getPath("appData");
const paths = storagePaths(platform, home, appData, env);
mkdirSync(paths.data, { recursive: true, mode: 0o700 });
app.setPath("userData", paths.data);
if (!app.requestSingleInstanceLock()) process.exit(0);

const storage = new AppStorage(platform, home, appData, env);
const localSpeech = new LocalSpeech(app.getAppPath(),process.resourcesPath,app.isPackaged,storage.paths.localSpeech);
app.on("will-quit",()=>localSpeech.close());
ipcMain.handle("speech:status",()=>localSpeech.status());
ipcMain.handle("speech:download",(event,id:string)=>localSpeech.download(id,update=>{if(!event.sender.isDestroyed())event.sender.send("speech:progress",update);}));
ipcMain.handle("speech:select",(_event,role:"asr"|"aligner",id:string)=>localSpeech.select(role,id));
ipcMain.handle("speech:folder",async()=>{const result=await dialog.showOpenDialog({title:"选择已下载的 MLX 模型文件夹",properties:["openDirectory"]});return result.canceled||!result.filePaths[0]?null:localSpeech.register(result.filePaths[0]);});
ipcMain.handle("speech:open-directory",async()=>{await mkdir(localSpeech.modelDirectory,{recursive:true});const error=await shell.openPath(localSpeech.modelDirectory);if(error)throw new Error(error);});
app.setPath("sessionData", paths.session);
app.commandLine.appendSwitch("disable-http-cache");

const existingArchive = storage.archive.read();
let userArchive: UserArchive = existingArchive ? {
  ...existingArchive,
  settings: storage.settings.validate(existingArchive.settings),
} : {
  ...defaultUserArchive(storage.settings.read()),
  workspace: storage.state.readSync<Record<string, unknown>>("workspace") ?? {},
  lastDatasetSource: storage.state.readSync("last-dataset-source") ?? undefined,
  lastMedia: storage.state.readSync("last-media") ?? undefined,
  migrations: {legacyImportedAt:new Date().toISOString()},
};
if (!existingArchive) storage.archive.write(userArchive);
const resources = storage.openResourceCache(userArchive.settings.cacheLimitMB);
const updateUserArchive = (change: (current: UserArchive) => UserArchive) => {
  const next = change(userArchive);
  storage.archive.write(next);
  userArchive = next;
};
let cacheDrained = false;
app.on("will-quit", event => {
  if (cacheDrained) return;
  event.preventDefault();
  void screeningMigration.then(() => resources.drain()).finally(() => {
    cacheDrained = true;
    app.quit();
  });
});
app.on("second-instance", () => {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window) {
    if (app.isReady()) createWindow();
    return;
  }
  if (window.isMinimized()) window.restore();
  window.focus();
});
ipcMain.on("storage:bootstrap", event => {
  event.returnValue = { state: userArchive.workspace, directory: storage.paths.cache, settings: userArchive.settings };
});
ipcMain.on("settings:save", (event, value: unknown) => {
  try {
    const settings=storage.settings.validate(value);
    const previousLimit = userArchive.settings.cacheLimitMB;
    updateUserArchive(current=>({...current,settings}));
    if (settings.cacheLimitMB !== previousLimit) {
      void resources.setLimit(settings.cacheLimitMB * 1024 * 1024).catch(console.warn);
    }
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
ipcMain.handle("cache:usage", () => resources.usage());

const buildingCachePrefix = (source: string) => {
  if (typeof source !== "string" || source.length > 64 * 1024) throw new Error("建筑数据源无效");
  return createHash("sha256").update(source).digest("hex") + "-";
};
ipcMain.handle("cache:buildings-list", (_event, source: string) =>
  resources.recentKeys("buildings", buildingCachePrefix(source), userArchive.settings.buildingCacheLimitMB * 1024 * 1024));
ipcMain.handle("cache:buildings-read", (_event, source: string, key: string) => {
  if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) throw new Error("建筑缓存键无效");
  return resources.read<string>("buildings", buildingCachePrefix(source) + key);
});
ipcMain.handle("cache:buildings-write", (_event, source: string, batch: string) => {
  if (typeof batch !== "string" || Buffer.byteLength(batch) > 1024 * 1024) throw new Error("建筑缓存批次无效");
  const key = buildingCachePrefix(source) + createHash("sha256").update(batch).digest("hex");
  return resources.write("buildings", key, batch);
});
const mapResources = new MapResources(resources, (url, options) => net.fetch(url, options));
const loadMapResource = (url: string, direct = false) => mapResources.load(url, direct);
const mapConsumers = new Map<string, AbortController>();

app.on("web-contents-created", (_event, contents) => {
  const prefix = contents.id + ":";
  contents.once("destroyed", () => {
    for (const [key, controller] of mapConsumers) {
      if (key.startsWith(prefix)) { controller.abort(); mapConsumers.delete(key); }
    }
  });
});

ipcMain.handle("cache:map", async (event, rawUrl: string, requestId?: string) => {
  if (requestId === undefined) return loadMapResource(rawUrl);
  if (typeof requestId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(requestId)) throw new Error("地图请求编号无效");
  const key = event.sender.id + ":" + requestId;
  if (mapConsumers.has(key)) throw new Error("地图请求编号重复");
  const controller = new AbortController();
  mapConsumers.set(key, controller);
  try { return await mapResources.load(rawUrl, false, controller.signal); }
  catch (error) {
    // The renderer checks its signal before consuming bytes. A normal pan
    // cancellation should not become an Electron IPC error in the main log.
    if (controller.signal.aborted) return new Uint8Array();
    throw error;
  }
  finally { mapConsumers.delete(key); }
});
ipcMain.on("cache:map-cancel", (event, requestId: string) => {
  mapConsumers.get(event.sender.id + ":" + requestId)?.abort();
});
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
  const saved = await resources.read<{ at: number; data: Uint8Array }>("maps", AIRPORTS_CACHE_KEY);
  if (saved && !force && Date.now() - saved.at < 30 * 86400_000) {
    if (!userArchive.services.airportsUpdatedAt) {
      updateUserArchive(current=>({...current,services:{...current.services,airportsUpdatedAt:new Date(saved.at).toISOString()}}));
    }
    return new TextDecoder().decode(saved.data);
  }
  try {
    const response = await net.fetch(AIRPORTS_URL);
    if (!response.ok) throw new Error(`机场数据请求失败 (${response.status})`);
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength <= 32 * 1024 * 1024) {
      await resources.write("maps", AIRPORTS_CACHE_KEY, { at: Date.now(), data }).catch(console.warn);
    }
    updateUserArchive(current=>({...current,services:{...current.services,airportsUpdatedAt:new Date().toISOString()}}));
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
  const code = typeof icao === "string" ? icao.toUpperCase() : "";
  const url = buildAirportNameZhQueryUrl(code);
  const key = `airport-zh-${code.toLowerCase()}`;
  const saved = await resources.read<{ at: number; name: string | null }>("maps", key);
  if (saved) {
    const ttl = saved.name === null ? AIRPORT_ZH_NEGATIVE_TTL_MS : AIRPORT_ZH_TTL_MS;
    if (Date.now() - saved.at < ttl) return saved.name;
  }
  try {
    const response = await net.fetch(url, {
      headers: { Accept: "text/csv", "User-Agent": "replaymod-reality" },
    });
    if (!response.ok) throw new Error(`机场中文名请求失败 (${response.status})`);
    const name = pickChineseNameFromCsv(await response.text());
    await resources.write("maps", key, { at: Date.now(), name }).catch(console.warn);
    return name;
  } catch (error) {
    if (saved) return saved.name;
    throw error;
  }
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

const rememberDatasetSource = (mainFilePath: string, photoFilePath: string | null, key: string) => {
  const current = userArchive.lastDatasetSource;
  if (current?.mainFilePath === mainFilePath && current.photoFilePath === photoFilePath
    && userArchive.lastDatasetCacheKey === key) return;
  updateUserArchive(archive => ({ ...archive, lastDatasetSource: {mainFilePath, photoFilePath}, lastDatasetCacheKey: key }));
};

const isPhotoDataFile = (filePath: string) =>
  path.basename(filePath).toLowerCase().includes("photo");

const pointKey = (point: TimedCoordinate) =>
  `${point.timestamp}|${point.longitude.toFixed(6)}|${point.latitude.toFixed(6)}`;

const readLocationCsvSnapshot = async (
  mainFilePath: string,
  photoFilePath: string | null = null,
): Promise<{dataset:PointDataset;key:string}> => {
  const signature = ["point-parser-v2-accuracy-100m", ...await Promise.all([mainFilePath, photoFilePath].map(async file => {
    if (!file) return null;
    const info = await stat(file);
    return [file, info.size, info.mtimeMs];
  }))];
  const key = createHash("sha256").update(JSON.stringify(signature)).digest("hex");
  const saved = await resources.read<PointDataset>("snapshots", key);
  if (saved) {
    return {dataset:saved,key};
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
  await resources.write("snapshots", key, dataset).catch(console.warn);
  return {dataset,key};
};

// Only explicit activation updates the persistent application selection.
// Background slicing, filtering and verification can read snapshots independently.
const activateLocationCsv = async (mainFilePath:string,photoFilePath:string|null=null):Promise<PointDataset> => {
  const {dataset,key}=await readLocationCsvSnapshot(mainFilePath,photoFilePath);
  rememberDatasetSource(mainFilePath,photoFilePath,key);
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

let defaultDatasetPromise: Promise<PointDataset | null> | null = null;

const latestDatasetSource = async (previous:CsvPair|undefined):Promise<CsvPair|null> => {
  if(previous) {
    try {const pair=await findCsvPairInDirectory(path.dirname(previous.mainFilePath));if(pair)return pair;}catch { /* Try the standard data directories next. */ }
  }
  const directories=[...new Set([
    path.resolve(process.cwd(),"../RawData/footprint"),path.resolve(process.cwd(),"RawData/footprint"),
    path.resolve(app.getAppPath(),"RawData/footprint"),path.resolve(path.dirname(app.getPath("exe")),"RawData/footprint"),
  ])];
  const candidates: {pair:CsvPair;modified:number}[]=[];
  for(const directory of directories) {
    try {const pair=await findCsvPairInDirectory(directory);if(pair)candidates.push({pair,modified:(await stat(pair.mainFilePath)).mtimeMs});}catch { /* Optional directory. */ }
  }
  candidates.sort((a,b)=>b.modified-a.modified);
  return candidates[0]?.pair ?? null;
};
const datasetLookup={exists:(file:string)=>access(file).then(()=>true,()=>false),latest:latestDatasetSource};
const findDefaultCsvPair = ():Promise<CsvPair|null> => resolveDatasetSource(userArchive.lastDatasetSource,datasetLookup);

ipcMain.handle(
  LOAD_DEFAULT_LOCATION_CSV_CHANNEL,
  (): Promise<PointDataset | null> => {
    defaultDatasetPromise ??= restoreDataset(userArchive.lastDatasetSource,userArchive.lastDatasetCacheKey,{
      ...datasetLookup,
      cached:key=>resources.read<PointDataset>("snapshots",key),
      read:activateLocationCsv,
    }).finally(() => { defaultDatasetPromise = null; });

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
        ? activateLocationCsv(directoryPair.mainFilePath, selectedFilePath)
        : activateLocationCsv(selectedFilePath);
    }

    // The selected footprint file is authoritative. Previously this reused the
    // directory's newest main CSV, which made selecting the full table reopen a
    // newer Example_footprint.csv instead.
    return activateLocationCsv(
      selectedFilePath,
      directoryPair?.photoFilePath ?? null,
    );
  },
);

const confirmedFlightsPath = async (): Promise<string> => {
  const pair = await findDefaultCsvPair();
  if (!pair) throw new Error("未找到 RawData 轨迹数据目录。");
  const sourceDirectory = path.dirname(pair.mainFilePath);
  const rawDataDirectory = path.basename(sourceDirectory).toLowerCase() === "footprint"
    ? path.dirname(sourceDirectory)
    : sourceDirectory;
  const directory = path.join(rawDataDirectory, "flights");
  await mkdir(directory, { recursive: true });
  return path.join(directory, "confirmed-flights.json");
};

const readConfirmedFlights = async (): Promise<ConfirmedFlightsFile> => {
  if (userArchive.flights) return userArchive.flights;
  const target = await confirmedFlightsPath();
  try {
    const parsed = JSON.parse(await readFile(target, "utf8")) as ConfirmedFlightsFile;
    if (parsed.format !== "replaymod.confirmed-flights" || parsed.version !== 1 || !Array.isArray(parsed.flights)) {
      throw new Error("已确认航班文件格式无效。");
    }
    if (userArchive.flights) return userArchive.flights;
    updateUserArchive(current=>({...current,flights:parsed}));
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { format: "replaymod.confirmed-flights", version: 1, updatedAt: new Date(0).toISOString(), flights: [] };
  }
};

const writeConfirmedFlights = (document: ConfirmedFlightsFile): string => {
  updateUserArchive(current=>({...current,flights:document}));
  return storage.paths.archive;
};

ipcMain.handle("flights:confirmed-list", async () => (await readConfirmedFlights()).flights);
// 旧版渲染进程仍可能只认 confirmed-ids；两个 handler 同源并存，热更新期间不出现空窗。
ipcMain.handle("flights:confirmed-ids", async () => (await readConfirmedFlights()).flights.map(flight => flight.id));
let confirmedFlightSaveQueue: Promise<string> = Promise.resolve("");
ipcMain.handle("flights:confirm", async (_event, value: ConfirmedFlightRecord): Promise<string> => {
  if (!value || typeof value !== "object" || typeof value.id !== "string" || value.id.length > 200
    || !Number.isFinite(value.startTime) || !Number.isFinite(value.endTime)
    || !Array.isArray(value.departure?.coordinate) || !Array.isArray(value.arrival?.coordinate)) {
    throw new Error("航班确认数据无效。");
  }
  const save = confirmedFlightSaveQueue.catch(() => "").then(async () => {
    const current = await readConfirmedFlights();
    const flights = [...current.flights.filter(flight => flight.id !== value.id), value]
      .sort((a, b) => a.startTime - b.startTime);
    const document: ConfirmedFlightsFile = {
      format: "replaymod.confirmed-flights",
      version: 1,
      updatedAt: new Date().toISOString(),
      flights,
      screening: current.screening,
    };
    return writeConfirmedFlights(document);
  });
  confirmedFlightSaveQueue = save;
  return save;
});
ipcMain.handle("flights:delete-confirmed", async (_event, id: string): Promise<void> => {
  if (typeof id !== "string" || id.length === 0 || id.length > 200) throw new Error("航班标识无效。");
  const save = confirmedFlightSaveQueue.catch(() => "").then(async () => {
    const current = await readConfirmedFlights();
    const document: ConfirmedFlightsFile = {
      format: "replaymod.confirmed-flights",
      version: 1,
      updatedAt: new Date().toISOString(),
      flights: current.flights.filter(flight => flight.id !== id),
      screening: current.screening,
    };
    return writeConfirmedFlights(document);
  });
  confirmedFlightSaveQueue = save;
  await save;
});
const SCREENING_KEY = "last-run";
async function migrateScreeningCache() {
  const current = userArchive.flights;
  if (!current?.screening) return;
  const saved = await resources.read<FlightScreeningCache>("screening", SCREENING_KEY);
  if (!saved && !await resources.write("screening", SCREENING_KEY, current.screening)) return;
  if (userArchive.flights === current) {
    const { screening, ...flights } = current;
    writeConfirmedFlights(flights);
  }
}
const screeningMigration = migrateScreeningCache().catch(console.warn);
ipcMain.handle("flights:screening-cache", async () => {
  await screeningMigration;
  const saved = await resources.read<FlightScreeningCache>("screening", SCREENING_KEY);
  if (saved) return saved;
  // Some installations still have a standalone confirmed-flights.json.
  const { screening } = await readConfirmedFlights();
  if (screening) await migrateScreeningCache().catch(console.warn);
  return screening ?? null;
});
ipcMain.handle("flights:save-screening-cache", async (_event, cache: FlightScreeningCache): Promise<void> => {
  if (!cache || !Number.isFinite(cache.datasetStartTime) || !Number.isInteger(cache.pointCount)
    || cache.pointCount < 0 || !Number.isFinite(cache.throughTimestamp)
    || typeof cache.throughDay !== "string" || !Array.isArray(cache.groundElevations)
    || cache.groundElevations.length !== cache.pointCount || cache.pointCount > 20_000_000) {
    throw new Error("飞行识别进度无效。");
  }
  const save = confirmedFlightSaveQueue.catch(() => "").then(async () => {
    await screeningMigration;
    await readConfirmedFlights();
    await migrateScreeningCache();
    await resources.write("screening", SCREENING_KEY, cache);
    return storage.paths.cache;
  });
  confirmedFlightSaveQueue = save;
  await save;
});

ipcMain.handle("cache:media", async () => {
  let source = userArchive.lastMedia as MediaSource | undefined;
  if (!source) return null;
  try { await access(source.sourcePath); } catch { return null; }
  // Refresh timestamps: the file may have been aligned since the archive was saved.
  source = await probeMediaFile(source.sourcePath);
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

ipcMain.handle(PROCESS_GPS_CHANNEL,async (_event,request:MotionGpsRequest):Promise<MotionGpsResult>=>{
  if(!openedMediaPaths.has(request.sourcePath))throw new Error("请先载入该视频。");
  if(!Array.isArray(request.points)||request.points.length>100000||request.points.length<2)throw new Error("匹配视频时段的 GPS 样本不足或范围过大。");
  const source=await probeMediaFile(request.sourcePath);
  if(source.creationTimeSeconds===undefined)throw new Error("请先对齐视频拍摄时间。");
  const info=await stat(request.sourcePath);
  const key=createHash("sha256").update(JSON.stringify(["motion-gps-v2",request.sourcePath,info.size,info.mtimeMs,source.creationTimeSeconds,request.points])).digest("hex");
  const cached=await resources.read<MotionGpsResult>("snapshots",key);if(cached)return cached;
  const roots=[path.resolve(process.cwd(),".."),process.cwd(),app.getAppPath(),path.dirname(app.getPath("exe"))];
  const exiftool=await firstExistingPath(roots.flatMap(root=>[path.join(root,".tools/exiftool/exiftool"),path.join(root,".tools/exiftool/exiftool.exe")]));
  let orientation:Awaited<ReturnType<typeof extractDjiOrientation>>=[];
  try {orientation=await extractDjiOrientation(request.sourcePath,exiftool??"exiftool");}catch { /* GPS-only fallback remains usable. */ }
  const result=processMotionGps(orientation,request.points,source.creationTimeSeconds);
  const end=source.creationTimeSeconds+(source.durationSeconds??Infinity);
  result.points=result.points.filter(p=>p.timeSeconds>=source.creationTimeSeconds!&&p.timeSeconds<=end);
  if(result.points.length<2)throw new Error("GPS 与视频时间不重叠，请先完成时间对齐。");
  await resources.write("snapshots",key,result);
  return result;
});

const aligningMedia = new Set<string>();
ipcMain.handle(ALIGN_MEDIA_CHANNEL, async (_event, request: MediaAlignmentRequest): Promise<MediaAlignmentResult> => {
  const {sourcePath,offsetSeconds,points}=request;
  if(!openedMediaPaths.has(sourcePath))throw new Error("请先载入该视频。");
  if(!Number.isSafeInteger(offsetSeconds)||Math.abs(offsetSeconds)>86400)throw new Error("请输入一天以内的整数秒，可使用正负号。");
  if(aligningMedia.has(sourcePath))throw new Error("该视频正在对齐，请稍候。");
  if(!Array.isArray(points)||points.length>100000)throw new Error("轨迹数据无效。");
  aligningMedia.add(sourcePath);
  try {
    const source=await probeMediaFile(sourcePath);
    if(source.creationTimeSeconds===undefined)throw new Error("视频没有可用的拍摄时间，无法应用秒数偏移。");
    let alignment: MotionAlignmentResult={offsetSeconds,adjustmentSeconds:0,refined:false,reason:"已使用输入偏移。"};
    const roots=[path.resolve(process.cwd(),".."),process.cwd(),app.getAppPath(),path.dirname(app.getPath("exe"))];
    const exiftool=await firstExistingPath(roots.flatMap(root=>[path.join(root,".tools/exiftool/exiftool"),path.join(root,".tools/exiftool/exiftool.exe")]));
    try {
      const orientation=await extractDjiOrientation(sourcePath,exiftool??"exiftool");
      alignment=refineMotionAlignment(orientation,points.map(p=>({...p,timeSeconds:p.timeSeconds-source.creationTimeSeconds!})),offsetSeconds);
    } catch {
      alignment.reason="无法读取运动数据，已使用输入偏移。";
    }
    if(alignment.offsetSeconds===0)throw new Error("最终偏移为 0 秒，视频无需修改。");
    const saved=await shiftVideoTimestamps(sourcePath,alignment.offsetSeconds);
    const updated={...source,creationTimeSeconds:source.creationTimeSeconds+alignment.offsetSeconds};
    updateUserArchive(current=>({...current,lastMedia:updated}));
    return {...alignment,...saved,source:updated};
  } finally {aligningMedia.delete(sourcePath);}
});

ipcMain.handle(
  TRANSCRIBE_MEDIA_CHANNEL,
  async (event, sourcePath: string): Promise<SubtitleTrack> => {
    if (!openedMediaPaths.has(sourcePath)) throw new Error("请先在当前工程中载入该视频。");
    const source=await probeMediaFile(sourcePath);
    const result=await localSpeech.transcribe(sourcePath,source.durationSeconds??0,update=>{if(!event.sender.isDestroyed())event.sender.send("speech:progress",update);});
    return {kind:"subtitle",language:"zh",source:"speech-recognition",cues:result.sentences};
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

const audioDocuments = new Map<string, AudioDocument>();
const audioJobs = new Set<string>();
const recordedSources = new Map<string, number>();
async function validateAudioSources(blocks: AudioBlock[], root: AudioDocument) {
  for (const b of blocks) {
    if(b.sourcePath && b.sourcePath !== root.sourcePath) {
      if(!recordedSources.has(b.sourcePath)) {
        const actual = await realpath(b.sourcePath);
        if(actual !== path.resolve(b.sourcePath) || path.dirname(actual) !== storage.paths.recordings || !/^[a-f0-9-]+\.wav$/i.test(path.basename(actual))) throw new Error("录音素材尚未载入。");
        const media = await probeMediaFile(actual);
        if(!media.durationSeconds) throw new Error("录音素材没有有效时长。");
        recordedSources.set(actual,media.durationSeconds); openedMediaPaths.add(actual);
      }
      if(recordedSources.get(b.sourcePath) !== b.sourceDuration) throw new Error("录音素材时长无效。");
    }
    if(b.sourcePath === root.sourcePath && b.sourceDuration !== root.duration) throw new Error("素材时长无效。");
  }
}
ipcMain.handle("audio-edit:prepare", async (_event, sourcePath: string, blocks: AudioBlock[]) => {
  const root = audioDocuments.get(sourcePath); if(!root) throw new Error("请先导入素材。");
  validateAudioBlocks(blocks, root.duration, true); await validateAudioSources(blocks, root);
});
ipcMain.handle("audio-edit:recording", async (_event, sourcePath: string | null, bytes: Uint8Array) => {
  const existing = sourcePath ? audioDocuments.get(sourcePath) : undefined;
  if(sourcePath && !existing) throw new Error("请先导入素材。");
  await mkdir(storage.paths.recordings, {recursive:true});
  const output = path.join(storage.paths.recordings, `${randomUUID()}.wav`);
  await saveRecordedAudio(bytes, output);
  const media = await probeMediaFile(output);
  if(!media.durationSeconds) throw new Error("录音没有有效时长。");
  recordedSources.set(output,media.durationSeconds); openedMediaPaths.add(output);
  const doc: AudioDocument = existing ?? {sourcePath:output,sourceName:"空格录音",duration:media.durationSeconds,blocks:[]};
  if(!existing) audioDocuments.set(output,doc);
  const tokens: AudioBlock[] = [{id:randomUUID(),kind:"speech",level:"phrase",sourcePath:output,sourceDuration:media.durationSeconds,start:0,end:media.durationSeconds,text:"录音"}];
  return {document:doc,tokens};
});
ipcMain.handle("audio-edit:open", async (): Promise<AudioDocument | null> => {
  const result = await dialog.showOpenDialog({title: "导入音频或提取视频音轨", properties: ["openFile"], filters: [{name: "音频 / 视频", extensions: ["m4a", "mp3", "wav", "flac", "ogg", "aac", "mp4", "mov", "mkv", "webm"]}]});
  if (result.canceled || !result.filePaths[0]) return null;
  const media = await probeMediaFile(result.filePaths[0]);
  if (!media.tracks.some(t => t.kind === "audio") || !media.durationSeconds) throw new Error("文件没有可用音轨或时长。");
  const doc: AudioDocument = {sourcePath: media.sourcePath, sourceName: media.sourceName, duration: media.durationSeconds, blocks: []};
  audioDocuments.set(doc.sourcePath, doc);
  openedMediaPaths.add(doc.sourcePath);
  return doc;
});
ipcMain.handle("audio-edit:transcribe", async (event, sourcePath: string, granularity: "word" | "phrase") => {
  const doc = audioDocuments.get(sourcePath);
  if (!doc) throw new Error("请先导入音频。");
  if (audioJobs.has(sourcePath)) throw new Error("该文件正在处理。");
  if (!["word", "phrase"].includes(granularity)) throw new Error("分块方式无效。");
  audioJobs.add(sourcePath);
  try {
    const result=await localSpeech.transcribe(sourcePath,doc.duration,update=>{if(!event.sender.isDestroyed())event.sender.send("speech:progress",update);});
    doc.blocks = coarseAudioBlocks(granularity==="word"?result.words:result.sentences, doc.duration, randomUUID);
    return doc.blocks;
  } finally { audioJobs.delete(sourcePath); }
});
ipcMain.handle("audio-edit:split", async (event, sourcePath: string, block: AudioBlock): Promise<AudioBlock[]> => {
  const doc = audioDocuments.get(sourcePath);
  if (!doc) throw new Error("请先导入音频。");
  await validateAudioSources([block], doc);
  validateAudioBlocks([block], doc.duration);
  if (block.kind === "silence" || block.kind === "extension") return [];
  if (audioJobs.has(sourcePath)) throw new Error("该素材正在处理，请稍候。");
  audioJobs.add(sourcePath);
  try {
    const result=await localSpeech.transcribe(block.sourcePath??sourcePath,block.sourceDuration??doc.duration,update=>{if(!event.sender.isDestroyed())event.sender.send("speech:progress",update);});
    const words=result.words.filter(c=>c.startTimeSeconds<block.end && c.endTimeSeconds>block.start).map(c=>({...c,startTimeSeconds:Math.max(0,c.startTimeSeconds-block.start),endTimeSeconds:Math.min(block.end,c.endTimeSeconds)-block.start}));
    return refineAudioBlock(block,words,randomUUID);
  } finally {audioJobs.delete(sourcePath);}
});
ipcMain.handle("audio-edit:export", async (_event, sourcePath: string, blocks: AudioBlock[]) => {
  const doc = audioDocuments.get(sourcePath);
  if (!doc) throw new Error("请先导入音频。");
  await validateAudioSources(blocks, doc);
  validateAudioBlocks(blocks, doc.duration);
  const result = await dialog.showSaveDialog({title: "导出 token 音频及同名字幕", defaultPath: `${path.parse(doc.sourceName).name}.edited.wav`, filters: [{name: "WAV 音频", extensions: ["wav"]}]});
  if (result.canceled || !result.filePath) return null;
  const output = result.filePath;
  if (path.resolve(output) === path.resolve(sourcePath)) throw new Error("不能覆盖原始音频。");
  await renderAudioEdit(sourcePath, blocks, doc.duration, output);
  const base = output.replace(/\.[^.]+$/, "");
  await writeFile(`${base}.srt`, serializeSrt(audioOutputCues(blocks)));
  await writeFile(`${base}.audio-edit.json`, JSON.stringify({version: 1, sourcePath, tokens: blocks}, null, 2));
  return output;
});

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
  installMediaPreviewProtocol(openedMediaPaths);
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
