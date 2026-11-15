/** Keep cancellation attached through IPC, including DEM and style requests. */
export async function loadMapBytes(url: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  signal?.throwIfAborted();
  if (!window.replaymod) return new Uint8Array(await (await fetch(url, { signal })).arrayBuffer());
  const id = crypto.randomUUID();
  const cancel = () => window.replaymod!.cancelMapResource?.(id);
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const data = await window.replaymod.loadMapResource(url, id);
    signal?.throwIfAborted();
    // Electron structured cloning already gives this renderer its own bytes.
    return data instanceof Uint8Array && data.buffer instanceof ArrayBuffer
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}
