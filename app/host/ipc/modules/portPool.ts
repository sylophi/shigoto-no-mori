import { portPoolContract } from "@shigomori/contracts/modules/portPool";
import type { EffectHandlers } from "@shared/ipc/registerContract";
import * as Effect from "effect/Effect";
import * as Ports from "@host/lib/ports";

export const portPoolHandlers = {
  isActive: (worktree) =>
    Effect.flatMap(Ports.Ports, (ports) => ports.portPoolActive(worktree)),
  isInstalled: () =>
    Effect.flatMap(Ports.Ports, (ports) => ports.portPoolInstalled),
} satisfies EffectHandlers<typeof portPoolContract, unknown, Ports.Ports>;
