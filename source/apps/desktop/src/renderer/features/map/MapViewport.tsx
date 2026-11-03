import { cachedMapRequest, readCached, writeCached } from "../../shared/cache";
import { AnnotationLabels } from "../annotations/AnnotationLabels";
import type { AnnotationProject, MapCoordinate } from "../../../../../../packages/data/src";
import type { FeatureCollection, Geometry } from "geojson";
import { visibleAnnotations } from "../annotations/annotations";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import type { PointDataset } from "../../../../../../packages/data/src";
import "maplibre-gl/dist/maplibre-gl.css";

const FOOTPRINT_SOURCE_ID = "footprint-points";
const FOOTPRINT_LAYER_ID = "footprint-points-circle";
const PHOTO_SOURCE_ID = "photo-points";
const PHOTO_LAYER_ID = "photo-points-circle";
const CURRENT_POSITION_SOURCE_ID = "current-position";
const CURRENT_POSITION_LAYER_ID = "current-position-circle";
const KEYBOARD_PAN_SPEED = 680;
const POINT_HIT_RADIUS = 12;

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

const normalizeLongitudeDelta = (longitude: number, reference: number) =>
  ((longitude - reference + 540) % 360) - 180;

const findNearestPointTimestamp = (
  map: maplibregl.Map,
  point: maplibregl.Point,
  pointDataset: PointDataset,
) => {
  const clickLocation = map.unproject(point);
  const topLeft = map.unproject([
    point.x - POINT_HIT_RADIUS,
    point.y - POINT_HIT_RADIUS,
  ]);
  const bottomRight = map.unproject([
    point.x + POINT_HIT_RADIUS,
    point.y + POINT_HIT_RADIUS,
  ]);
  const maximumLongitudeDelta = Math.max(
    Math.abs(normalizeLongitudeDelta(topLeft.lng, clickLocation.lng)),
    Math.abs(normalizeLongitudeDelta(bottomRight.lng, clickLocation.lng)),
  );
  const minimumLatitude = Math.min(topLeft.lat, bottomRight.lat);
  const maximumLatitude = Math.max(topLeft.lat, bottomRight.lat);
  let nearestTimestamp: number | null = null;
  let nearestDistanceSquared = POINT_HIT_RADIUS * POINT_HIT_RADIUS;
  let nearestPriority = -1;

  const inspectPoints = (
    coordinates: readonly number[],
    timestamps: readonly number[],
    priority: number,
  ) => {
    const pointCount = Math.min(
      timestamps.length,
      Math.floor(coordinates.length / 2),
    );

    for (let index = 0; index < pointCount; index += 1) {
      const coordinateIndex = index * 2;
      const longitude = coordinates[coordinateIndex];
      const latitude = coordinates[coordinateIndex + 1];

      if (
        latitude < minimumLatitude ||
        latitude > maximumLatitude ||
        Math.abs(normalizeLongitudeDelta(longitude, clickLocation.lng)) >
          maximumLongitudeDelta
      ) {
        continue;
      }

      const projectedPoint = map.project([longitude, latitude]);
      const horizontalDistance = projectedPoint.x - point.x;
      const verticalDistance = projectedPoint.y - point.y;
      const distanceSquared =
        horizontalDistance * horizontalDistance +
        verticalDistance * verticalDistance;

      if (
        distanceSquared < nearestDistanceSquared ||
        (distanceSquared === nearestDistanceSquared &&
          priority > nearestPriority)
      ) {
        nearestTimestamp = timestamps[index];
        nearestDistanceSquared = distanceSquared;
        nearestPriority = priority;
      }
    }
  };

  inspectPoints(
    pointDataset.footprintCoordinates,
    pointDataset.footprintTimestamps,
    0,
  );
  inspectPoints(
    pointDataset.photoCoordinates,
    pointDataset.photoTimestamps,
    1,
  );

  return nearestTimestamp;
};

interface MapViewportProps {
  annotations: AnnotationProject;
  annotationSelectedId: string | null;
  annotationFocus: {id:string;sequence:number}|null;
  onAnnotationSelect: (id:string)=>void;
  drawMode: "select"|"point"|"route";
  draftCoordinates: MapCoordinate[];
  onDrawCoordinate: (coordinate:MapCoordinate)=>void;
  onFinishRoute: ()=>void;
  onCancelDrawing: ()=>void;
  onMoveAnnotationCoordinate: (id:string,index:number,coordinate:MapCoordinate)=>void;
  apiKey: string;
  onClearKey: () => void;
  onPointSelect: (timestamp: number) => void;
  pointDataset: PointDataset | null;
  currentTime: number | null;
}

export function MapViewport({
  annotations, annotationSelectedId, annotationFocus, onAnnotationSelect,
  drawMode, draftCoordinates, onDrawCoordinate, onFinishRoute, onCancelDrawing, onMoveAnnotationCoordinate,
  apiKey,
  onClearKey,
  onPointSelect,
  pointDataset,
  currentTime,
}: MapViewportProps) {
  const restoreCameraRef = useRef(Boolean(readCached("map-camera", null)));
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [errorMessage, setErrorMessage] = useState("");
  const annotationPoints = useMemo(() => visibleAnnotations(annotations).filter(node => node.kind === "point"), [annotations]);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    setStatus("loading");
    setErrorMessage("");

    const camera = readCached<{center: [number, number]; zoom: number; bearing: number; pitch: number} | null>("map-camera", null);
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: `https://api.maptiler.com/maps/dataviz-dark/style.json?key=${encodeURIComponent(apiKey)}`,
      center: [104.2, 35.8],
      zoom: 2.4,
      ...camera,
      transformRequest: cachedMapRequest,
      attributionControl: false,
      localIdeographFontFamily:
        '"Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
    });
    mapRef.current = map;
    const saveCamera = () => {
      const center = map.getCenter();
      writeCached("map-camera", { center: [center.lng, center.lat], zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() });
    };
    map.on("moveend", saveCamera);
    map.dragPan.enable();
    map.dragRotate.disable();
    map.boxZoom.disable();
    map.doubleClickZoom.disable();

    const canvasContainer = map.getCanvasContainer();
    const handleWheel = (event: WheelEvent) => {
      // Chromium emits trackpad pinch gestures as Ctrl+wheel. Let MapLibre
      // keep handling those so its existing zoom behavior stays intact.
      if (event.ctrlKey) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      const horizontalScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 40
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? canvasContainer.clientWidth
          : 1;
      const verticalScale = event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? canvasContainer.clientHeight
        : horizontalScale;
      map.panBy(
        [event.deltaX * horizontalScale, event.deltaY * verticalScale],
        { duration: 0 },
      );
    };
    canvasContainer.addEventListener("wheel", handleWheel, {
      capture: true,
      passive: false,
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
      canvasContainer.removeEventListener("wheel", handleWheel, true);
      mapRef.current = null;
      map.remove();
    };
  }, [apiKey]);

  useEffect(()=>{
    const map=mapRef.current;
    if(!map || status!=="ready")return;
    const features: FeatureCollection<Geometry> = {type:"FeatureCollection",features:visibleAnnotations(annotations).filter(n=>n.kind==="route").map(n=>({type:"Feature",id:n.id,properties:{id:n.id,name:n.name,color:n.style.color,opacity:n.style.opacity,width:n.style.width,selected:n.id===annotationSelectedId},geometry:n.kind==="point"?{type:"Point",coordinates:n.coordinates[0]}:{type:"LineString",coordinates:n.coordinates}}))};
    if(draftCoordinates.length)features.features.push({type:"Feature",properties:{id:"draft",color:"#ffe36e",opacity:1,width:3},geometry:draftCoordinates.length>1?{type:"LineString",coordinates:draftCoordinates}:{type:"Point",coordinates:draftCoordinates[0]}});
    const source=map.getSource("annotations") as maplibregl.GeoJSONSource|undefined;
    if(source)source.setData(features);
    else {
      map.addSource("annotations",{type:"geojson",data:features});
      map.addLayer({id:"annotation-routes",type:"line",source:"annotations",filter:["==",["geometry-type"],"LineString"],paint:{"line-color":["get","color"],"line-width":["+",["get","width"],["case",["==",["get","selected"],true],2,0]],"line-opacity":["get","opacity"]}});
      map.addLayer({id:"annotation-points",type:"circle",source:"annotations",filter:["==",["geometry-type"],"Point"],paint:{"circle-color":["get","color"],"circle-radius":["case",["==",["get","selected"],true],4,2.5],"circle-stroke-width":0.75,"circle-stroke-color":"#fff","circle-opacity":["get","opacity"]}});
    }
  },[annotations,annotationSelectedId,draftCoordinates,status]);

  useEffect(()=>{
    const map=mapRef.current;
    if(!map || status!=="ready" || !annotationFocus)return;
    const selected=annotations.nodes.find(n=>n.id===annotationFocus.id);
    if(!selected)return;
    const descendants=new Set([selected.id]);
    if(selected.kind==="folder") {let changed=true;while(changed){changed=false;for(const n of annotations.nodes)if(n.parentId&&descendants.has(n.parentId)&&!descendants.has(n.id)){descendants.add(n.id);changed=true;}}}
    const bounds=new maplibregl.LngLatBounds();
    for(const n of annotations.nodes)if(descendants.has(n.id))for(const c of n.coordinates)bounds.extend([c[0],c[1]]);
    if(!bounds.isEmpty())map.fitBounds(bounds,{padding:{top:120,bottom:180,left:350,right:310},maxZoom:14,duration:700});
  },[annotationFocus,status]);

  useEffect(()=>{
    const map=mapRef.current;
    if(!map || status!=="ready")return;
    map.getCanvas().style.cursor=drawMode==="select"?"":"crosshair";
    const click=(e:maplibregl.MapMouseEvent)=>{
      if(drawMode!=="select"){onDrawCoordinate([((e.lngLat.lng+180)%360+360)%360-180,e.lngLat.lat,0]);return;}
      const layers=["annotation-points","annotation-routes"].filter(id=>map.getLayer(id));
      if(!layers.length)return;
      const feature=map.queryRenderedFeatures([[e.point.x-5,e.point.y-5],[e.point.x+5,e.point.y+5]],{layers})[0];
      if(feature?.properties?.id && feature.properties.id!=="draft")onAnnotationSelect(String(feature.properties.id));
    };
    const key=(e:KeyboardEvent)=>{
      if(isEditableTarget(e.target))return;
      if(e.key==="Escape")onCancelDrawing();
      if(e.key==="Enter"&&drawMode==="route"){e.preventDefault();onFinishRoute();}
    };
    map.on("click",click);window.addEventListener("keydown",key);
    return()=>{map.off("click",click);window.removeEventListener("keydown",key);};
  },[drawMode,status,onDrawCoordinate,onAnnotationSelect,onFinishRoute,onCancelDrawing]);

  useEffect(()=>{
    const map=mapRef.current;
    const node=visibleAnnotations(annotations).find(n=>n.id===annotationSelectedId);
    if(!map||status!=="ready"||drawMode!=="select"||!node||node.coordinates.length>200)return;
    const markers=node.coordinates.map((c,index)=>{
      const element=document.createElement("div");element.className="annotation-handle";element.title="拖动调整坐标";
      const marker=new maplibregl.Marker({element,draggable:true}).setLngLat([c[0],c[1]]).addTo(map);
      marker.on("dragend",()=>{const pos=marker.getLngLat();onMoveAnnotationCoordinate(node.id,index,[((pos.lng+180)%360+360)%360-180,pos.lat,c[2]??0]);});
      return marker;
    });
    return()=>markers.forEach(m=>m.remove());
  },[annotations,annotationSelectedId,drawMode,status,onMoveAnnotationCoordinate]);

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

    if (restoreCameraRef.current) { restoreCameraRef.current = false; return; }
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
    const map = mapRef.current;

    if (!map || status !== "ready" || !pointDataset) {
      return;
    }

    const handleClick = (event: maplibregl.MapMouseEvent) => {
      if(drawMode!=="select")return;
      const annotationLayers=["annotation-points","annotation-routes"].filter(id=>map.getLayer(id));
      if(annotationLayers.length && map.queryRenderedFeatures([[event.point.x-5,event.point.y-5],[event.point.x+5,event.point.y+5]],{layers:annotationLayers}).length)return;
      const timestamp = findNearestPointTimestamp(
        map,
        event.point,
        pointDataset,
      );

      if (timestamp !== null) {
        onPointSelect(timestamp);
      }
    };

    map.on("click", handleClick);
    return () => {
      map.off("click", handleClick);
    };
  }, [onPointSelect, pointDataset, status, drawMode]);

  useEffect(() => {
    const pressedKeys = new Set<"w" | "a" | "s" | "d">();
    let animationFrame: number | null = null;
    let previousFrameTime: number | null = null;

    const stopAnimation = () => {
      if (animationFrame !== null) {
        cancelAnimationFrame(animationFrame);
        animationFrame = null;
      }

      previousFrameTime = null;
    };

    const runPanFrame = (frameTime: number) => {
      const map = mapRef.current;

      if (!map || status !== "ready" || pressedKeys.size === 0) {
        stopAnimation();
        return;
      }

      const previousTime = previousFrameTime ?? frameTime;
      const deltaSeconds = Math.min(
        Math.max((frameTime - previousTime) / 1000, 0),
        0.05,
      );
      previousFrameTime = frameTime;

      const horizontal =
        (pressedKeys.has("d") ? 1 : 0) - (pressedKeys.has("a") ? 1 : 0);
      const vertical =
        (pressedKeys.has("s") ? 1 : 0) - (pressedKeys.has("w") ? 1 : 0);
      const length = Math.hypot(horizontal, vertical);

      if (length > 0 && deltaSeconds > 0) {
        const distance = KEYBOARD_PAN_SPEED * deltaSeconds;
        map.panBy(
          [
            (horizontal / length) * distance,
            (vertical / length) * distance,
          ],
          {
            duration: 0,
          },
        );
      }

      animationFrame = requestAnimationFrame(runPanFrame);
    };

    const startAnimation = () => {
      if (animationFrame === null) {
        previousFrameTime = null;
        animationFrame = requestAnimationFrame(runPanFrame);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        !mapRef.current ||
        status !== "ready" ||
        isEditableTarget(event.target) ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      ) {
        return;
      }

      const key = event.key.toLowerCase();

      if (key !== "w" && key !== "a" && key !== "s" && key !== "d") {
        return;
      }

      event.preventDefault();
      pressedKeys.add(key);
      startAnimation();
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();

      if (key !== "w" && key !== "a" && key !== "s" && key !== "d") {
        return;
      }

      pressedKeys.delete(key);

      if (pressedKeys.size === 0) {
        stopAnimation();
      }
    };

    const handleBlur = () => {
      pressedKeys.clear();
      stopAnimation();
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
      pressedKeys.clear();
      stopAnimation();
    };
  }, [status]);

  return (
    <section className="viewport map-viewport">
      <div ref={containerRef} className="map-container" />
      {status === "ready" && mapRef.current && <AnnotationLabels
        map={mapRef.current}
        points={annotationPoints}
        selectedId={annotationSelectedId}
        drawing={drawMode !== "select"}
        onSelect={onAnnotationSelect}
      />}

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
            <span className="map-control-hint">
              {drawMode==="point"?"点击地图放置地标 · Esc 取消":drawMode==="route"?"逐点点击绘制路线 · Enter 完成 · Esc 取消":"点击标注编辑 · 双指滑动 / 鼠标拖拽平移 · 双指捏合缩放 · WASD 移动"}
            </span>
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
