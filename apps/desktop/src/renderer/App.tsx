import { useState } from "react";
import type { PointDataset } from "../../../../packages/data/src";
import { MapTokenSetup, MapViewport } from "./MapViewport";

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
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [dataError, setDataError] = useState("");
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
      }
    } catch (error) {
      setDataError(
        error instanceof Error ? error.message : "载入 CSV 数据时发生未知错误。",
      );
    } finally {
      setIsLoadingData(false);
    }
  };

  return (
    <main className="app-shell">
      <div className="map-background">
        {maptilerKey ? (
          <MapViewport
            apiKey={maptilerKey}
            onClearKey={clearMaptilerKey}
            pointDataset={pointDataset}
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

          <section className="timeline">
            <header className="timeline-toolbar">
              <div className="playback-controls">
                <button type="button" aria-label="上一帧">
                  |&lt;
                </button>
                <button className="play-button" type="button" aria-label="播放">
                  &gt;
                </button>
                <button type="button" aria-label="下一帧">
                  &gt;|
                </button>
              </div>
              <span className="timecode">00:00:00.000</span>
              <span className="timeline-title">回放时间线</span>
              <div className="timeline-options">
                <span>30 帧/秒</span>
                <button type="button">适配</button>
              </div>
            </header>
            <div className="timeline-body">
              <div className="track-labels">
                <span>轨迹层</span>
                <span>处理层</span>
              </div>
              <div className="timeline-ruler">
                <div className="ruler-labels">
                  <span>00:00</span>
                  <span>00:10</span>
                  <span>00:20</span>
                  <span>00:30</span>
                </div>
                <div className="playhead" />
                <p>没有活动的回放序列</p>
              </div>
            </div>
          </section>
        </section>

        <aside className="inspector-panel">
          <PanelHeader title="属性检查器" />
          <div className="inspector-empty">
            <div className="inspector-icon">i</div>
            <p>选择一个项目，查看它的 IR 信息与处理参数。</p>
          </div>
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
