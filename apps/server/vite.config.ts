import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `tanstackStart()` must come before the React plugin.
//
// Vite 8 is required by @tanstack/react-start (peer `vite >=8`), which is why the admin was
// moved to 8 earlier rather than pinning back to 6.
export default defineConfig({
  server: { port: 3000 },
  resolve: { tsconfigPaths: true },
  plugins: [tanstackStart(), viteReact()],
});
