import { app, BrowserWindow, ipcMain, screen } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { DisplayHDRInfo } from "../shared/display";
const run = promisify(execFile);
type NativeDisplay = Pick<DisplayHDRInfo, "displayId" | "currentHeadroom" | "potentialHeadroom" | "referenceHeadroom">;
let pending: Promise<NativeDisplay[]> | undefined;
let expires = 0;
function readNative(): Promise<NativeDisplay[]> {
  if (process.platform !== "darwin") return Promise.resolve([]);
  if (!pending || Date.now() >= expires) {
    const helper = app.isPackaged
      ? path.join(process.resourcesPath, "hdr-display")
      : path.join(app.getAppPath(), "native/build/hdr-display");
    pending = run(helper, [], { timeout: 2000, maxBuffer: 64 * 1024 })
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
    const native = (await readNative()).find(item => item.displayId === display.id);
    return {
      displayId: display.id, label: display.label, colorDepth: display.colorDepth,
      depthPerComponent: display.depthPerComponent, colorSpace: display.colorSpace,
      currentHeadroom: native?.currentHeadroom ?? null,
      potentialHeadroom: native?.potentialHeadroom ?? null,
      referenceHeadroom: native?.referenceHeadroom ?? null,
      source: native ? "macos-nsscreen" : "unavailable",
    } satisfies DisplayHDRInfo;
  });
}
