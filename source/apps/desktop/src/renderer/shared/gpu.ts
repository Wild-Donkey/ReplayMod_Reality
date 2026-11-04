// WebGPU is not yet included in this project's DOM declarations.
export type GPU = any;
let pending: Promise<GPU> | undefined;
export function requestGPUDevice(): Promise<GPU> {
  if (!pending) {
    const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
    if (!gpu) return Promise.reject(new Error("WebGPU 不可用"));
    pending = (async () => {
      const adapter = await gpu.requestAdapter();
      if (!adapter) throw new Error("没有可用的 GPU 适配器");
      const device = await adapter.requestDevice();
      void device.lost.then(() => { pending = undefined; });
      return device;
    })().catch(error => { pending = undefined; throw error; });
  }
  return pending;
}
