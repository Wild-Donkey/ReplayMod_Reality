import { HDRSettings } from "../features/settings/HDRSettings";
import { defaultTimelineMetrics, type TimelineMetricsSettings } from "../features/timeline/metrics";
import { useCachedState, readCached, cacheError } from "../shared/cache";
import type { AnnotationProject, MapCoordinate } from "../../../../../packages/data/src";
import { AnnotationPanel } from "../features/annotations/AnnotationPanel";
import { emptyAnnotations, parseAnnotationProject } from "../features/annotations/annotations";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointDataset, TimeBounds } from "../../../../../packages/data/src";
import type { MediaSource, SubtitleTrack } from "../../../../../packages/media/src";
import { MapTokenSetup, MapViewport } from "../features/map/MapViewport";
import { OverlayExport } from "../features/export/OverlayExport";
import { SubtitleEditor } from "../features/subtitles/SubtitleEditor";
import {
  Timeline,
  type TimelineFocusRequest,
} from "../features/timeline/Timeline";

type WorkspaceTab = "annotations" | "sources" | "export" | "settings";
const tabs: {id: WorkspaceTab; label: string; path: string}[] = [
  {id: "annotations", label: "地图标注", path: "M12 21s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12Z M15 9a3 3 0 1 1-6 0 3 3 0 0 1 6 0"},
  {id: "sources", label: "数据与视频", path: "M3 7h7l2 2h9v11H3Z M3 7V4h7l2 3 M10 12l5 3-5 3Z"},
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
  const [mapLegendContainer, setMapLegendContainer] = useState<HTMLDivElement | null>(null);
  const [timelineMetrics, setTimelineMetrics] = useCachedState<TimelineMetricsSettings>("timeline-metrics", defaultTimelineMetrics);
  const [activeTab, setActiveTab] = useCachedState<WorkspaceTab>("workspace-tab", "annotations");
  const [keyDraft, setKeyDraft] = useState("");
  const [settingsStatus, setSettingsStatus] = useState("");
  const [annotations, setAnnotations] = useCachedState<AnnotationProject>("annotations", emptyAnnotations());
  const [annotationsReady,setAnnotationsReady] = useState(false);
  const [annotationStatus,setAnnotationStatus] = useState("正在载入地图标注…");
  const [annotationSelectedId,setAnnotationSelectedId] = useCachedState<string|null>("annotationSelectedId", null);
  const [annotationFocus,setAnnotationFocus] = useState<{id:string;sequence:number}|null>(null);
  const [drawMode,setDrawMode] = useCachedState<"select"|"point"|"route">("drawMode", "select");
  const [draftCoordinates,setDraftCoordinates] = useCachedState<MapCoordinate[]>("draftCoordinates", []);
  useEffect(()=>{
    let active=true;
    if(!window.replaymod){setAnnotationStatus("请在桌面应用中打开地图标注");return;}
    window.replaymod.loadAnnotations().then(file=>{
      if(!active)return;
      const cached = readCached<AnnotationProject | null>("annotations", null);
      if(cached)setAnnotations(parseAnnotationProject(JSON.stringify(cached)));
      else if(file)setAnnotations(parseAnnotationProject(file.content,file.name));
      setAnnotationsReady(true);setAnnotationStatus("地图标注已载入");
    }).catch((e:unknown)=>{if(active)setAnnotationStatus(`载入失败：${e instanceof Error?e.message:String(e)}`);});
    return()=>{active=false;};
  },[]);
  useEffect(()=>{
    if(!annotationsReady)return;
    let active=true;setAnnotationStatus("有更改，等待保存…");
    const timer=window.setTimeout(()=>{
      window.replaymod!.saveAnnotations(JSON.stringify(annotations)).then(()=>{if(active)setAnnotationStatus("已自动保存到本机");}).catch((e:unknown)=>{if(active)setAnnotationStatus(`保存失败：${e instanceof Error?e.message:String(e)}`);});
    },600);
    return()=>{active=false;window.clearTimeout(timer);};
  },[annotations,annotationsReady]);
  const selectAnnotation = (id:string) => {
    setAnnotationSelectedId(id);setAnnotationFocus({id,sequence:Date.now()});
  };
  const addAnnotation = (coordinates:MapCoordinate[],kind:"point"|"route") => {
    if(!annotationsReady)return;
    const selected=annotations.nodes.find(n=>n.id===annotationSelectedId);
    const id=crypto.randomUUID();
    setAnnotations(p=>({...p,nodes:[...p.nodes,{id,parentId:selected?.kind==="folder"?selected.id:selected?.parentId??null,kind,name:kind==="point"?"新建地标":"新建路线",description:"",visible:true,open:true,coordinates,altitudeMode:"clampToGround",style:{color:"#55cfff",opacity:1,width:3}}]}));
    setAnnotationSelectedId(id);setDraftCoordinates([]);setDrawMode("select");
  };
  const finishRoute = () => {if(draftCoordinates.length>=2)addAnnotation(draftCoordinates,"route");};
  const [pointDataset, setPointDataset] = useState<PointDataset | null>(null);
  const [currentTime, setCurrentTime] = useCachedState<number | null>("currentTime", null);
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

  const saveMaptilerKey = (key: string) => {
    const error = window.replaymod?.saveSettings({ maptilerApiKey: key });
    if (error) { setDataError(error); setSettingsStatus(error); return false; }
    setMaptilerKey(key.trim());
    return true;
  };

  const clearMaptilerKey = () => saveMaptilerKey("");

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
            legendContainer={mapLegendContainer}
            apiKey={maptilerKey}
            onClearKey={clearMaptilerKey}
            onPointSelect={selectMapPoint}
            pointDataset={pointDataset}
            currentTime={currentTime}
            onMoveAnnotationCoordinate={(id,index,coordinate)=>setAnnotations(p=>({...p,nodes:p.nodes.map(n=>n.id===id?{...n,coordinates:n.coordinates.map((c,i)=>i===index?coordinate:c)}:n)}))}
            annotations={annotations}
            annotationSelectedId={annotationSelectedId}
            annotationFocus={annotationFocus}
            onAnnotationSelect={setAnnotationSelectedId}
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

      <section className="workspace">
        <aside className="activity-bar" aria-label="工作区模块">
          {tabs.map(tab => <button key={tab.id} type="button"
            className={`activity-button ${activeTab === tab.id ? "active" : ""} ${tab.id === "settings" ? "settings-entry" : ""}`}
            title={tab.label} aria-label={tab.label} aria-pressed={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}>
            <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={tab.path}/></svg>
          </button>)}
        </aside>

        <aside className="library-panel">
          <PanelHeader title={tabs.find(tab => tab.id === activeTab)?.label ?? "地图标注"} />
          <div className="workspace-page" hidden={activeTab !== "annotations"}>
          <AnnotationPanel project={annotations} onChange={setAnnotations} selectedId={annotationSelectedId} onSelect={selectAnnotation} status={annotationStatus} ready={annotationsReady}/>
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
            <h3>时间轴信息</h3>
            <p>上方为速度图：位置按真实时间分段线性插值后求导取模，纵轴按当前视野自动缩放。</p>
            <p>下方为足迹、照片的一维密度条：每像素一个时间桶，亮度按点数取对数后，以各自当前峰值归一化，空桶为纯黑，两条线紧贴速度图底部。悬停可查看点数与时间范围。</p>
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

          <Timeline
            dataset={pointDataset}
            currentTime={currentTime}
            onCurrentTimeChange={setCurrentTime}
            focusRequest={timelineFocusRequest}
            selectionRange={exportRange}
            metrics={timelineMetrics}
          />
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
        <span>
          数据点 {pointDataset?.pointCount.toLocaleString("zh-CN") ?? "0"}
        </span>

        <span>{window.replaymod?.platform ?? "web-preview"}</span>
      </footer>
    </main>
  );
}
