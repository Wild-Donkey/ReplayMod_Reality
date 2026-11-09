import { WebMercatorViewport } from "@deck.gl/core";
import { replayPhotoPoints } from "../../apps/desktop/src/renderer/render-engine/PhotoPoints";
import { ReplayScene } from "../../apps/desktop/src/renderer/render-engine/ReplayScene";
import { ReplayCanvasCapture } from "../../apps/desktop/src/renderer/render-engine/export/ReplayCanvasCapture";

export async function checkVisibleReplayLayers() {
  const parent = document.createElement("div");
  Object.assign(parent.style, {position: "absolute", width: "128px", height: "392px"}); document.body.append(parent);
  const scene = new ReplayScene(), camera = {longitude: 0, latitude: 0, zoom: 10, bearing: 0, pitch: 0};
  scene.setAnnotationGeometry({type: "FeatureCollection", features: [
    {type: "Feature", id: "route", properties: {id: "route", color: "#55cfff"}, geometry: {type: "LineString", coordinates: [[-0.05, 0, 900], [0.05, 0, 900]]}},
    {type: "Feature", id: "draft", properties: {id: "draft", color: "#ffe36e"}, geometry: {type: "Point", coordinates: [-0.02, 0.02]}},
  ]});
  const release = scene.registerMetricSeries("elevation", {id: "profile", space: "distanceProfile", x: new Float64Array([0, 0.5, 1]), values: new Float64Array([0, 1, 0]), xDomain: [0, 1], yDomain: [0, 1], padding: {left: 0.1, right: 0.1, top: 0.1, bottom: 0.1}});
  const releaseTimeline = scene.registerMetricSeries("timeline", {id: "density", space: "timeline", x: new Float64Array([0, 1]), values: new Float64Array([0.25, 0.75]), xDomain: [0, 1], yDomain: [0, 1], color: [201, 154, 255, 255], areaOpacity: 0.25});
  const releaseDensity = scene.registerTimelineDensity({
    footprint: {counts: new Uint32Array([0, 1, 3]), peak: 3},
    photo: {counts: new Uint32Array([1, 0, 3]), peak: 3},
  });
  const capture = new ReplayCanvasCapture(parent, scene, {width: 128, height: 392, views: [
    {id: "map", kind: "map", x: 0, y: 0, width: 128, height: 128},
    {id: "elevation", kind: "orthographic", x: 0, y: 128, width: 128, height: 128},
    {id: "timeline", kind: "orthographic", x: 0, y: 256, width: 128, height: 128},
    {id: "timeline-density", kind: "orthographic", x: 0, y: 386, width: 128, height: 4},
  ]});
  const controller = new AbortController();
  const bitmap = document.createElement("canvas"), context = bitmap.getContext("2d")!;
  const read = (source: HTMLCanvasElement) => {bitmap.width = source.width; bitmap.height = source.height; context.clearRect(0, 0, bitmap.width, bitmap.height); context.drawImage(source, 0, 0);};
  const strongest = (x: number, y: number) => {
    const ratio = bitmap.width / 128, radius = Math.ceil(3 * ratio);
    const left = Math.max(0, Math.floor(x * ratio) - radius), top = Math.max(0, Math.floor(y * ratio) - radius);
    const width = Math.min(bitmap.width - left, radius * 2 + 1), height = Math.min(bitmap.height - top, radius * 2 + 1);
    const values = context.getImageData(left, top, width, height).data;
    let color = [0, 0, 0, 0];
    for (let index = 0; index < values.length; index += 4) if (values[index + 3] > color[3]) color = Array.from(values.subarray(index, index + 4));
    return color;
  };
  try {
    const frame = await capture.capture(1000, 0, camera, controller.signal);
    if (!frame) throw new Error("Visible replay frame did not finish"); read(frame);
    const {width, height} = frame;
    const viewport = new WebMercatorViewport({width: 128, height: 128, ...camera});
    const [draftX, draftY] = viewport.project([-0.02, 0.02]);
    const route = strongest(64, 64), draft = strongest(draftX, draftY), profile = strongest(64, 140.8);
    const timelineLine = strongest(64, 320), timelineFill = strongest(64, 352), aboveTimeline = strongest(64, 288);
    const outside = strongest(5, 200);
    const pixel = (x: number, y: number) => Array.from(context.getImageData(x, y, 1, 1).data);
    const density = [pixel(20, 387), pixel(64, 387), pixel(100, 387), pixel(20, 389), pixel(64, 389), pixel(100, 389)];
    const outsideDensity = [pixel(64, 385), pixel(64, 390)];
    scene.setVisibility({...scene.current.visibility, annotations: false});
    const hidden = await capture.capture(1033, 1, camera, controller.signal);
    if (!hidden) throw new Error("Hidden replay frame did not finish"); read(hidden);
    const hiddenRoute = strongest(64, 64), hiddenProfile = strongest(64, 140.8);
    scene.setVisibility({...scene.current.visibility, annotations: true});
    const restored = await capture.capture(1066, 2, camera, controller.signal);
    if (!restored) throw new Error("Restored replay frame did not finish"); read(restored);
    const restoredProfile = strongest(64, 140.8);
    return {route, draft, profile, outside, hiddenRoute, hiddenProfile, restoredProfile, timelineLine, timelineFill, aboveTimeline, density, outsideDensity, width, height, dpr: devicePixelRatio};
  } finally {release(); releaseTimeline(); releaseDensity(); capture.destroy(); capture.destroy(); parent.remove();}
}

export async function checkElevationVisualHandoff() {
  const {createElement} = await import("react");
  const {createRoot} = await import("react-dom/client");
  const {ReplayRenderSurface} = await import("../../apps/desktop/src/renderer/render-engine/ReplayRenderSurface");
  const {ElevationProfile} = await import("../../apps/desktop/src/renderer/features/annotations/ElevationProfile");
  const parent = document.createElement("div"), style = document.createElement("style");
  Object.assign(parent.style, {position: "absolute", left: "0", top: "0", width: "320px", height: "180px"});
  style.textContent = '.render-engine-surface{position:absolute;inset:0;pointer-events:none}.route-elevation{position:absolute;inset:0;--replay-view-background:#0d1218;background:var(--replay-view-background)}.route-elevation header{height:24px}.route-elevation-plot{position:relative;height:calc(100% - 24px)}.route-elevation svg{display:block;width:100%;height:100%}.metric-canvas-fallback{position:absolute;inset:0;width:100%;height:100%}.route-elevation[data-replay-renderer="engine"]{background:transparent}';
  document.head.append(style); document.body.append(parent);
  const scene = new ReplayScene(), root = createRoot(parent);
  const coordinates: [number, number, number][] = [[0, 0, 100], [0.01, 0, 200], [0.02, 0, 100]];
  const wait = async (test: () => boolean) => {
    const deadline = performance.now() + 15000;
    while (!test()) {if (performance.now() > deadline) throw new Error("Elevation visual handoff timed out"); await new Promise(resolve => requestAnimationFrame(resolve));}
  };
  try {
    root.render(createElement("div", {style: {position: "relative", width: "100%", height: "100%"}}, createElement(ReplayRenderSurface, {scene}), createElement(ElevationProfile, {scene, coordinates, routeName: "GPU acceptance", onHover: () => {}})));
    await wait(() => parent.querySelector(".route-elevation")?.getAttribute("data-replay-renderer") === "engine");
    const canvas = parent.querySelector<HTMLCanvasElement>(".render-engine-surface canvas")!, section = parent.querySelector<HTMLElement>(".route-elevation")!;
    const copy = document.createElement("canvas"); copy.width = canvas.width; copy.height = canvas.height;
    const context = copy.getContext("2d")!; context.drawImage(canvas, 0, 0);
    const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
    let cyan = 0, opaqueBackground = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 1] > 140 && pixels[index + 2] > 200 && pixels[index + 3] > 150) cyan++;
      if (pixels[index] === 13 && pixels[index + 1] === 18 && pixels[index + 2] === 24 && pixels[index + 3] === 255) opaqueBackground++;
    }
    const result = {cyan, opaqueBackground, fallbackHidden: !section.querySelector(".metric-canvas-fallback"), transparentDOM: getComputedStyle(section).backgroundColor === "rgba(0, 0, 0, 0)", fallbackRestored: false};
    const gl = canvas.getContext("webgl2"), loss = gl?.getExtension("WEBGL_lose_context");
    if (loss) {
      loss.loseContext();
      await wait(() => section.getAttribute("data-replay-renderer") !== "engine");
      const fallback = section.querySelector<HTMLCanvasElement>(".metric-canvas-fallback");
      const pixels = fallback?.getContext("2d")?.getImageData(0, 0, fallback.width, fallback.height).data;
      result.fallbackRestored = Boolean(pixels?.some((value, index) => index % 4 === 3 && value > 150));
    }
    return {...result, contextLossSupported: Boolean(loss)};
  } finally {root.unmount(); parent.remove(); style.remove();}
}

export async function checkAnnotationVisualHandoff() {
  const {createElement} = await import("react"), {createRoot} = await import("react-dom/client");
  const {ReplayRenderSurface} = await import("../../apps/desktop/src/renderer/render-engine/ReplayRenderSurface");
  const parent = document.createElement("div");
  Object.assign(parent.style, {position: "absolute", left: "0", top: "0", width: "128px", height: "128px"}); document.body.append(parent);
  const scene = new ReplayScene(), camera = {longitude: 0, latitude: 0, zoom: 10, bearing: 0, pitch: 0}, root = createRoot(parent);
  scene.setMapViewState(camera);
  scene.setPhotos(replayPhotoPoints([0.02, -0.02]));
  scene.setAnnotationHandles([[0.035, 0.015]]);
  scene.setAnnotationGeometry({type: "FeatureCollection", features: [
    {type: "Feature", id: "route", properties: {color: "#55cfff"}, geometry: {type: "LineString", coordinates: [[-0.05, 0, 900], [0.05, 0, 900]]}},
    {type: "Feature", id: "place", properties: {color: "#55cfff"}, geometry: {type: "Point", coordinates: [0, 0.03]}},
  ]});
  const wait = async (test: () => boolean) => {
    const deadline = performance.now() + 15000;
    while (!test()) {if (performance.now() > deadline) throw new Error("Annotation visual handoff timed out"); await new Promise(resolve => requestAnimationFrame(resolve));}
  };
  const copy = document.createElement("canvas"), context = copy.getContext("2d")!;
  const pixelsAt = (x: number, y: number) => {
    const canvas = parent.querySelector("canvas")!;
    copy.width = canvas.width; copy.height = canvas.height; context.drawImage(canvas, 0, 0);
    const ratio = canvas.width / 128;
    return Array.from(context.getImageData(Math.floor(x * ratio), Math.floor(y * ratio), 1, 1).data);
  };
  try {
    root.render(createElement(ReplayRenderSurface, {scene}));
    // The real component normally gets this positioning from app/styles.css.
    await wait(() => Boolean(parent.firstElementChild));
    Object.assign((parent.firstElementChild as HTMLElement).style, {position: "absolute", inset: "0", pointerEvents: "none"});
    await wait(() => Boolean(scene.visuals.current.annotations && scene.visuals.current.photos && scene.visuals.current.handles));
    await new Promise(resolve => requestAnimationFrame(resolve));
    const viewport = new WebMercatorViewport({width: 128, height: 128, ...camera}), place = viewport.project([0, 0.03]);
    const photo = viewport.project([0.02, -0.02]);
    const route = pixelsAt(64, 64), placeMarker = pixelsAt(place[0], place[1]), photoMarker = pixelsAt(photo[0], photo[1]);
    const firstHandle = viewport.project([0.035, 0.015]), secondHandle = viewport.project([0.032, -0.01]);
    const handle = pixelsAt(firstHandle[0], firstHandle[1]);
    scene.setAnnotationHandles([[0.032, -0.01]]);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const clearedHandle = pixelsAt(firstHandle[0], firstHandle[1]), movedHandle = pixelsAt(secondHandle[0], secondHandle[1]);
    scene.setVisibility({...scene.current.visibility, annotations: false});
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const hidden = pixelsAt(64, 64), hiddenHandle = pixelsAt(secondHandle[0], secondHandle[1]);
    scene.setVisibility({...scene.current.visibility, annotations: true});
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const restored = pixelsAt(64, 64);
    scene.setVisibility({...scene.current.visibility, trajectory: false});
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {route, placeMarker, hidden, restored, photoMarker, handle, clearedHandle, movedHandle, hiddenHandle, hiddenPhoto: pixelsAt(photo[0], photo[1]), annotationWithPhotosHidden: pixelsAt(64, 64)};
  } finally {root.unmount(); parent.remove();}
}


export async function checkFootprintVisualHandoff() {
  const {DeckRenderBackend} = await import("../../apps/desktop/src/renderer/render-engine/backends/DeckRenderBackend");
  const {createDeckLayerRegistry} = await import("../../apps/desktop/src/renderer/render-engine/backends/DeckLayerRegistry");
  const {ReplayRenderEngine} = await import("../../apps/desktop/src/renderer/render-engine/ReplayRenderEngine");
  const parent = document.createElement("div");
  Object.assign(parent.style, {position: "absolute", width: "192px", height: "160px"});
  document.body.append(parent);
  const scene = new ReplayScene();
  const camera = {longitude: 179.999, latitude: 0, zoom: 14, pitch: 35, bearing: 28};
  const point = [-179.9998, 0] as const;
  const route = [[-180.001, 0], [-179.999, 0]] as const;
  const offsetX = 16, offsetY = 12, width = 160, height = 128;
  scene.setMapViewState(camera);
  scene.setPhotos(replayPhotoPoints([179.998, 0.001]));
  let ownsFootprint = false;
  const backend = new DeckRenderBackend(parent, scene.current, {
    onVisualOwnership: ownership => { ownsFootprint = !!ownership.footprint; },
  });
  const engine = new ReplayRenderEngine(parent, scene, backend, createDeckLayerRegistry({footprint: true, photos: true, picking: false}), {
    views: [{id: "map", kind: "map", x: offsetX, y: offsetY, width, height}],
  });
  const bitmap = document.createElement("canvas"), context = bitmap.getContext("2d", {willReadFrequently: true})!;
  const view = new WebMercatorViewport({width, height, ...camera});
  const signal = AbortSignal.timeout(12000);
  const draw = async () => {
    if (!await engine.renderComplete(signal)) throw new Error("Footprint frame did not complete");
    const canvas = backend.canvas!;
    bitmap.width = canvas.width;
    bitmap.height = canvas.height;
    context.drawImage(canvas, 0, 0);
  };
  const pixelNear = ([x, y]: number[]) => {
    const ratio = bitmap.width / 192;
    const left = Math.round((x + offsetX - 2) * ratio), top = Math.round((y + offsetY - 2) * ratio);
    const size = Math.ceil(4 * ratio);
    const values = context.getImageData(left, top, size, size).data;
    let color = [0, 0, 0, 0];
    for (let index = 0; index < values.length; index += 4) {
      if (values[index + 3] > color[3]) color = Array.from(values.subarray(index, index + 4));
    }
    return color;
  };
  try {
    const pointScreen = view.project([point[0] + 360, point[1]]);
    const lineScreen = view.project([179.9997, 0]);
    scene.setFootprint({coordinates: point, paths: [route], mode: "points"});
    await draw();
    const first = pixelNear(pointScreen), ownedFirst = ownsFootprint;
    scene.setFootprint({coordinates: [...point, ...point, ...point, ...point], paths: [route], mode: "points"});
    await draw();
    const overlap = pixelNear(pointScreen);
    scene.setFootprint({coordinates: point, paths: [route], mode: "line"});
    await draw();
    const line = pixelNear(lineScreen);
    const photo = pixelNear(view.project([179.998, 0.001]));
    const outsideView = context.getImageData(0, 0, 1, 1).data[3];
    scene.setVisibility({...scene.current.visibility, trajectory: false});
    await draw();
    const hidden = pixelNear(lineScreen), ownedHidden = ownsFootprint;
    scene.setVisibility({...scene.current.visibility, trajectory: true});
    await draw();
    return {first, ownedFirst, overlap, line, photo, outsideView, hidden, ownedHidden, restored: pixelNear(lineScreen), ownedRestored: ownsFootprint};
  } finally {
    engine.destroy();
    parent.remove();
  }
}
