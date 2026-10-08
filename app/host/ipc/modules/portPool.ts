import { portPoolContract } from "@shigomori/contracts/modules/portPool";
import type { Handlers } from "@shigomori/contracts/types";
import { onPorts } from "@host/lib/ports";

export const portPoolHandlers: Handlers<typeof portPoolContract> = {
  isActive: (worktree) => onPorts((ports) => ports.portPoolActive(worktree)),
  isInstalled: () => onPorts((ports) => ports.portPoolInstalled),
};
