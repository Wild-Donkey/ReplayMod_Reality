import { HDRSettings } from "../features/settings/HDRSettings";
import { defaultTimelineMetrics, type TimelineMetricsSettings } from "../features/timeline/metrics";
import { useCachedState, readCached, writeCached, cacheError } from "../shared/cache";
import type { AnnotationProject, MapCoordinate } from "../../../../../packages/data/src";
import type { TerrainProfilePoint } from "../features/map/elevation";
import type { AppSettings, MapLanguage } from "../../shared/settings";
import { AnnotationPanel } from "../features/annotations/AnnotationPanel";
import { ElevationProfile } from "../features/annotations/ElevationProfile";
import { emptyAnnotations, parseAnnotationProject, serializeAnnotationProject } from "../features/annotations/annotations";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointDataset, TimeBounds } from "../../../../../packages/data/src";
import type { MediaSource, SubtitleTrack } from "../../../../../packages/media/src";
import { MapTokenSetup, MapViewport } from "../features/map/MapViewport";
import { OverlayExport } from "../features/export/OverlayExport";
import { SubtitleEditor } from "../features/subtitles/SubtitleEditor";
import { FlightPanel } from "../features/flights/FlightPanel";
import { defaultLayerVisibility, renderLayerLabels, type RenderLayerId } from "../render-engine/LayerVisibility";
import {
  Timeline,
  type TimelineFocusRequest,
} from "../features/timeline/Timeline";
import { ReplayScene } from "../render-engine/ReplayScene";
import { ReplayPlayback } from "../render-engine/ReplayPlayback";
import { compileAnnotationGeometry } from "../render-engine/AnnotationGeometry";
import { ReplayRenderSurface } from "../render-engine/ReplayRenderSurface";
import { TrajectoryBuffer } from "../render-engine/buffers/TrajectoryBuffer";
import type { FlightRouteSegment } from "../features/map/flights";

type WorkspaceTab = "annotations" | "sources" | "flights" | "export" | "settings";
const tabs: {id: WorkspaceTab; label: string; path: string}[] = [
  {id: "annotations", label: "地图标注", path: "M12 21s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12Z M15 9a3 3 0 1 1-6 0 3 3 0 0 1 6 0"},
  {id: "sources", label: "数据与视频", path: "M3 7h7l2 2h9v11H3Z M3 7V4h7l2 3 M10 12l5 3-5 3Z"},
  {id: "flights", label: "航行", path: "M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5Z"},
  {id: "export", label: "叠加导出", path: "M4 14v6h16v-6 M12 16V3 M7 8l5-5 5 5"},
  {id: "settings", label: "设置", path: "M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6"},
];

const PanelHeader = ({
  title,
  action,
  onAction,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
}) => (
  <header className="panel-header">
    <span>{title}</span>
    {action && (
      <button
        className="icon-button"
        type="button"
        aria-label={action}
        onClick={onAction}
      >
        {action}
      </button>
    )}
  </header>
);

export function App() {
  const [layerVisibility, setLayerVisibility] = useCachedState("render-layer-visibility", defaultLayerVisibility);
  const replaySceneRef = useRef<ReplayScene | null>(null);
  if (!replaySceneRef.current) replaySceneRef.current = new ReplayScene();
  const replayScene = replaySceneRef.current;
  useEffect(() => replayScene.setVisibility(layerVisibility), [replayScene, layerVisibility]);
  const syncReplayMapView = useCallback((viewState: import("../render-engine/ReplayCamera").ReplayCamera) => {
    replayScene.setMapViewState(viewState);
  }, [replayScene]);
  const syncReplayTimelineHover = useCallback((timestamp: number | null) => {
    replayScene.setCursorTime("timeline", timestamp);
  }, [replayScene]);
  const [mapLegendContainer, setMapLegendContainer] = useState<HTMLDivElement | null>(null);
  const [timelineMetrics, setTimelineMetrics] = useCachedState<TimelineMetricsSettings>("timeline-metrics", defaultTimelineMetrics);
  const [activeTab, setActiveTab] = useCachedState<WorkspaceTab>("workspace-tab", "annotations");
  const [leftPanelCollapsed, setLeftPanelCollapsed] = useCachedState("left-panel-collapsed", false);
  const [bottomPanelCollapsed, setBottomPanelCollapsed] = useCachedState("bottom-panel-collapsed", false);
  useEffect(() => { if (bottomPanelCollapsed) replayScene.setCursor(null); }, [bottomPanelCollapsed, replayScene]);
  const [keyDraft, setKeyDraft] = useState("");
  const [settingsStatus, setSettingsStatus] = useState("");
  const [annotations, setAnnotations] = useState<AnnotationProject>(emptyAnnotations());
  const [annotationsReady,setAnnotationsReady] = useState(false);
  const [annotationStatus,setAnnotationStatus] = useState("正在载入地图标注…");
  const [annotationSelectedId,setAnnotationSelectedId] = useCachedState<string|null>("annotationSelectedId", null);
  const [annotationFocus,setAnnotationFocus] = useState<{id:string;sequence:number}|null>(null);
  const syncElevationHover = useCallback((coordinate: TerrainProfilePoint | null) => {
    replayScene.setCursor(coordinate ? {
      source: "elevation", timestamp: null, trajectoryIndex: null,
      coordinate: [coordinate[0], coordinate[1]],
    } : null);
  }, [replayScene]);
  const [annotationElevationProfile,setAnnotationElevationProfile] = useState<TerrainProfilePoint[]|null|undefined>(undefined);
  const selectedRoute = annotations.nodes.find(node => node.id === annotationSelectedId && node.kind === "route");
  useEffect(()=>{replayScene.setCursor(null);},[annotationSelectedId, replayScene]);
  const [drawMode,setDrawMode] = useCachedState<"select"|"point"|"route">("drawMode", "select");
  const [draftCoordinates,setDraftCoordinates] = useCachedState<MapCoordinate[]>("draftCoordinates", []);
  useEffect(() => {
    replayScene.setAnnotationGeometry(compileAnnotationGeometry(annotations, annotationSelectedId, draftCoordinates));
  }, [annotations, annotationSelectedId, draftCoordinates, replayScene]);
  useEffect(()=>{
    let active=true;
    if(!window.replaymod){setAnnotationStatus("请在桌面应用中打开地图标注");return;}
    window.replaymod.loadAnnotations().then(file=>{
      if(!active)return;
      if(file)setAnnotations(parseAnnotationProject(file.content,file.name));
      setAnnotationsReady(true);setAnnotationStatus("地图标注已载入");
    }).catch((e:unknown)=>{if(active)setAnnotationStatus(`载入失败：${e instanceof Error?e.message:String(e)}`);});
    return()=>{active=false;};
  },[]);
  useEffect(()=>{
    if(!annotationsReady)return;
    let active=true;setAnnotationStatus("有更改，等待保存…");
    const timer=window.setTimeout(()=>{
      window.replaymod!.saveAnnotations(serializeAnnotationProject(annotations)).then(()=>{if(active)setAnnotationStatus("已自动保存到本机");}).catch((e:unknown)=>{if(active)setAnnotationStatus(`保存失败：${e instanceof Error?e.message:String(e)}`);});
    },600);
    return()=>{active=false;window.clearTimeout(timer);};
  },[annotations,annotationsReady]);
  const selectAnnotation = (id:string|null) => {
    setAnnotationSelectedId(id);
    setCurrentTime(null);
    setTimelineFocusRequest(null);
    if(!id)replayScene.setCursor(null);
  };
  const focusAnnotation = (id:string) => setAnnotationFocus({id,sequence:Date.now()});
  const addAnnotation = (coordinates:MapCoordinate[],kind:"point"|"route") => {
    if(!annotationsReady)return;
    const selected=annotations.nodes.find(n=>n.id===annotationSelectedId);
    const id=crypto.randomUUID();
    setAnnotations(p=>({...p,nodes:[...p.nodes,{id,parentId:selected?.kind==="folder"?selected.id:selected?.parentId??null,kind,name:kind==="point"?"新建地标":"新建路线",description:"",visible:true,open:false,coordinates,color:"#55cfff"}]}));
    setAnnotationSelectedId(id);setDraftCoordinates([]);setDrawMode("select");
  };
  const finishRoute = () => {if(draftCoordinates.length>=2)addAnnotation(draftCoordinates,"route");};
  const [pointDataset, setPointDataset] = useState<PointDataset | null>(null);
  const [flightRoutes, setFlightRoutes] = useState<readonly (readonly [number, number])[][]>([]);
  const [flightRouteSegments, setFlightRouteSegments] = useState<readonly FlightRouteSegment[]>([]);
  const [flightAirports, setFlightAirports] = useState<readonly (readonly [number, number])[]>([]);
  useEffect(() => {
    setFlightRoutes([]);
    setFlightRouteSegments([]);
    setFlightAirports([]);
  }, [pointDataset, replayScene]);
  useEffect(() => {
    replayScene.setTrajectory(pointDataset
      ? TrajectoryBuffer.fromPointDatasetWithFlightRoutes(pointDataset, flightRouteSegments)
      : null);
  }, [pointDataset, flightRouteSegments, replayScene]);
  const [currentTime, displayCurrentTime] = useState<number | null>(() => readCached("currentTime", null));
  const [playing, setPlaying] = useState(false);
  const playbackRef = useRef<ReplayPlayback | null>(null);
  const setCurrentTime = useCallback((time: number | null) => {
    playbackRef.current?.pause();
    replayScene.clock.setTime(time);
  }, [replayScene]);
  useEffect(() => {
    replayScene.clock.setTime(readCached("currentTime", null));
    const unsubscribe = replayScene.clock.subscribe(snapshot => {
      displayCurrentTime(snapshot.time);
      setPlaying(snapshot.mode === "playback");
      writeCached("currentTime", snapshot.time);
    });
    return () => { unsubscribe(); };
  }, [replayScene]);
  useEffect(() => {
    if (!pointDataset) return;
    const playback = new ReplayPlayback(replayScene.clock, pointDataset.timeBounds);
    playbackRef.current = playback;
    return () => { playback.destroy(); playbackRef.current = null; };
  }, [pointDataset, replayScene]);
  const [exportRange, setExportRange] = useCachedState<TimeBounds | null>("exportRange", null);
  const [timelineFocusRequest, setTimelineFocusRequest] =
    useState<TimelineFocusRequest | null>(null);
  const timelineFocusSequenceRef = useRef(0);
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [dataError, setDataError] = useState("");
  const [mediaSource, setMediaSource] = useState<MediaSource | null>(null);
  const [isLoadingMedia, setIsLoadingMedia] = useState(false);
  const [subtitleTrack, setSubtitleTrack] = useCachedState<SubtitleTrack | null>("subtitleTrack", null);
  const [isSubtitleEditorOpen, setIsSubtitleEditorOpen] = useCachedState("subtitle-editor-open", false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [subtitleStatus, setSubtitleStatus] = useState("");
  const [maptilerKey, setMaptilerKey] = useState(() => window.replaymod?.settings.maptilerApiKey ?? "");
  const [mapLanguage, setMapLanguage] = useState<MapLanguage>(() => window.replaymod?.settings.mapLanguage ?? "auto");
  const [buildingCacheLimitMB,setBuildingCacheLimitMB]=useState(()=>window.replaymod?.settings.buildingCacheLimitMB??256);
  const [buildingCacheStats,setBuildingCacheStats]=useState({bytes:0,features:0});
  const [pointerLocation, setPointerLocation] = useState<TerrainProfilePoint | null>(null);

  const saveAppSettings = (settings: AppSettings) => {
    const error = window.replaymod?.saveSettings(settings);
    if (error) { setDataError(error); setSettingsStatus(error); return false; }
    return true;
  };

  const saveMaptilerKey = (key: string) => {
    if (!saveAppSettings({ maptilerApiKey: key, mapLanguage, buildingCacheLimitMB })) return false;
    setMaptilerKey(key.trim());
    return true;
  };

  const saveMapLanguage = (language: MapLanguage) => {
    if (!saveAppSettings({ maptilerApiKey: maptilerKey, mapLanguage: language, buildingCacheLimitMB })) return;
    setMapLanguage(language);
    setSettingsStatus("地图文字语言已更新");
  };

  const clearMaptilerKey = () => saveMaptilerKey("");

  const saveBuildingCacheLimit=(limit:number)=>{
    if(!saveAppSettings({maptilerApiKey:maptilerKey,mapLanguage,buildingCacheLimitMB:limit}))return;
    setBuildingCacheLimitMB(limit);setSettingsStatus(`建筑 LOD 缓存上限已设为 ${limit} MB`);
  };

  useEffect(()=>{
    const update=(event:Event)=>setBuildingCacheStats((event as CustomEvent<{bytes:number;features:number}>).detail);
    window.addEventListener("building-cache-stats",update);
    return()=>window.removeEventListener("building-cache-stats",update);
  },[]);

  useEffect(() => {
    const handleRangeShortcut = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        currentTime === null ||
        !exportRange ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "i") {
        event.preventDefault();
        setExportRange([Math.min(currentTime, exportRange[1]), exportRange[1]]);
      } else if (key === "o") {
        event.preventDefault();
        setExportRange([exportRange[0], Math.max(currentTime, exportRange[0])]);
      }
    };

    window.addEventListener("keydown", handleRangeShortcut);
    return () => window.removeEventListener("keydown", handleRangeShortcut);
  }, [currentTime, exportRange]);

  const selectMapPoint = useCallback((timestamp: number) => {
    setAnnotationSelectedId(null);
    replayScene.setCursor(null);
    timelineFocusSequenceRef.current += 1;
    setCurrentTime(timestamp);
    setTimelineFocusRequest({
      timestamp,
      sequence: timelineFocusSequenceRef.current,
    });
  }, []);

  useEffect(() => {
    let isActive = true;

    if (!window.replaymod) {
      return;
    }

    setIsLoadingData(true);
    window.replaymod
      .loadDefaultLocationCsv()
      .then((dataset) => {
        if (!isActive || !dataset) {
          return;
        }

        setPointDataset(dataset);
        setCurrentTime(readCached("currentTime", dataset.timeBounds[0]));
        setExportRange(readCached("exportRange", dataset.timeBounds));
        setTimelineFocusRequest(null);
      })
      .catch((error: unknown) => {
        if (isActive) {
          setDataError(
            error instanceof Error
              ? error.message
              : "自动载入 RawData 时发生未知错误。",
          );
        }
      })
      .finally(() => {
        if (isActive) {
          setIsLoadingData(false);
        }
      });

    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    window.replaymod?.loadCachedMedia().then(source => {
      if (active) setMediaSource(source);
    }).catch(error => { if (active) setDataError(String(error)); });
    return () => { active = false; };
  }, []);

  const openLocationCsv = async () => {
    if (!window.replaymod || isLoadingData) {
      return;
    }

    setIsLoadingData(true);
    setDataError("");

    try {
      const dataset = await window.replaymod.openLocationCsv();

      if (dataset) {
        setPointDataset(dataset);
        setCurrentTime(dataset.timeBounds[0]);
        setExportRange(dataset.timeBounds);
        setTimelineFocusRequest(null);
      }
    } catch (error) {
      setDataError(
        error instanceof Error ? error.message : "载入 CSV 数据时发生未知错误。",
      );
    } finally {
      setIsLoadingData(false);
    }
  };

  const openMedia = async () => {
    if (!window.replaymod || isLoadingMedia) return;
    setIsLoadingMedia(true);
    setDataError("");

    try {
      const source = await window.replaymod.openMedia();
      if (source) {
        setMediaSource(source);
        setSubtitleTrack(null);
        setSubtitleStatus("");
      }
    } catch (error) {
      setDataError(error instanceof Error ? error.message : "载入视频时发生未知错误。");
    } finally {
      setIsLoadingMedia(false);
    }
  };

  const generateSubtitles = async () => {
    if (!window.replaymod || !mediaSource || isTranscribing) return;
    setIsTranscribing(true);
    setSubtitleStatus("正在提取音频并识别人声…");
    try {
      const track = await window.replaymod.transcribeMedia(mediaSource.sourcePath);
      setSubtitleTrack(track);
      setSubtitleStatus(`已生成 ${track.cues.length} 条字幕，可直接修改。`);
    } catch (error) {
      setSubtitleStatus(error instanceof Error ? error.message : "生成字幕失败。");
    } finally {
      setIsTranscribing(false);
    }
  };

  const saveSubtitles = async () => {
    if (!window.replaymod || !mediaSource || !subtitleTrack) return;
    setSubtitleStatus("正在保存字幕轨…");
    try {
      const saved = await window.replaymod.saveSubtitles(
        mediaSource.sourcePath,
        subtitleTrack,
      );
      setSubtitleStatus(`已保存：${saved.srtPath}`);
    } catch (error) {
      setSubtitleStatus(error instanceof Error ? error.message : "保存字幕失败。");
    }
  };

  const isMac = window.replaymod?.platform === "darwin";
  useEffect(() => {
    if (!isMac || !window.replaymod) return;
    const bridge = window.replaymod;
    const update = () => bridge.updateMenuState({
      openLocation: !isLoadingData,
      openMedia: !isLoadingMedia,
      subtitles: mediaSource !== null,
      range: currentTime !== null && exportRange !== null,
    });
    update();
    window.addEventListener("focus", update);
    const unsubscribe = bridge.onMenuAction(action => {
      switch (action) {
        case "open-location": void openLocationCsv(); break;
        case "open-media": void openMedia(); break;
        case "open-subtitles": if (mediaSource) setIsSubtitleEditorOpen(true); break;
        case "set-in":
          if (currentTime !== null && exportRange) setExportRange([Math.min(currentTime, exportRange[1]), exportRange[1]]);
          break;
        case "set-out":
          if (currentTime !== null && exportRange) setExportRange([exportRange[0], Math.max(currentTime, exportRange[0])]);
          break;
      }
    });
    return () => { unsubscribe(); window.removeEventListener("focus", update); };
  }, [isMac, isLoadingData, isLoadingMedia, mediaSource, currentTime, exportRange]);

  return (
    <main className="app-shell">
      <div className="map-background">
        {maptilerKey ? (
          <MapViewport
            scene={replayScene}
            legendContainer={mapLegendContainer}
            apiKey={maptilerKey}
            mapLanguage={mapLanguage}
            buildingCacheLimitMB={buildingCacheLimitMB}
            onClearKey={clearMaptilerKey}
            onPointSelect={selectMapPoint}
            onPointerLocation={setPointerLocation}
            pointDataset={pointDataset}
            flightRoutes={flightRoutes}
            flightRouteSegments={flightRouteSegments}
            flightAirports={flightAirports}
            onMapViewStateChange={syncReplayMapView}
            onMoveAnnotationCoordinate={(id,index,coordinate)=>setAnnotations(p=>({...p,nodes:p.nodes.map(n=>n.id===id?{...n,coordinates:n.coordinates.map((c,i)=>i===index?coordinate:c)}:n)}))}
            annotations={annotations}
            annotationSelectedId={annotationSelectedId}
            annotationFocus={annotationFocus}
            onAnnotationElevationProfile={setAnnotationElevationProfile}
            onAnnotationSelect={selectAnnotation}
            onAnnotationFocus={focusAnnotation}
            drawMode={drawMode}
            draftCoordinates={draftCoordinates}
            onDrawCoordinate={coordinate=>drawMode==="point"?addAnnotation([coordinate],"point"):setDraftCoordinates(p=>[...p,coordinate])}
            onFinishRoute={finishRoute}
            onCancelDrawing={()=>{setDrawMode("select");setDraftCoordinates([]);}}
          />
        ) : (
          <MapTokenSetup onSave={saveMaptilerKey} />
        )}
      </div>
      <ReplayRenderSurface scene={replayScene}/>

      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark">R</span>
          <span className="brand-copy">
            <strong>现实回放</strong>
            <small>REPLAY MOD REALITY</small>
          </span>
        </div>
        <button className="project-state trajectory-file-button" type="button"
          title={pointDataset ? `选择轨迹文件 · 当前：${pointDataset.sourceName}` : "选择轨迹 CSV 文件"}
          aria-label="选择轨迹文件" aria-busy={isLoadingData}
          disabled={isLoadingData} onClick={() => void openLocationCsv()}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7V4h7l2 3h9v13H3Z M3 10h18"/></svg>
          <span>{isLoadingData ? "正在读取轨迹…" : pointDataset?.sourceName ?? "选择轨迹文件…"}</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>
        </button>
        <nav className="titlebar-map-tools" aria-label="地图工具">
          <div className="render-layer-toggles" aria-label="图层开关">
            {(Object.keys(renderLayerLabels) as RenderLayerId[]).map(id => <button
              key={id} type="button" aria-pressed={layerVisibility[id]}
              onClick={() => setLayerVisibility(previous => ({...previous, [id]: !previous[id]}))}
            >{renderLayerLabels[id]}</button>)}
          </div>
          {([
            {mode: "select", label: "选择", path: "M5 3l14 9-7 1-3 7Z"},
            {mode: "point", label: "标点", path: "M12 21s7-6 7-12a7 7 0 1 0-14 0c0 6 7 12 7 12Z M15 9a3 3 0 1 1-6 0 3 3 0 0 1 6 0"},
            {mode: "route", label: "画路线", path: "M6 6h9a4 4 0 0 1 0 8H9a4 4 0 0 0 0 8 M6 3v6 M3 6h6 M18 19v4 M16 21h4"},
          ] as const).map(tool => <button key={tool.mode} className={`tool-button ${drawMode === tool.mode ? "active" : ""}`}
            type="button" title={tool.label} aria-label={tool.label} aria-pressed={drawMode === tool.mode}
            disabled={tool.mode !== "select" && !annotationsReady}
            onClick={() => {setDrawMode(tool.mode); setDraftCoordinates([]);}}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={tool.path}/></svg>
          </button>)}
          {drawMode === "route" && <>
            <button className="tool-button" type="button" title={`完成路线（${draftCoordinates.length} 个点）`} aria-label="完成路线" disabled={draftCoordinates.length < 2} onClick={finishRoute}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>
            </button>
            <button className="tool-button" type="button" title="撤回一点" aria-label="撤回一点" disabled={!draftCoordinates.length} onClick={() => setDraftCoordinates(p => p.slice(0, -1))}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 5 4 10l5 5 M4 10h10a6 6 0 0 1 0 12"/></svg>
            </button>
          </>}
        </nav>
        <div className="titlebar-legend-slot" ref={setMapLegendContainer} />
      </header>

      <section className={`workspace ${leftPanelCollapsed ? "left-panel-collapsed" : ""} ${bottomPanelCollapsed ? "bottom-panel-collapsed" : ""}`}>
        <aside className="activity-bar" aria-label="工作区模块">
          {tabs.map(tab => <button key={tab.id} type="button"
            className={`activity-button ${!leftPanelCollapsed && activeTab === tab.id ? "active" : ""} ${tab.id === "settings" ? "settings-entry" : ""}`}
            title={tab.label} aria-label={tab.label} aria-pressed={!leftPanelCollapsed && activeTab === tab.id}
            onClick={() => {
              if (!leftPanelCollapsed && activeTab === tab.id) {
                setLeftPanelCollapsed(true);
                return;
              }
              setActiveTab(tab.id);
              setLeftPanelCollapsed(false);
            }}>
            <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={tab.path}/></svg>
          </button>)}
        </aside>

        <aside className="library-panel">
          <PanelHeader title={tabs.find(tab => tab.id === activeTab)?.label ?? "地图标注"} action="收起左侧面板" onAction={() => setLeftPanelCollapsed(true)} />
          <div className="workspace-page" hidden={activeTab !== "annotations"}>
          <AnnotationPanel project={annotations} onChange={setAnnotations} selectedId={annotationSelectedId} onSelect={selectAnnotation} onFocus={focusAnnotation} status={annotationStatus} ready={annotationsReady}/>
          </div>
          <div className="workspace-page" hidden={activeTab !== "sources"}>
          <section className="library-section">
            <h2 className="section-label">
              数据源
            </h2>
            <div className={pointDataset ? "data-source-item" : "empty-list"}>
              {pointDataset ? (
                <>
                  <strong>{pointDataset.sourceName}</strong>
                  <span>
                    足迹{" "}
                    {pointDataset.footprintPointCount.toLocaleString("zh-CN")}
                    {" · "}照片{" "}
                    {pointDataset.photoPointCount.toLocaleString("zh-CN")}
                  </span>
                </>
              ) : (
                "尚未载入数据"
              )}
            </div>
          </section>
          <section className="library-section">
            <h2 className="section-label">
              时间压缩
            </h2>
            <div className="time-compression-list">
              <button
                type="button"
                disabled={!mediaSource}
                onClick={() => setIsSubtitleEditorOpen(true)}
              >谈话类 · 字幕轨</button>
            </div>
          </section>
          <section className="library-section">
            <h2 className="section-label">
              视频源
            </h2>
            <div className={mediaSource ? "data-source-item" : "empty-list"}>
              {mediaSource ? (
                <>
                  <strong>{mediaSource.sourceName}</strong>
                  <span>
                    {mediaSource.isLikelyDji ? "DJI · " : ""}
                    {mediaSource.tracks.length} 轨 · {mediaSource.capabilities.encoders.filter((encoder) => encoder.hardwareAccelerated).length} 个硬件编码器
                  </span>
                </>
              ) : "尚未载入视频"}
            </div>
          </section>
          <button
            className="primary-action"
            type="button"
            disabled={isLoadingData}
            onClick={() => void openLocationCsv()}
          >
            {isLoadingData ? "正在读取 CSV..." : "载入数据源"}
          </button>
          <button
            className="primary-action"
            type="button"
            disabled={isLoadingMedia}
            onClick={() => void openMedia()}
          >
            {isLoadingMedia ? "正在检查视频..." : "载入 DJI 视频"}
          </button>
          {dataError && <div className="data-error">{dataError}</div>}
          </div>
          <div className="workspace-page" hidden={activeTab !== "flights"}>
            <FlightPanel
              dataset={pointDataset}
              apiKey={maptilerKey}
              active={activeTab === "flights"}
              mapLanguage={mapLanguage}
              systemLanguageIsZh={(navigator.languages?.[0] ?? navigator.language).toLowerCase().startsWith("zh")}
              onFlightRoutesChange={setFlightRoutes}
              onFlightRouteSegmentsChange={setFlightRouteSegments}
              onFlightAirportsChange={setFlightAirports}
            />
          </div>
          <div className="workspace-page" hidden={activeTab !== "export"}>
            <p className="page-intro">将轨迹与仪表导出为透明视频，叠加到拍摄素材上。</p>
          <section className="range-editor">
            <p>移动红色播放头，再设置导出区间。</p>
            <div>
              <button type="button" disabled={currentTime === null || !exportRange} onClick={() => {
                if (currentTime !== null && exportRange) setExportRange([Math.min(currentTime, exportRange[1]), exportRange[1]]);
              }}>设为入点 (I)</button>
              <button type="button" disabled={currentTime === null || !exportRange} onClick={() => {
                if (currentTime !== null && exportRange) setExportRange([exportRange[0], Math.max(currentTime, exportRange[0])]);
              }}>设为出点 (O)</button>
            </div>
            {exportRange && <code>{new Date(exportRange[0]).toLocaleString("zh-CN")}<br />— {new Date(exportRange[1]).toLocaleString("zh-CN")}</code>}
          </section>
          {pointDataset && exportRange ? (
            <OverlayExport dataset={pointDataset} range={exportRange} apiKey={maptilerKey} />
          ) : (
            <div className="inspector-empty"><div className="inspector-icon">i</div><p>载入轨迹后可输出透明视频。</p></div>
          )}
          </div>
          <div className="workspace-page settings-page" hidden={activeTab !== "settings"}>
            <div className="settings-heading"><small>REPLAY MOD REALITY</small><h2>设置</h2><p>工作区偏好自动保存在本机。</p></div>
            <HDRSettings/>
            <h3>地图服务</h3>
            <form onSubmit={event => {event.preventDefault(); if (saveMaptilerKey(keyDraft)) {setKeyDraft(""); setSettingsStatus("地图密钥已更新");}}}>
              <label htmlFor="settings-map-key">MapTiler API Key</label>
              <p>{maptilerKey ? "已连接 · 输入新密钥可替换" : "尚未连接地图服务"}</p>
              <input id="settings-map-key" type="password" autoComplete="off" placeholder="输入新的 API Key" value={keyDraft} onChange={event => setKeyDraft(event.target.value)}/>
              <button className="primary-action" disabled={!keyDraft.trim()} type="submit">保存并连接</button>
              <button type="button" disabled={!maptilerKey} onClick={() => {if (saveMaptilerKey("")) setSettingsStatus("地图密钥已移除");}}>移除密钥</button>
            </form>
            <label className="settings-row" htmlFor="settings-map-language">
              <span>地图文字语言</span>
              <select id="settings-map-language" value={mapLanguage} onChange={event => saveMapLanguage(event.target.value as MapLanguage)}>
                <option value="auto">跟随系统</option>
                <option value="local">当地语言</option>
                <option value="zh">中文</option>
                <option value="en">English</option>
              </select>
            </label>
            <p>切换后底图地名会立即更新；缺少翻译时使用当地名称。</p>
            <h3>建筑 LOD 缓存</h3>
            <label className="settings-row" htmlFor="settings-building-cache-limit">
              <span>容量上限</span>
              <select id="settings-building-cache-limit" value={buildingCacheLimitMB} onChange={event=>saveBuildingCacheLimit(Number(event.target.value))}>
                {[64,128,256,512,1024,2048].map(value=><option key={value} value={value}>{value>=1024?`${value/1024} GB`:`${value} MB`}</option>)}
              </select>
            </label>
            <div className="settings-row"><span>当前已用</span><strong>{buildingCacheStats.bytes<1024*1024?`${(buildingCacheStats.bytes/1024).toFixed(1)} KB`:`${(buildingCacheStats.bytes/1024/1024).toFixed(1)} MB`}</strong></div>
            <p>{buildingCacheStats.features.toLocaleString("zh-CN")} 个建筑要素；超出上限后优先淘汰最早记忆的区域。</p>
            <h3>本地存储</h3>
            <p>标注、视角和导出偏好会自动保存。</p>
            <button type="button" disabled={!window.replaymod} onClick={() => {
              if (cacheError()) setSettingsStatus(cacheError());
              void window.replaymod?.openCacheDirectory().then(error => setSettingsStatus(error || "已打开缓存目录"));
            }}>打开缓存目录 ↗</button>
            <h3>操作快捷键</h3>
            <div className="settings-row"><span>设置导出入点</span><kbd>I</kbd></div>
            <div className="settings-row"><span>设置导出出点</span><kbd>O</kbd></div>
            <p role="status">{settingsStatus}</p>
          </div>
        </aside>

        <section className="stage-column">


          <div className="map-interaction-area" aria-label="地图视图" />

          <div className="bottom-panel">
            <button className="bottom-panel-toggle" type="button"
              title={bottomPanelCollapsed ? "展开底部面板" : "收起底部面板"}
              aria-label={bottomPanelCollapsed ? "展开底部面板" : "收起底部面板"}
              aria-expanded={!bottomPanelCollapsed} onClick={() => setBottomPanelCollapsed(value => !value)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={bottomPanelCollapsed ? "m5 15 7-7 7 7" : "m5 9 7 7 7-7"}/></svg>
            </button>
            <div className="bottom-panel-content">
              {selectedRoute ? <ElevationProfile scene={replayScene} coordinates={annotationElevationProfile} routeName={selectedRoute.name} onHover={syncElevationHover}/> : <Timeline
                scene={replayScene}
                dataset={pointDataset}
                currentTime={currentTime}
                onCurrentTimeChange={setCurrentTime}
                playing={playing}
                onTogglePlayback={() => playing ? playbackRef.current?.pause() : playbackRef.current?.play()}
                onStepFrame={direction => playbackRef.current?.step(direction)}
                onHoverTimeChange={syncReplayTimelineHover}
                focusRequest={timelineFocusRequest}
                selectionRange={exportRange}
                metrics={timelineMetrics}
              />}
            </div>
          </div>
        </section>


      </section>

      {isSubtitleEditorOpen && (
        <SubtitleEditor
          track={subtitleTrack}
          busy={isTranscribing}
          status={subtitleStatus}
          onChange={setSubtitleTrack}
          onClose={() => setIsSubtitleEditorOpen(false)}
          onGenerate={() => void generateSubtitles()}
          onSave={() => void saveSubtitles()}
        />
      )}

      <footer className="statusbar">
        <span className="ready-state">
          {dataError
            ? "数据载入失败"
            : isLoadingData
              ? "正在解析数据"
              : "系统就绪"}
        </span>
        <span className="status-spacer" />
        <span className="pointer-location">
          {pointerLocation
            ? `经度 ${pointerLocation[0].toFixed(5)}  纬度 ${pointerLocation[1].toFixed(5)}  海拔 ${Number.isFinite(pointerLocation[2]) ? `${Math.round(pointerLocation[2])} m` : "…"}`
            : "经度 —  纬度 —  海拔 —"}
        </span>
        <span>
          数据点 {pointDataset?.pointCount.toLocaleString("zh-CN") ?? "0"}
        </span>

        <span>{window.replaymod?.platform ?? "web-preview"}</span>
      </footer>
    </main>
  );
}
