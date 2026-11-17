import { defineConfig } from "vite";

// Served by FastAPI at /admin from ../server/admin/dist in production; `bun run dev`
// proxies /v1 to the local backend so the SPA works unchanged against live servers.
export default defineConfig({
  base: "/admin/",
  build: { outDir: "../server/admin/dist", emptyOutDir: true },
  server: {
    proxy: {
      "/v1": "http://127.0.0.1:8000",
    },
  },
});
