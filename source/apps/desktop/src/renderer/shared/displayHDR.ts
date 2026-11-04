import { useSyncExternalStore } from "react";
import { displayHeadroom, type DisplayHDRInfo } from "../../shared/display";
import { readCached, writeCached } from "./cache";
const listeners = new Set<() => void>();
let info: DisplayHDRInfo | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let reading = false;
let detected = false;
let enabled = readCached("hdr-enabled", true);
const media = matchMedia("(dynamic-range: high)");
export interface HDRState { enabled: boolean; supported: boolean | null; active: boolean; label: string; headroom: number }
let state: HDRState = {enabled,supported:null,active:false,label:"",headroom:1};
export const currentDisplayHDR = () => info;
export const getHDRState = () => state;
export const currentHDRHeadroom = () => state.headroom;
function publish() {
  const potential = info?.potentialHeadroom;
  const capable = typeof potential === "number" && Number.isFinite(potential) ? potential > 1 : media.matches;
  const supported = detected ? capable && Boolean((navigator as Navigator & {gpu?: unknown}).gpu) : null;
  const active = enabled && supported === true;
  const next = {enabled,supported,active,label:info?.label ?? "",headroom:active ? displayHeadroom(info) : 1};
  if (JSON.stringify(next) !== JSON.stringify(state)) {
    state = next;
    listeners.forEach(listener => listener());
  }
}
export function setHDREnabled(value: boolean) {
  if (state.supported !== true) return;
  enabled = value; writeCached("hdr-enabled", value); publish();
}
async function refresh() {
  if (reading) return;
  reading = true;
  try { info = await window.replaymod?.getDisplayHDR() ?? null; }
  catch { info = null; }
  finally { detected = true; reading = false; publish(); }
}
export function watchDisplayHDR(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    void refresh();
    timer = setInterval(() => { if (!document.hidden) void refresh(); }, 1000);
    window.addEventListener("focus", refresh);
    media.addEventListener("change", refresh);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearInterval(timer); timer = undefined;
      window.removeEventListener("focus", refresh);
      media.removeEventListener("change", refresh);
    }
  };
}
export const useHDRState = () => useSyncExternalStore(watchDisplayHDR,getHDRState);
