import { execFileSync } from "node:child_process";
import path from "node:path";
import { app } from "electron";

export function prepareWindows() {
  if (process.platform !== "win32") return;
  if (app.isPackaged) {
    app.setAppUserModelId("com.squirrel.replaymod_reality.ReplayModReality");
    const event = process.argv[1];
    if (event === "--squirrel-obsolete") process.exit(0);
    if (event === "--squirrel-install" || event === "--squirrel-updated" || event === "--squirrel-uninstall") {
      const action = event === "--squirrel-uninstall" ? "--removeShortcut" : "--createShortcut";
      const update = path.resolve(path.dirname(process.execPath), "..", "Update.exe");
      try {
        execFileSync(update, [`${action}=${path.basename(process.execPath)}`], {windowsHide: true, timeout: 10_000});
      } catch (error) {
        console.error("Unable to update the ReplayMod Reality shortcuts:", error);
      }
      process.exit(0);
    }
  }

  const root = app.isPackaged ? path.dirname(process.execPath) : path.resolve(app.getAppPath(), "..");
  const tools = path.join(root, ".tools");
  const directories = ["ffmpeg/bin", "ffmpeg", "ffmpeg-native/bin", "exiftool", "gpac"].map(directory => path.join(tools, directory));
  const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === "PATH") ?? "Path";
  process.env[pathKey] = [...directories, process.env[pathKey]].filter(Boolean).join(path.delimiter);
}
