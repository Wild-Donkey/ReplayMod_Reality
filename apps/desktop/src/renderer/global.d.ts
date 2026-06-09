import type { DesktopBridge } from "../preload/preload";

declare global {
  interface Window {
    replaymod?: DesktopBridge;
  }
}

export {};
