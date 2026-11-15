import type {LocalSpeechStatus,LocalSpeechUpdate} from "../shared/localSpeech";
import type { AudioDocument, AudioBlock } from "../../../../packages/media/src/audio-document";
import type { OfflineExportOptions, OfflineExportSession, OfflineExportSegment } from "../shared/overlayExport";
import type { DisplayHDRInfo } from "../shared/display";
import { contextBridge, ipcRenderer } from "electron";
import type { AppSettings } from "../shared/settings";
import type { ConfirmedFlightRecord, FlightScreeningCache } from "../shared/confirmedFlight";
import { SCROLL_SOURCE_CHANNEL, type ScrollSource } from "../shared/scrollInput";
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
  getLocalSpeechStatus(): Promise<LocalSpeechStatus>;
  downloadSpeechModel(id:string): Promise<LocalSpeechStatus>;
  selectSpeechModel(role:"asr"|"aligner",id:string): Promise<LocalSpeechStatus>;
  addSpeechModelFolder(): Promise<LocalSpeechStatus|null>;
  openSpeechModelDirectory(): Promise<void>;
  onLocalSpeechProgress(listener:(update:LocalSpeechUpdate)=>void):()=>void;
  prepareAudioEdit(sourcePath: string, blocks: AudioBlock[]): Promise<void>;
  saveAudioRecording(sourcePath: string | null, bytes: Uint8Array): Promise<{document: AudioDocument; tokens: AudioBlock[]}>;
  openAudioEdit(): Promise<AudioDocument | null>;
  transcribeAudioEdit(sourcePath: string, granularity: "word" | "phrase"): Promise<AudioBlock[]>;
  splitAudioEdit(sourcePath: string, block: AudioBlock): Promise<AudioBlock[]>;
  exportAudioEdit(sourcePath: string, blocks: AudioBlock[]): Promise<string | null>;
  canExportOffline(): Promise<boolean>;
  beginOfflineExport(options: OfflineExportOptions): Promise<OfflineExportSession | null>;
  writeOfflineExportFrame(id: string, segment: number, frame: number, rgba: Uint8Array): Promise<void>;
  finishOfflineExportSegment(id: string, segment: number): Promise<OfflineExportSegment>;
  completeOfflineExport(id: string): Promise<string[]>;
  cancelOfflineExport(id: string): Promise<void>;
  getDisplayHDR(): Promise<DisplayHDRInfo | null>;
  readonly settings: AppSettings;
  saveSettings(settings: AppSettings): string | null;
  onMenuAction(listener: (action: MenuAction) => void): () => void;
  updateMenuState(state: MenuState): void;
  onScrollSource(listener: (source: ScrollSource) => void): () => void;
  readonly workspaceState: Record<string, unknown>;
  readonly cacheDirectory: string;
  saveWorkspaceState(state: Record<string, unknown>): string | null;
  openCacheDirectory(): Promise<string>;
  getCacheUsage(): Promise<{ bytes: number; entries: number }>;
  listBuildingCache(source: string): Promise<string[]>;
  readBuildingCache(source: string, key: string): Promise<string | null>;
  writeBuildingCache(source: string, batch: string): Promise<boolean>;
  loadCachedMedia(): Promise<MediaSource | null>;
  loadMapResource(url: string): Promise<Uint8Array>;
  loadMapResources(urls: readonly string[]): Promise<Uint8Array[]>;
  loadAnnotations(): Promise<{name:string; content:string} | null>;
  openAnnotations(): Promise<{name:string; content:string} | null>;
  saveAnnotations(content: string): Promise<void>;
  exportAnnotations(content: string, format: "json" | "kml"): Promise<string | null>;
  readonly platform: NodeJS.Platform;
  readonly appVersion: string;
  loadDefaultLocationCsv(): Promise<PointDataset | null>;
  openLocationCsv(): Promise<PointDataset | null>;
  loadAirports(force?: boolean): Promise<string>;
  loadAirportNameZh(icao: string): Promise<string | null>;
  loadConfirmedFlights(): Promise<ConfirmedFlightRecord[]>;
  /** @deprecated 旧桥兼容，等同 loadConfirmedFlights 后取 id；新代码用前者。 */
  loadConfirmedFlightIds(): Promise<string[]>;
  confirmFlight(flight: ConfirmedFlightRecord): Promise<string>;
  deleteConfirmedFlight(id: string): Promise<void>;
  loadFlightScreeningCache(): Promise<FlightScreeningCache | null>;
  saveFlightScreeningCache(cache: FlightScreeningCache): Promise<void>;
  openMedia(): Promise<MediaSource | null>;
  transcribeMedia(sourcePath: string): Promise<SubtitleTrack>;
  saveSubtitles(sourcePath: string, track: SubtitleTrack): Promise<SavedSubtitleTrack>;
}

const bootstrap = ipcRenderer.sendSync("storage:bootstrap");
const bridge: DesktopBridge = Object.freeze({
  getLocalSpeechStatus: () => ipcRenderer.invoke("speech:status"),
  downloadSpeechModel: (id:string) => ipcRenderer.invoke("speech:download",id),
  selectSpeechModel: (role:"asr"|"aligner",id:string) => ipcRenderer.invoke("speech:select",role,id),
  addSpeechModelFolder: () => ipcRenderer.invoke("speech:folder"),
  openSpeechModelDirectory: () => ipcRenderer.invoke("speech:open-directory"),
  onLocalSpeechProgress: (listener:(update:LocalSpeechUpdate)=>void) => {
    const handler=(_event:Electron.IpcRendererEvent,update:LocalSpeechUpdate)=>listener(update);
    ipcRenderer.on("speech:progress",handler);return ()=>ipcRenderer.removeListener("speech:progress",handler);
  },
  prepareAudioEdit: (sourcePath: string, blocks: AudioBlock[]) => ipcRenderer.invoke("audio-edit:prepare", sourcePath, blocks),
  saveAudioRecording: (sourcePath: string | null, bytes: Uint8Array) => ipcRenderer.invoke("audio-edit:recording", sourcePath, bytes),
  openAudioEdit: () => ipcRenderer.invoke("audio-edit:open"),
  transcribeAudioEdit: (sourcePath: string, granularity: "word" | "phrase") => ipcRenderer.invoke("audio-edit:transcribe", sourcePath, granularity),
  splitAudioEdit: (sourcePath: string, block: AudioBlock) => ipcRenderer.invoke("audio-edit:split", sourcePath, block),
  exportAudioEdit: (sourcePath: string, blocks: AudioBlock[]) => ipcRenderer.invoke("audio-edit:export", sourcePath, blocks),
  canExportOffline: () => ipcRenderer.invoke("export:offline-available"),
  beginOfflineExport: (options: OfflineExportOptions) => ipcRenderer.invoke("export:offline-begin", options),
  writeOfflineExportFrame: (id: string, segment: number, frame: number, rgba: Uint8Array) => ipcRenderer.invoke("export:offline-frame", id, segment, frame, rgba),
  finishOfflineExportSegment: (id: string, segment: number) => ipcRenderer.invoke("export:offline-segment", id, segment),
  completeOfflineExport: (id: string) => ipcRenderer.invoke("export:offline-complete", id),
  cancelOfflineExport: (id: string) => ipcRenderer.invoke("export:offline-cancel", id),
  getDisplayHDR: () => ipcRenderer.invoke("display:hdr"),
  settings: bootstrap.settings,
  saveSettings: (settings: AppSettings) => ipcRenderer.sendSync("settings:save", settings),
  onMenuAction: (listener: (action: MenuAction) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: MenuAction) => listener(action);
    ipcRenderer.on(MENU_ACTION_CHANNEL, handler);
    return () => { ipcRenderer.removeListener(MENU_ACTION_CHANNEL, handler); };
  },
  updateMenuState: (state: MenuState) => ipcRenderer.send(MENU_STATE_CHANNEL, state),
  onScrollSource: (listener: (source: ScrollSource) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, source: ScrollSource) => listener(source);
    ipcRenderer.on(SCROLL_SOURCE_CHANNEL, handler);
    return () => { ipcRenderer.removeListener(SCROLL_SOURCE_CHANNEL, handler); };
  },
  workspaceState: bootstrap.state,
  cacheDirectory: bootstrap.directory,
  saveWorkspaceState: (state: Record<string, unknown>) => ipcRenderer.sendSync("workspace:save", state),
  openCacheDirectory: () => ipcRenderer.invoke("cache:open"),
  getCacheUsage: () => ipcRenderer.invoke("cache:usage"),
  listBuildingCache: (source: string) => ipcRenderer.invoke("cache:buildings-list", source),
  readBuildingCache: (source: string, key: string) => ipcRenderer.invoke("cache:buildings-read", source, key),
  writeBuildingCache: (source: string, batch: string) => ipcRenderer.invoke("cache:buildings-write", source, batch),
  loadCachedMedia: () => ipcRenderer.invoke("cache:media"),
  loadMapResource: (url: string) => ipcRenderer.invoke("cache:map", url),
  loadMapResources: (urls: readonly string[]) => ipcRenderer.invoke("cache:map-batch", urls),
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
  loadAirports: (force = false) =>
    ipcRenderer.invoke("data:airports", force) as Promise<string>,
  loadAirportNameZh: (icao: string) =>
    ipcRenderer.invoke("data:airport-name-zh", icao) as Promise<string | null>,
  loadConfirmedFlights: () => ipcRenderer.invoke("flights:confirmed-list") as Promise<ConfirmedFlightRecord[]>,
  loadConfirmedFlightIds: () => ipcRenderer.invoke("flights:confirmed-ids") as Promise<string[]>,
  confirmFlight: (flight: ConfirmedFlightRecord) => ipcRenderer.invoke("flights:confirm", flight) as Promise<string>,
  deleteConfirmedFlight: (id: string) => ipcRenderer.invoke("flights:delete-confirmed", id) as Promise<void>,
  loadFlightScreeningCache: () => ipcRenderer.invoke("flights:screening-cache") as Promise<FlightScreeningCache | null>,
  saveFlightScreeningCache: (cache: FlightScreeningCache) => ipcRenderer.invoke("flights:save-screening-cache", cache) as Promise<void>,
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
