// The bundled terminal binary: Resources/sm when packaged, dist-cli/smd
// in dev (built by `pnpm dev`). The app links it onto PATH
// (cliInstall.ts), the doctor checks it, and the updater hands it the
// install that has to outlive the app.
import { CLI_DIST_DIR, cliBinaryName } from "@shared/packaging/cliDist.mts";
import { app } from "electron";
import { bundledBinaryResolver } from "./bundledBinary";

export const cliBinaryPath = bundledBinaryResolver(
  CLI_DIST_DIR,
  cliBinaryName(app.isPackaged ? "prod" : "dev"),
);

// A missing binary (a dev run before `pnpm cli:build --dev`) is an
// actionable error.
export function requireCliBinary(): string {
  const binary = cliBinaryPath();
  if (binary === null) {
    throw new Error(
      "The sm binary is missing. Run `pnpm cli:build --dev` (dev) or reinstall the app.",
    );
  }
  return binary;
}
