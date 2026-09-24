import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";
import { DeviceIconSchema } from "@shared/account/deviceIcon";

// What this machine looks like, as a HOST module, so the account's
// other devices can change its icon from their Devices page. The icon
// is still this machine's own answer: a peer's pick lands in this
// machine's account store exactly as a pick made here would (the
// account contract's setDeviceIcon), and this machine pushes it to the
// device hub. The read is served to any account peer. The pick rides
// the per-peer command grant like every other mutation, so a machine
// that does not allow control keeps its icon to itself.
export const deviceContract = defineContract("host", {
  // What the machine detected about itself, the picker's "back to the
  // default" tile. The icon worn now is the registry's to say.
  detectedIcon: invoke("device:detectedIcon", z.void(), DeviceIconSchema, {
    remote: true,
    mutating: false,
  }),
  // Resolves to the icon the machine wears after the pick. Picking the
  // detected icon drops the pick (shared/account/enroll.ts). The icon
  // is not host state a viewer caches (the caller patches its device
  // list itself), so no cache ping.
  setIcon: invoke("device:setIcon", DeviceIconSchema, DeviceIconSchema, {
    remote: true,
    mutating: true,
    movesHostState: false,
  }),
});
