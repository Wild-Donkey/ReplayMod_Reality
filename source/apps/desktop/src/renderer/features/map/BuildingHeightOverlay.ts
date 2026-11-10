import maplibregl, {type CustomLayerInterface, type Map as GLMap, type StyleSpecification, type GeoJSONSource} from "maplibre-gl";
import type {Feature, FeatureCollection, MultiPolygon, Polygon} from "geojson";
import {cachedMapRequest} from "../../shared/cache";
import {addElevationBuildings, buildingHeight, buildingMaskPaint} from "./basemapStyle";

const MEMORY_SOURCE = "building-height-memory";
const MEMORY_LAYER = "building-height-memory-buffer";
const PROVIDER_LAYER = "elevation-buildings";
type Footprint = Feature<Polygon | MultiPolygon>;
type Building = {feature: Footprint; bytes: number};
const MAX_BATCH_BYTES = 1024 * 1024;
const encoder = new TextEncoder();

function buildingKey({id, properties, geometry}: Footprint) {
  // Tile-local IDs can collide. Keep distinct clipped geometry so the
  // coarse mask can reconstruct footprints that span tile edges.
  const height = properties?.height ?? properties?.render_height ?? properties?.levels ?? properties?.["building:levels"] ?? 0;
  return `${id ?? ""}:${height}:${JSON.stringify(geometry)}`;
}

function createMaskProgram(gl: WebGLRenderingContext | WebGL2RenderingContext) {
  const vertex = gl.createShader(gl.VERTEX_SHADER)!;
  gl.shaderSource(vertex, `#version 300 es
    out vec2 uv;
    void main() {
      uv = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
      gl_Position = vec4(uv * vec2(2., -2.) + vec2(-1., 1.), 0., 1.);
    }`);
  const fragment = gl.createShader(gl.FRAGMENT_SHADER)!;
  gl.shaderSource(fragment, `#version 300 es
    precision mediump float;
    uniform sampler2D mask;
    in vec2 uv;
    out vec4 color;
    void main() {
      color = vec4(texture(mask, uv).r);
    }`);
  gl.compileShader(vertex);
  gl.compileShader(fragment);
  const program = gl.createProgram()!;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`建筑合成着色器初始化失败 (${message})`);
  }
  return program;
}

// Use one sorted fill so a lower-detail tile cannot paint a placeholder
// height over a known taller footprint. The primary map blends the mask once.
export class BuildingHeightOverlay {
  private readonly container = document.createElement("div");
  private readonly map: GLMap;
  private readonly layer: CustomLayerInterface;
  private readonly providerSource: string | undefined;
  private readonly cacheSource: string | undefined;
  private restoring = false;
  private visible = true;
  private disposed = false;
  private synchronizing = false;
  private maskRevision = 0;
  private memoryBytes = 0;
  private current = new Map<string, Building>();
  private remembered = new Map<string, Building>();

  constructor(private base: GLMap, style: StyleSpecification, private memoryLimitMB = 256) {
    const templates = style.layers.filter(layer => "source-layer" in layer && layer["source-layer"] === "building");
    const template = templates.find(layer => layer.type === "fill" || layer.type === "fill-extrusion") ?? templates[0];
    this.providerSource = template && "source" in template ? template.source : undefined;
    this.cacheSource = this.providerSource ? JSON.stringify(style.sources[this.providerSource]) : undefined;

    Object.assign(this.container.style, {position: "absolute", inset: "0", pointerEvents: "none", opacity: "0"});
    base.getCanvasContainer().before(this.container);
    const center = base.getCenter();
    this.map = new maplibregl.Map({
      container: this.container,
      style: {
        version: 8,
        sources: this.providerSource ? {[this.providerSource]: style.sources[this.providerSource]} : {},
        layers: template ? [{...template, layout: {...template.layout, visibility: "none"}}] : [],
      },
      center: [center.lng, center.lat], zoom: base.getZoom(), bearing: base.getBearing(), pitch: base.getPitch(),
      pixelRatio: base.getPixelRatio(),
      interactive: false, attributionControl: false, transformRequest: cachedMapRequest,
      canvasContextAttributes: {alpha: true, preserveDrawingBuffer: true, antialias: false},
    });

    let program: WebGLProgram;
    let texture: WebGLTexture;
    let uploadedRevision = -1;
    this.layer = {
      id: "building-composite",
      type: "custom",
      renderingMode: "2d",
      onAdd: (_map, gl) => {
        program = createMaskProgram(gl);
        texture = gl.createTexture()!;
        uploadedRevision = -1;
      },
      render: gl => {
        const canvas = this.map.getCanvas();
        if (!this.visible || !this.maskRevision || canvas.width !== gl.drawingBufferWidth || canvas.height !== gl.drawingBufferHeight) return;
        gl.useProgram(program);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        if (uploadedRevision !== this.maskRevision) {
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
          uploadedRevision = this.maskRevision;
        }
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      },
      onRemove: (_map, gl) => {
        gl.deleteTexture(texture);
        gl.deleteProgram(program);
      },
    };
    const firstSymbol = base.getStyle().layers.find(layer => layer.type === "symbol")?.id;
    base.addLayer(this.layer, firstSymbol);

    this.map.once("load", () => {
      if (addElevationBuildings(this.map)) {
        // Keep the provider source active for tile loading and queries.
        this.map.setPaintProperty(PROVIDER_LAYER, "fill-opacity", 0);
      }
      this.map.addSource(MEMORY_SOURCE, {type: "geojson", data: {type: "FeatureCollection", features: []}});
      this.map.addLayer({
        id: MEMORY_LAYER, type: "fill", source: MEMORY_SOURCE, minzoom: 7,
        layout: {"fill-sort-key": buildingHeight}, paint: buildingMaskPaint,
      });
      this.map.on("render", this.frameRendered);
      this.map.on("idle", this.capture);
      this.map.on("sourcedata", this.captureSource);
      this.restoring = true;
      void this.restoreMemory().catch(console.warn).finally(() => {
        this.restoring = false;
        if (this.disposed) return;
        if (this.remembered.size) {
          this.publishMask();
          this.publishStats();
        }
        this.capture();
      });
    });
    base.on("movestart", this.capture);
    base.on("move", this.synchronize);
    base.on("resize", this.synchronize);
  }

  setVisible(visible: boolean) {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    if (visible) {
      this.synchronize();
      this.capture();
    }
    this.base.triggerRepaint();
  }

  private frameRendered = () => {
    this.maskRevision++;
    if (this.visible && !this.synchronizing) this.base.triggerRepaint();
  };

  private synchronize = () => {
    if (this.disposed || !this.visible) return;
    this.synchronizing = true;
    try {
      const center = this.base.getCenter();
      this.map.jumpTo({center, zoom: this.base.getZoom(), bearing: this.base.getBearing(), pitch: this.base.getPitch()});
      this.map.resize();
      this.map.redraw();
    } finally {
      this.synchronizing = false;
    }
  };

  private captureSource = (event: {sourceId?: string}) => {
    if (event.sourceId === this.providerSource) this.capture();
  };

  private async restoreMemory() {
    const bridge = window.replaymod;
    const source = this.cacheSource;
    if (!bridge?.listBuildingCache || !source) return;
    const keys = await bridge.listBuildingCache(source);
    for (const key of keys) {
      if (this.disposed) return;
      const batch = await bridge.readBuildingCache(source, key);
      if (this.disposed) return;
      if (!batch) continue;
      try {
        for (const feature of JSON.parse(batch) as Footprint[]) {
          const key = buildingKey(feature);
          if (this.remembered.has(key)) continue;
          const bytes = encoder.encode(JSON.stringify(feature)).byteLength;
          this.remembered.set(key, {feature, bytes});
          this.memoryBytes += bytes;
        }
        this.trimMemory();
      } catch (error) {
        console.warn("建筑缓存读取失败", error);
      }
    }
  }

  private persistFootprints(entries: {json: string; bytes: number}[]) {
    const bridge = window.replaymod;
    const source = this.cacheSource;
    if (!bridge?.writeBuildingCache || !source) return;
    let batch: string[] = [];
    let bytes = 2; // JSON array delimiters
    const save = () => {
      if (batch.length) void bridge.writeBuildingCache(source, `[${batch.join(",")}]`).catch(console.warn);
      batch = [];
      bytes = 2;
    };
    for (const entry of entries) {
      if (entry.bytes + 2 > MAX_BATCH_BYTES) continue;
      if (bytes + entry.bytes + 1 > MAX_BATCH_BYTES) save();
      bytes += entry.bytes + (batch.length ? 1 : 0);
      batch.push(entry.json);
    }
    save();
  }

  private capture = () => {
    if (this.disposed || this.restoring || !this.visible || !this.providerSource || !this.map.getSource(MEMORY_SOURCE)) return;
    const current = new Map<string, Building>();
    const additions: {json: string; bytes: number}[] = [];
    for (const feature of this.map.querySourceFeatures(this.providerSource, {sourceLayer: "building"})) {
      const geometry = feature.geometry;
      if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") continue;
      const retained: Footprint = {type: "Feature", id: feature.id, properties: feature.properties, geometry};
      const key = buildingKey(retained);
      if (current.has(key)) continue;
      let building = this.remembered.get(key) ?? this.current.get(key);
      if (!building) {
        const json = JSON.stringify(retained);
        const bytes = encoder.encode(json).byteLength;
        building = {feature: retained, bytes};
        this.remembered.set(key, building);
        this.memoryBytes += bytes;
        additions.push({json, bytes});
      }
      current.set(key, building);
    }
    const currentChanged = current.size !== this.current.size || [...current.keys()].some(key => !this.current.has(key));
    this.current = current;
    const evicted = this.trimMemory();
    if (currentChanged || additions.length || evicted) this.publishMask();
    if (additions.length || evicted) this.publishStats();
    this.persistFootprints(additions);
  };

  updateMemoryLimit(limitMB: number) {
    if (this.disposed) return;
    const increased = limitMB > this.memoryLimitMB;
    this.memoryLimitMB = limitMB;
    let rememberedMore = false;
    if (increased) {
      for (const [key, building] of this.current) {
        if (this.remembered.has(key)) continue;
        this.remembered.set(key, building);
        this.memoryBytes += building.bytes;
        rememberedMore = true;
      }
    }
    const evicted = this.trimMemory();
    if (rememberedMore || evicted) {
      this.publishMask();
      this.publishStats();
    }
  }

  private trimMemory() {
    const limit = this.memoryLimitMB * 1024 * 1024;
    let evicted = false;
    for (const [key, {bytes}] of this.remembered) {
      if (this.memoryBytes <= limit) break;
      this.memoryBytes -= bytes;
      this.remembered.delete(key);
      evicted = true;
    }
    return evicted;
  }

  private publishMask() {
    const features = Array.from(this.remembered.values(), entry => entry.feature);
    // The cache limit controls retention after leaving a tile. Current
    // footprints still render if they exceed that limit.
    for (const [key, building] of this.current) {
      if (!this.remembered.has(key)) features.push(building.feature);
    }
    const collection: FeatureCollection = {
      type: "FeatureCollection",
      features,
    };
    (this.map.getSource(MEMORY_SOURCE) as GeoJSONSource).setData(collection);
  }

  private publishStats() {
    window.dispatchEvent(new CustomEvent("building-cache-stats", {
      detail: {bytes: this.memoryBytes, features: this.remembered.size},
    }));
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.base.off("movestart", this.capture);
    this.base.off("move", this.synchronize);
    this.base.off("resize", this.synchronize);
    if (this.base.getLayer(this.layer.id)) this.base.removeLayer(this.layer.id);
    this.map.remove();
    this.container.remove();
    this.current.clear();
    this.remembered.clear();
    this.memoryBytes = 0;
    this.publishStats();
  }
}
