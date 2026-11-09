import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, unlink } from "node:fs/promises";
import path from "node:path";
import { RawVideoEncoder } from "../../../../packages/media/src/raw-video";
import { OfflineFramePlan, type OfflineExportOptions, type OfflineExportSegment } from "../shared/overlayExport";

interface Session {
  readonly owner: number;
  readonly plan: OfflineFramePlan;
  readonly destination: string;
  readonly encoderPath: string;
  readonly paths: string[];
  segment: number;
  frames: number;
  busy: boolean;
  cancelled: boolean;
  encoder: RawVideoEncoder | null;
  temporary: string | null;
}
export class OfflineExportManager {
  private readonly sessions = new Map<string, Session>();
  get active() { return this.sessions.size > 0; }
  begin(owner: number, options: OfflineExportOptions, destination: string, encoderPath: string) {
    if ([...this.sessions.values()].some(session => session.owner === owner)) throw new Error("An export is already running");
    const plan = new OfflineFramePlan(options), id = randomUUID();
    this.sessions.set(id, {owner, plan, destination, encoderPath, paths: [], segment: 0, frames: 0, busy: false, cancelled: false, encoder: null, temporary: null});
    return {id, segmentCount: plan.segmentCount};
  }
  async write(owner: number, id: string, segment: number, index: number, rgba: Uint8Array) {
    const session = this.get(owner, id);
    if (session.busy || segment !== session.segment || index !== session.frames) throw new Error("Export frames must be submitted sequentially");
    session.plan.frame(segment, index);
    if (!ArrayBuffer.isView(rgba) || rgba.BYTES_PER_ELEMENT !== 1 || rgba.byteLength !== session.plan.options.width * session.plan.options.height * 4) throw new Error("Invalid RGBA frame size");
    session.busy = true;
    try {
      if (!session.encoder) {
        session.temporary = path.join(path.dirname(session.destination), `.${path.basename(session.destination)}.${id}.${segment}.part.webm`);
        session.encoder = new RawVideoEncoder({...session.plan.options, encoder: session.encoderPath, output: session.temporary});
      }
      await session.encoder.write(rgba);
      if (session.cancelled) throw new Error("Export was cancelled");
      session.frames++;
    } catch (error) { await this.cancel(owner, id); throw error; }
    finally { session.busy = false; }
  }
  async finishSegment(owner: number, id: string, segment: number): Promise<OfflineExportSegment> {
    const session = this.get(owner, id);
    if (session.busy || segment !== session.segment || session.frames !== session.plan.segmentFrames(segment) || !session.encoder || !session.temporary) throw new Error("Export segment is incomplete");
    session.busy = true;
    try {
      await session.encoder.finish();
      if (session.cancelled) throw new Error("Export was cancelled");
      const extension = path.extname(session.destination), base = session.destination.slice(0, session.destination.length - extension.length);
      const suffix = session.plan.segmentCount > 1 ? `-${String(segment + 1).padStart(3, "0")}-of-${session.plan.segmentCount}` : "";
      let destination = `${base}${suffix}.webm`;
      for (let collision = 0; ; collision++) {
        try {
          try { await link(session.temporary, destination); }
          catch (error) {
            if (!["ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
            await copyFile(session.temporary, destination, constants.COPYFILE_EXCL);
          }
          break;
        }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST" || collision >= 9999) throw error;
          destination = `${base}${suffix} (${collision + 1}).webm`;
        }
      }
      if (session.cancelled) { await unlink(destination).catch(() => {}); throw new Error("Export was cancelled"); }
      await unlink(session.temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
      if (session.cancelled) { await unlink(destination).catch(() => {}); throw new Error("Export was cancelled"); }
      const result = {path: destination, frames: session.frames};
      session.paths.push(destination); session.segment++; session.frames = 0; session.encoder = null; session.temporary = null;
      return result;
    } catch (error) { await this.cancel(owner, id); throw error; }
    finally { session.busy = false; }
  }
  complete(owner: number, id: string) {
    const session = this.get(owner, id);
    if (session.busy || session.encoder || session.segment !== session.plan.segmentCount) throw new Error("Export is incomplete");
    this.sessions.delete(id);
    return [...session.paths];
  }
  async cancel(owner: number, id: string) {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner) return;
    session.cancelled = true;
    this.sessions.delete(id);
    await session.encoder?.cancel();
    if (session.temporary) await unlink(session.temporary).catch(() => {});
  }
  async cancelOwner(owner: number) { await Promise.all([...this.sessions].filter(([, session]) => session.owner === owner).map(([id]) => this.cancel(owner, id))); }
  async cancelAll() { await Promise.all([...this.sessions].map(([id, session]) => this.cancel(session.owner, id))); }
  private get(owner: number, id: string) {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner || session.cancelled) throw new Error("Unknown export session");
    return session;
  }
}
