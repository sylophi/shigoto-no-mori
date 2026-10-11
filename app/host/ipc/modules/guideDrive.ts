import { guideDriveContract } from "@shigomori/contracts/modules/guide";
import type { EffectHandlers } from "@shared/ipc/registerContract";
import type { HandlerContext } from "@shared/ipc/transport";
import { onShell, shellCalls } from "@host/process/shell";

// The guide's actions, which the shell runs in the window a session
// guides: the host only passes them on.
export const guideDriveHandlers = {
  drive: (payload) => onShell(() => shellCalls().guide(payload)),
} satisfies EffectHandlers<typeof guideDriveContract, HandlerContext>;
