import { app, type BrowserWindow } from "electron";
import { createRequire } from "node:module";
import path from "node:path";
import { SCROLL_SOURCE_CHANNEL, type ScrollSource } from "../shared/scrollInput";

interface NativeScrollEvent {
  phase: number;
  momentumPhase: number;
  deltaX: number;
  deltaY: number;
}
interface NativeScrollInput {
  start(callback: (event: NativeScrollEvent) => void): void;
  stop(): void;
}

export function installScrollInput(window: BrowserWindow): () => void {
  if (process.platform !== "darwin") return () => undefined;
  const nativePath = app.isPackaged
    ? path.join(process.resourcesPath, "scroll-input.node")
    : path.join(app.getAppPath(), "native/build/scroll-input.node");
  const native = createRequire(__filename)(nativePath) as NativeScrollInput;
  let source: ScrollSource = "unknown";
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  native.start(event => {
    if (resetTimer) clearTimeout(resetTimer);
    // Physical trackpad scrolls carry an AppKit gesture phase (MayBegin,
    // Began, Changed, Ended...). Injected/smoothed wheel events do not.
    if (event.phase !== 0) source = "trackpad";
    else if (source === "unknown" && (event.deltaX !== 0 || event.deltaY !== 0)) source = "mouse-wheel";
    window.webContents.send(SCROLL_SOURCE_CHANNEL, source);
    // Finger-up precedes the momentum tail. End the source transaction only
    // after the complete native scroll stream has gone quiet.
    resetTimer = setTimeout(() => {
      source = "unknown";
      resetTimer = undefined;
    }, 120);
  });
  return () => {
    if (resetTimer) clearTimeout(resetTimer);
    native.stop();
  };
}

