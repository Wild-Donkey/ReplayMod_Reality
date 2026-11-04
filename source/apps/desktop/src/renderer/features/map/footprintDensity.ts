import maplibregl, { type CustomLayerInterface, type CustomRenderMethodInput } from "maplibre-gl";

// Fixed response: a pan or a new dense cluster must not change other points.
export const footprintOpacity = (count: number) => Math.min(0.96, 0.12 * Math.log2(1 + Math.max(0, count)));
export function footprintRadius(zoom: number) {
  if (zoom <= 1) return 0.6;
  if (zoom <= 8) return 0.6 + (zoom - 1) / 7 * 0.5;
  return 1.1 + Math.min(6, zoom - 8) / 6 * 0.9;
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

// Count coverage in a separate floating-point target before applying log.
// Applying log to already alpha-composited circles cannot recover their density.
export class FootprintDensity implements CustomLayerInterface {
  readonly id = "footprint-log-density";
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;
  private map!: maplibregl.Map;
  private gl!: WebGL2RenderingContext;
  private points!: WebGLProgram;
  private composite!: WebGLProgram;
  private buffer!: WebGLBuffer;
  private vao!: WebGLVertexArrayObject;
  private texture!: WebGLTexture;
  private framebuffer!: WebGLFramebuffer;
  private width = 0;
  private height = 0;
  private count = 0;
  constructor(private coordinates: readonly number[]) {}
  setCoordinates(coordinates: readonly number[]) {
    this.coordinates = coordinates;
    if (this.gl) { this.upload(); this.map.triggerRepaint(); }
  }
  private upload() {
    const data = new Float32Array(this.coordinates.length);
    for (let i = 0; i < data.length; i += 2) {
      const point = maplibregl.MercatorCoordinate.fromLngLat([this.coordinates[i], this.coordinates[i + 1]]);
      data[i] = point.x; data[i + 1] = point.y;
    }
    this.count = data.length / 2;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }
  onAdd(map: maplibregl.Map, context: WebGLRenderingContext | WebGL2RenderingContext) {
    if (!(context instanceof WebGL2RenderingContext) || !context.getExtension("EXT_color_buffer_float")) throw new Error("轨迹密度需要浮点渲染目标");
    this.map = map; this.gl = context;
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
    this.composite = program(gl, `
      void main() {
        vec2 uv = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
        gl_Position = vec4(uv * 2.0 - 1.0, 0, 1);
      }
    `, `
      uniform sampler2D density; out vec4 color;
      void main() {
        float count = texelFetch(density, ivec2(gl_FragCoord.xy), 0).r;
        float alpha = min(0.96, 0.12 * log2(1.0 + count));
        color = vec4(vec3(185.0, 245.0, 197.0) / 255.0 * alpha, alpha);
      }
    `);
    this.vao = gl.createVertexArray()!;
    this.buffer = gl.createBuffer()!;
    this.texture = gl.createTexture()!;
    this.framebuffer = gl.createFramebuffer()!;
    this.upload();
  }
  prerender(context: WebGLRenderingContext | WebGL2RenderingContext, options: CustomRenderMethodInput) {
    const gl = this.gl;
    const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const viewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    if (this.width !== gl.drawingBufferWidth || this.height !== gl.drawingBufferHeight) {
      this.width = gl.drawingBufferWidth; this.height = gl.drawingBufferHeight;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, this.width, this.height, 0, gl.RGBA, gl.HALF_FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
    }
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.SCISSOR_TEST); gl.disable(gl.DEPTH_TEST); gl.disable(gl.STENCIL_TEST); gl.disable(gl.CULL_FACE);
    gl.colorMask(true, true, true, true);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.points); gl.bindVertexArray(this.vao);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.points, "matrix"), false, options.defaultProjectionData.mainMatrix);
    const ratio = this.width / Math.max(1, this.map.getCanvas().clientWidth);
    gl.uniform1f(gl.getUniformLocation(this.points, "diameter"), footprintRadius(this.map.getZoom()) * 2 * ratio);
    const center = Math.floor((this.map.getCenter().lng + 180) / 360);
    for (let wrap = center - 1; wrap <= center + 1; wrap++) {
      gl.uniform1f(gl.getUniformLocation(this.points, "wrap"), wrap);
      gl.drawArrays(gl.POINTS, 0, this.count);
    }
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
    gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }
  render() {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.STENCIL_TEST); gl.disable(gl.SCISSOR_TEST); gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.composite); gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(gl.getUniformLocation(this.composite, "density"), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  onRemove() {
    const gl = this.gl;
    if (!gl) return;
    gl.deleteProgram(this.points); gl.deleteProgram(this.composite);
    gl.deleteBuffer(this.buffer); gl.deleteVertexArray(this.vao);
    gl.deleteTexture(this.texture); gl.deleteFramebuffer(this.framebuffer);
  }
}
