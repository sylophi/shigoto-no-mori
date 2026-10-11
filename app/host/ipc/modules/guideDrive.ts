import { guideDriveContract } from "@shigomori/contracts/modules/guide";
import type { EffectHandlers } from "@shared/ipc/registerContract";
import type { HandlerContext } from "@shared/ipc/transport";
import * as Effect from "effect/Effect";
import * as Shell from "@host/lib/Shell";
import type { HostServices } from "@host/process/services";

// The guide's actions, which the shell runs in the window a session
// guides: the host only passes them on.
export const guideDriveHandlers = {
  drive: (payload) =>
    Effect.flatMap(Shell.Shell, (shell) => shell.guide(payload)),
} satisfies EffectHandlers<
  typeof guideDriveContract,
  HandlerContext,
  HostServices
>;
