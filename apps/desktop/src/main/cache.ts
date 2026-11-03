import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { serialize, deserialize } from "node:v8";

// Binary snapshots preserve NaN altitude values and avoid reparsing large CSVs.
export class LocalCache {
  private queue: Promise<void> = Promise.resolve();
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  private file(key: string) {
    if (!/^[a-z0-9-]+$/.test(key)) throw new Error("无效的缓存键");
    return path.join(this.directory, `${key}.bin`);
  }
  readSync<T>(key: string): T | null {
    try { return deserialize(readFileSync(this.file(key))) as T; }
    catch { return null; } // Missing, incompatible or damaged cache is disposable.
  }
  async read<T>(key: string): Promise<T | null> {
    try { return deserialize(await readFile(this.file(key))) as T; }
    catch { return null; }
  }
  writeSync(key: string, value: unknown) {
    const target = this.file(key);
    writeFileSync(`${target}.tmp`, serialize(value), { mode: 0o600 });
    renameSync(`${target}.tmp`, target);
  }
  write(key: string, value: unknown): Promise<void> {
    const bytes = serialize(value);
    const target = this.file(key);
    const task = this.queue.catch(() => {}).then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(`${target}.tmp`, bytes, { mode: 0o600 });
      await rename(`${target}.tmp`, target);
    });
    this.queue = task;
    return task;
  }
}
