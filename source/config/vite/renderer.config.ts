import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("../../apps/desktop/src/renderer", import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("../../.vite/renderer/main_window", import.meta.url)),
    sourcemap: true,
  },
});
