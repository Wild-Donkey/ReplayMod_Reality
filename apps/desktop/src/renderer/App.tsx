import { useCallback, useEffect, useRef, useState } from "react";
import type { PointDataset, TimeBounds } from "../../../../packages/data/src";
import type { MediaSource } from "../../../../packages/media/src";
import { MapTokenSetup, MapViewport } from "./MapViewport";
import { OverlayExport } from "./OverlayExport";
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
      if (source) setMediaSource(source);
    } catch (error) {
      setDataError(error instanceof Error ? error.message : "载入视频时发生未知错误。");
    } finally {
      setIsLoadingMedia(false);
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
              <button className="tool-button active" type="button">
                选择
              </button>
              <button className="tool-button" type="button">
                移动
              </button>
              <button className="tool-button" type="button">
                切分
              </button>
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
