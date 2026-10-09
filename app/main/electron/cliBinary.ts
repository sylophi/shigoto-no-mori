// The bundled terminal binary, as the shell finds it: the updater hands
// it the install that has to outlive the app. The host finds its own
// (host/lib/cli/binary.ts).
import { CLI_DIST_DIR, cliBinaryName } from "@shared/packaging/cliDist.mts";
import { bundledBinaryResolver } from "@shared/packaging/bundledBinary.mts";
import { app } from "electron";
import { appPlace } from "./appPlace";

const cliBinaryPath = bundledBinaryResolver(appPlace, CLI_DIST_DIR, () =>
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
