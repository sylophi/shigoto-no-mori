// The proofs read sources (the boundary) and render the scenes in Node,
// where there is no window.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
