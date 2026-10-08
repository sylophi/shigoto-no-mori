import { portsContract } from "@shigomori/contracts/modules/ports";
import type { Handlers } from "@shigomori/contracts/types";
import { onPorts } from "@host/lib/ports";

export const portsHandlers: Handlers<typeof portsContract> = {
  list: async (worktree) => ({
    ports: await onPorts((ports) => ports.list(worktree)),
  }),
};
