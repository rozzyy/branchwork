/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
    rolldownOptions: {
      output: {
        // Large third-party libraries get their own chunks, so no chunk passes
        // Vite's 500 kB warning and app code changes don't bust vendor caches.
        // Groups only bundle what importers already load (lazy stays lazy).
        codeSplitting: {
          groups: [
            { name: "vendor-react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: "vendor-xterm", test: /node_modules[\\/]@xterm[\\/]/ },
            { name: "vendor-codemirror-legacy", test: /node_modules[\\/]@codemirror[\\/]legacy-modes[\\/]/ },
            { name: "vendor-codemirror-js", test: /node_modules[\\/]@(codemirror[\\/]lang-javascript|lezer[\\/]javascript)[\\/]/ },
            { name: "vendor-codemirror-web", test: /node_modules[\\/]@(codemirror[\\/]lang-(html|css)|lezer[\\/](html|css))[\\/]/ },
            { name: "vendor-codemirror-lang", test: /node_modules[\\/]@(codemirror[\\/]lang-[^\\/]+|lezer[\\/](?!common|highlight|lr)[^\\/]+)[\\/]/ },
            { name: "vendor-codemirror", test: /node_modules[\\/](@codemirror|@lezer|codemirror|@marijn|style-mod|w3c-keyname|crelt)[\\/]/ },
            { name: "vendor-markdown", test: /node_modules[\\/](marked|dompurify)[\\/]/ },
          ],
        },
      },
    },
  },
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
