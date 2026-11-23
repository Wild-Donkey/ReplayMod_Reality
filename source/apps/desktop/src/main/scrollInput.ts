import { app, ipcMain, type BrowserWindow, type IpcMainEvent } from "electron";
import { createRequire } from "node:module";
import path from "node:path";
import { MAP_SCROLL_GESTURE_CHANNEL, MAP_SCROLL_TARGET_CHANNEL, SCROLL_SOURCE_CHANNEL, type MapScrollGesture, type ScrollSource } from "../shared/scrollInput";

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
  if (process.platform !== "darwin" && process.platform !== "win32") return () => undefined;
  const filename = process.platform === "win32" ? "scroll-input-win.node" : "scroll-input.node";
  const nativePath = app.isPackaged
    ? path.join(process.resourcesPath, filename)
    : path.join(app.getAppPath(), "native/build", filename);
  const load = createRequire(__filename);
  if (process.platform === "win32") {
    try { return installWindowsScrollInput(window, load(nativePath)); }
    catch (error) {
      console.warn("Windows touchpad input is unavailable", error);
      return () => undefined;
    }
  }
  const native = load(nativePath) as NativeScrollInput;
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

function installWindowsScrollInput(window: BrowserWindow, native: { poll(frame: Buffer): void; stop(): void }) {
  const contents = window.webContents;
  // ScrollFrame in scroll-input-win.cpp: HWND followed by seven doubles.
  const frame = Buffer.alloc(64);
  window.getNativeWindowHandle().copy(frame);
  let timer: ReturnType<typeof setInterval> | undefined;
  const poll = () => {
    native.poll(frame);
    const gesture: MapScrollGesture = {
      dx: frame.readDoubleLE(16), dy: frame.readDoubleLE(24), zoomDelta: frame.readDoubleLE(32),
      x: frame.readDoubleLE(40), y: frame.readDoubleLE(48),
    };
    if ((gesture.dx || gesture.dy || gesture.zoomDelta) && !contents.isDestroyed()) {
      contents.send(MAP_SCROLL_GESTURE_CHANNEL, gesture);
    }
  };
  const leave = () => {
    clearInterval(timer);
    timer = undefined;
    frame.writeDoubleLE(0, 8);
    native.poll(frame);
  };
  const setTarget = (event: IpcMainEvent, active: unknown) => {
    if (event.sender !== contents || event.senderFrame !== contents.mainFrame) return;
    if (active !== true) { leave(); return; }
    if (timer) return;
    frame.writeDoubleLE(1, 8);
    poll();
    timer = setInterval(poll, 16);
  };
  ipcMain.on(MAP_SCROLL_TARGET_CHANNEL, setTarget);
  window.on("blur", leave);
  contents.on("did-start-loading", leave);
  return () => {
    ipcMain.off(MAP_SCROLL_TARGET_CHANNEL, setTarget);
    window.off("blur", leave);
    contents.off("did-start-loading", leave);
    clearInterval(timer);
    native.stop();
  };
}

