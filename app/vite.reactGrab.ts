// What React Grab reads in a packaged build of the renderer tree (the
// desktop renderer, the web client): the functions' own names for its
// components, and sourcemaps for their files. The maps leave the
// sources out and name each file from the repo's root, not from the
// machine that built them.
import { dirname, relative, resolve } from "node:path";
import type { BuildEnvironmentOptions } from "vite";

const repoRoot = resolve(__dirname, "..");

export const reactGrabBuild = {
  sourcemap: true,
  rolldownOptions: {
    output: {
      keepNames: true,
      sourcemapExcludeSources: true,
      sourcemapPathTransform: (source, sourcemapPath) =>
        relative(repoRoot, resolve(dirname(sourcemapPath), source)),
    },
  },
} satisfies BuildEnvironmentOptions;
