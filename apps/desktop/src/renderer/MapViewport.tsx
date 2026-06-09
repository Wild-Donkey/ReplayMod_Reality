import { FormEvent, useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

interface MapViewportProps {
  apiKey: string;
  onClearKey: () => void;
}

export function MapViewport({
  apiKey,
  onClearKey,
}: MapViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    setStatus("loading");
    setErrorMessage("");

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: `https://api.maptiler.com/maps/dataviz-dark/style.json?key=${encodeURIComponent(apiKey)}`,
      center: [104.2, 35.8],
      zoom: 2.4,
      attributionControl: false,
      localIdeographFontFamily:
        '"Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
    });

    map.addControl(
      new maplibregl.NavigationControl({
        showCompass: true,
        showZoom: true,
        visualizePitch: true,
      }),
      "top-right",
    );
    map.addControl(
      new maplibregl.AttributionControl({
        compact: true,
      }),
      "bottom-right",
    );

    map.once("load", () => {
      setStatus("ready");
    });

    map.on("error", (event) => {
      if (!map.loaded()) {
        setStatus("error");
        setErrorMessage(event.error?.message ?? "地图服务连接失败");
      }
    });

    return () => {
      map.remove();
    };
  }, [apiKey]);

  return (
    <section className="viewport map-viewport">
      <div ref={containerRef} className="map-container" />

      {status === "loading" && (
        <div className="map-message">
          <strong>正在连接 MapTiler</strong>
          <span>加载全球矢量底图</span>
        </div>
      )}

      {status === "error" && (
        <div className="map-message map-error">
          <strong>地图载入失败</strong>
          <span>{errorMessage}</span>
          <button type="button" onClick={onClearKey}>
            重新配置 Key
          </button>
        </div>
      )}

      {status === "ready" && (
        <>
          <div className="map-data-state">
            <strong>尚未载入轨迹</strong>
            <span>底图已连接，可以开始导入 CSV 数据。</span>
          </div>
          <div className="viewport-badge">MAPTILER　在线</div>
        </>
      )}
    </section>
  );
}

interface MapTokenSetupProps {
  onSave: (token: string) => void;
}

export function MapTokenSetup({ onSave }: MapTokenSetupProps) {
  const [token, setToken] = useState("");

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedToken = token.trim();

    if (normalizedToken) {
      onSave(normalizedToken);
    }
  };

  return (
    <section className="viewport token-setup">
      <form className="token-panel" onSubmit={handleSubmit}>
        <span className="token-kicker">在线地图服务</span>
        <h1>连接 MapTiler</h1>
        <p>
          输入 MapTiler API Key。密钥仅保存在这台设备上，不会写入项目文件。
        </p>
        <label htmlFor="maptiler-key">MAPTILER API KEY</label>
        <input
          id="maptiler-key"
          name="maptiler-key"
          type="password"
          value={token}
          placeholder="输入 API Key"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setToken(event.target.value)}
        />
        <button type="submit" disabled={!token.trim()}>
          连接地图
        </button>
        <a
          href="https://cloud.maptiler.com/account/keys/"
          target="_blank"
          rel="noreferrer"
        >
          打开 MapTiler Key 管理页
        </a>
      </form>
      <div className="viewport-badge">MAPTILER　未配置</div>
    </section>
  );
}
