import type {
  CliStatus,
  ShellIntegrationStatus,
} from "@shared/ipc/modules/cli";
import { cliContract } from "@shared/ipc/modules/cli";
import type { Handlers } from "@shared/ipc/types";
import { doctorViaCli } from "@host/ipc/cliDelegate";
import { loadProjects, refreshProjects } from "@host/lib/projects";
import { killScriptsForProject } from "@host/lib/scripts";
import { implSlot } from "@host/lib/util/implSlot";

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
};

const { set: setCliImpl, get: cliImpl } = implSlot<CliImpl>(
  "cli handler invoked before setCliImpl registered one",
);
export { setCliImpl };

// ZDOTDIR alone, for the shell-hook check's .zshrc. XDG_CONFIG_HOME
// also places the CLI's data dir pointer, and the doctor must inspect
// the data dir the app runs on, not the one a shell would find.
async function doctorEnv(): Promise<Record<string, string>> {
  const { ZDOTDIR } = await cliImpl().hookPathEnv();
  return ZDOTDIR === undefined ? {} : { ZDOTDIR };
}

export const cliHandlers: Handlers<typeof cliContract> = {
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
  doctor: async () => doctorViaCli(false, await doctorEnv()),
  // A repair can unregister a project whose directory is gone. The
  // sync readers (the git watcher, the fetch sweep) hold the snapshot,
  // and, as with projects.remove, scripts still running in a project
  // that left have no UI left to stop them. Re-read whatever the report
  // says: a repair that failed halfway can still have unregistered.
  doctorFix: async () => {
    const before = loadProjects();
    const report = await doctorViaCli(true, await doctorEnv());
    const after = new Set((await refreshProjects()).map((p) => p.id));
    await Promise.all(
      before
        .filter(({ id }) => !after.has(id))
        .map(({ id }) => killScriptsForProject(id)),
    );
    return report;
  },
};
