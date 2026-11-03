import type { AnnotationProject, MapCoordinate } from "../../../../packages/data/src";
import { AnnotationPanel } from "./AnnotationPanel";
import { emptyAnnotations, parseAnnotationProject } from "./annotations";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointDataset, TimeBounds } from "../../../../packages/data/src";
import type { MediaSource, SubtitleTrack } from "../../../../packages/media/src";
import { MapTokenSetup, MapViewport } from "./MapViewport";
import { OverlayExport } from "./OverlayExport";
import { SubtitleEditor } from "./SubtitleEditor";
import {
  Timeline,
  type TimelineFocusRequest,
} from "./Timeline";

const MAPTILER_KEY_STORAGE_KEY = "replaymod.maptiler.api-key";

const Icon = ({ children }: { children: string }) => (
  <span className="icon" aria-hidden="true">
    {children}
  </span>
);

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
  const [annotations, setAnnotations] = useState<AnnotationProject>(emptyAnnotations);
  const [annotationsReady,setAnnotationsReady] = useState(false);
  const [annotationStatus,setAnnotationStatus] = useState("正在载入地图标注…");
  const [annotationSelectedId,setAnnotationSelectedId] = useState<string|null>(null);
  const [annotationFocus,setAnnotationFocus] = useState<{id:string;sequence:number}|null>(null);
  const [drawMode,setDrawMode] = useState<"select"|"point"|"route">("select");
  const [draftCoordinates,setDraftCoordinates] = useState<MapCoordinate[]>([]);
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
  const [currentTime, setCurrentTime] = useState<number | null>(null);
  const [exportRange, setExportRange] = useState<TimeBounds | null>(null);
  const [timelineFocusRequest, setTimelineFocusRequest] =
    useState<TimelineFocusRequest | null>(null);
  const timelineFocusSequenceRef = useRef(0);
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [dataError, setDataError] = useState("");
  const [mediaSource, setMediaSource] = useState<MediaSource | null>(null);
  const [isLoadingMedia, setIsLoadingMedia] = useState(false);
  const [subtitleTrack, setSubtitleTrack] = useState<SubtitleTrack | null>(null);
  const [isSubtitleEditorOpen, setIsSubtitleEditorOpen] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [subtitleStatus, setSubtitleStatus] = useState("");
  const [maptilerKey, setMaptilerKey] = useState(() => {
    const environmentKey = import.meta.env.VITE_MAPTILER_API_KEY?.trim();
    return (
      environmentKey ??
      window.localStorage.getItem(MAPTILER_KEY_STORAGE_KEY) ??
      ""
    );
  });

  const saveMaptilerKey = (key: string) => {
    window.localStorage.setItem(MAPTILER_KEY_STORAGE_KEY, key);
    setMaptilerKey(key);
  };

  const clearMaptilerKey = () => {
    window.localStorage.removeItem(MAPTILER_KEY_STORAGE_KEY);
    setMaptilerKey("");
  };

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
        setCurrentTime(dataset.timeBounds[0]);
        setExportRange(dataset.timeBounds);
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

  return (
    <main className="app-shell">
      <div className="map-background">
        {maptilerKey ? (
          <MapViewport
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
        <nav className="top-actions" aria-label="项目操作">
          <button type="button">项目</button>
          <button type="button">编辑</button>
          <button type="button">视图</button>
          <button type="button">输出</button>
        </nav>
        <div className="project-state">
          <span className="status-dot" />
          {pointDataset?.sourceName ?? "未载入工程"}
        </div>
      </header>

      <section className="workspace">
        <aside className="activity-bar" aria-label="工作区模块">
          <button className="activity-button active" type="button" title="数据">
            <Icon>数</Icon>
          </button>
          <button className="activity-button" type="button" title="处理管线">
            <Icon>流</Icon>
          </button>
          <button
            className="activity-button"
            type="button"
            title="回放 / 视频输出"
          >
            <Icon>录</Icon>
          </button>
          <button
            className="activity-button"
            type="button"
            title="视界 / 实时预览"
          >
            <Icon>视</Icon>
          </button>
          <span className="activity-spacer" />
          <button className="activity-button" type="button" title="设置">
            <Icon>设</Icon>
          </button>
        </aside>

        <aside className="library-panel">
          <PanelHeader
            title="工程工作区"
            action="+"
            onAction={() => void openLocationCsv()}
          />
          <AnnotationPanel project={annotations} onChange={setAnnotations} selectedId={annotationSelectedId} onSelect={selectAnnotation} status={annotationStatus} ready={annotationsReady}/>
          <section className="library-section">
            <button className="section-label" type="button">
              <span>▼</span> 数据源
            </button>
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
            <button className="section-label" type="button">
              <span>▼</span> 时间压缩
            </button>
            <div className="time-compression-list">
              <span>骑行类 · 姿态旋转</span>
              <button
                type="button"
                disabled={!mediaSource}
                onClick={() => setIsSubtitleEditorOpen(true)}
              >谈话类 · 字幕轨</button>
            </div>
          </section>
          <section className="library-section">
            <button className="section-label" type="button">
              <span>▼</span> 视频源
            </button>
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
          <section className="library-section">
            <button className="section-label" type="button">
              <span>▼</span> 处理管线
            </button>
            <div className="empty-list">尚未配置处理节点</div>
          </section>
          <section className="library-section grow">
            <button className="section-label" type="button">
              <span>▼</span> 输出目标
            </button>
            <div className="empty-list">尚未创建输出任务</div>
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
        </aside>

        <section className="stage-column">
          <header className="stage-toolbar">
            <div className="tool-group">
              <button className={`tool-button ${drawMode==="select"?"active":""}`} type="button" onClick={()=>{setDrawMode("select");setDraftCoordinates([]);}}>选择</button>
              <button className={`tool-button ${drawMode==="point"?"active":""}`} type="button" disabled={!annotationsReady} onClick={()=>{setDrawMode("point");setDraftCoordinates([]);}}>标点</button>
              <button className={`tool-button ${drawMode==="route"?"active":""}`} type="button" disabled={!annotationsReady} onClick={()=>{setDrawMode("route");setDraftCoordinates([]);}}>画路线</button>
              {drawMode==="route" && <>
                <button className="tool-button" type="button" disabled={draftCoordinates.length<2} onClick={finishRoute}>完成 ({draftCoordinates.length})</button>
                <button className="tool-button" type="button" disabled={!draftCoordinates.length} onClick={()=>setDraftCoordinates(p=>p.slice(0,-1))}>撤回一点</button>
              </>}
            </div>
            <div className="view-switch">
              <button className="active" type="button">
                地图
              </button>
              <button type="button">管线</button>
              <button type="button">表格</button>
            </div>
            <div className="zoom-readout">100%</div>
          </header>

          <div className="map-interaction-area" aria-label="地图视图" />

          <Timeline
            dataset={pointDataset}
            currentTime={currentTime}
            onCurrentTimeChange={setCurrentTime}
            focusRequest={timelineFocusRequest}
            selectionRange={exportRange}
          />
        </section>

        <aside className="inspector-panel">
          <PanelHeader title="透明叠加视频" />
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
          <section className="inspector-section">
            <h2>数据管线</h2>
            <dl>
              <div>
                <dt>输入 IR</dt>
                <dd>无</dd>
              </div>
              <div>
                <dt>输出 IR</dt>
                <dd>无</dd>
              </div>
              <div>
                <dt>缓存状态</dt>
                <dd>空</dd>
              </div>
            </dl>
          </section>
        </aside>
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
        <span>处理节点 0</span>
        <span>{window.replaymod?.platform ?? "web-preview"}</span>
      </footer>
    </main>
  );
}
