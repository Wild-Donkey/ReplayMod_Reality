import { Layer, WebMercatorViewport } from "@deck.gl/core";
import type { ReplayLayerFactory } from "../LayerRegistry";
import { FootprintDensityPass, type FootprintDensityData } from "../FootprintDensityPass";
import { footprintProjectionMatrix, normalizedMercator } from "../backends/FootprintProjection";

export const footprintLayerId = "map/footprint-visual";

export class FootprintDensityLayer extends Layer<{footprint: FootprintDensityData}> {
  static layerName = "FootprintDensityLayer";
  declare state: {
    pass?: FootprintDensityPass;
    ready: boolean;
    failed: boolean;
    pending: boolean;
    footprint?: FootprintDensityData;
    viewport?: WebMercatorViewport;
    width?: number;
    height?: number;
  };
  get hasRendered() { return Boolean(this.state?.ready); }

  initializeState() {
    this.state.ready = false;
    this.state.failed = false;
    this.state.pending = true;
  }

  draw({shaderModuleProps, context}: Parameters<Layer["draw"]>[0]) {
    const {device, gl, viewport} = context, state = this.state;
    if (device.type !== "webgl" || state.failed || !(viewport instanceof WebMercatorViewport)) return;
    // The pass accumulates the wrapped copies together before tone mapping.
    // Deck calls draw once per copy, so only use the first call of this view.
    if (shaderModuleProps.project?.viewport !== (viewport.subViewports?.[0] ?? viewport)) return;
    const [x, y, width, height] = gl.getParameter(gl.VIEWPORT) as Int32Array;
    if (width <= 0 || height <= 0) return;

    const activeTexture = gl.getParameter(gl.ACTIVE_TEXTURE);
    gl.activeTexture(gl.TEXTURE0);
    const texture = gl.getParameter(gl.TEXTURE_BINDING_2D);
    const sampler = gl.getParameter(gl.SAMPLER_BINDING);
    try {
      device.withParametersWebGL({nocatch: false}, () => {
        gl.bindSampler(0, null);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
        const {footprint} = this.props, {coordinates, paths, mode} = footprint;
        if (!state.pass) {
          state.pass = new FootprintDensityPass(coordinates, paths, normalizedMercator, () => {
            state.pending = true;
            context.layerManager.setNeedsRedraw(footprintLayerId);
          });
          state.pass.attach(gl);
        }
        const pass = state.pass;
        // Cursor and chart updates redraw the composite without re-rasterizing
        // the map geometry. Exposure can still request a follow-up accumulation.
        if (state.pending || state.footprint !== footprint || state.width !== width || state.height !== height || !state.viewport?.equals(viewport)) {
          pass.setCoordinates(coordinates);
          pass.setLinePaths(paths);
          pass.setMode(mode);
          state.pending = false;
          pass.accumulate({matrix: footprintProjectionMatrix(viewport.viewProjectionMatrix),
            zoom: viewport.zoom, centerLongitude: viewport.longitude, cssWidth: viewport.width, width, height});
          Object.assign(state, {footprint, viewport, width, height});
        }
        pass.compositeToViewport(x, y);
      });
      if (!state.ready) {
        const error = gl.getError();
        if (error !== gl.NO_ERROR) throw new Error(`Footprint first frame failed with WebGL error ${error}`);
      }
      state.ready = true;
    } catch (error) {
      state.ready = false;
      state.failed = true;
      state.pass?.destroy();
      state.pass = undefined;
      console.warn("共享 GPU 足迹密度不可用", error);
    } finally {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.bindSampler(0, sampler);
      gl.activeTexture(activeTexture);
    }
  }

  finalizeState() { this.state.pass?.destroy(); }
}

export const buildFootprintDensityLayer: ReplayLayerFactory<Layer> = scene => {
  const footprint = scene.footprint;
  if (!footprint || (footprint.mode === "line" ? !footprint.paths.length : !footprint.coordinates.length)) return [];
  return [new FootprintDensityLayer({id: footprintLayerId, footprint, pickable: false})];
};
