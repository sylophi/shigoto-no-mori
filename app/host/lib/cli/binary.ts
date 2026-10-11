// The bundled terminal binary: Resources/sm when packaged, dist-cli/smd
// in dev (built by `pnpm dev`). The app links it onto PATH
// (install.ts) and the doctor checks it.
import { existsSync } from "node:fs";
import * as Effect from "effect/Effect";
import { CLI_DIST_DIR, cliBinaryName } from "@shared/packaging/cliDist.mts";
import { bundledBinaryPath } from "@shared/packaging/bundledBinary.mts";
import * as HostFacts from "@host/lib/HostFacts";

// The binary, or null while it isn't there (a dev run before
// `pnpm cli:build --dev`), probed on every read so one built after
// launch is picked up.
export const cliBinaryOf = (
  facts: HostFacts.HostFacts["Service"],
): string | null => {
  const binary = bundledBinaryPath(
    facts,
    CLI_DIST_DIR,
    cliBinaryName(facts.flavor),
  );
  return existsSync(binary) ? binary : null;
};

// A missing binary is an actionable error.
export const requireCliBinary = Effect.flatMap(HostFacts.HostFacts, (facts) => {
  const binary = cliBinaryOf(facts);
  return binary === null
    ? Effect.die(
        new Error(
          "The sm binary is missing. Run `pnpm cli:build --dev` (dev) or reinstall the app.",
        ),
      )
    : Effect.succeed(binary);
});
