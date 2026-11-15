import { createHash } from "node:crypto";
import { isTransitTileUrl } from "../shared/transitTiles";
import type { ResourceCache } from "./storage/resourceCache";

type CachedResource = { at: number; data: Uint8Array };
type FetchResource = (url: string, options: RequestInit) => Promise<Response>;
type PendingResource = { controller: AbortController; promise: Promise<Uint8Array>; consumers: number; finished: boolean };
type Download = { signal: AbortSignal; start: () => void; cancel: () => void };
const CACHE_TTL = 7 * 86400_000;
const MEMORY_BYTES = 64 * 1024 * 1024;

class DownloadQueue {
  private active = 0;
  private waiting: Download[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(signal: AbortSignal, priority: boolean, download: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const entry: Download = {
        signal,
        start: () => { signal.removeEventListener("abort", entry.cancel); this.active++; resolve(); },
        cancel: () => {
          this.waiting = this.waiting.filter(item => item !== entry);
          reject(signal.reason);
        },
      };
      if (this.active < this.limit) entry.start();
      else {
        if (this.waiting.length >= 256) { reject(new Error("地图请求繁忙，请稍后重试")); return; }
        signal.addEventListener("abort", entry.cancel, { once: true });
        if (priority) this.waiting.unshift(entry);
        else this.waiting.push(entry);
      }
    });
    try {
      signal.throwIfAborted();
      return await download();
    } finally {
      this.active--;
      this.waiting.shift()?.start();
    }
  }
}

/** Shared by interactive maps, road/building carriers and terrain batch jobs. */
export class MapResources {
  private readonly memory = new Map<string, CachedResource>();
  private memoryBytes = 0;
  private readonly requests = new Map<string, PendingResource>();
  private readonly refreshes = new Map<string, Promise<void>>();
  private readonly retryAfter = new Map<string, number>();
  private readonly basemapDownloads = new DownloadQueue(8);
  private readonly transitDownloads = new DownloadQueue(4);
  private readonly batchDownloads = new DownloadQueue(4);

  constructor(private readonly cache: Pick<ResourceCache, "read" | "write">, private readonly fetchResource: FetchResource) {}

  async load(rawUrl: string, direct = false, signal?: AbortSignal): Promise<Uint8Array> {
    const url = new URL(rawUrl);
    const transit = !direct && isTransitTileUrl(url);
    if (!transit && (url.protocol !== "https:" || url.hostname !== "api.maptiler.com" || url.port || url.username || url.password)) {
      throw new Error("不支持的地图资源地址");
    }
    signal?.throwIfAborted();
    const key = createHash("sha256").update(url.href).digest("hex");
    const saved = this.memory.get(key);
    if (saved) {
      this.memory.delete(key);
      this.memory.set(key, saved);
      if (!direct && Date.now() - saved.at >= CACHE_TTL) this.refresh(key, url, transit);
      return saved.data;
    }

    let pending = this.requests.get(key);
    if (!pending || pending.controller.signal.aborted) {
      const controller = new AbortController();
      const request: PendingResource = { controller, consumers: 0, finished: false, promise: undefined! };
      request.promise = this.readOrDownload(key, url, transit, direct, controller.signal).finally(() => {
        request.finished = true;
        if (this.requests.get(key) === request) this.requests.delete(key);
      });
      pending = request;
      this.requests.set(key, request);
    }
    const request = pending;
    request.consumers++;
    return new Promise<Uint8Array>((resolve, reject) => {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        signal?.removeEventListener("abort", abort);
        request.consumers--;
        if (!request.consumers && !request.finished) request.controller.abort();
      };
      const abort = () => { release(); reject(signal!.reason); };
      signal?.addEventListener("abort", abort, { once: true });
      request.promise.then(data => { release(); resolve(data); }, error => { release(); reject(error); });
    });
  }

  private remember(key: string, value: CachedResource) {
    const previous = this.memory.get(key);
    if (previous) this.memoryBytes -= previous.data.byteLength;
    this.memory.delete(key);
    this.memory.set(key, value);
    this.memoryBytes += value.data.byteLength;
    while (this.memoryBytes > MEMORY_BYTES || this.memory.size > 512) {
      const oldest = this.memory.keys().next().value!;
      this.memoryBytes -= this.memory.get(oldest)!.data.byteLength;
      this.memory.delete(oldest);
      this.retryAfter.delete(oldest);
    }
  }

  private async readOrDownload(key: string, url: URL, transit: boolean, direct: boolean, signal: AbortSignal) {
    const saved = await this.cache.read<CachedResource>("maps", key);
    signal.throwIfAborted();
    if (saved) {
      this.remember(key, saved);
      // Draw the cached tile immediately; a slow refresh must not blank a map.
      if (!direct && Date.now() - saved.at >= CACHE_TTL) this.refresh(key, url, transit);
      return saved.data;
    }
    return this.downloadAndSave(key, url, transit, direct, signal);
  }

  private refresh(key: string, url: URL, transit: boolean) {
    if (this.refreshes.has(key) || Date.now() < (this.retryAfter.get(key) ?? 0)) return;
    const promise = this.downloadAndSave(key, url, transit, false, new AbortController().signal)
      .then(() => { this.retryAfter.delete(key); })
      .catch(() => {
        if (this.memory.has(key)) this.retryAfter.set(key, Date.now() + 60_000);
      })
      .finally(() => { this.refreshes.delete(key); });
    this.refreshes.set(key, promise);
  }

  private async downloadAndSave(key: string, url: URL, transit: boolean, direct: boolean, signal: AbortSignal) {
    const queue = direct ? this.batchDownloads : transit ? this.transitDownloads : this.basemapDownloads;
    const data = await queue.run(signal, url.pathname.endsWith(".json"), async () => {
      const response = await this.fetchResource(url.href, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        redirect: transit ? "error" : "follow",
      });
      // LOOM omits tiles with no transit service; cache those empty tiles too.
      if (transit && response.status === 404) {
        await response.body?.cancel();
        return new Uint8Array();
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`地图请求失败 (${response.status})`);
      }
      return new Uint8Array(await response.arrayBuffer());
    });
    signal.throwIfAborted();
    const value = { at: Date.now(), data };
    this.remember(key, value);
    if (data.byteLength <= 32 * 1024 * 1024) {
      // Persistent writes retain the cache's atomic ordering, but rendering does
      // not wait for serialization, disk writes or LRU eviction.
      void this.cache.write("maps", key, value).catch(console.warn);
    }
    return data;
  }
}
