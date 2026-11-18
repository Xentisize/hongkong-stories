import { defineConfig } from "vite";

// The spike imports the real content and art straight out of `client/` (the Godot project),
// which sits above this app's root — hence `server.fs.allow`. A shipped client would instead
// fetch a content hot-pack from the API, so these imports disappear rather than move.
export default defineConfig({
  base: "/",
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    fs: { allow: ["../.."] },
    proxy: { "/v1": "http://127.0.0.1:3000" },
  },
});
