import { createReadStream } from "node:fs";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import { parse } from "csv-parse";
import type {
  CoordinateBounds,
  PointDataset,
} from "../../../../packages/data/src";

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

const OPEN_LOCATION_CSV_CHANNEL = "data:open-location-csv";

const readLocationCsv = async (filePath: string): Promise<PointDataset> => {
  const footprintCoordinates: number[] = [];
  const photoCoordinates: number[] = [];
  let skippedRowCount = 0;
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;

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

    if (
      !Number.isFinite(longitude) ||
      !Number.isFinite(latitude) ||
      longitude < -180 ||
      longitude > 180 ||
      latitude < -90 ||
      latitude > 90
    ) {
      skippedRowCount += 1;
      continue;
    }

    if (stepType === 1) {
      photoCoordinates.push(longitude, latitude);
    } else {
      footprintCoordinates.push(longitude, latitude);
    }

    west = Math.min(west, longitude);
    south = Math.min(south, latitude);
    east = Math.max(east, longitude);
    north = Math.max(north, latitude);
  }

  const pointCount =
    (footprintCoordinates.length + photoCoordinates.length) / 2;

  if (pointCount === 0) {
    throw new Error("CSV 中没有找到有效的 longitude / latitude 坐标。");
  }

  const bounds: CoordinateBounds = [west, south, east, north];

  return {
    sourceName: path.basename(filePath),
    footprintCoordinates,
    photoCoordinates,
    pointCount,
    footprintPointCount: footprintCoordinates.length / 2,
    photoPointCount: photoCoordinates.length / 2,
    skippedRowCount,
    bounds,
  };
};

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

    const filePath = result.filePaths[0];

    if (result.canceled || !filePath) {
      return null;
    }

    return readLocationCsv(filePath);
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
