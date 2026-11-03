import { useState, type Dispatch, type SetStateAction } from "react";
import maplibregl from "maplibre-gl";

const state: Record<string, unknown> = { ...window.replaymod?.workspaceState };
let timer: ReturnType<typeof setTimeout> | undefined;
let failure = "";
export const cacheError = () => failure;
const flush = () => {
  clearTimeout(timer);
  failure = window.replaymod?.saveWorkspaceState(state) ?? "";
};
window.addEventListener("beforeunload", flush);
export function readCached<T>(key: string, fallback: T): T {
  return Object.hasOwn(state, key) ? state[key] as T : fallback;
}
export function writeCached(key: string, value: unknown) {
  state[key] = value;
  clearTimeout(timer);
  timer = setTimeout(flush, 500);
}
export function useCachedState<T>(key: string, fallback: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => readCached(key, fallback));
  const update: Dispatch<SetStateAction<T>> = next => {
    setValue(previous => {
      const result = typeof next === "function" ? (next as (value: T) => T)(previous) : next;
      writeCached(key, result);
      return result;
    });
  };
  return [value, update];
}

if (window.replaymod) {
  maplibregl.addProtocol("replaymap", async (request, abortController) => {
    abortController.signal.throwIfAborted();
    const data = await window.replaymod!.loadMapResource(request.url.replace(/^replaymap:/, "https:"));
    abortController.signal.throwIfAborted();
    const bytes = new Uint8Array(data);
    return { data: request.type === "json" ? JSON.parse(new TextDecoder().decode(bytes))
      : request.type === "string" ? new TextDecoder().decode(bytes) : bytes.buffer };
  });
}
export const cachedMapRequest = (url: string) => ({
  url: window.replaymod && url.startsWith("https://api.maptiler.com/")
    ? url.replace(/^https:/, "replaymap:") : url,
});
