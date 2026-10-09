// The bundled terminal binary: Resources/sm when packaged, dist-cli/smd
// in dev (built by `pnpm dev`). The app links it onto PATH
// (install.ts) and the doctor checks it.
import { CLI_DIST_DIR, cliBinaryName } from "@shared/packaging/cliDist.mts";
import { flavorOf, hostBinaryResolver, hostFacts } from "@host/process/facts";

export const cliBinaryPath = hostBinaryResolver(CLI_DIST_DIR, () =>
  cliBinaryName(flavorOf(hostFacts())),
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
