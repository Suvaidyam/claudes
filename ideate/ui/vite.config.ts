import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

// Built into dist/web: tsc owns dist/ui (the compiled server), and emptyOutDir would wipe it.
export default defineConfig({
  root,
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    proxy: {
      // The ui server only accepts same-origin writes, so present its own origin.
      "/api": { target: "http://127.0.0.1:4317", changeOrigin: true, headers: { origin: "http://127.0.0.1:4317" } },
    },
  },
});
