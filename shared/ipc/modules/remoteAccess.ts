import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";

// The remote execution surface's preflight (v2 step 6, slice B): "does
// the CALLING peer hold command access on this host?", answered per
// caller so a client can decide whether to render mutation UI before
// firing a command that would be refused. remote:true, mutating:false,
// so every wire serves it ungated. The verdict comes from the transport
// binding via HandlerContext.isCallerCommandGranted:
//   - Electron (local window): always granted.
//   - LAN socket: never granted, that wire is read-only by policy.
//   - Direct data plane: the host's live command-access switch (does
//     it accept commands from the account's other devices at all).
// The answer is a single boolean about the caller alone. The switch
// itself is read only on its own machine (client-scoped in
// account.acceptsCommands). Fail-closed: a transport supplying no
// verdict reads as not granted.
export const remoteAccessContract = defineContract("host", {
  commandAccess: invoke(
    "remoteAccess:commandAccess",
    z.void(),
    z.object({ granted: z.boolean() }),
    { remote: true, mutating: false },
  ),
});
