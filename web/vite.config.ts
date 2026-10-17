import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

// The build output is embedded into the Go binary (internal/webui/dist).
export default defineConfig({
  plugins: [svelte(), tailwindcss(), serviceWorker()],
  build: {
    outDir: "../internal/webui/dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:8080",
      "/view": "http://localhost:8080",
      "/s/": "http://localhost:8080",
      "/auth": "http://localhost:8080",
      "/healthz": "http://localhost:8080",
    },
  },
});

// serviceWorker emits sw.js with the list of files this build precaches: the
// shell, the hashed bundle and the public files. Its version is a hash of that
// list and of the worker's source, so each deploy installs a new worker.
function serviceWorker(): Plugin {
  const root = dirname(fileURLToPath(import.meta.url));
  const publicDir = join(root, "public");
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
      d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)],
    );
  return {
    name: "specola-sw",
    apply: "build",
    generateBundle(_, bundle) {
      const files = [
        "/",
        ...Object.keys(bundle).map((f) => "/" + f),
        ...walk(publicDir).map((f) => "/" + relative(publicDir, f).split("\\").join("/")),
      ].filter((f) => f !== "/index.html");
      const source = readFileSync(join(root, "sw.js"), "utf8");
      const version = createHash("sha256").update(files.join("\n")).update(source).digest("hex").slice(0, 12);
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: `const VERSION = ${JSON.stringify(version)};\nconst PRECACHE = ${JSON.stringify(files)};\n\n${source}`,
      });
    },
  };
}
