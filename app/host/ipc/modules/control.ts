// The CLI's cross-device verbs on the control wire (host/lib/control/ops.ts).
import type { controlContract } from "@shigomori/contracts/modules/control";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shigomori/contracts/types";
import {
  bring,
  devices,
  mirrors,
  mirrorStop,
  peerWorktrees,
  send,
} from "@host/lib/control/ops";

export const controlHandlers: Handlers<typeof controlContract, HandlerContext> =
  { devices, peerWorktrees, send, bring, mirrors, mirrorStop };
