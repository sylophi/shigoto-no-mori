import type {
  CliStatus,
  ShellIntegrationStatus,
} from "@shared/ipc/modules/cli";
import { cliContract } from "@shared/ipc/modules/cli";
import type { Handlers } from "@shared/ipc/types";

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
};

let impl: CliImpl | null = null;

export function setCliImpl(next: CliImpl): void {
  impl = next;
}

function cliImpl(): CliImpl {
  if (impl === null) {
    throw new Error("cli handler invoked before setCliImpl registered one");
  }
  return impl;
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
};
