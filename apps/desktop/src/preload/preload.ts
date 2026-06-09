import { contextBridge } from "electron";

export interface DesktopBridge {
  readonly platform: NodeJS.Platform;
  readonly appVersion: string;
}

const bridge: DesktopBridge = Object.freeze({
  platform: process.platform,
  appVersion: "0.1.0",
});

contextBridge.exposeInMainWorld("replaymod", bridge);
