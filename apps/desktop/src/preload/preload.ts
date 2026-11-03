import { contextBridge, ipcRenderer } from "electron";
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

const bridge: DesktopBridge = Object.freeze({
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
