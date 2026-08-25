import { remoteAccessContract } from "@shared/ipc/modules/remoteAccess";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shared/ipc/types";

export const remoteAccessHandlers: Handlers<
  typeof remoteAccessContract,
  HandlerContext
> = {
  // The per-caller verdict comes from the transport binding (see
  // HandlerContext.isCallerCommandGranted), never from a grant store
  // read here, so this handler stays wire-agnostic and can never leak
  // more than one boolean about the one calling peer. Fail-closed: a
  // transport that supplies no verdict reads as not granted.
  commandAccess: (_input, ctx) => ({
    granted: ctx.isCallerCommandGranted?.() ?? false,
  }),
};
