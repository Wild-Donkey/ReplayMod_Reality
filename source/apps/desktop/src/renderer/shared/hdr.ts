import { requestGPUDevice, type GPU } from "./gpu";
import { getHDRState, currentHDRHeadroom, watchDisplayHDR } from "./displayHDR";
// WebGPU's extended rgba16float presentation is independent of the SDR
// MapLibre/ECharts renderers. Keep their canvases as the fallback and input.
// DOM's bundled types do not yet include WebGPU in this TypeScript version.
/* eslint-disable @typescript-eslint/no-explicit-any */

export function presentHDR(source: HTMLCanvasElement) {
  const overlay = document.createElement("canvas");
  overlay.setAttribute("aria-hidden", "true");
  Object.assign(overlay.style, {
    position: "absolute", inset: "0", width: "100%", height: "100%",
    pointerEvents: "none", display: "none",
  });
  source.after(overlay);
  const originalOpacity = source.style.opacity;
  let disposed = false;
  let device: GPU, context: GPU, pipeline: GPU, texture: GPU, sampler: GPU, headroomBuffer: GPU;
  let textureWidth = 0, textureHeight = 0;
  const fallback = () => {
    overlay.style.display = "none";
    source.style.opacity = originalOpacity;
  };
  const render = () => {
    if (disposed || !device || !pipeline || !getHDRState().active || !source.width || !source.height) {
      if (!disposed) fallback();
      return;
    }
    try {
      if (textureWidth !== source.width || textureHeight !== source.height) {
        texture?.destroy();
        overlay.width = textureWidth = source.width;
        overlay.height = textureHeight = source.height;
        context.configure({ device, format: "rgba16float", alphaMode: "premultiplied", toneMapping: { mode: "extended" } });
        // COPY_DST | TEXTURE_BINDING | RENDER_ATTACHMENT
        texture = device.createTexture({ size: [textureWidth, textureHeight], format: "rgba8unorm", usage: 0x16 });
      }
      device.queue.copyExternalImageToTexture({ source }, { texture, premultipliedAlpha: true }, [textureWidth, textureHeight]);
      device.queue.writeBuffer(headroomBuffer, 0, new Float32Array([currentHDRHeadroom(), 0, 0, 0]));
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({ colorAttachments: [{
        view: context.getCurrentTexture().createView(), clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store",
      }] });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: texture.createView() }, { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: headroomBuffer } },
      ] }));
      pass.draw(3);
      pass.end();
      device.queue.submit([encoder.finish()]);
      overlay.style.display = "block";
      source.style.opacity = "0";
    } catch {
      // Including unsupported formats, tainted sources and lost contexts.
      fallback();
    }
  };
  const onGPUError = () => { pipeline = undefined; fallback(); };
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (gpu) {
    void requestGPUDevice().then((result: GPU) => {
      if (disposed || !result) return;
      device = result;
      device.addEventListener("uncapturederror", onGPUError);
      context = (overlay as GPU).getContext("webgpu");
      if (!context) return;
      const module = device.createShaderModule({ code: `
        @group(0) @binding(0) var image: texture_2d<f32>;
        @group(0) @binding(1) var imageSampler: sampler;
        @group(0) @binding(2) var<uniform> display: vec4f;
        struct Vertex { @builtin(position) position: vec4f, @location(0) uv: vec2f }
        @vertex fn vertex(@builtin(vertex_index) i: u32) -> Vertex {
          let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
          return Vertex(vec4f(uv * vec2f(2, -2) + vec2f(-1, 1), 0, 1), uv);
        }
        @fragment fn fragment(v: Vertex) -> @location(0) vec4f {
          let pixel = textureSample(image, imageSampler, v.uv);
          let rgb = pixel.rgb / max(pixel.a, 0.00001);
          let linear = select(rgb / 12.92, pow((rgb + 0.055) / 1.055, vec3f(2.4)), rgb > vec3f(0.04045));
          // Preserve shadows; map peak white to the current measured EDR limit.
          // Potential headroom is capability only, never the current output limit.
          let peak = max(max(linear.r, linear.g), linear.b);
          let output = linear * (1.0 + (display.x - 1.0) * peak * peak);
          let encoded = select(output*12.92,1.055*pow(output,vec3f(1.0/2.4))-0.055,output>vec3f(0.0031308));
          return vec4f(encoded * pixel.a, pixel.a);
        }
      ` });
      return device.createRenderPipelineAsync({ layout: "auto", vertex: { module, entryPoint: "vertex" }, fragment: { module, entryPoint: "fragment", targets: [{ format: "rgba16float" }] }, primitive: { topology: "triangle-list" } }).then((result: GPU) => {
        if (disposed) return;
        pipeline = result;
        headroomBuffer = device.createBuffer({ size: 16, usage: 0x48 }); // UNIFORM | COPY_DST
        sampler = device.createSampler({ magFilter: "nearest", minFilter: "nearest" });
        void device.lost.then(() => { if (!disposed) { device = undefined; fallback(); } });
        render();
      });
    }).catch(fallback);
  }
  const stopWatchingDisplay = watchDisplayHDR(render);
  return {
    render,
    dispose() {
      disposed = true;
      stopWatchingDisplay();
      fallback();
      device?.removeEventListener("uncapturederror", onGPUError);
      texture?.destroy();
      headroomBuffer?.destroy();
      context?.unconfigure();
      overlay.remove();
    },
  };
}
