// The command line tool on PATH, through this OS's placement
// (placement.ts).
//
// Install and uninstall are user actions in Settings (the cli IPC
// module); the app never installs on its own. The only launch-time
// behavior is repairCliLinks: silently repointing a link the user
// already installed when its target moved, so an existing install
// keeps working across app updates and relocations.
import { byPlatform } from "@shigomori/engine/platform";
import { cliBinaryOf } from "./binary";
import { callFailureOf } from "@shigomori/contracts/errors";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { uninstallShellIntegration } from "./shell";
import * as HostFacts from "@host/lib/HostFacts";
import { links } from "./links";
import type { CliPlacement, Facts } from "./placement";

// Nothing puts the command on PATH on Windows yet, so it never has links
// to show, take off or repair.
const unplaced: CliPlacement = {
  ...links,
  install: async () => {
    throw new Error(
      "Installing the command line tool isn't available on Windows yet.",
    );
  },
};

const placement = () =>
  byPlatform({ darwin: links, linux: links, win32: unplaced });

// The links' state, and their install, for the handlers. A refusal
// crosses the wire in its own words.
export const cliLinkStatus = Effect.flatMap(HostFacts.HostFacts, (facts) =>
  Effect.tryPromise({
    try: () => placement().status(facts),
    catch: callFailureOf,
  }),
);
export const installCliLinks = (force: boolean) =>
  Effect.flatMap(HostFacts.HostFacts, (facts) =>
    Effect.tryPromise({
      try: () => placement().install(facts, force),
      catch: callFailureOf,
    }),
  );

// The whole teardown, shared by the Settings uninstall action and
// "Nuke everything": shell hooks first, while the binary is still
// reachable, then the links. A hook failure must not strand the links,
// so unlinking always runs. The failure then surfaces afterwards
// rather than being swallowed: a hook left behind is inert (its guard
// line no-ops once the command is gone), yet the user should hear it
// stayed.
export const uninstallCliEverything = Effect.gen(function* () {
  const facts = yield* HostFacts.HostFacts;
  // No binary means the hook-removal spawn can't run. The guarded hook
  // line is inert without the command anyway, so skipping is not a
  // failure worth reporting.
  const hooks =
    cliBinaryOf(facts) === null
      ? Exit.void
      : yield* Effect.exit(uninstallShellIntegration);
  yield* Effect.promise(() => placement().remove(facts));
  return yield* hooks;
});

export async function repairCliLinks(facts: Facts): Promise<void> {
  await placement().repair(facts);
}
