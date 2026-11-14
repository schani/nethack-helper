import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  build: { outDir: "../dist/web", emptyOutDir: true, target: "es2022" },
  server: { port: 8789, proxy: { "/api": "http://localhost:8788" } },
});
