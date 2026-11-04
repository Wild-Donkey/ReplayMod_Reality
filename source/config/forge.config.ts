import { execFileSync } from "node:child_process";
import path from "node:path";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { VitePlugin } from "@electron-forge/plugin-vite";

const config: ForgeConfig = {
  hooks: {
    generateAssets: async () => {
      execFileSync(process.execPath, [path.resolve("scripts/native/build-hdr.cjs")], { stdio: "inherit" });
    },
  },
  packagerConfig: {
    name: "ReplayMod Reality",
    appBundleId: "com.replaymod.reality",
    asar: true,
    extraResource: process.platform === "darwin" ? ["native/build/hdr-display"] : [],
    executableName: "ReplayMod Reality",
  },
  makers: [
    new MakerSquirrel({
      name: "replaymod_reality",
    }),
    new MakerZIP({}, ["darwin", "linux"]),
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
