import type { BrowserWindowConstructorOptions } from "electron";

// The map's translucent materials composite onto one stable gray substrate.
export function windowBackgroundOptions(): BrowserWindowConstructorOptions {
  return {backgroundColor: "#1e1e1e", transparent: false};
}
