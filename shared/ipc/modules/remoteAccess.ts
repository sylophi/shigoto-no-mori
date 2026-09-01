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
//   - Hub: the host's live per-peer grant for the caller's deviceId.
// The answer is a single boolean about the caller alone; the full grant
// list never rides a remote wire (it stays client-scoped in
// account.listGrantedDevices). Fail-closed: a transport supplying no
// verdict reads as not granted.
export const remoteAccessContract = defineContract("host", {
  commandAccess: invoke(
    "remoteAccess:commandAccess",
    z.void(),
    z.object({ granted: z.boolean() }),
    { remote: true, mutating: false },
  ),
});
