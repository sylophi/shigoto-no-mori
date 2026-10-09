import { portsContract } from "@shigomori/contracts/modules/ports";
import type { Handlers, ViewHandlers } from "@shigomori/contracts/types";
import * as Views from "@host/lib/views";
import { scriptsContract } from "@shigomori/contracts/modules/scripts";
import { onPorts } from "@host/lib/ports";

const listPorts = async (worktree: {
  readonly projectId: string;
  readonly worktreeId: string;
}) => ({ ports: await onPorts((ports) => ports.list(worktree)) });

export const portsHandlers: Handlers<typeof portsContract> = {
  list: listPorts,
};

export const portsViews: ViewHandlers<typeof portsContract, Views.Services> = {
  // A server coming up on a port says nothing to the host, so the
  // probes run again every few seconds.
  watch: (worktree) =>
    Views.view(
      () => listPorts(worktree),
      Views.either(
        Views.wrote("worktree_data"),
        Views.pushed(scriptsContract, "changed"),
      ),
      { every: "5 seconds" },
    ),
};
