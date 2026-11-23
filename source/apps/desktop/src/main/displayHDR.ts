import { app, BrowserWindow, ipcMain, screen } from "electron";
import { runChild } from "../../../../packages/media/src/childProcesses";
import path from "node:path";
import type { DisplayHDRInfo } from "../shared/display";
type NativeDisplay = Pick<DisplayHDRInfo, "displayId" | "currentHeadroom" | "potentialHeadroom" | "referenceHeadroom">;
let pending: Promise<NativeDisplay[]> | undefined;
let expires = 0;
let windowsReading: {key: string; expires: number; result: Promise<{currentHeadroom: number; hdrActive: boolean} | null>} | undefined;
function readWindows(window: BrowserWindow, displayId: number) {
  const handle = window.getNativeWindowHandle().reduceRight((hex, byte) => hex + byte.toString(16).padStart(2, "0"), "");
  const key = `${displayId}:${handle}`;
  if (!windowsReading || windowsReading.key !== key || Date.now() >= windowsReading.expires) {
    const helper = app.isPackaged ? path.join(process.resourcesPath, "hdr-display.exe") : path.join(app.getAppPath(), "native/build/hdr-display.exe");
    const result = runChild(helper, [handle], {timeout: 2000, maxBuffer: 4096})
      .then(({stdout}) => JSON.parse(stdout) as {currentHeadroom: number; hdrActive: boolean}).catch(() => null);
    windowsReading = {key, expires: Date.now() + 750, result};
  }
  return windowsReading.result;
}
function readNative(): Promise<NativeDisplay[]> {
  if (process.platform !== "darwin") return Promise.resolve([]);
  if (!pending || Date.now() >= expires) {
    const helper = app.isPackaged
      ? path.join(process.resourcesPath, "hdr-display")
      : path.join(app.getAppPath(), "native/build/hdr-display");
    pending = runChild(helper, [], { timeout: 2000, maxBuffer: 64 * 1024 })
      .then(({ stdout }) => JSON.parse(stdout) as NativeDisplay[]).catch(() => []);
    expires = Date.now() + 500;
  }
  return pending;
}
export function installDisplayHDR() {
  ipcMain.handle("display:hdr", async event => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return null;
    const display = screen.getDisplayMatching(window.getBounds());
    const windows = process.platform === "win32" ? await readWindows(window, display.id) : null;
    const native = (await readNative()).find(item => item.displayId === display.id);
    return {
      displayId: display.id, label: display.label, colorDepth: display.colorDepth,
      depthPerComponent: display.depthPerComponent, colorSpace: display.colorSpace,
      currentHeadroom: windows?.currentHeadroom ?? native?.currentHeadroom ?? null,
      potentialHeadroom: native?.potentialHeadroom ?? null,
      referenceHeadroom: native?.referenceHeadroom ?? null,
      hdrActive: windows?.hdrActive,
      source: windows ? "windows-dxgi" : native ? "macos-nsscreen" : "unavailable",
    } satisfies DisplayHDRInfo;
  });
}
