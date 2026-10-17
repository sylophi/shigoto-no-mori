import { cliContract } from "@shigomori/contracts/modules/cli";
import type { EffectHandlers } from "@shigomori/contracts/types";
import { requireCliBinary } from "@host/lib/cli/binary";
import {
  cliLinkStatus,
  installCliLinks,
  uninstallCliEverything,
} from "@host/lib/cli/install";
import {
  HookShell,
  installShellIntegration,
  shellIntegrationStatus,
  uninstallShellIntegration,
} from "@host/lib/cli/shell";
import * as Ops from "@host/lib/engineOps";
import * as Scripts from "@host/lib/Scripts";
import * as HostFacts from "@host/lib/HostFacts";
import type { HostServices } from "@host/process/services";
import * as Effect from "effect/Effect";

// What the doctor is told about this install: the app's version, the
// bundled `sm`, and the login shell's ZDOTDIR alone for the shell-hook
// check's .zshrc. XDG_CONFIG_HOME also places the data dir pointer, and
// the doctor must inspect the data dir the app runs on, not the one a
// shell would find.
const doctorInput = Effect.gen(function* () {
  const { zdotdir } = yield* (yield* HookShell).read;
  return {
    version: (yield* HostFacts.HostFacts).appVersion,
    executable: yield* requireCliBinary,
    ...(zdotdir === undefined ? {} : { zdotdir }),
  };
});

export const cliHandlers = {
  status: () => cliLinkStatus,
  install: ({ force }) => installCliLinks(force),
  // Only ever removes what shigomori made (links it owns, hooks it
  // wrote), so a foreign occupant survives this unchanged and the
  // returned status says so.
  uninstall: () => Effect.andThen(uninstallCliEverything, cliLinkStatus),
  shellStatus: () => shellIntegrationStatus,
  shellInstall: () => installShellIntegration,
  shellUninstall: () => uninstallShellIntegration,
  doctor: () =>
    Effect.flatMap(doctorInput, (input) => Ops.runDoctor(false, input)),
  // A repair can unregister a project whose directory is gone, which
  // takes its scripts and terminals, whatever the report says: a repair
  // that failed halfway can still have unregistered.
  doctorFix: () =>
    Effect.flatMap(doctorInput, (input) => Ops.runDoctor(true, input)).pipe(
      Effect.ensuring(
        Effect.flatMap(
          Scripts.Scripts,
          (scripts) => scripts.reapRemovedProjects,
        ),
      ),
    ),
} satisfies EffectHandlers<typeof cliContract, unknown, HostServices>;
