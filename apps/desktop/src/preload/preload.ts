import { contextBridge, ipcRenderer } from "electron";
import type { PointDataset } from "../../../../packages/data/src";

const OPEN_LOCATION_CSV_CHANNEL = "data:open-location-csv";

export interface DesktopBridge {
  readonly platform: NodeJS.Platform;
  readonly appVersion: string;
  openLocationCsv(): Promise<PointDataset | null>;
}

const bridge: DesktopBridge = Object.freeze({
  platform: process.platform,
  appVersion: "0.1.0",
  openLocationCsv: () =>
    ipcRenderer.invoke(OPEN_LOCATION_CSV_CHANNEL) as Promise<PointDataset | null>,
});

contextBridge.exposeInMainWorld("replaymod", bridge);
