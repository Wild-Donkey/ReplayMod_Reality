import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { UserArchive } from "../../shared/userArchive";

export class UserArchiveStore {
  constructor(readonly file: string) {}

  read(): UserArchive | null {
    try {
      const value = JSON.parse(readFileSync(this.file, "utf8")) as UserArchive;
      if (value.format !== "replaymod.user-archive" || value.version !== 1
        || !value.settings || !value.workspace || !value.services) throw new Error("用户存档格式无效");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("无法读取用户存档；原文件未覆盖。", { cause: error });
    }
  }

  write(value: UserArchive): void {
    const next: UserArchive = {...value,updatedAt:new Date().toISOString()};
    writeFileSync(`${this.file}.tmp`, JSON.stringify(next,null,2)+"\n", {mode:0o600});
    renameSync(`${this.file}.tmp`,this.file);
  }

  update(change: (current: UserArchive) => UserArchive, fallback: UserArchive): UserArchive {
    const next=change(this.read() ?? fallback);
    this.write(next);
    return next;
  }
}
