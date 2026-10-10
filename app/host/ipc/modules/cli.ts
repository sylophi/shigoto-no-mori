import { cliContract } from "@shigomori/contracts/modules/cli";
import type { EffectHandlers } from "@shared/ipc/registerContract";
import { requireCliBinary } from "@host/lib/cli/binary";
import {
  cliLinkStatus,
  installCliLinks,
  uninstallCliEverything,
} from "@host/lib/cli/install";
import {
  hookPathEnv,
  installShellIntegration,
  shellIntegrationStatus,
  uninstallShellIntegration,
} from "@host/lib/cli/shell";
import * as Ops from "@host/lib/engineOps";
import { loadProjects, refresh } from "@host/lib/projects";
import { killScriptsForProject } from "@host/lib/scripts";
import { hostFacts } from "@host/process/facts";
import type { HostServices } from "@host/process/services";
import * as Effect from "effect/Effect";

// What the doctor is told about this install: the app's version, the
// bundled `sm`, and the login shell's ZDOTDIR alone for the shell-hook
// check's .zshrc. XDG_CONFIG_HOME also places the data dir pointer, and
// the doctor must inspect the data dir the app runs on, not the one a
// shell would find.
const doctorInput = Effect.map(Effect.promise(hookPathEnv), ({ ZDOTDIR }) => ({
  version: hostFacts().appVersion,
  executable: requireCliBinary(),
  ...(ZDOTDIR === undefined ? {} : { zdotdir: ZDOTDIR }),
}));

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
  // A repair can unregister a project whose directory is gone. The
  // sync readers (the git watcher, the fetch sweep) hold the snapshot,
  // and, as with projects.remove, scripts still running in a project
  // that left have no UI left to stop them. Re-read whatever the report
  // says: a repair that failed halfway can still have unregistered.
  doctorFix: () =>
    Effect.gen(function* () {
      const before = loadProjects();
      const report = yield* Effect.flatMap(doctorInput, (input) =>
        Ops.runDoctor(true, input),
      );
      const after = new Set((yield* refresh).map((p) => p.id));
      yield* Effect.forEach(
        before.filter(({ id }) => !after.has(id)),
        ({ id }) => killScriptsForProject(id),
        { concurrency: "unbounded", discard: true },
      );
      return report;
    }),
} satisfies EffectHandlers<typeof cliContract, unknown, HostServices>;
