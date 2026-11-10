import { mkdirSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { deserialize, serialize } from "node:v8";

const directories = {
  maps: "maps-v1",
  snapshots: "snapshots-v1",
  buildings: "buildings-v1",
  screening: "screening-v1",
} as const;
type Namespace = keyof typeof directories;
type ScanEntry = { bytes: number; usedAt: number };

const entryName = /^[a-z0-9-]+\.bin$/;

// One LRU for all persistent application resources. The file mtime records the
// last use across launches, independently of the provider's refresh timestamp.
export class ResourceCache {
  private readonly entries = new Map<string, number>();
  private bytes = 0;
  private lastUse = 0;
  private queue: Promise<unknown>;

  constructor(readonly directory: string, private limit: number, migrate: () => Promise<void>) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.queue = this.initialize(migrate).catch(console.warn);
  }

  private async initialize(migrate: () => Promise<void>) {
    await migrate().catch(console.warn);
    const entries: [string, ScanEntry][] = [];
    for (const directory of Object.values(directories)) {
      const folder = path.join(this.directory, directory);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const files = await readdir(folder, { withFileTypes: true });
      for (let index = 0; index < files.length; index += 64) {
        await Promise.all(files.slice(index, index + 64).map(async file => {
          if (!file.isFile()) return;
          const relative = path.join(directory, file.name);
          const target = path.join(this.directory, relative);
          if (file.name.endsWith(".tmp") && entryName.test(file.name.slice(0, -4))) {
            await rm(target, { force: true });
          } else if (entryName.test(file.name)) {
            const info = await stat(target);
            entries.push([relative, { bytes: info.size, usedAt: info.mtimeMs }]);
          }
        }));
      }
    }
    entries.sort((a, b) => a[1].usedAt - b[1].usedAt);
    for (const [file, entry] of entries) {
      this.entries.set(file, entry.bytes);
      this.bytes += entry.bytes;
      this.lastUse = Math.max(this.lastUse, entry.usedAt);
    }
    await this.trim();
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const task = this.queue.then(run);
    this.queue = task.catch(() => {});
    return task;
  }

  private file(namespace: Namespace, key: string) {
    if (!/^[a-z0-9-]+$/.test(key)) throw new Error("无效的缓存键");
    return path.join(directories[namespace], `${key}.bin`);
  }

  private forget(file: string) {
    this.bytes -= this.entries.get(file) ?? 0;
    this.entries.delete(file);
  }

  private async remove(file: string) {
    await rm(path.join(this.directory, file), { force: true });
    this.forget(file);
  }

  private async trim() {
    for (const file of this.entries.keys()) {
      if (this.bytes <= this.limit) break;
      await this.remove(file);
    }
  }

  private nextUse() {
    this.lastUse = Math.max(Date.now(), Math.floor(this.lastUse) + 1);
    return this.lastUse;
  }

  read<T>(namespace: Namespace, key: string): Promise<T | null> {
    const file = this.file(namespace, key);
    return this.enqueue(async () => {
      const entry = this.entries.get(file);
      if (entry === undefined) return null;
      const target = path.join(this.directory, file);
      let value: T;
      try {
        value = deserialize(await readFile(target)) as T;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!code || code === "ENOENT") await this.remove(file).catch(console.warn);
        else console.warn(error);
        return null;
      }
      this.entries.delete(file);
      this.entries.set(file, entry);
      const now = this.nextUse();
      await utimes(target, now / 1000, now / 1000).catch(console.warn);
      return value;
    });
  }

  write(namespace: Namespace, key: string, value: unknown): Promise<boolean> {
    const file = this.file(namespace, key);
    return this.enqueue(async () => {
      const bytes = serialize(value);
      if (bytes.byteLength > this.limit) return false;
      const target = path.join(this.directory, file);
      const temporary = `${target}.tmp`;
      try {
        await writeFile(temporary, bytes, { mode: 0o600 });
        // Retain the old entry until the replacement has been committed.
        const now = this.nextUse() / 1000;
        await utimes(temporary, now, now);
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true }).catch(console.warn);
        throw error;
      }
      this.forget(file);
      this.entries.set(file, bytes.byteLength);
      this.bytes += bytes.byteLength;
      await this.trim();
      return true;
    });
  }

  recentKeys(namespace: Namespace, prefix: string, budget: number): Promise<string[]> {
    return this.enqueue(async () => {
      const base = this.file(namespace, prefix).slice(0, -4);
      const keys: string[] = [];
      for (const [file, bytes] of [...this.entries].reverse()) {
        if (!file.startsWith(base)) continue;
        if (bytes > budget) break;
        budget -= bytes;
        keys.push(file.slice(base.length, -4));
      }
      return keys.reverse();
    });
  }

  setLimit(bytes: number) {
    return this.enqueue(async () => {
      this.limit = bytes;
      await this.trim();
    });
  }

  usage() {
    return this.enqueue(async () => ({ bytes: this.bytes, entries: this.entries.size }));
  }

  drain() { return this.queue; }
}
