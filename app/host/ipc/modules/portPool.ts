import { portPoolContract } from "@shigomori/contracts/modules/portPool";
import type { Handlers } from "@shigomori/contracts/types";
import * as Effect from "effect/Effect";
import * as Ports from "@host/lib/ports";

export const portPoolHandlers: Handlers<
  typeof portPoolContract,
  unknown,
  Ports.Ports
> = {
  isActive: (worktree) =>
    Effect.flatMap(Ports.Ports, (ports) => ports.portPoolActive(worktree)),
  isInstalled: () =>
    Effect.flatMap(Ports.Ports, (ports) => ports.portPoolInstalled),
};
