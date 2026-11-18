import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The TanStack Start API serves this build from apps/server/public/admin, and `bun run dev`
// proxies /v1 to it so the SPA works unchanged against a live server.
//
// The `@/*` alias mirrors tsconfig `paths` because the shadcn CLI writes its generated
// components with `@/lib/utils` imports — the two configs must agree or every generated
// component fails to resolve.
//
// If `bun run check` starts reporting `Plugin<any> is not assignable to PluginOption`, or a
// build banner shows an older Vite than package.json declares: bun can leave a *physical* copy
// of vite inside admin/node_modules instead of the usual link into node_modules/.bun, while
// resolving @vitejs/plugin-react's peer set. That copy shadows the workspace version, so the
// install looks correct and the build silently runs the old one. Delete admin/node_modules and
// reinstall from the workspace root to collapse it back to a single linked copy. Do not "fix"
// it with a tsconfig `paths` entry for `vite`: that only hides the second copy, and the stale
// one still runs.
export default defineConfig({
  base: "/admin/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  // Served by the TanStack Start app from its public directory at /admin/. It used to be
  // ../server/admin/dist, which FastAPI mounted; that app is gone.
  build: { outDir: "../apps/server/public/admin", emptyOutDir: true },
  server: {
    // The API is the TanStack Start app during development (`bun run dev` in apps/server).
    // FastAPI's 8000 is gone; do not resurrect it.
    proxy: {
      "/v1": "http://127.0.0.1:3000",
    },
  },
});
