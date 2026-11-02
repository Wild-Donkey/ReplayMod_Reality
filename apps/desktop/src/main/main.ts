import { createReadStream } from "node:fs";
import { access, readdir, stat, writeFile } from "node:fs/promises";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
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
const OPEN_MEDIA_CHANNEL = "media:open";
const TRANSCRIBE_MEDIA_CHANNEL = "media:transcribe";
const SAVE_SUBTITLES_CHANNEL = "media:save-subtitles";

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
  const roots = [process.cwd(), app.getAppPath(), path.dirname(app.getPath("exe"))];
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

const isPhotoDataFile = (filePath: string) =>
  path.basename(filePath).toLowerCase().includes("photo");

const pointKey = (point: TimedCoordinate) =>
  `${point.timestamp}|${point.longitude.toFixed(6)}|${point.latitude.toFixed(6)}`;

const readLocationCsv = async (
  mainFilePath: string,
  photoFilePath: string | null = null,
): Promise<PointDataset> => {
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

  return {
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
    path.resolve(process.cwd(), "RawData"),
    path.resolve(app.getAppPath(), "RawData"),
    path.resolve(path.dirname(app.getPath("exe")), "RawData"),
  ];
  const uniqueDirectories = [...new Set(candidateDirectories)];
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

ipcMain.handle(
  LOAD_DEFAULT_LOCATION_CSV_CHANNEL,
  (): Promise<PointDataset | null> => {
    defaultDatasetPromise ??= (async () => {
      const pair = await findLatestRawDataCsvPair();
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

    const pair = await findCsvPairInDirectory(path.dirname(selectedFilePath));

    if (!pair) {
      return readLocationCsv(selectedFilePath);
    }

    return readLocationCsv(pair.mainFilePath, pair.photoFilePath);
  },
);

ipcMain.handle(OPEN_MEDIA_CHANNEL, async (): Promise<MediaSource | null> => {
  const result = await dialog.showOpenDialog({
    title: "载入 DJI 视频",
    properties: ["openFile"],
    filters: [{ name: "视频", extensions: ["mp4", "mov"] }],
  });
  const selectedFilePath = result.filePaths[0];

  if (result.canceled || !selectedFilePath) return null;
  openedMediaPaths.add(selectedFilePath);
  return probeMediaFile(selectedFilePath);
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

const createWindow = (): void => {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: "#111318",
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
