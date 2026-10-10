import type {
  CliStatus,
  ShellIntegrationStatus,
} from "@shigomori/contracts/modules/cli";
import { cliContract } from "@shigomori/contracts/modules/cli";
import type { Handlers } from "@shigomori/contracts/types";
import { runDoctor } from "@host/lib/engineCalls";
import { loadProjects, refreshProjects } from "@host/lib/projects";
import { killScriptsForProject } from "@host/lib/scripts";
import { implSlot } from "@host/lib/util/implSlot";
import { fromPromise } from "@host/lib/util/fromPromise";
import type { HostServices } from "@host/process/services";
import * as Effect from "effect/Effect";

// The electron layer injects the CLI link and shell-integration
// operations at boot. Keeping them behind a setter keeps this handler
// module free of Electron imports while the implementations stay with
// the binary plumbing in main/electron.
type CliImpl = {
  cliLinkStatus: () => Promise<CliStatus>;
  installCliLinks: (force: boolean) => Promise<CliStatus>;
  uninstallCliEverything: () => Promise<void>;
  shellIntegrationStatus: () => Promise<ShellIntegrationStatus>;
  installShellIntegration: () => Promise<ShellIntegrationStatus>;
  uninstallShellIntegration: () => Promise<ShellIntegrationStatus>;
  // The login shell's ZDOTDIR / XDG_CONFIG_HOME.
  hookPathEnv: () => Promise<Record<string, string>>;
  // The app's version, which the doctor compares the bundle against.
  appVersion: () => string;
  // The bundled `sm`.
  binaryPath: () => string;
};

const { set: setCliImpl, get: cliImpl } = implSlot<CliImpl>(
  "cli handler invoked before setCliImpl registered one",
);
export { setCliImpl };

// What the doctor is told about this install: the app's version, the
// bundled `sm`, and the login shell's ZDOTDIR alone for the shell-hook
// check's .zshrc. XDG_CONFIG_HOME also places the data dir pointer, and
// the doctor must inspect the data dir the app runs on, not the one a
// shell would find.
async function doctorInput(): Promise<{
  version: string;
  executable: string;
  zdotdir?: string;
}> {
  const { ZDOTDIR } = await cliImpl().hookPathEnv();
  return {
    version: cliImpl().appVersion(),
    executable: cliImpl().binaryPath(),
    ...(ZDOTDIR === undefined ? {} : { zdotdir: ZDOTDIR }),
  };
}

export const cliHandlers = {
  status: () => cliImpl().cliLinkStatus(),
  install: ({ force }) => cliImpl().installCliLinks(force),
  // Only ever removes what shigomori made (links it owns, hooks it
  // wrote), so a foreign occupant survives this unchanged and the
  // returned status says so.
  uninstall: async () => {
    await cliImpl().uninstallCliEverything();
    return cliImpl().cliLinkStatus();
  },
  shellStatus: () => cliImpl().shellIntegrationStatus(),
  shellInstall: () => cliImpl().installShellIntegration(),
  shellUninstall: () => cliImpl().uninstallShellIntegration(),
  doctor: async () => runDoctor(false, await doctorInput()),
  // A repair can unregister a project whose directory is gone. The
  // sync readers (the git watcher, the fetch sweep) hold the snapshot,
  // and, as with projects.remove, scripts still running in a project
  // that left have no UI left to stop them. Re-read whatever the report
  // says: a repair that failed halfway can still have unregistered.
  doctorFix: () =>
    Effect.gen(function* () {
      const before = loadProjects();
      const report = yield* fromPromise(async () =>
        runDoctor(true, await doctorInput()),
      );
      const after = new Set(
        (yield* fromPromise(refreshProjects)).map((p) => p.id),
      );
      yield* Effect.forEach(
        before.filter(({ id }) => !after.has(id)),
        ({ id }) => killScriptsForProject(id),
        { concurrency: "unbounded", discard: true },
      );
      return report;
    }),
} satisfies Handlers<typeof cliContract, unknown, HostServices>;
