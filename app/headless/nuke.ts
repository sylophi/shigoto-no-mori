// "Nuke everything" for `<binary> nuke` on a machine with no windows
// (the CLI starts the host with --sm-nuke, its unit taken out first):
// the host's half (host/lib/nuke.ts), then a marker naming the files,
// which the next start deletes before anything opens them
// (shared/nuke.ts), and an exit that tells the command which start
// this was.
import { errorMessageOf } from "@shigomori/contracts/errors";
import { NUKE_EXIT, NUKE_SWITCH } from "@shigomori/engine/footprint";
import { nukeHost } from "@host/ipc/modules/runtime";
import * as Graph from "@host/process/graph";
import { quit } from "@host/process/run";
import type { HostFacts } from "@shared/hostFacts";
import { log } from "@shared/log";
import { nukedPaths, writeNukeMarker } from "@shared/nuke";

export const nuking = process.argv.includes(`--${NUKE_SWITCH}`);

// The start that found the marker, which deleted what it could: the
// install with userData among it, so this process ends here.
export function finishNuke(
  files: readonly { readonly path: string; readonly why: string }[],
): never {
  for (const { path, why } of files)
    console.log(`[nuke] left: ${path}: ${why}`);
  process.exit(files.length > 0 ? NUKE_EXIT.marked : NUKE_EXIT.finished);
}

// The live half, once the host is up: this device off the account
// first, as the desktop's (main/electron/nuke.ts).
export async function runNuke(
  facts: HostFacts,
  signOut: () => Promise<string | null>,
): Promise<void> {
  try {
    const failure = await signOut().catch(errorMessageOf);
    const host = await Graph.run(nukeHost);
    writeNukeMarker(facts.userDataPath, nukedPaths(facts.logsPath));
    const left =
      failure === null
        ? host.left
        : [
            {
              what: "This device on your account",
              why: `${failure} Remove it from another device's account page.`,
            },
            ...host.left,
          ];
    for (const { what, why } of left)
      console.log(`[nuke] left: ${what}: ${why}`);
    quit(false, left.length === 0 ? NUKE_EXIT.again : NUKE_EXIT.againWithLeft);
  } catch (error) {
    log.error("[nuke] could not nuke:", error);
    quit(false, 1);
  }
}
