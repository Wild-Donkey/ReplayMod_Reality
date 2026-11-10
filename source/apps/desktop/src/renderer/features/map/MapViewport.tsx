import { AstronomyOverlay } from "../astronomy/AstronomyOverlay";
import type { AstronomyMapState, ObservationPoint } from "../astronomy/astronomy";
import type { FootprintDensityData } from "../../render-engine/FootprintDensityPass";
import { FootprintDensity, footprintRadius } from "./footprintDensity";
import {
  FOOTPRINT_BREAK_DURATION,
  decimateFootprintCoordinates,
  footprintCoarseTargetPx,
  footprintMetersPerPixel,
  medianAnchoredScreenSpacing,
  selectFootprintLod,
  type FootprintLod,
} from "./footprintLod";
import { cachedMapRequest, readCached, writeCached } from "../../shared/cache";
import { AnnotationLabels } from "../annotations/AnnotationLabels";
import type { AnnotationProject, MapCoordinate } from "../../../../../../packages/data/src";
import type { FeatureCollection, Geometry } from "geojson";
import { visibleAnnotations } from "../annotations/annotations";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import type { ScrollSource } from "../../../shared/scrollInput";
import type { MapLanguage } from "../../../shared/settings";
import { createPortal } from "react-dom";
import type { PointDataset } from "../../../../../../packages/data/src";
import "maplibre-gl/dist/maplibre-gl.css";

import { useHDRState } from "../../shared/displayHDR";
import { photoPointRadiusStops, replayPhotoPoints } from "../../render-engine/PhotoPoints";
import { presentHDR } from "../../shared/hdr";
import { addElevationGlass, sampleTerrainProfile, type TerrainProfilePoint } from "./elevation";
import { restoreWaterLayers } from "./water";
import { TerrainLegend } from "./TerrainLegend";
import type { TerrainAppearance } from "./terrainExposure";
import { stylePublicBasemap } from "./basemapStyle";
import { RoadOverlay } from "./RoadOverlay";
import { BuildingHeightOverlay } from "./BuildingHeightOverlay";
import { applyMapLanguage } from "./mapLanguage";
import type { ReplayCamera } from "../../render-engine/ReplayCamera";
import { loadLocalAirportLayers, type Airport } from "./airports";
import { applyMapLayerVisibility } from "../../render-engine/MapLayerVisibility";
import { RenderChannelRegistry } from "../../render-engine/RenderChannelRegistry";
import { registerStyleRenderChannels } from "../../render-engine/MapRenderChannels";
import { legacyMapAnnotationGeometry } from "../../render-engine/AnnotationGeometry";
import type { ReplayScene } from "../../render-engine/ReplayScene";
import type { FlightRouteSegment } from "./flights";

const FOOTPRINT_SOURCE_ID = "footprint-points";
const FOOTPRINT_LAYER_ID = "footprint-points-circle";
const FALLBACK_ROUTE_SOURCE_ID = "footprint-route";
const FALLBACK_ROUTE_LAYER_ID = "footprint-route-line";
const PHOTO_SOURCE_ID = "photo-points";
const PHOTO_LAYER_ID = "photo-points-circle";
const KEYBOARD_PAN_SPEED = 680;
const POINT_HIT_RADIUS = 12;
const AIRPORT_MIN_ZOOM = 10;
// Bump when the imperative canvas renderer changes so Fast Refresh reinstalls
// its render callback instead of retaining a stale effect closure.
const FLIGHT_ROUTE_OVERLAY_VERSION = 7;

const airportDisplayName = (airport: Airport, language: MapLanguage) => {
  const browserIsChinese = /^zh\b/i.test(navigator.languages?.[0] ?? navigator.language);
  const useChinese = language === "zh" ||
    (language === "auto" && browserIsChinese) ||
    (language === "local" && airport.country === "CN");
  return useChinese && airport.nameZh ? airport.nameZh : airport.name;
};

const airportGeoJson = (language: MapLanguage): FeatureCollection => {
  const airports = new Map<string, Airport>();
  for (const layer of loadLocalAirportLayers()) {
    for (const airport of layer.airports) {
      const key = airport.icao || airport.iata || `${airport.latitude},${airport.longitude}`;
      const previous = airports.get(key);
      airports.set(key, previous && !airport.nameZh && previous.nameZh
        ? { ...airport, nameZh: previous.nameZh }
        : airport);
    }
  }
  return {
    type: "FeatureCollection",
    features: [...airports.values()].map(airport => ({
      type: "Feature",
      properties: {
        kind: airport.kind,
        name: airportDisplayName(airport, language),
        code: airport.iata || airport.icao,
      },
      geometry: { type: "Point", coordinates: [airport.longitude, airport.latitude] },
    })),
  };
};

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

// Gap-split, 0.25/0.5/0.25 smoothed footprint paths, shared by the GPU
// density layer and its no-float-target MapLibre fallback.
const toFootprintRoutePaths = (
  flatCoordinates: readonly number[],
  timestamps: readonly number[],
): [number, number][][] => {
  const count = Math.min(timestamps.length, Math.floor(flatCoordinates.length / 2));
  const rawSegments: [number, number][][] = [];
  let segment: [number, number][] = [];

  for (let index = 0; index < count; index += 1) {
    if (
      index > 0 &&
      timestamps[index] - timestamps[index - 1] > FOOTPRINT_BREAK_DURATION
    ) {
      if (segment.length > 1) rawSegments.push(segment);
      segment = [];
    }
    segment.push([
      flatCoordinates[index * 2],
      flatCoordinates[index * 2 + 1],
    ]);
  }
  if (segment.length > 1) rawSegments.push(segment);

  return rawSegments.map(points => points.map((point, index) => {
    if (index === 0 || index === points.length - 1) return point;
    const previous = points[index - 1];
    const next = points[index + 1];
    return [
      previous[0] * 0.25 + point[0] * 0.5 + next[0] * 0.25,
      previous[1] * 0.25 + point[1] * 0.5 + next[1] * 0.25,
    ] as [number, number];
  }));
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

const pickMapAnnotationId = (map: maplibregl.Map, point: {x: number; y: number}, scene: ReplayScene, routesOnly = false): string | null => {
  if (!scene.current.visibility.annotations) return null;
  const bounds = map.getCanvas().getBoundingClientRect();
  const picked = scene.picking.pick({viewId: "map", target: "annotation", x: bounds.left + point.x, y: bounds.top + point.y, radius: 5});
  if (picked?.kind === "annotation" && (!routesOnly || (picked.object as {geometry?: {type?: string}})?.geometry?.type === "LineString")) return picked.annotationId ?? null;
  const layers = (routesOnly ? ["annotation-routes"] : ["annotation-points", "annotation-routes"]).filter(id => map.getLayer(id));
  const feature = layers.length ? map.queryRenderedFeatures([[point.x - 5, point.y - 5], [point.x + 5, point.y + 5]], {layers})[0] : undefined;
  const id = feature?.properties?.id;
  return id && id !== "draft" ? String(id) : null;
};

interface MapViewportProps {
  scene: ReplayScene;
  legendContainer: HTMLDivElement | null;
  annotations: AnnotationProject;
  annotationSelectedId: string | null;
  annotationFocus: {id:string;sequence:number}|null;
  onAnnotationElevationProfile: (profile:TerrainProfilePoint[]|null|undefined)=>void;
  onAnnotationSelect: (id:string|null)=>void;
  onAnnotationFocus: (id:string)=>void;
  astronomy: AstronomyMapState | null;
  onObservationSelect: (point: ObservationPoint) => void;
  drawMode: "select"|"point"|"route";
  draftCoordinates: MapCoordinate[];
  onDrawCoordinate: (coordinate:MapCoordinate)=>void;
  onFinishRoute: ()=>void;
  onCancelDrawing: ()=>void;
  onMoveAnnotationCoordinate: (id:string,index:number,coordinate:MapCoordinate)=>void;
  apiKey: string;
  mapLanguage: MapLanguage;
  buildingCacheLimitMB: number;
  onClearKey: () => void;
  onPointSelect: (timestamp: number) => void;
  onPointerLocation: (location: TerrainProfilePoint | null) => void;
  pointDataset: PointDataset | null;
  flightRoutes: readonly (readonly [number, number])[][];
  flightRouteSegments: readonly FlightRouteSegment[];
  /** 已确认航班涉及的机场坐标（数据层已按机场去重），小比例尺下绘制端点光点。 */
  flightAirports: readonly (readonly [number, number])[];
  onMapViewStateChange?: (viewState: ReplayCamera) => void;
}

export function MapViewport({
  scene,
  legendContainer,
  annotations, annotationSelectedId, annotationFocus, onAnnotationElevationProfile, onAnnotationSelect, onAnnotationFocus,
  astronomy, onObservationSelect,
  drawMode, draftCoordinates, onDrawCoordinate, onFinishRoute, onCancelDrawing, onMoveAnnotationCoordinate,
  apiKey,
  mapLanguage,
  buildingCacheLimitMB,
  onClearKey,
  onPointSelect,
  onPointerLocation,
  pointDataset,
  flightRoutes,
  flightRouteSegments,
  flightAirports,
  onMapViewStateChange,
}: MapViewportProps) {
  const astronomyActive = astronomy !== null;
  const restoreCameraRef = useRef(Boolean(readCached("map-camera", null)));
  const scrollSourceRef = useRef<ScrollSource>("unknown");
  const [terrainAppearance,setTerrainAppearance] = useState<TerrainAppearance | null>(null);
  const [elevationUnavailable, setElevationUnavailable] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const footprintDensityRef = useRef<FootprintDensity | null>(null);
  const footprintLodRef = useRef<FootprintLod>("points");
  const buildingOverlayRef=useRef<BuildingHeightOverlay|null>(null);
  const flightRouteOverlayRef = useRef<HTMLCanvasElement | null>(null);
  const buildingCacheLimitRef=useRef(buildingCacheLimitMB);
  const renderedFootprint = useMemo(() => {
    if (!pointDataset || !flightRouteSegments.length) return {
      coordinates: pointDataset?.footprintCoordinates ?? [],
      timestamps: pointDataset?.footprintTimestamps ?? [],
    };
    const ranges = [...flightRouteSegments]
      .map(segment => [segment.startTime, segment.endTime] as const)
      .sort((a, b) => a[0] - b[0]);
    const coordinates: number[] = [];
    const timestamps: number[] = [];
    let rangeIndex = 0;
    const count = Math.min(pointDataset.footprintTimestamps.length,
      Math.floor(pointDataset.footprintCoordinates.length / 2));
    for (let index = 0; index < count; index += 1) {
      const timestamp = pointDataset.footprintTimestamps[index];
      while (rangeIndex < ranges.length && timestamp > ranges[rangeIndex][1]) rangeIndex += 1;
      const range = ranges[rangeIndex];
      if (range && timestamp >= range[0] && timestamp <= range[1]) continue;
      coordinates.push(pointDataset.footprintCoordinates[index * 2], pointDataset.footprintCoordinates[index * 2 + 1]);
      timestamps.push(timestamp);
    }
    return {coordinates, timestamps};
  }, [pointDataset, flightRouteSegments]);
  useEffect(() => window.replaymod?.onScrollSource(source => {
    scrollSourceRef.current = source;
  }), []);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [errorMessage, setErrorMessage] = useState("");
  const hdrActive = useHDRState().active;
  useEffect(() => {
    scene.setPhotos(status === "ready" && pointDataset && !hdrActive ? replayPhotoPoints(pointDataset.photoCoordinates) : null);
    return () => scene.setPhotos(null);
  }, [scene, status, pointDataset, hdrActive]);
  const [footprint, setFootprint] = useState<FootprintDensityData | null>(null);
  useEffect(() => {
    scene.setFootprint(status === "ready" && pointDataset && !hdrActive ? footprint : null);
    return () => scene.setFootprint(null);
  }, [scene, status, pointDataset, hdrActive, footprint]);

  useEffect(()=>{
    const route=annotations.nodes.find(node=>node.id===annotationSelectedId&&node.kind==="route");
    if(!route){onAnnotationElevationProfile(null);return;}
    const controller=new AbortController();
    onAnnotationElevationProfile(undefined);
    sampleTerrainProfile(route.coordinates,apiKey,controller.signal).then(profile=>{if(!controller.signal.aborted)onAnnotationElevationProfile(profile);}).catch(error=>{if(!controller.signal.aborted){console.warn("路线海拔采样失败",error);onAnnotationElevationProfile(null);}});
    return()=>controller.abort();
  },[annotations,annotationSelectedId,apiKey,onAnnotationElevationProfile]);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    setStatus("loading");
    setErrorMessage("");
    let baseStyleReady = false;
    let roadOverlay: RoadOverlay | null = null;
    let buildingOverlay: BuildingHeightOverlay | null = null;
    const channels = new RenderChannelRegistry(scene);

    const camera = readCached<{center: [number, number]; zoom: number; bearing: number; pitch: number} | null>("map-camera", null);
    setElevationUnavailable(false);
    const elevationController = new AbortController();
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
    const publishCamera = () => {
      const center = map.getCenter();
      onMapViewStateChange?.({longitude:center.lng,latitude:center.lat,zoom:map.getZoom(),bearing:map.getBearing(),pitch:map.getPitch()});
    };
    publishCamera();
    map.on("move", publishCamera);
    const hdr = presentHDR(map.getCanvas());
    map.on("render", hdr.render);
    const basemap = map;
    basemap.once("load", () => {
      baseStyleReady = true;
      const roadStyle = structuredClone(basemap.getStyle());
      // Terrain supplies the surface color/alpha. Keep cartographic details
      // above it at their original opacity, including all map text.
      const surfaceLayers = (basemap.getStyle().layers ?? []).filter(layer =>
        ["background", "fill", "fill-extrusion", "raster", "hillshade", "color-relief"].includes(layer.type));
      for (const layer of surfaceLayers) {
        basemap.setLayoutProperty(layer.id, "visibility", "none");
      }
      restoreWaterLayers(basemap);
      stylePublicBasemap(basemap);
      roadOverlay = new RoadOverlay(basemap, roadStyle);
      const roads = roadOverlay;
      channels.register({id: "map/roads", group: "roads", setVisible: visible => roads.setVisible(visible), dispose: () => roads.dispose()});
      buildingOverlay = new BuildingHeightOverlay(basemap,roadStyle,buildingCacheLimitRef.current);
      buildingOverlayRef.current=buildingOverlay;
      const buildings = buildingOverlay;
      channels.register({id: "map/building-height", group: "buildings", setVisible: visible => buildings.setVisible(visible), dispose: () => buildings.dispose()});
      applyMapLanguage(basemap, mapLanguage);
      setStatus("ready");
      void addElevationGlass(basemap, apiKey, elevationController.signal, setTerrainAppearance,raw=>{
        if (!raw || elevationController.signal.aborted) return;
        channels.register({id: "map/raw-terrain", group: "elevation", setVisible: visible => raw.setVisible(visible), dispose: () => raw.dispose()});
      }).catch(() => {
        if (!elevationController.signal.aborted) {
          setElevationUnavailable(true);
          for (const layer of surfaceLayers) {
            if ("source-layer" in layer && layer["source-layer"] === "building") continue;
            basemap.setLayoutProperty(layer.id, "visibility", layer.layout?.visibility ?? "visible");
          }
        }
      });
    });
    basemap.on("error", event => {
      if ("sourceId" in event && (event.sourceId === "elevation-glass" || event.sourceId === "ocean-elevation-glass")) setElevationUnavailable(true);
    });
    const saveCamera = () => {
      const center = map.getCenter();
      writeCached("map-camera", { center: [center.lng, center.lat], zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() });
    };
    map.on("moveend", saveCamera);
    // MapLibre defaults: trackpad 1/100, wheel 1/450, touch scale 1.
    map.scrollZoom.setZoomRate(2 / 100);
    map.scrollZoom.setWheelZoomRate(2 / 450);
    map.touchZoomRotate.setZoomRate(2);
    map.dragPan.enable();
    map.dragRotate.disable();
    map.boxZoom.disable();
    map.doubleClickZoom.disable();

    const canvasContainer = map.getCanvasContainer();
    const handleWheel = (event: WheelEvent) => {
      // Chromium emits trackpad pinch gestures as Ctrl+wheel. Let MapLibre
      // handle those with the doubled zoom rates configured above.
      if (event.ctrlKey) return;
      if (scrollSourceRef.current === "mouse-wheel") return;

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


    basemap.on("error", (event) => {
      if (!baseStyleReady) {
        setStatus("error");
        setErrorMessage(event.error?.message ?? "地图服务连接失败");
      }
    });

    return () => {
      canvasContainer.removeEventListener("wheel", handleWheel, true);
      elevationController.abort();
      channels.destroy();
      map.off("render", hdr.render);
      map.off("move", publishCamera);
      hdr.dispose();
      footprintDensityRef.current = null;
      if(buildingOverlayRef.current===buildingOverlay)buildingOverlayRef.current=null;
      mapRef.current = null;
      map.remove();
    };
  }, [apiKey, mapLanguage, onMapViewStateChange, scene]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    const airports = airportGeoJson(mapLanguage).features;
    let visible = scene.current.visibility.airports;
    const registry = new RenderChannelRegistry(scene);
    let markers: maplibregl.Marker[] = [];
    const update = () => {
      markers.forEach(marker => marker.remove());
      markers = [];
      if (!visible || map.getZoom() < AIRPORT_MIN_ZOOM) return;
      const bounds = map.getBounds();
      for (const feature of airports) {
        if (feature.geometry.type !== "Point") continue;
        const [longitude, latitude] = feature.geometry.coordinates;
        if (!bounds.contains([longitude, latitude])) continue;
        const element = document.createElement("div");
        Object.assign(element.style, {
          display: "flex", flexDirection: "column", alignItems: "center",
          color: "#e9f4ff", font: "600 12px/1.15 sans-serif",
          textShadow: "0 1px 2px #08111c, 0 0 3px #08111c",
          whiteSpace: "nowrap", pointerEvents: "none", zIndex: "101",
        });
        const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        icon.setAttribute("viewBox", "0 0 24 24");
        icon.setAttribute("width", "22");
        icon.setAttribute("height", "22");
        icon.innerHTML = '<path d="M21 16v-2l-8-5V3.5A1.5 1.5 0 0 0 11.5 2 1.5 1.5 0 0 0 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z" fill="#c9f7ff"/>';
        const label = document.createElement("span");
        label.textContent = String(feature.properties?.name ?? "");
        element.append(icon, label);
        // The airport coordinate must sit at the aircraft icon's center, not
        // at the center of the combined icon + label block. Otherwise route
        // caps converge below the icon and form a stray star-shaped "point".
        markers.push(new maplibregl.Marker({ element, anchor: "top", offset: [0, -11] })
          .setLngLat([longitude, latitude]).addTo(map));
      }
    };
    map.on("moveend", update);
    registry.register({
      id: "map/airports", group: "airports",
      setVisible: value => { visible = value; update(); },
      dispose: () => {
        map.off("moveend", update);
        markers.forEach(marker => marker.remove());
        markers = [];
      },
    });
    return () => registry.destroy();
  }, [mapLanguage, status, scene]);

  useEffect(()=>{buildingCacheLimitRef.current=buildingCacheLimitMB;buildingOverlayRef.current?.updateMemoryLimit(buildingCacheLimitMB);},[buildingCacheLimitMB]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    const applyVisibility = (group: keyof typeof scene.current.visibility) => {
      applyMapLayerVisibility(map, scene.current.visibility, {
        density: Boolean(footprintDensityRef.current || scene.visuals.current.footprint),
        line: footprintLodRef.current === "line",
        photosInEngine: scene.visuals.current.photos,
      }, group);
      if (group === "trajectory") footprintDensityRef.current?.setVisible(scene.current.visibility.trajectory && !scene.visuals.current.footprint);
    };
    const disposeStyles = registerStyleRenderChannels(scene, map, "map/style", applyVisibility);
    const disposeVisuals = scene.visuals.subscribe(() => applyVisibility("trajectory"));
    return () => { disposeVisuals(); disposeStyles(); };
  }, [scene, status]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    let timer = 0;
    let controller: AbortController | null = null;
    let latest: [number, number] | null = null;
    const sample = () => {
      if (!latest) return;
      controller?.abort();
      const requestController = new AbortController();
      controller = requestController;
      const coordinate = latest;
      sampleTerrainProfile([coordinate], apiKey, requestController.signal).then(points => {
        if (!requestController.signal.aborted && points[0]) onPointerLocation(points[0]);
      }).catch(() => undefined);
    };
    const move = (event: maplibregl.MapMouseEvent) => {
      latest = [event.lngLat.lng, event.lngLat.lat];
      onPointerLocation([latest[0], latest[1], Number.NaN]);
      window.clearTimeout(timer);
      timer = window.setTimeout(sample, 180);
    };
    map.on("mousemove", move);
    return () => {
      map.off("mousemove", move);
      window.clearTimeout(timer);
      controller?.abort();
    };
  }, [apiKey, onPointerLocation, status]);

  useEffect(()=>{
    const map=mapRef.current;
    if(!map || status!=="ready")return;
    const applyRenderer = () => {
      const opacity = scene.visuals.current.annotations ? 0 : 1;
      for (const [id, property] of [["annotation-routes", "line-opacity"], ["annotation-points", "circle-opacity"], ["annotation-points", "circle-stroke-opacity"]] as const) {
        if (map.getLayer(id) && map.getPaintProperty(id, property) !== opacity) map.setPaintProperty(id, property, opacity);
      }
    };
    const update = (snapshot: typeof scene.current) => {
    const features = legacyMapAnnotationGeometry(snapshot.annotationGeometry);
    const source=map.getSource("annotations") as maplibregl.GeoJSONSource|undefined;
    if(source)source.setData(features);
    else {
      map.addSource("annotations",{type:"geojson",data:features});
      map.addLayer({id:"annotation-routes",type:"line",source:"annotations",filter:["==",["geometry-type"],"LineString"],layout:{"line-cap":"round","line-join":"round"},paint:{"line-color":["get","color"],"line-width":["case",["==",["get","selected"],true],3,2],"line-opacity":1}});
      map.addLayer({id:"annotation-points",type:"circle",source:"annotations",filter:["==",["geometry-type"],"Point"],paint:{"circle-color":["get","color"],"circle-radius":["case",["==",["get","selected"],true],4,2.5],"circle-stroke-width":0.75,"circle-stroke-color":"#fff","circle-opacity":1}});
    }
    applyRenderer();
    };
    let previous = scene.current.annotationGeometry;
    update(scene.current);
    const unsubscribe = scene.subscribe(snapshot => {
      if (snapshot.annotationGeometry === previous) return;
      previous = snapshot.annotationGeometry;
      update(snapshot);
    });
    const unsubscribeVisual = scene.visuals.subscribe(applyRenderer);
    map.on("styledata", applyRenderer);
    return () => { unsubscribe(); unsubscribeVisual(); map.off("styledata", applyRenderer); };
  },[scene,status]);

  useEffect(()=>{
    const map=mapRef.current;
    if(!map || status!=="ready" || !annotationFocus)return;
    const selected=annotations.nodes.find(n=>n.id===annotationFocus.id);
    if(!selected)return;
    const descendants=new Set([selected.id]);
    if(selected.kind==="folder") {let changed=true;while(changed){changed=false;for(const n of annotations.nodes)if(n.parentId&&descendants.has(n.parentId)&&!descendants.has(n.id)){descendants.add(n.id);changed=true;}}}
    const bounds=new maplibregl.LngLatBounds();
    for(const n of annotations.nodes)if(descendants.has(n.id))for(const c of n.coordinates)bounds.extend([c[0],c[1]]);
    if(!bounds.isEmpty())map.fitBounds(bounds,{padding:{top:120,bottom:180,left:350,right:32},maxZoom:14,duration:700});
  },[annotationFocus,status]);

  useEffect(()=>{
    const map=mapRef.current;
    if(!map || status!=="ready")return;
    map.getCanvas().style.cursor=astronomyActive || drawMode!=="select"?"crosshair":"";
    const click=(e:maplibregl.MapMouseEvent)=>{
      if (astronomyActive) {
        const { lng, lat } = e.lngLat.wrap();
        onObservationSelect([lng, lat]);
        return;
      }
      if(drawMode!=="select"){onDrawCoordinate([((e.lngLat.lng+180)%360+360)%360-180,e.lngLat.lat]);return;}
      onAnnotationSelect(pickMapAnnotationId(map, e.point, scene));
    };
    const doubleClick=(e:maplibregl.MapMouseEvent)=>{
      if(astronomyActive || drawMode!=="select" || !scene.current.visibility.annotations)return;
      const id = pickMapAnnotationId(map, e.point, scene, true);
      if (id) onAnnotationFocus(id);
    };
    const key=(e:KeyboardEvent)=>{
      if(astronomyActive || isEditableTarget(e.target))return;
      if(e.key==="Escape")onCancelDrawing();
      if(e.key==="Enter"&&drawMode==="route"){e.preventDefault();onFinishRoute();}
    };
    map.on("click",click);map.on("dblclick",doubleClick);window.addEventListener("keydown",key);
    return()=>{map.off("click",click);map.off("dblclick",doubleClick);window.removeEventListener("keydown",key);};
  },[astronomyActive,onObservationSelect,drawMode,status,onDrawCoordinate,onAnnotationSelect,onAnnotationFocus,onFinishRoute,onCancelDrawing,scene]);

  useEffect(() => {
    const map = mapRef.current;
    const node = visibleAnnotations(annotations).find(candidate => candidate.id === annotationSelectedId);
    if (!map || status !== "ready" || astronomyActive || drawMode !== "select" || !node || node.coordinates.length > 200) return;
    const registry = new RenderChannelRegistry(scene);
    const positions: [number, number][] = node.coordinates.map(([longitude, latitude]) => [longitude, latitude]);
    const markers = positions.map((position, index) => {
      const element = document.createElement("div");
      element.className = "annotation-handle";
      element.title = "拖动调整坐标";
      const marker = new maplibregl.Marker({element, draggable: true}).setLngLat(position).addTo(map);
      const updatePosition = () => {
        const {lng, lat} = marker.getLngLat();
        const coordinate: [number, number] = [((lng + 180) % 360 + 360) % 360 - 180, lat];
        positions[index] = coordinate;
        scene.setAnnotationHandles(positions.slice());
        return coordinate;
      };
      marker.on("drag", updatePosition);
      marker.on("dragend", () => onMoveAnnotationCoordinate(node.id, index, updatePosition()));
      return marker;
    });
    scene.setAnnotationHandles(positions.slice());
    const applyRenderer = () => {
      const opacity = scene.visuals.current.handles ? "0" : "";
      for (const marker of markers) marker.getElement().style.opacity = opacity;
    };
    applyRenderer();
    const unsubscribeVisuals = scene.visuals.subscribe(applyRenderer);
    registry.register({
      id: "map/annotation-handles", group: "annotations",
      setVisible: visible => markers.forEach(marker => {
        marker.getElement().style.display = visible ? "" : "none";
      }),
      dispose: () => markers.forEach(marker => marker.remove()),
    });
    return () => {
      unsubscribeVisuals();
      registry.destroy();
      scene.setAnnotationHandles([]);
    };
  }, [annotations, annotationSelectedId, astronomyActive, drawMode, status, onMoveAnnotationCoordinate, scene]);

  useEffect(() => {
    const map = mapRef.current;

    if (!map || status !== "ready") return;
    if (!pointDataset) {
      const photoSource = map.getSource<maplibregl.GeoJSONSource>(PHOTO_SOURCE_ID);
      photoSource?.setData(toMultiPoint([]));
      footprintDensityRef.current?.setCoordinates([]);
      footprintDensityRef.current?.setLinePaths([]);
      map.getSource<maplibregl.GeoJSONSource>(FOOTPRINT_SOURCE_ID)?.setData(toMultiPoint([]));
      map.getSource<maplibregl.GeoJSONSource>(FALLBACK_ROUTE_SOURCE_ID)?.setData({
        type: "Feature", properties: {}, geometry: {type: "MultiLineString", coordinates: []},
      });
      setFootprint(null);
      return;
    }

    const footprintGeoJson = toMultiPoint(
      renderedFootprint.coordinates,
    );
    // Photos are sparse, independent observations: always keep the complete
    // point set instead of applying the trajectory's continuity-based LOD.
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
          "circle-opacity": 0.12,
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            1,
            0.6,
            8,
            1.1,
            14,
            2,
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
          "circle-opacity": 0.82,
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            ...photoPointRadiusStops,
          ],
          "circle-blur": 0.15,
        },
      });
    }

    const routePaths = toFootprintRoutePaths(
      renderedFootprint.coordinates,
      renderedFootprint.timestamps,
    );
    const density = footprintDensityRef.current;
    if (density) {
      density.setCoordinates(renderedFootprint.coordinates);
      density.setLinePaths(routePaths);
    } else {
      const layer = new FootprintDensity(renderedFootprint.coordinates, routePaths);
      try {
        map.addLayer(layer, PHOTO_LAYER_ID);
        footprintDensityRef.current = layer;
        map.setLayoutProperty(FOOTPRINT_LAYER_ID, "visibility", "none");
      } catch (error) {
        console.warn("浮点轨迹密度不可用，使用普通轨迹点与路线", error);
        if (map.getLayer(layer.id)) map.removeLayer(layer.id);
        else layer.onRemove();
        const fallbackSource = map.getSource(FALLBACK_ROUTE_SOURCE_ID);
        if (fallbackSource) {
          (fallbackSource as maplibregl.GeoJSONSource).setData({
            type: "Feature",
            properties: {},
            geometry: {type: "MultiLineString", coordinates: routePaths},
          });
        } else {
          map.addSource(FALLBACK_ROUTE_SOURCE_ID, {
            type: "geojson",
            data: {
              type: "Feature",
              properties: {},
              geometry: {type: "MultiLineString", coordinates: routePaths},
            },
          });
          map.addLayer({
            id: FALLBACK_ROUTE_LAYER_ID,
            type: "line",
            source: FALLBACK_ROUTE_SOURCE_ID,
            layout: {
              visibility: "none",
              "line-cap": "round",
              "line-join": "round",
            },
            paint: {
              "line-color": "#b9f5c5",
              "line-opacity": 0.72,
              "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.7, 8, 1.4, 14, 2.4],
              "line-blur": 0.2,
            },
          });
        }
      }
    }

    let appliedLod: FootprintLod | null = null;
    const applyFootprintLod = (lod: FootprintLod) => {
      appliedLod = lod;
      footprintLodRef.current = lod;
      const mode = lod === "line" ? "line" : "points";
      const displayCoordinates = lod === "coarse"
        ? decimateFootprintCoordinates(
            renderedFootprint.coordinates,
            renderedFootprint.timestamps,
            footprintCoarseTargetPx(2 * footprintRadius(map.getZoom())) *
              footprintMetersPerPixel(map.getZoom(), map.getCenter().lat),
          )
        : renderedFootprint.coordinates;
      setFootprint(previous => previous?.mode === mode && previous.coordinates === displayCoordinates && previous.paths === routePaths
        ? previous : {mode, coordinates: displayCoordinates, paths: routePaths});

      const legacyDensity = footprintDensityRef.current;
      if (legacyDensity) {
        legacyDensity.setMode(mode);
        legacyDensity.setCoordinates(displayCoordinates);
        legacyDensity.setVisible(scene.current.visibility.trajectory && !scene.visuals.current.footprint);
      } else if (mode === "points") {
        map.getSource<maplibregl.GeoJSONSource>(FOOTPRINT_SOURCE_ID)?.setData(toMultiPoint(displayCoordinates));
      }
      applyMapLayerVisibility(map, scene.current.visibility, {
        density: Boolean(legacyDensity || scene.visuals.current.footprint),
        line: mode === "line",
        photosInEngine: scene.visuals.current.photos,
      }, "trajectory");
    };

    const evaluateFootprintLod = () => {
      if (!scene.current.visibility.trajectory) return;
      try {
        const center = map.getCenter();
        const bounds = map.getBounds();
        const medianSpacing = medianAnchoredScreenSpacing(
          renderedFootprint.coordinates,
          renderedFootprint.timestamps,
          map.getZoom(),
          center.lat,
          {
            west: bounds.getWest(),
            east: bounds.getEast(),
            south: bounds.getSouth(),
            north: bounds.getNorth(),
          },
        );
        const lod = selectFootprintLod(
          footprintLodRef.current,
          medianSpacing,
          2 * footprintRadius(map.getZoom()),
        );
        // Coarse thinning retargets its spacing to the zoom on every moveend.
        if (lod !== appliedLod || lod === "coarse") {
          applyFootprintLod(lod);
        }
      } catch (error) {
        console.error("足迹 LOD 更新失败", error);
      }
    };
    if (!scene.current.visibility.trajectory) applyFootprintLod("points");
    map.on("moveend", evaluateFootprintLod);
    const lodChannels = new RenderChannelRegistry(scene);
    lodChannels.register({id: "map/footprint-lod", group: "trajectory", setVisible: visible => { if (visible) evaluateFootprintLod(); }, dispose: () => { map.off("moveend", evaluateFootprintLod); }});

    if (restoreCameraRef.current) {
      restoreCameraRef.current = false;
      return () => {
        lodChannels.destroy();
      };
    }
    map.fitBounds(
      [
        [pointDataset.bounds[0], pointDataset.bounds[1]],
        [pointDataset.bounds[2], pointDataset.bounds[3]],
      ],
      {
        padding: {
          top: 84,
          right: 32,
          bottom: 150,
          left: 320,
        },
        duration: 900,
        maxZoom: 13,
      },
    );
    return () => {
      lodChannels.destroy();
    };
  }, [pointDataset, renderedFootprint, status, scene]);

  useEffect(() => {
    const mapReady = mapRef.current;
    if (!mapReady || status !== "ready") return;
    const map = mapReady;
    const mapContainer = map.getContainer();
    flightRouteOverlayRef.current?.remove();
    flightRouteOverlayRef.current = null;
    // Fast Refresh can preserve an older effect closure and leave its direct-child
    // canvas behind. Remove any previous flight overlay before installing the
    // current dynamic one, otherwise old and new arrow-placement rules stack.
    for (const child of Array.from(mapContainer.children)) {
      if (child instanceof HTMLCanvasElement && (
        child.dataset.flightRouteOverlay === "true" ||
        (child.style.zIndex === "100" && child.style.pointerEvents === "none")
      )) child.remove();
    }
    const routeOverlay = document.createElement("canvas");
    routeOverlay.dataset.flightRouteOverlay = "true";
    Object.assign(routeOverlay.style, {
      position: "absolute", inset: "0", width: "100%", height: "100%",
      pointerEvents: "none", overflow: "hidden", zIndex: "100",
    });
    const routeContext = routeOverlay.getContext("2d")!;
    // MapLibre 5 的 .maplibregl-canvas-container 没有定位/尺寸规则（clientHeight 为 0，
    // 主 canvas 靠显式 px 撑尺寸）。覆盖层必须挂到 position:relative 的 .maplibregl-map
    // 容器并用它的 clientWidth/Height 定尺寸，否则位图高度为 0，弧线全部画丢。
    mapContainer.append(routeOverlay);
    flightRouteOverlayRef.current = routeOverlay;
    let routesVisible = scene.current.visibility.airports;
    // 分段线性插值（zoom→值），与原 MapLibre circle 层 interpolate 口径一致。
    const piecewise = (zoom: number, stops: ReadonlyArray<readonly [number, number]>) => {
      if (zoom <= stops[0][0]) return stops[0][1];
      for (let i = 1; i < stops.length; i += 1) {
        if (zoom <= stops[i][0]) {
          const [z0, v0] = stops[i - 1];
          const [z1, v1] = stops[i];
          return v0 + (v1 - v0) * (zoom - z0) / (z1 - z0);
        }
      }
      return stops.at(-1)![1];
    };
    const drawRoutes = () => {
      routeOverlay.style.display = routesVisible ? "block" : "none";
      if (!routesVisible) return;
      const container = map.getContainer();
      const pixelRatio = window.devicePixelRatio || 1;
      routeOverlay.width = Math.round(container.clientWidth * pixelRatio);
      routeOverlay.height = Math.round(container.clientHeight * pixelRatio);
      routeContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      routeContext.clearRect(0, 0, container.clientWidth, container.clientHeight);
      const zoom = map.getZoom();
      // 全国视角保持纤细（0.625px），放大到省级以下后逐步加粗，近地视角约 2.4px。
      const width = piecewise(zoom, [[1, .625], [5, .625], [14, 2.4]]);
      // 高饱和亮青、不透明：浅色低饱和青叠在灰度地形上会发“污”。
      routeContext.strokeStyle = "#22ebff";
      routeContext.lineWidth = width;
      routeContext.lineCap = "round";
      routeContext.lineJoin = "round";
      // 箭头尺寸：全国视角 9px，随放大增长到约 13px。
      const arrowLength = piecewise(zoom, [[1, 9], [5, 9], [14, 13]]);
      // 大比例尺下能看清机场 icon：弧线两端在屏幕空间各缩短固定像素，为 icon 留空；
      // 小比例尺 icon 不显示，弧线直达机场点。
      // Leave enough room for both the 20px aircraft glyph and the first line
      // of its label. A smaller gap lets many round line caps pile up into an
      // irregular point around hub airports.
      const endpointGap = zoom >= AIRPORT_MIN_ZOOM ? 24 : 0;
      // canvas 铺满整个应用，实际可见地图区由中央交互区决定。
      const containerRect = container.getBoundingClientRect();
      const interactionRect = document.querySelector<HTMLElement>(".map-interaction-area")?.getBoundingClientRect();
      const viewLeft = interactionRect ? interactionRect.left - containerRect.left : 0;
      const viewTop = interactionRect ? interactionRect.top - containerRect.top : 0;
      const viewRight = interactionRect ? interactionRect.right - containerRect.left : container.clientWidth;
      const viewBottom = interactionRect ? interactionRect.bottom - containerRect.top : container.clientHeight;
      const viewMargin = arrowLength * .9 + 6;
      const minX = viewLeft + viewMargin;
      const maxX = viewRight - viewMargin - 52;
      const minY = viewTop + viewMargin;
      const maxY = viewBottom - viewMargin;
      const insideView = (p: {x: number; y: number}) =>
        p.x >= viewLeft && p.x <= viewRight && p.y >= viewTop && p.y <= viewBottom;
      const insideSafe = (p: {x: number; y: number}) =>
        p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY;
      const trimPolyline = (pts: Array<{x: number; y: number}>, gap: number) => {
        if (gap <= 0 || pts.length < 2) return pts;
        const lengths = [0];
        for (let i = 1; i < pts.length; i += 1) {
          lengths[i] = lengths[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        }
        const total = lengths.at(-1)!;
        if (!(total > gap * 2)) return [];
        const at = (distance: number) => {
          if (distance <= 0) return pts[0];
          if (distance >= total) return pts.at(-1)!;
          let i = 1;
          while (lengths[i] < distance) i += 1;
          const segment = lengths[i] - lengths[i - 1] || 1;
          const t = (distance - lengths[i - 1]) / segment;
          return {x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t};
        };
        const trimmed = [at(gap)];
        for (let i = 1; i < pts.length - 1; i += 1) {
          if (lengths[i] > gap && lengths[i] < total - gap) trimmed.push(pts[i]);
        }
        trimmed.push(at(total - gap));
        return trimmed;
      };
      const airportCoordinateKey = ([longitude, latitude]: readonly [number, number]) =>
        `${longitude.toFixed(4)},${latitude.toFixed(4)}`;
      const visibleAirportTraffic = new Map<string, number>();
      for (const route of flightRoutes) {
        // 完整弧用于箭头切向；实际描边用两端缩短后的路径。
        const points = route.map(([longitude, latitude]) => map.project([longitude, latitude]));
        // 起降端都不在当前真实可见地图区时视为过境航线：整条不画。
        if (!insideView(points[0]) && !insideView(points.at(-1)!)) continue;
        for (const endpoint of [route[0], route.at(-1)!]) {
          const key = airportCoordinateKey(endpoint);
          visibleAirportTraffic.set(key, (visibleAirportTraffic.get(key) ?? 0) + 1);
        }
        const pathPoints = trimPolyline(points, endpointGap);
        if (pathPoints.length > 1) {
          routeContext.beginPath();
          pathPoints.forEach((point, index) => index
            ? routeContext.lineTo(point.x, point.y)
            : routeContext.moveTo(point.x, point.y));
          routeContext.stroke();
        }

        // 方向箭头：凹四边形燕尾航向标（前尖 + 两翼 + 尾缘中点前凹），骑在线上。
        // 箭头落在当前可见航段中最靠近屏幕边缘的位置。之前误用了“离边缘最远”，
        // 放大枢纽机场时机场本身正是最深点，导致所有航线箭头聚成一团。
        // 安全区已在循环外按当前 UI 布局实时计算。
        // 对每个折线段做矩形裁切，直接得到它与安全边框的交点。不能只检查离散
        // 采样点：高倍缩放时相邻两点可能从机场中心一步跳到屏幕外。
        const clipToSafeRect = (start: {x: number; y: number}, end: {x: number; y: number}) => {
          const dx = end.x - start.x;
          const dy = end.y - start.y;
          const p = [-dx, dx, -dy, dy];
          const q = [start.x - minX, maxX - start.x, start.y - minY, maxY - start.y];
          let from = 0;
          let to = 1;
          for (let i = 0; i < 4; i += 1) {
            if (Math.abs(p[i]) < 1e-9) {
              if (q[i] < 0) return null;
              continue;
            }
            const ratio = q[i] / p[i];
            if (p[i] < 0) from = Math.max(from, ratio);
            else to = Math.min(to, ratio);
            if (from > to) return null;
          }
          const at = (ratio: number) => ({x: start.x + dx * ratio, y: start.y + dy * ratio});
          return {start: at(from), end: at(to)};
        };
        let center: {x: number; y: number} | null = null;
        let tangentStart: {x: number; y: number} | null = null;
        let tangentEnd: {x: number; y: number} | null = null;
        // 原曲线弧长中点（不使用为机场图标留白后的截短线）。
        const segmentLengths: number[] = [];
        let pathLength = 0;
        for (let i = 1; i < points.length; i += 1) {
          const length = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
          segmentLengths.push(length);
          pathLength += length;
        }
        let traversed = 0;
        const midpointDistance = pathLength / 2;
        let curveMidpoint: {x: number; y: number} | null = null;
        let midpointTangentStart: {x: number; y: number} | null = null;
        let midpointTangentEnd: {x: number; y: number} | null = null;
        for (let i = 1; i < points.length; i += 1) {
          const length = segmentLengths[i - 1];
          if (traversed + length >= midpointDistance && length > 1e-6) {
            const ratio = (midpointDistance - traversed) / length;
            const start = points[i - 1];
            const end = points[i];
            curveMidpoint = {x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio};
            midpointTangentStart = start;
            midpointTangentEnd = end;
            break;
          }
          traversed += length;
        }
        // 原中点可见时用中点；仅在中点不可见时才吸附到可见边缘。
        if (curveMidpoint && midpointTangentStart && midpointTangentEnd
          && insideSafe(curveMidpoint)
          && insideView(curveMidpoint)) {
          center = curveMidpoint;
          tangentStart = midpointTangentStart;
          tangentEnd = midpointTangentEnd;
        }
        if (!center) {
          let edgeDepth = Number.POSITIVE_INFINITY;
          for (let i = 1; i < pathPoints.length; i += 1) {
            const segmentStart = pathPoints[i - 1];
            const segmentEnd = pathPoints[i];
            const clipped = clipToSafeRect(segmentStart, segmentEnd);
            if (!clipped) continue;
            // 相同深度时取航线方向上更靠后的交点，使穿屏航线的箭头落在去向一侧。
            for (const point of [clipped.start, clipped.end]) {
              const depth = Math.min(point.x - minX, maxX - point.x, point.y - minY, maxY - point.y);
              if (depth <= edgeDepth) {
                edgeDepth = depth;
                center = point;
                tangentStart = segmentStart;
                tangentEnd = segmentEnd;
              }
            }
          }
        }
        if (!center || !tangentStart || !tangentEnd) continue;
        let tangentX = tangentEnd.x - tangentStart.x;
        let tangentY = tangentEnd.y - tangentStart.y;
        const tangentLength = Math.hypot(tangentX, tangentY);
        if (!(tangentLength > 1e-6)) continue;
        tangentX /= tangentLength;
        tangentY /= tangentLength;
        const perpendicularX = -tangentY;
        const perpendicularY = tangentX;
        const halfLength = arrowLength / 2;
        const halfWidth = arrowLength * .42;
        // 尾缘凹点在中心后方、但比两翼更靠前，构成向内凹进的燕尾缺口。
        const notchBack = halfLength * .35;
        const tipX = center.x + tangentX * halfLength;
        const tipY = center.y + tangentY * halfLength;
        const wingRightX = center.x - tangentX * halfLength + perpendicularX * halfWidth;
        const wingRightY = center.y - tangentY * halfLength + perpendicularY * halfWidth;
        const notchX = center.x - tangentX * notchBack;
        const notchY = center.y - tangentY * notchBack;
        const wingLeftX = center.x - tangentX * halfLength - perpendicularX * halfWidth;
        const wingLeftY = center.y - tangentY * halfLength - perpendicularY * halfWidth;
        routeContext.beginPath();
        routeContext.moveTo(tipX, tipY);
        routeContext.lineTo(wingRightX, wingRightY);
        routeContext.lineTo(notchX, notchY);
        routeContext.lineTo(wingLeftX, wingLeftY);
        routeContext.closePath();
        routeContext.fillStyle = "#a8f7ff";
        routeContext.fill();
      }

      // 起降端点最后用加色混合画：内核保持小，bloom 随汇入航线数增长，
      // 亮青航线会直接融入光晕，而不是被一个独立圆点盖住。
      // 点位直接取数据层按机场去重后的机场坐标（flightAirports），不从航线端点推算；
      // zoom≥10 机场 icon 可见，光点隐藏，弧线已在端点附近截断给 icon 留空。
      if (zoom < AIRPORT_MIN_ZOOM) {
        routeContext.save();
        routeContext.globalCompositeOperation = "lighter";
        const drawEndpoint = (longitude: number, latitude: number, traffic: number) => {
          const {x, y} = map.project([longitude, latitude]);
          const trafficScale = Math.sqrt(Math.max(1, traffic));
          const bloom = piecewise(zoom, [[1, 1.8], [8, 3.2], [9.9, 4.5]]) + (trafficScale - 1) * 1.15;
          const bloomAlpha = Math.min(.2 + Math.log2(Math.max(1, traffic) + 1) * .045, .42);
          const bloomGradient = routeContext.createRadialGradient(x, y, 0, x, y, bloom * 1.9);
          bloomGradient.addColorStop(0, `rgba(168,247,255,${bloomAlpha})`);
          bloomGradient.addColorStop(.28, `rgba(34,235,255,${bloomAlpha * .72})`);
          bloomGradient.addColorStop(1, "rgba(189,245,255,0)");
          routeContext.fillStyle = bloomGradient;
          routeContext.beginPath();
          routeContext.arc(x, y, bloom * 1.85, 0, Math.PI * 2);
          routeContext.fill();
          const core = piecewise(zoom, [[1, .7], [8, 1.05], [9.9, 1.4]])
            + Math.min(Math.log2(Math.max(1, traffic) + 1) * .12, .55);
          const coreGradient = routeContext.createRadialGradient(x, y, 0, x, y, core * 1.15);
          coreGradient.addColorStop(0, "rgba(226,252,255,.94)");
          coreGradient.addColorStop(.72, "rgba(168,247,255,.78)");
          coreGradient.addColorStop(1, "rgba(189,245,255,0)");
          routeContext.fillStyle = coreGradient;
          routeContext.beginPath();
          routeContext.arc(x, y, core * 1.15, 0, Math.PI * 2);
          routeContext.fill();
        };
        for (const [longitude, latitude] of flightAirports) {
          const traffic = visibleAirportTraffic.get(airportCoordinateKey([longitude, latitude])) ?? 0;
          if (traffic > 0) drawEndpoint(longitude, latitude, traffic);
        }
        routeContext.restore();
      }
    };
    const drawRoutesGuarded = () => {
      try {
        drawRoutes();
      } catch (error) {
        // 覆盖层绘制不能打断 MapLibre 的 render 事件循环。
        console.error("[flight-routes] overlay draw failed", error);
      }
    };
    map.on("render", drawRoutesGuarded);
    drawRoutesGuarded();
    const registry = new RenderChannelRegistry(scene);
    registry.register({
      id: "map/airport-flight-routes",
      group: "airports",
      setVisible: visible => {
        routesVisible = visible;
        drawRoutesGuarded();
      },
      dispose: () => {},
    });
    return () => {
      map.off("render", drawRoutesGuarded);
      routeOverlay.remove();
      if (flightRouteOverlayRef.current === routeOverlay) {
        flightRouteOverlayRef.current = null;
      }
      registry.destroy();
    };
  }, [flightRoutes, flightAirports, scene, status, FLIGHT_ROUTE_OVERLAY_VERSION]);

  useEffect(() => {
    const map = mapRef.current;

    if (!map || status !== "ready" || !pointDataset || astronomyActive) {
      return;
    }

    const handleClick = (event: maplibregl.MapMouseEvent) => {
      if(drawMode!=="select" || !scene.current.visibility.trajectory)return;
      if (pickMapAnnotationId(map, event.point, scene)) return;
      const bounds = map.getCanvas().getBoundingClientRect();
      const picked = scene.picking.pick({viewId: "map", target: "trajectory", x: bounds.left + event.point.x, y: bounds.top + event.point.y, radius: POINT_HIT_RADIUS});
      // Preserve the verified fallback until real-GPU parity is established.
      const timestamp = picked?.timestamp ?? findNearestPointTimestamp(map, event.point, pointDataset);

      if (timestamp !== null) {
        onPointSelect(timestamp);
      }
    };

    let hoverFrame: number | null = null;
    let hoverPoint: {x: number; y: number} | null = null;
    const clearHover = () => {
      hoverPoint = null;
      if (hoverFrame !== null) cancelAnimationFrame(hoverFrame);
      hoverFrame = null;
      if (scene.current.cursor?.source === "map") scene.setCursor(null);
    };
    const handleHover = (event: maplibregl.MapMouseEvent) => {
      if (drawMode !== "select" || !scene.current.visibility.trajectory || map.isMoving()) { clearHover(); return; }
      hoverPoint = event.point;
      if (hoverFrame !== null) return;
      hoverFrame = requestAnimationFrame(() => {
        hoverFrame = null;
        if (!hoverPoint || !scene.current.visibility.trajectory) { clearHover(); return; }
        const bounds = map.getCanvas().getBoundingClientRect();
        const picked = scene.picking.pick({viewId: "map", target: "trajectory", x: bounds.left + hoverPoint.x, y: bounds.top + hoverPoint.y, radius: POINT_HIT_RADIUS});
        if (picked?.timestamp !== null && picked?.timestamp !== undefined && picked.coordinate) scene.setCursor({source: "map", timestamp: picked.timestamp, trajectoryIndex: picked.trajectoryIndex, coordinate: [picked.coordinate[0], picked.coordinate[1]]});
        else clearHover();
      });
    };
    map.on("click", handleClick);
    map.on("mousemove", handleHover);
    map.on("mouseout", clearHover);
    map.on("movestart", clearHover);
    return () => {
      clearHover();
      map.off("click", handleClick);
      map.off("mousemove", handleHover);
      map.off("mouseout", clearHover);
      map.off("movestart", clearHover);
    };
  }, [onPointSelect, pointDataset, status, drawMode, scene, astronomyActive]);

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
      <div ref={containerRef} className={`map-container${astronomyActive ? " astronomy-basemap" : ""}`} />
      {astronomy && status === "ready" && mapRef.current && <AstronomyOverlay map={mapRef.current} state={astronomy}/>}
      {!astronomyActive && status === "ready" && mapRef.current && <AnnotationLabels
        map={mapRef.current}
        scene={scene}
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

      {status === "ready" && legendContainer && createPortal(
        <div className="toolbar-map-legend" aria-label="地图图例">
          {pointDataset && <span className="toolbar-point-legend" title={pointDataset.sourceName}>
            <span><i className="footprint-swatch"/>足迹 {pointDataset.footprintPointCount.toLocaleString("zh-CN")}</span>
            <span><i className="photo-swatch"/>照片 {pointDataset.photoPointCount.toLocaleString("zh-CN")}</span>
          </span>}
          {elevationUnavailable ? <span role="status">海拔图层暂不可用</span> : <TerrainLegend appearance={terrainAppearance}/>}
        </div>, legendContainer
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
    </section>
  );
}
