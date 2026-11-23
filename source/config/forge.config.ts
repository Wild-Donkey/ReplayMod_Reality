import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { VitePlugin } from "@electron-forge/plugin-vite";

const requireFromSource = createRequire(path.resolve("package.json"));

const config: ForgeConfig = {
  hooks: {
    postStart: async (_config, child) => {
      if (process.platform !== "win32" || !process.env.REPLAYMOD_STOP_FILE) return;
      child.once("exit", code => {
        if (code === null) return;
        const status = code >>> 0;
        if (status < 0x80000000) return;
        // Forge's Windows CLI wrapper can report success for native exception codes.
        console.error(`Electron terminated with Windows status 0x${status.toString(16).toUpperCase()}.`);
        process.exit(1);
      });
    },
    generateAssets: async () => {
      if(process.platform === "darwin" && process.arch === "arm64") execFileSync(process.execPath,[path.resolve("resources/speech/bundle-runtime.cjs")],{stdio:"inherit"});
      if (process.platform === "darwin") execFileSync(process.execPath, [path.resolve("scripts/native/build-hdr.cjs")], { stdio: "inherit" });
      execFileSync(process.execPath, [path.resolve("scripts/native/build-scroll-input.cjs")], { stdio: "inherit" });
    },
  },
  packagerConfig: {
    download: {cacheRoot: process.env.electron_config_cache, checksums: requireFromSource("electron/checksums.json")},
    extendInfo: {NSMicrophoneUsageDescription: "按住空格录制声音，并插入你的音频剪辑。"},
    name: "ReplayMod Reality",
    appBundleId: "com.replaymod.reality",
    asar: true,
    extraResource: process.platform === "darwin"
      ? ["native/build/hdr-display", "native/build/scroll-input.node", "resources/speech", ...(process.arch === "arm64" ? ["../.tools/speech-runtime"] : [])]
      : [],
    executableName: process.platform === "win32" ? "ReplayModReality" : "ReplayMod Reality",
  },
  makers: [
    new MakerSquirrel({
      name: "replaymod_reality",
      authors: "ReplayMod Reality",
    }),
    new MakerZIP({}, ["darwin", "linux", "win32"]),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: "apps/desktop/src/main/main.ts",
          config: "config/vite/main.config.ts",
          target: "main",
        },
        {
          entry: "apps/desktop/src/main/trajectoryWorker.ts",
          config: "config/vite/main.config.ts",
          target: "main",
        },
        {
          entry: "apps/desktop/src/preload/preload.ts",
          config: "config/vite/preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "config/vite/renderer.config.ts",
        },
      ],
    }),
  ],
};

export default config;
