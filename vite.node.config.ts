// Shared by both node-side builds (main and preload): the only setting
// either needs is the @shared alias, and one file means a future
// node-side option can't be added to just one of them.
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "shared"),
      "@host": resolve(__dirname, "host"),
    },
  },
});
