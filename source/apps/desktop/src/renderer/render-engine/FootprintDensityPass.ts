// Convergent brightness response shared by far points and near route strokes.
// v(1) = 0.20 (a single coverage is just visible), and repeated coverage grows
// through arctan towards 1 without a hard saturation plateau. k is derived from
// the single-coverage baseline: k = 1 / tan(0.20 · π/2).
const SINGLE_COVERAGE_INTENSITY = 0.20;
export const FOOTPRINT_ARCTAN_K = 1 / Math.tan((SINGLE_COVERAGE_INTENSITY * Math.PI) / 2);
// Exposure compresses additional overlap, preserving one traversal and its
// antialiased edges. Multiplying all coverage by exposure erased sparse routes.
export const footprintIntensity = (count: number, exposure = 0) => {
  const coverage = Math.max(0, count);
  const scale = 2 ** Math.min(0, exposure);
  const exposed = Math.min(coverage, 1) + Math.max(coverage - 1, 0) * scale;
  return (2 / Math.PI) * Math.atan(exposed / FOOTPRINT_ARCTAN_K);
};
const FOOTPRINT_MINT = [70 / 255, 225 / 255, 135 / 255] as const;
const WHITE_START = 0.72;
const smoothStep = (edge0: number, edge1: number, value: number) => {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};
// Premultiplied RGB plus alpha, matching the composite shader exactly. Heavy
// overlap desaturates the mint tint towards pure white instead of plateauing.
export const footprintTone = (count: number, exposure = 0) => {
  const intensity = footprintIntensity(count, exposure);
  const whiteMix = smoothStep(WHITE_START, 1, intensity);
  return {
    r: (FOOTPRINT_MINT[0] + (1 - FOOTPRINT_MINT[0]) * whiteMix) * intensity,
    g: (FOOTPRINT_MINT[1] + (1 - FOOTPRINT_MINT[1]) * whiteMix) * intensity,
    b: (FOOTPRINT_MINT[2] + (1 - FOOTPRINT_MINT[2]) * whiteMix) * intensity,
    a: intensity,
  };
};
// Empty map pixels do not steer metering. Preserve isolated-point brightness
// and keep the bright one percent near four effective overlaps.
export function footprintExposure(samples: Float32Array): number {
  const occupied: number[] = [];
  for (let i = 0; i < samples.length; i += 4)
    if (Number.isFinite(samples[i]) && samples[i] >= 0.25) occupied.push(samples[i]);
  if (!occupied.length) return 0;
  occupied.sort((a, b) => a - b);
  return Math.max(-10, Math.min(0, Math.log2(4 / occupied[Math.floor((occupied.length - 1) * 0.99)])));
}
export function footprintRadius(zoom: number) {
  if (zoom <= 1) return 0.6;
  if (zoom <= 8) return 0.6 + (zoom - 1) / 7 * 0.5;
  return 1.1 + Math.min(6, zoom - 8) / 6 * 0.9;
}
// Near-zoom route stroke width, identical to the former MapLibre line stops.
export function footprintRouteWidth(zoom: number) {
  if (zoom <= 1) return 0.7;
  if (zoom <= 8) return 0.7 + (zoom - 1) / 7 * 0.7;
  if (zoom <= 14) return 1.4 + (zoom - 8) / 6 * 1.0;
  return 2.4;
}

export type FootprintDensityMode = "points" | "line";
export type FootprintPaths = readonly (readonly (readonly [number, number])[])[];

export interface FootprintDensityData {
  readonly coordinates: readonly number[];
  readonly paths: FootprintPaths;
  readonly mode: FootprintDensityMode;
}

export interface FootprintDensityFrame {
  readonly matrix: Iterable<number>;
  readonly zoom: number;
  readonly centerLongitude: number;
  readonly cssWidth: number;
  readonly width?: number;
  readonly height?: number;
}

function program(gl: WebGL2RenderingContext, vertex: string, fragment: string) {
  const shaders = [gl.VERTEX_SHADER, gl.FRAGMENT_SHADER].map((type, i) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, `#version 300 es\nprecision highp float;\n${i ? fragment : vertex}`);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader); gl.deleteShader(shader); throw new Error(message ?? "轨迹着色器编译失败");
    }
    return shader;
  });
  const result = gl.createProgram()!;
  shaders.forEach(shader => gl.attachShader(result, shader));
  gl.linkProgram(result);
  shaders.forEach(shader => gl.deleteShader(shader));
  if (!gl.getProgramParameter(result, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(result); gl.deleteProgram(result); throw new Error(message ?? "轨迹着色器链接失败");
  }
  return result;
}

// Count coverage in a separate floating-point target before tone mapping.
// Applying a response curve to already alpha-composited circles cannot recover
// their density. The same target also accumulates route strokes in line mode,
// so roads walked repeatedly brighten with the identical arctan response as
// point clusters: a single coverage lands at 0.20 and heavy overlap nears white.
// Point coordinates may arrive pre-decimated by footprintLod at far zoom, so a
// single traversal never piles into fake density.
export class FootprintDensityPass {
  private gl!: WebGL2RenderingContext;
  private attached = false;
  private points!: WebGLProgram;
  private lines!: WebGLProgram;
  private composite!: WebGLProgram;
  private pointBuffer!: WebGLBuffer;
  private pointVao!: WebGLVertexArrayObject;
  private lineBuffer!: WebGLBuffer;
  private lineVao!: WebGLVertexArrayObject;
  private lineVertexCount = 0;
  private texture!: WebGLTexture;
  private framebuffer!: WebGLFramebuffer;
  private width = 0;
  private height = 0;
  private count = 0;
  private mode: FootprintDensityMode = "points";
  private visible = true;
  private meterTexture!: WebGLTexture;
  private meterFramebuffer!: WebGLFramebuffer;
  private meterPixels = new Float32Array(128 * 128 * 4);
  private lastMeter = -Infinity;
  private lastFrame = 0;
  private meteredView: number[] = [];
  private exposure = 0;
  private targetExposure = 0;
  setVisible(visible: boolean) {
    if (this.visible === visible) return;
    this.visible = visible;
    this.requestRedraw();
  }
  constructor(
    private coordinates: readonly number[],
    private linePaths: FootprintPaths,
    private readonly project: (longitude: number, latitude: number) => {x: number; y: number},
    private readonly requestRedraw: () => void,
  ) {}
  setMode(mode: FootprintDensityMode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.lastMeter = -Infinity;
    this.requestRedraw();
  }
  setCoordinates(coordinates: readonly number[]) {
    if (this.coordinates === coordinates) return;
    this.coordinates = coordinates;
    this.lastMeter = -Infinity;
    if (this.attached) { this.uploadPoints(); this.requestRedraw(); }
  }
  setLinePaths(paths: FootprintPaths) {
    if (this.linePaths === paths) return;
    this.linePaths = paths;
    this.lastMeter = -Infinity;
    if (this.attached) { this.uploadLines(); this.requestRedraw(); }
  }
  private uploadPoints() {
    const data = new Float32Array(this.coordinates.length);
    for (let i = 0; i < data.length; i += 2) {
      const point = this.project(this.coordinates[i], this.coordinates[i + 1]);
      data[i] = point.x; data[i + 1] = point.y;
    }
    this.count = data.length / 2;
    const gl = this.gl;
    gl.bindVertexArray(this.pointVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }
  // Tessellate every path into one continuous left/right ribbon. All paths
  // share a single TRIANGLE_STRIP: between two paths two degenerate connector
  // vertices collapse the bridge triangles to zero area, so thousands of
  // segments cost one draw call per world wrap instead of one per segment.
  // Each vertex carries its previous and next neighbour so the GPU builds a
  // miter join; overlapping traversals add up in the float target.
  private uploadLines() {
    const paths = this.linePaths
      .map(path => path.map(([longitude, latitude]) => this.project(longitude, latitude)))
      .filter(path => path.length > 1);
    // Two connector vertices per path boundary plus two ribbon vertices per
    // path point, seven floats per vertex.
    const totalVertices = paths.reduce(
      (sum, path) => sum + path.length * 2,
      Math.max(0, paths.length - 1) * 2,
    );
    const data = new Float32Array(totalVertices * 7);
    let offset = 0;
    const writeVertex = (
      path: {x: number; y: number}[],
      index: number,
      side: number,
    ) => {
      const current = path[index];
      const previous = path[index === 0 ? 0 : index - 1];
      const next = path[index === path.length - 1 ? index : index + 1];
      data.set([current.x, current.y, previous.x, previous.y, next.x, next.y, side], offset);
      offset += 7;
    };
    paths.forEach((path, pathIndex) => {
      if (pathIndex > 0) {
        // Duplicate the previous path's last (+1 side) vertex and this path's
        // first (-1 side) vertex; the three bridging triangles are degenerate.
        writeVertex(paths[pathIndex - 1], paths[pathIndex - 1].length - 1, 1);
        writeVertex(path, 0, -1);
      }
      for (let i = 0; i < path.length; i += 1) {
        for (const side of [-1, 1]) writeVertex(path, i, side);
      }
    });
    const gl = this.gl;
    gl.bindVertexArray(this.lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const stride = 7 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 2 * 4);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 4 * 4);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 6 * 4);
    gl.bindVertexArray(null);
    this.lineVertexCount = totalVertices;
  }
  attach(context: WebGLRenderingContext | WebGL2RenderingContext) {
    if (this.attached) return;
    if (!(context instanceof WebGL2RenderingContext) || !context.getExtension("EXT_color_buffer_float")) throw new Error("轨迹密度需要浮点渲染目标");
    this.gl = context;
    this.attached = true;
    this.width = 0; this.height = 0;
    this.lastMeter = -Infinity; this.lastFrame = 0;
    this.meteredView = [];
    const gl = this.gl;
    this.points = program(gl, `
      layout(location=0) in vec2 position;
      uniform mat4 matrix; uniform float diameter; uniform float wrap;
      void main() { gl_Position = matrix * vec4(position + vec2(wrap, 0), 0, 1); gl_PointSize = diameter; }
    `, `
      out vec4 color;
      void main() {
        float distance = length(gl_PointCoord * 2.0 - 1.0);
        float coverage = 1.0 - smoothstep(0.75, 1.0, distance);
        color = vec4(coverage, 0, 0, 0);
      }
    `);
    this.lines = program(gl, `
      layout(location=0) in vec2 position;
      layout(location=1) in vec2 previousPosition;
      layout(location=2) in vec2 nextPosition;
      layout(location=3) in float side;
      uniform mat4 matrix; uniform float wrap; uniform vec2 pixelScale; uniform float halfWidth;
      out float vSide;
      void main() {
        vec4 current = matrix * vec4(position + vec2(wrap, 0.0), 0.0, 1.0);
        vec4 previous = matrix * vec4(previousPosition + vec2(wrap, 0.0), 0.0, 1.0);
        vec4 next = matrix * vec4(nextPosition + vec2(wrap, 0.0), 0.0, 1.0);
        vec2 incoming = (current.xy / current.w - previous.xy / previous.w) / pixelScale;
        vec2 outgoing = (next.xy / next.w - current.xy / current.w) / pixelScale;
        vec2 n0 = incoming / max(length(incoming), 1e-6);
        vec2 n1 = outgoing / max(length(outgoing), 1e-6);
        if (length(incoming) < 1e-6) n0 = n1;
        if (length(outgoing) < 1e-6) n1 = n0;
        vec2 bisector = n0 + n1;
        vec2 direction;
        float miter = 1.0;
        if (length(bisector) < 1e-6) {
          direction = n0;
        } else {
          direction = normalize(bisector);
          float seam = max(dot(direction, n0), 0.2);
          miter = clamp(1.0 / seam, 1.0, 4.0);
        }
        vec2 normal = vec2(-direction.y, direction.x);
        vSide = side;
        vec2 offsetPixels = normal * side * halfWidth * miter;
        gl_Position = current + vec4(offsetPixels * pixelScale * current.w, 0.0, 0.0);
      }
    `, `
      in float vSide;
      uniform float halfWidth;
      out vec4 color;
      void main() {
        float distance = abs(vSide) * halfWidth;
        float antialias = clamp(halfWidth * 0.35, 0.35, 1.0);
        float coverage = 1.0 - smoothstep(halfWidth - antialias, halfWidth + antialias, distance);
        if (coverage <= 0.001) discard;
        color = vec4(coverage, 0.0, 0.0, 0.0);
      }
    `);
    this.composite = program(gl, `
      void main() {
        vec2 uv = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
        gl_Position = vec4(uv * 2.0 - 1.0, 0, 1);
      }
    `, `
      uniform sampler2D density; uniform float exposureScale; uniform ivec2 origin; out vec4 color;
      void main() {
        float count = texelFetch(density, ivec2(gl_FragCoord.xy) - origin, 0).r;
        float coverage = max(count, 0.0);
        float exposed = min(coverage, 1.0) + max(coverage - 1.0, 0.0) * exposureScale;
        float intensity = (2.0 / 3.141592653589793) * atan(exposed / ${FOOTPRINT_ARCTAN_K.toFixed(6)});
        vec3 mint = vec3(70.0, 225.0, 135.0) / 255.0;
        float t = clamp((intensity - ${WHITE_START.toFixed(2)}) / ${(1 - WHITE_START).toFixed(2)}, 0.0, 1.0);
        float whiteMix = t * t * (3.0 - 2.0 * t);
        vec3 rgb = mix(mint, vec3(1.0), whiteMix);
        color = vec4(rgb * intensity, intensity);
      }
    `);
    this.pointVao = gl.createVertexArray()!;
    this.pointBuffer = gl.createBuffer()!;
    this.lineVao = gl.createVertexArray()!;
    this.lineBuffer = gl.createBuffer()!;
    this.texture = gl.createTexture()!;
    this.framebuffer = gl.createFramebuffer()!;
    this.meterTexture = gl.createTexture()!;
    this.meterFramebuffer = gl.createFramebuffer()!;
    gl.bindTexture(gl.TEXTURE_2D, this.meterTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 128, 128, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.meterFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.meterTexture, 0);
    const meterStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
    if (meterStatus !== gl.FRAMEBUFFER_COMPLETE) throw new Error("Footprint exposure framebuffer is incomplete");
    this.uploadPoints();
    this.uploadLines();
  }
  private targetSetup(gl: WebGL2RenderingContext, width: number, height: number) {
    if (this.width !== width || this.height !== height) {
      this.width = width; this.height = height;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, this.width, this.height, 0, gl.RGBA, gl.HALF_FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("Footprint density framebuffer is incomplete");
    }
  }
  accumulate({matrix, zoom, centerLongitude, cssWidth, width, height}: FootprintDensityFrame) {
    if (!this.attached || !this.visible) return;
    const gl = this.gl;
    const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const viewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    this.targetSetup(gl, width ?? gl.drawingBufferWidth, height ?? gl.drawingBufferHeight);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.SCISSOR_TEST); gl.disable(gl.DEPTH_TEST); gl.disable(gl.STENCIL_TEST); gl.disable(gl.CULL_FACE);
    gl.colorMask(true, true, true, true);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE);
    const center = Math.floor((centerLongitude + 180) / 360);
    if (this.mode === "line") {
      if (this.lineVertexCount > 0) {
        const ratio = this.width / Math.max(1, cssWidth);
        gl.useProgram(this.lines);
        gl.bindVertexArray(this.lineVao);
        gl.uniformMatrix4fv(gl.getUniformLocation(this.lines, "matrix"), false, matrix);
        gl.uniform2f(gl.getUniformLocation(this.lines, "pixelScale"), 2 / this.width, 2 / this.height);
        gl.uniform1f(gl.getUniformLocation(this.lines, "halfWidth"), footprintRouteWidth(zoom) / 2 * ratio);
        for (let wrap = center - 1; wrap <= center + 1; wrap += 1) {
          gl.uniform1f(gl.getUniformLocation(this.lines, "wrap"), wrap);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, this.lineVertexCount);
        }
      }
    } else {
      gl.useProgram(this.points); gl.bindVertexArray(this.pointVao);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.points, "matrix"), false, matrix);
      const ratio = this.width / Math.max(1, cssWidth);
      gl.uniform1f(gl.getUniformLocation(this.points, "diameter"), footprintRadius(zoom) * 2 * ratio);
      for (let wrap = center - 1; wrap <= center + 1; wrap += 1) {
        gl.uniform1f(gl.getUniformLocation(this.points, "wrap"), wrap);
        gl.drawArrays(gl.POINTS, 0, this.count);
      }
    }
    gl.bindVertexArray(null);
    const now = performance.now();
    const view = [...matrix, this.width, this.height, zoom, center];
    const viewChanged = view.some((value, index) => value !== this.meteredView[index]);
    // A final zoom/pan frame may arrive within the metering cooldown. Keep
    // drawing until that final view has actually been metered.
    if (viewChanged && now - this.lastMeter < 150) this.requestRedraw();
    if (now - this.lastMeter >= 150) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.framebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.meterFramebuffer);
      gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, 128, 128, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.meterFramebuffer);
      gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.FLOAT, this.meterPixels);
      this.targetExposure = footprintExposure(this.meterPixels);
      this.lastMeter = now;
      this.meteredView = view;
    }
    const elapsed = this.lastFrame ? Math.min(100, now - this.lastFrame) : 0;
    this.lastFrame = now;
    this.exposure += (this.targetExposure - this.exposure) * (1 - Math.exp(-elapsed / 450));
    if (Math.abs(this.targetExposure - this.exposure) > 0.005) this.requestRedraw();
    gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
    gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }
  compositeToViewport(x = 0, y = 0) {
    if (!this.attached || !this.visible) return;
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.STENCIL_TEST); gl.disable(gl.SCISSOR_TEST); gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.composite); gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(gl.getUniformLocation(this.composite, "density"), 0);
    gl.uniform2i(gl.getUniformLocation(this.composite, "origin"), x, y);
    gl.uniform1f(gl.getUniformLocation(this.composite, "exposureScale"), 2 ** this.exposure);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  destroy() {
    if (!this.attached) return;
    this.attached = false;
    const gl = this.gl;
    gl.deleteProgram(this.points); gl.deleteProgram(this.lines); gl.deleteProgram(this.composite);
    gl.deleteBuffer(this.pointBuffer); gl.deleteVertexArray(this.pointVao);
    gl.deleteBuffer(this.lineBuffer); gl.deleteVertexArray(this.lineVao);
    gl.deleteTexture(this.texture); gl.deleteFramebuffer(this.framebuffer);
    gl.deleteTexture(this.meterTexture); gl.deleteFramebuffer(this.meterFramebuffer);
  }
}
