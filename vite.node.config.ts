// Shared by both node-side builds (main and preload): the @shared alias
// and the one runtime dependency Vite must not bundle. One file means a
// future node-side option can't be added to just one of them.
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "shared"),
    },
  },
  build: {
    rollupOptions: {
      // node-pty loads its native addon and spawn helper by path
      // relative to its own package, so it has to stay a real
      // node_modules require (forge.config.ts ships that directory).
      external: ["node-pty"],
    },
  },
});
