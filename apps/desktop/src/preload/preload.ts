import { contextBridge, ipcRenderer } from "electron";
import type { PointDataset } from "../../../../packages/data/src";

const OPEN_LOCATION_CSV_CHANNEL = "data:open-location-csv";
const LOAD_DEFAULT_LOCATION_CSV_CHANNEL = "data:load-default-location-csv";

export interface DesktopBridge {
  readonly platform: NodeJS.Platform;
  readonly appVersion: string;
  loadDefaultLocationCsv(): Promise<PointDataset | null>;
  openLocationCsv(): Promise<PointDataset | null>;
}

const bridge: DesktopBridge = Object.freeze({
  platform: process.platform,
  appVersion: "0.1.0",
  loadDefaultLocationCsv: () =>
    ipcRenderer.invoke(
      LOAD_DEFAULT_LOCATION_CSV_CHANNEL,
    ) as Promise<PointDataset | null>,
  openLocationCsv: () =>
    ipcRenderer.invoke(OPEN_LOCATION_CSV_CHANNEL) as Promise<PointDataset | null>,
});

contextBridge.exposeInMainWorld("replaymod", bridge);
