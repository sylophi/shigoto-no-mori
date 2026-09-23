import { Context, Effect } from "effect";
import type {
  CliStatus,
  ShellIntegrationStatus,
} from "@shared/ipc/modules/cli";
import { cliContract } from "@shared/ipc/modules/cli";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shared/ipc/types";
import { hostAttempt, hostHandler, requireService } from "@host/runtime";

// The electron layer provides the CLI link and shell-integration
// operations. Keeping them behind a service keeps this handler module
// free of Electron imports while the implementations stay with the
// binary plumbing in main/electron.
type CliImpl = {
  cliLinkStatus: () => Promise<CliStatus>;
  installCliLinks: (force: boolean) => Promise<CliStatus>;
  uninstallCliEverything: () => Promise<void>;
  shellIntegrationStatus: () => Promise<ShellIntegrationStatus>;
  installShellIntegration: () => Promise<ShellIntegrationStatus>;
  uninstallShellIntegration: () => Promise<ShellIntegrationStatus>;
};

export class CliTools extends Context.Service<CliTools, CliImpl>()(
  "sm/host/CliTools",
) {}

const cliTools = requireService(
  CliTools,
  "cli handler invoked before the host runtime provided CliTools",
);

// One CliTools call as the handler's whole body.
const withTools = <A>(run: (tools: CliImpl) => Promise<A>) =>
  hostHandler<unknown, A, HandlerContext>(() =>
    Effect.flatMap(cliTools, (tools) => hostAttempt(() => run(tools))),
  );

export const cliHandlers: Handlers<typeof cliContract, HandlerContext> = {
  status: withTools((tools) => tools.cliLinkStatus()),
  install: hostHandler(({ force }: { force: boolean }) =>
    Effect.gen(function* () {
      const tools = yield* cliTools;
      return yield* hostAttempt(() => tools.installCliLinks(force));
    }),
  ),
  // Only ever removes what shigomori made (links it owns, hooks it
  // wrote), so a foreign occupant survives this unchanged and the
  // returned status says so. One step, so a caller that leaves
  // mid-uninstall stops waiting, not the uninstall.
  uninstall: withTools(async (tools) => {
    await tools.uninstallCliEverything();
    return tools.cliLinkStatus();
  }),
  shellStatus: withTools((tools) => tools.shellIntegrationStatus()),
  shellInstall: withTools((tools) => tools.installShellIntegration()),
  shellUninstall: withTools((tools) => tools.uninstallShellIntegration()),
};
