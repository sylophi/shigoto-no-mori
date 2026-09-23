import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";
import { DeviceKindSchema } from "@shared/account/deviceKind";

// What this machine looks like, as a HOST module, so the account's
// other devices can change its icon from their Devices page. The kind
// is still this machine's own answer: a peer's pick lands in this
// machine's account store exactly as a pick made here would (the
// account contract's setDeviceKind), and this machine pushes it to the
// device hub. The read is served to any account peer. The pick rides
// the per-peer command grant like every other mutation, so a machine
// that does not allow control keeps its icon to itself.
export const deviceContract = defineContract("host", {
  // What the machine detected about itself, the picker's "back to the
  // default" tile. The kind worn now is the registry's to say.
  detectedKind: invoke("device:detectedKind", z.void(), DeviceKindSchema, {
    remote: true,
    mutating: false,
  }),
  // Resolves to the kind the machine wears after the pick. Picking the
  // detected kind drops the pick (shared/account/enroll.ts). The kind
  // is not host state a viewer caches (the caller patches its device
  // list itself), so no cache ping.
  setKind: invoke("device:setKind", DeviceKindSchema, DeviceKindSchema, {
    remote: true,
    mutating: true,
    movesHostState: false,
  }),
});
