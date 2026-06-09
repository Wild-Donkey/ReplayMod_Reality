import { FormEvent, useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import type { PointDataset } from "../../../../packages/data/src";
import "maplibre-gl/dist/maplibre-gl.css";

const FOOTPRINT_SOURCE_ID = "footprint-points";
const FOOTPRINT_LAYER_ID = "footprint-points-circle";
const PHOTO_SOURCE_ID = "photo-points";
const PHOTO_LAYER_ID = "photo-points-circle";
const CURRENT_POSITION_SOURCE_ID = "current-position";
const CURRENT_POSITION_LAYER_ID = "current-position-circle";
const KEYBOARD_PAN_DISTANCE = 120;

const isEditableTarget = (target: EventTarget | null) =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  target instanceof HTMLSelectElement ||
  (target instanceof HTMLElement && target.isContentEditable);

const toMultiPoint = (flatCoordinates: readonly number[]) => {
  const coordinates: [number, number][] = [];

  for (let index = 0; index < flatCoordinates.length; index += 2) {
    coordinates.push([
      flatCoordinates[index],
      flatCoordinates[index + 1],
    ]);
  }

  return {
    type: "Feature" as const,
    properties: {},
    geometry: {
      type: "MultiPoint" as const,
      coordinates,
    },
  };
};

const lowerBound = (values: readonly number[], target: number) => {
  let low = 0;
  let high = values.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);

    if (values[middle] < target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
};

const interpolatePosition = (
  timestamps: readonly number[],
  coordinates: readonly number[],
  currentTime: number,
): [number, number] | null => {
  if (timestamps.length === 0 || coordinates.length < timestamps.length * 2) {
    return null;
  }

  const rightIndex = lowerBound(timestamps, currentTime);

  if (rightIndex === 0) {
    return [coordinates[0], coordinates[1]];
  }

  if (rightIndex >= timestamps.length) {
    const lastCoordinateIndex = (timestamps.length - 1) * 2;
    return [
      coordinates[lastCoordinateIndex],
      coordinates[lastCoordinateIndex + 1],
    ];
  }

  const leftIndex = rightIndex - 1;
  const leftTime = timestamps[leftIndex];
  const rightTime = timestamps[rightIndex];
  const duration = rightTime - leftTime;
  const ratio =
    duration <= 0 ? 1 : (currentTime - leftTime) / duration;
  const leftCoordinateIndex = leftIndex * 2;
  const rightCoordinateIndex = rightIndex * 2;

  return [
    coordinates[leftCoordinateIndex] +
      (coordinates[rightCoordinateIndex] -
        coordinates[leftCoordinateIndex]) *
        ratio,
    coordinates[leftCoordinateIndex + 1] +
      (coordinates[rightCoordinateIndex + 1] -
        coordinates[leftCoordinateIndex + 1]) *
        ratio,
  ];
};

interface MapViewportProps {
  apiKey: string;
  onClearKey: () => void;
  pointDataset: PointDataset | null;
  currentTime: number | null;
}

export function MapViewport({
  apiKey,
  onClearKey,
  pointDataset,
  currentTime,
}: MapViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
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
    mapRef.current = map;

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
      mapRef.current = null;
      map.remove();
    };
  }, [apiKey]);

  useEffect(() => {
    const map = mapRef.current;

    if (!map || status !== "ready" || !pointDataset) {
      return;
    }

    const footprintGeoJson = toMultiPoint(
      pointDataset.footprintCoordinates,
    );
    const photoGeoJson = toMultiPoint(pointDataset.photoCoordinates);
    const footprintSource = map.getSource(FOOTPRINT_SOURCE_ID);
    const photoSource = map.getSource(PHOTO_SOURCE_ID);

    if (footprintSource) {
      (footprintSource as maplibregl.GeoJSONSource).setData(footprintGeoJson);
    } else {
      map.addSource(FOOTPRINT_SOURCE_ID, {
        type: "geojson",
        data: footprintGeoJson,
      });
      map.addLayer({
        id: FOOTPRINT_LAYER_ID,
        type: "circle",
        source: FOOTPRINT_SOURCE_ID,
        paint: {
          "circle-color": "#b9f5c5",
          "circle-opacity": 0.34,
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            1,
            1.2,
            8,
            2.2,
            14,
            4,
          ],
          "circle-blur": 0.15,
        },
      });
    }

    if (photoSource) {
      (photoSource as maplibregl.GeoJSONSource).setData(photoGeoJson);
    } else {
      map.addSource(PHOTO_SOURCE_ID, {
        type: "geojson",
        data: photoGeoJson,
      });
      map.addLayer({
        id: PHOTO_LAYER_ID,
        type: "circle",
        source: PHOTO_SOURCE_ID,
        paint: {
          "circle-color": "#ffe36e",
          "circle-opacity": 0.92,
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            1,
            2,
            8,
            3.4,
            14,
            5.6,
          ],
          "circle-blur": 0.06,
          "circle-stroke-color": "#fff6bd",
          "circle-stroke-opacity": 0.82,
          "circle-stroke-width": 0.8,
        },
      });
    }

    map.fitBounds(
      [
        [pointDataset.bounds[0], pointDataset.bounds[1]],
        [pointDataset.bounds[2], pointDataset.bounds[3]],
      ],
      {
        padding: {
          top: 84,
          right: 290,
          bottom: 150,
          left: 320,
        },
        duration: 900,
        maxZoom: 13,
      },
    );
  }, [pointDataset, status]);

  useEffect(() => {
    const map = mapRef.current;

    if (
      !map ||
      status !== "ready" ||
      !pointDataset ||
      currentTime === null
    ) {
      return;
    }

    const position = interpolatePosition(
      pointDataset.timelineTimestamps,
      pointDataset.timelineCoordinates,
      currentTime,
    );

    if (!position) {
      return;
    }

    const geoJson = {
      type: "Feature" as const,
      properties: {
        timestamp: currentTime,
      },
      geometry: {
        type: "Point" as const,
        coordinates: position,
      },
    };
    const source = map.getSource(CURRENT_POSITION_SOURCE_ID);

    if (source) {
      (source as maplibregl.GeoJSONSource).setData(geoJson);
      return;
    }

    map.addSource(CURRENT_POSITION_SOURCE_ID, {
      type: "geojson",
      data: geoJson,
    });
    map.addLayer({
      id: CURRENT_POSITION_LAYER_ID,
      type: "circle",
      source: CURRENT_POSITION_SOURCE_ID,
      paint: {
        "circle-color": "#ff3030",
        "circle-opacity": 1,
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          1,
          5,
          8,
          7,
          14,
          10,
        ],
        "circle-stroke-color": "#fff",
        "circle-stroke-opacity": 0.95,
        "circle-stroke-width": 2,
      },
    });
  }, [currentTime, pointDataset, status]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const map = mapRef.current;

      if (
        !map ||
        status !== "ready" ||
        isEditableTarget(event.target) ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      ) {
        return;
      }

      const offsets: Record<string, [number, number]> = {
        w: [0, -KEYBOARD_PAN_DISTANCE],
        a: [-KEYBOARD_PAN_DISTANCE, 0],
        s: [0, KEYBOARD_PAN_DISTANCE],
        d: [KEYBOARD_PAN_DISTANCE, 0],
      };
      const offset = offsets[event.key.toLowerCase()];

      if (!offset) {
        return;
      }

      event.preventDefault();
      map.panBy(offset, {
        duration: event.repeat ? 0 : 110,
        easing: (value) => value,
      });
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [status]);

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
            <strong>
              {pointDataset
                ? pointDataset.sourceName
                : "尚未载入位置数据"}
            </strong>
            {pointDataset ? (
              <span className="point-legend">
                <span className="point-legend-item">
                  <i className="footprint-swatch" />
                  足迹{" "}
                  {pointDataset.footprintPointCount.toLocaleString("zh-CN")}
                </span>
                <span className="point-legend-item">
                  <i className="photo-swatch" />
                  照片 {pointDataset.photoPointCount.toLocaleString("zh-CN")}
                </span>
              </span>
            ) : (
              <span>底图已连接，可以开始导入 CSV 数据。</span>
            )}
            <span className="map-control-hint">WASD 移动 · 滚轮缩放</span>
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
