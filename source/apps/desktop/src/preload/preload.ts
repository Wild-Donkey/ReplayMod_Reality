import { contextBridge, ipcRenderer } from "electron";
import type { AppSettings } from "../shared/settings";
import { MENU_ACTION_CHANNEL, MENU_STATE_CHANNEL, type MenuAction, type MenuState } from "../shared/menu";
import type { PointDataset } from "../../../../packages/data/src";
import type {
  MediaSource,
  SavedSubtitleTrack,
  SubtitleTrack,
} from "../../../../packages/media/src";

const OPEN_LOCATION_CSV_CHANNEL = "data:open-location-csv";
const LOAD_DEFAULT_LOCATION_CSV_CHANNEL = "data:load-default-location-csv";
const OPEN_MEDIA_CHANNEL = "media:open";
const TRANSCRIBE_MEDIA_CHANNEL = "media:transcribe";
const SAVE_SUBTITLES_CHANNEL = "media:save-subtitles";

export interface DesktopBridge {
  readonly settings: AppSettings;
  saveSettings(settings: AppSettings): string | null;
  onMenuAction(listener: (action: MenuAction) => void): () => void;
  updateMenuState(state: MenuState): void;
  readonly workspaceState: Record<string, unknown>;
  readonly cacheDirectory: string;
  saveWorkspaceState(state: Record<string, unknown>): string | null;
  openCacheDirectory(): Promise<string>;
  loadCachedMedia(): Promise<MediaSource | null>;
  loadMapResource(url: string): Promise<Uint8Array>;
  loadAnnotations(): Promise<{name:string; content:string} | null>;
  openAnnotations(): Promise<{name:string; content:string} | null>;
  saveAnnotations(content: string): Promise<void>;
  exportAnnotations(content: string, format: "json" | "kml"): Promise<string | null>;
  readonly platform: NodeJS.Platform;
  readonly appVersion: string;
  loadDefaultLocationCsv(): Promise<PointDataset | null>;
  openLocationCsv(): Promise<PointDataset | null>;
  openMedia(): Promise<MediaSource | null>;
  transcribeMedia(sourcePath: string): Promise<SubtitleTrack>;
  saveSubtitles(sourcePath: string, track: SubtitleTrack): Promise<SavedSubtitleTrack>;
}

const bootstrap = ipcRenderer.sendSync("storage:bootstrap");
const bridge: DesktopBridge = Object.freeze({
  settings: bootstrap.settings,
  saveSettings: (settings: AppSettings) => ipcRenderer.sendSync("settings:save", settings),
  onMenuAction: (listener: (action: MenuAction) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: MenuAction) => listener(action);
    ipcRenderer.on(MENU_ACTION_CHANNEL, handler);
    return () => { ipcRenderer.removeListener(MENU_ACTION_CHANNEL, handler); };
  },
  updateMenuState: (state: MenuState) => ipcRenderer.send(MENU_STATE_CHANNEL, state),
  workspaceState: bootstrap.state,
  cacheDirectory: bootstrap.directory,
  saveWorkspaceState: (state: Record<string, unknown>) => ipcRenderer.sendSync("workspace:save", state),
  openCacheDirectory: () => ipcRenderer.invoke("cache:open"),
  loadCachedMedia: () => ipcRenderer.invoke("cache:media"),
  loadMapResource: (url: string) => ipcRenderer.invoke("cache:map", url),
  loadAnnotations: () => ipcRenderer.invoke("annotations:load"),
  openAnnotations: () => ipcRenderer.invoke("annotations:open"),
  saveAnnotations: (content: string) => ipcRenderer.invoke("annotations:save", content),
  exportAnnotations: (content: string, format: "json" | "kml") => ipcRenderer.invoke("annotations:export",content,format),
  platform: process.platform,
  appVersion: "0.1.0",
  loadDefaultLocationCsv: () =>
    ipcRenderer.invoke(
      LOAD_DEFAULT_LOCATION_CSV_CHANNEL,
    ) as Promise<PointDataset | null>,
  openLocationCsv: () =>
    ipcRenderer.invoke(OPEN_LOCATION_CSV_CHANNEL) as Promise<PointDataset | null>,
  openMedia: () => ipcRenderer.invoke(OPEN_MEDIA_CHANNEL) as Promise<MediaSource | null>,
  transcribeMedia: (sourcePath: string) =>
    ipcRenderer.invoke(TRANSCRIBE_MEDIA_CHANNEL, sourcePath) as Promise<SubtitleTrack>,
  saveSubtitles: (sourcePath: string, track: SubtitleTrack) =>
    ipcRenderer.invoke(
      SAVE_SUBTITLES_CHANNEL,
      sourcePath,
      track,
    ) as Promise<SavedSubtitleTrack>,
});

contextBridge.exposeInMainWorld("replaymod", bridge);
