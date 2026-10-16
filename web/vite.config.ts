import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

// The build output is embedded into the Go binary (internal/webui/dist).
export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  build: {
    outDir: "../internal/webui/dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:8080",
      "/view": "http://localhost:8080",
      "/auth": "http://localhost:8080",
      "/healthz": "http://localhost:8080",
    },
  },
});
