/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // Side-effect `import "*.css"` stays stubbed (no jsdom styling needed in
    // tests), but `import css from "*.css?raw"` (tokens.test.ts reads the
    // token values straight out of tokens.css) needs the real file content.
    css: { include: [/\.css\?raw$/] },
    exclude: ["e2e/**", "node_modules/**"],
  },
});
