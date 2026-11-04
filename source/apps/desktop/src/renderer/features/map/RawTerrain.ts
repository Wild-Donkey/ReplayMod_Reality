import type { Map as GLMap, CustomLayerInterface } from "maplibre-gl";
import { requestGPUDevice, type GPU } from "../../shared/gpu";
import { getHDRState, currentHDRHeadroom, watchDisplayHDR } from "../../shared/displayHDR";
import { adaptExposure, materialToneWindow, rangeFromMeter, METER_BYTES, type TerrainAppearance, type TerrainRange } from "./terrainExposure";
import { elevationShader, toneShader, meterShader, composeElevationShader } from "./terrainShaders";

export interface ElevationTile { z: number; x: number; y: number; ocean: boolean; width: number; height: number; heights: Float32Array; materials?: Uint8Array; reload?: () => Promise<void> }
type Resident = Omit<ElevationTile, "heights" | "materials"> & { texture?: GPU; loading?: boolean; retryAt?: number; draws: Map<number, { uniform: GPU; binding: GPU }>; used: number };
const LIMIT = 96;
const NO_DATA = -1e20;

export class RawTerrain {
  readonly canvas = document.createElement("canvas");
  private tiles = new Map<string, Resident>();
  private device!: GPU;
  private context!: GPU;
  private elevationPipeline!: GPU;
  private tonePipeline!: GPU;
  private meterPipeline!: GPU;
  private heightTexture: GPU;
  private surfaceTexture: GPU;
  private oceanTexture: GPU;
  private composePipeline: GPU;
  private composeBinding: GPU;
  private settings: GPU;
  private histogram: GPU;
  private readback: GPU;
  private toneBinding: GPU;
  private meterBinding: GPU;
  private matrix: number[] = [];
  private revision = 0;
  private renderedRevision = -1;
  private measuredRevision = -1;
  private imageRevision = 0;
  private metering = false;
  private lastMeter = -Infinity;
  private black = 0;
  private oceanBlack = -10000;
  private oceanWhite = 0;
  private targetOceanBlack = -10000;
  private targetOceanWhite = 0;
  private white = 9000;
  private targetBlack = 0;
  private targetWhite = 9000;
  private land: TerrainRange | null = null;
  private depth: TerrainRange | null = null;
  private lastAppearance = -Infinity;
  private lastFrame = 0;
  private animationFrame: number | null = null;
  private disposed = false;
  private failed = false;
  private outputMode = "";
  private stopDisplay = () => {};
  private layer: CustomLayerInterface;
  private bridgeAdded = false;
  private errorListener = () => this.fail();
  private constructor(private map: GLMap, private onFailure: () => void, private onAppearance?: (appearance: TerrainAppearance | null) => void) {
    this.canvas.setAttribute("aria-hidden", "true");
    this.canvas.dataset.terrainPrecision = "raw-rg32float";
    Object.assign(this.canvas.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none", display: "none" });
    this.layer = { id: "terrain-raw-presentation", type: "custom", renderingMode: "2d", render: (_gl, options) => {
      this.render(Array.from(options.defaultProjectionData.mainMatrix));
    } };
  }
  static async create(map: GLMap, onFailure: () => void, onAppearance?: (appearance: TerrainAppearance | null) => void) {
    const instance = new RawTerrain(map, onFailure, onAppearance);
    try { await instance.initialize(); return instance; }
    catch (error) { instance.dispose(); throw error; }
  }
  private async initialize() {
    this.device = await requestGPUDevice();
    const device = this.device;
    this.context = (this.canvas as GPU).getContext("webgpu");
    if (!this.context) throw new Error("浮点地形画布不可用");
    const module = (code: string) => device.createShaderModule({ code });
    const elevation = module(elevationShader), tone = module(toneShader), meter = module(meterShader);
    [this.elevationPipeline, this.tonePipeline, this.meterPipeline, this.composePipeline] = await Promise.all([
      device.createRenderPipelineAsync({ layout: "auto", vertex: { module: elevation, entryPoint: "vertex" }, fragment: { module: elevation, entryPoint: "fragment", targets: [{ format: "rg32float" }] }, primitive: { topology: "triangle-list" } }),
      device.createRenderPipelineAsync({ layout: "auto", vertex: { module: tone, entryPoint: "vertex" }, fragment: { module: tone, entryPoint: "fragment", targets: [{ format: "rgba16float" }] }, primitive: { topology: "triangle-list" } }),
      device.createComputePipelineAsync({ layout: "auto", compute: { module: meter, entryPoint: "main" } }),
      device.createRenderPipelineAsync({ layout: "auto", vertex: { module: module(composeElevationShader), entryPoint: "vertex" }, fragment: { module: module(composeElevationShader), entryPoint: "fragment", targets: [{ format: "rg32float" }] }, primitive: { topology: "triangle-list" } }),
    ]);
    this.settings = device.createBuffer({ size: 32, usage: 0x48 });
    this.histogram = device.createBuffer({ size: METER_BYTES, usage: 0x8c }); // STORAGE | COPY_SRC | COPY_DST
    this.readback = device.createBuffer({ size: METER_BYTES, usage: 0x9 }); // MAP_READ | COPY_DST
    device.addEventListener("uncapturederror", this.errorListener);
    void device.lost.then(() => this.fail());
    this.map.getCanvas().before(this.canvas);
    const first = this.map.getStyle().layers?.[0]?.id;
    this.map.addLayer(this.layer, first);
    this.bridgeAdded = true;
    this.stopDisplay = watchDisplayHDR(() => this.schedulePresentation());
  }
  addTile(tile: ElevationTile) {
    if (this.disposed || this.failed) return;
    const key = `${tile.ocean}:${tile.z}/${tile.x}/${tile.y}`;
    const old = this.tiles.get(key);
    old?.texture?.destroy();
    old?.draws.forEach(draw => draw.uniform.destroy());
    const texture = this.device.createTexture({ size: [tile.width, tile.height], format: "rg32float", usage: 0x6 });
    const numeric = new Float32Array(tile.heights.length*2);
    for (let i=0;i<tile.heights.length;i++) {
      numeric[i*2] = tile.heights[i];
      numeric[i*2+1] = tile.ocean || tile.materials?.[i] === 1 ? 1 : 0;
    }
    this.device.queue.writeTexture({ texture }, numeric, { bytesPerRow: tile.width * 8, rowsPerImage: tile.height }, [tile.width, tile.height]);
    const { heights: _heights, materials: _materials, ...metadata } = tile;
    this.tiles.set(key, { ...metadata, texture, draws: new Map(), used: performance.now() });
    this.revision++;
    this.map.triggerRepaint();
  }
  private resize() {
    const source = this.map.getCanvas();
    if (this.heightTexture && this.canvas.width === source.width && this.canvas.height === source.height) return;
    this.canvas.width = Math.max(1, source.width); this.canvas.height = Math.max(1, source.height);
    this.heightTexture?.destroy();
    this.surfaceTexture?.destroy(); this.oceanTexture?.destroy();
    this.surfaceTexture = this.device.createTexture({ size: [this.canvas.width,this.canvas.height],format: "rg32float",usage: 0x14 });
    this.oceanTexture = this.device.createTexture({ size: [this.canvas.width,this.canvas.height],format: "rg32float",usage: 0x14 });
    this.composeBinding = this.device.createBindGroup({ layout:this.composePipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:this.surfaceTexture.createView()},{binding:1,resource:this.oceanTexture.createView()},
    ] });
    this.heightTexture = this.device.createTexture({ size: [this.canvas.width, this.canvas.height], format: "rg32float", usage: 0x15 });
    const view = this.heightTexture.createView();
    this.toneBinding = this.device.createBindGroup({ layout: this.tonePipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: view }, { binding: 1, resource: { buffer: this.settings } },
    ] });
    this.meterBinding = this.device.createBindGroup({ layout: this.meterPipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: view }, { binding: 1, resource: { buffer: this.histogram } },
    ] });
    this.revision++;
  }
  private drawElevation(encoder: GPU, matrix: number[]) {
    const centerWrap = Math.floor((this.map.getCenter().lng + 180) / 360);
    const ordered = [...this.tiles.values()].sort((a, b) => Number(a.ocean) - Number(b.ocean) || a.z - b.z);
    for (const oceanPass of [false,true]) {
      const target = oceanPass ? this.oceanTexture : this.surfaceTexture;
      const pass = encoder.beginRenderPass({ colorAttachments:[{view:target.createView(),clearValue:[NO_DATA,Number(oceanPass),0,0],loadOp:"clear",storeOp:"store"}] });
      pass.setPipeline(this.elevationPipeline);
    // Wrapped copies keep separate uniforms; exposure-only frames reuse all of them.
    for (const tile of ordered) {
      if (tile.ocean !== oceanPass) continue;
      if (tile.z > Math.ceil(this.map.getZoom())) continue;
      const scale = 2 ** -tile.z;
      for (let wrap = centerWrap - 1; wrap <= centerWrap + 1; wrap++) {
        const x = tile.x * scale + wrap, y = tile.y * scale;
        const corners = [[x,y],[x+scale,y],[x,y+scale],[x+scale,y+scale]].map(([x,y]) => {
          const w = matrix[3]*x+matrix[7]*y+matrix[15];
          return [(matrix[0]*x+matrix[4]*y+matrix[12])/w, (matrix[1]*x+matrix[5]*y+matrix[13])/w];
        });
        if (corners.every(p => p[0] < -1) || corners.every(p => p[0] > 1) || corners.every(p => p[1] < -1) || corners.every(p => p[1] > 1)) continue;
        tile.used = performance.now();
        if (!tile.texture) {
          if (tile.reload && !tile.loading && tile.used >= (tile.retryAt ?? 0)) {
            tile.loading = true;
            void tile.reload().catch(error => {
              tile.retryAt = performance.now() + 5000;
              console.warn("原始高程缓存重载失败",error);
            }).finally(() => { tile.loading = false; });
          }
          continue;
        }
        // Transform tile-local coordinates on the CPU in double precision.
        // This avoids world-coordinate float cancellation at close zooms.
        const local = new Float32Array(24);
        for (let row = 0; row < 4; row++) {
          local[row] = matrix[row] * scale;
          local[4+row] = matrix[4+row] * scale;
          local[8+row] = matrix[8+row];
          local[12+row] = matrix[row]*x + matrix[4+row]*y + matrix[12+row];
        }
        local.set([0,0,1,1],16); local[20] = Number(tile.ocean);
        let draw = tile.draws.get(wrap);
        if (!draw) {
          const uniform = this.device.createBuffer({ size: 96, usage: 0x48 });
          const binding = this.device.createBindGroup({ layout: this.elevationPipeline.getBindGroupLayout(0), entries: [
            { binding: 0, resource: tile.texture.createView() }, { binding: 1, resource: { buffer: uniform } },
          ] });
          draw = { uniform, binding }; tile.draws.set(wrap,draw);
        }
        this.device.queue.writeBuffer(draw.uniform,0,local);
        pass.setBindGroup(0,draw.binding); pass.draw(6);
      }
    }
    pass.end();
    }
    const compose = encoder.beginRenderPass({ colorAttachments:[{view:this.heightTexture.createView(),clearValue:[NO_DATA,0,0,0],loadOp:"clear",storeOp:"store"}] });
    compose.setPipeline(this.composePipeline); compose.setBindGroup(0,this.composeBinding); compose.draw(3); compose.end();
  }
  private render(matrix: number[]) {
    if (this.disposed || this.failed) return;
    try {
      this.resize();
      const now = performance.now();
      const changed = this.renderedRevision !== this.revision || matrix.some((value,i) => value !== this.matrix[i]);
      const encoder = this.device.createCommandEncoder();
      if (changed) {
        this.drawElevation(encoder,matrix);
        this.matrix = matrix; this.renderedRevision = this.revision; this.imageRevision++;
      }
      const elapsed = Math.min(100,now-(this.lastFrame || now));
      this.black = adaptExposure(this.black,this.targetBlack,elapsed);
      this.white = adaptExposure(this.white,this.targetWhite,elapsed);
      this.oceanBlack = adaptExposure(this.oceanBlack,this.targetOceanBlack,elapsed);
      this.oceanWhite = adaptExposure(this.oceanWhite,this.targetOceanWhite,elapsed);
      this.lastFrame = now;
      const headroom = currentHDRHeadroom();
      const mode = getHDRState().active ? "extended" : "standard";
      if (mode !== this.outputMode) {
        this.context.configure({ device: this.device, format: "rgba16float", alphaMode: "opaque", toneMapping: { mode } });
        this.outputMode = mode;
      }
      this.device.queue.writeBuffer(this.settings,0,new Float32Array([this.black,headroom,this.white,0,this.oceanBlack,headroom,this.oceanWhite,0]));
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: this.context.getCurrentTexture().createView(), clearValue: [0,0,0,1], loadOp: "clear", storeOp: "store" }] });
      pass.setPipeline(this.tonePipeline); pass.setBindGroup(0,this.toneBinding); pass.draw(3); pass.end();
      const meter = !this.metering && this.measuredRevision !== this.imageRevision && now-this.lastMeter >= 200;
      const measuredImage = this.imageRevision;
      if (meter) {
        this.metering = true; this.lastMeter = now;
        encoder.clearBuffer(this.histogram);
        const compute = encoder.beginComputePass(); compute.setPipeline(this.meterPipeline); compute.setBindGroup(0,this.meterBinding); compute.dispatchWorkgroups(16,9); compute.end();
        encoder.copyBufferToBuffer(this.histogram,0,this.readback,0,METER_BYTES);
      }
      this.device.queue.submit([encoder.finish()]);
      this.canvas.style.display = "block";
      if (meter) void this.readMeter(measuredImage);
      this.evict();
      const adapting = Math.abs(this.black-this.targetBlack)>.1 || Math.abs(this.white-this.targetWhite)>.1 || Math.abs(this.oceanBlack-this.targetOceanBlack)>.1 || Math.abs(this.oceanWhite-this.targetOceanWhite)>.1;
      if (this.onAppearance && (now-this.lastAppearance>100 || !adapting)) {
        this.lastAppearance = now;
        this.onAppearance({land:this.land,depth:this.depth,black:this.black,white:this.white,headroom,oceanBlack:this.oceanBlack,oceanWhite:this.oceanWhite});
      }
      if (adapting || (!this.metering && this.measuredRevision!==this.imageRevision)) this.schedulePresentation();
    } catch { this.fail(); }
  }
  private async readMeter(revision: number) {
    try {
      await this.readback.mapAsync(1);
      const meter = new Uint32Array(this.readback.getMappedRange());
      const target = materialToneWindow(meter);
      const oceanTarget = materialToneWindow(meter,true);
      const land = rangeFromMeter(meter), depth = rangeFromMeter(meter,true);
      this.readback.unmap();
      if (this.disposed || this.failed) return;
      this.measuredRevision = revision;
      if (target) [this.targetBlack,this.targetWhite] = target;
      if (oceanTarget) [this.targetOceanBlack,this.targetOceanWhite] = oceanTarget;
      this.land = land; this.depth = depth;
    } catch { if (!this.disposed) this.fail(); }
    finally { this.metering = false; this.schedulePresentation(); }
  }
  private schedulePresentation() {
    if (this.disposed || this.failed || this.animationFrame !== null || this.matrix.length !== 16) return;
    // Exposure/headroom updates draw only the separate floating-point canvas.
    // They must not trigger another MapLibre/cartography/point-cloud frame.
    this.animationFrame = requestAnimationFrame(() => {
      this.animationFrame = null;
      this.render(this.matrix);
    });
  }
  private evict() {
    const resident = [...this.tiles.values()].filter(tile => tile.texture).sort((a,b) => a.used-b.used);
    for (const tile of resident.slice(0,Math.max(0,resident.length-LIMIT))) {
      tile.texture.destroy(); tile.texture = undefined;
      tile.draws.forEach(draw => draw.uniform.destroy()); tile.draws.clear();
    }
    // Retain only small reload descriptors. Original PNG bytes remain in the
    // disk cache, so revisiting an evicted tile does not require a download.
    const oldest = [...this.tiles.entries()].filter(([,tile]) => !tile.texture && !tile.loading).sort((a,b) => a[1].used-b[1].used);
    for (const [key] of oldest.slice(0,Math.max(0,this.tiles.size-2048))) this.tiles.delete(key);
  }

  private fail() {
    if (this.disposed || this.failed) return;
    this.failed = true; this.canvas.style.display = "none";
    this.onAppearance?.(null);
    this.onFailure();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.stopDisplay();
    this.onAppearance?.(null);
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
    this.device?.removeEventListener("uncapturederror",this.errorListener);
    if (this.bridgeAdded && this.map.getLayer(this.layer.id)) this.map.removeLayer(this.layer.id);
    for (const tile of this.tiles.values()) { tile.texture?.destroy(); tile.draws.forEach(draw => draw.uniform.destroy()); }
    this.tiles.clear();
    this.surfaceTexture?.destroy(); this.oceanTexture?.destroy();
    this.heightTexture?.destroy(); this.settings?.destroy(); this.histogram?.destroy(); this.readback?.destroy();
    this.context?.unconfigure(); this.canvas.remove();
  }
}
