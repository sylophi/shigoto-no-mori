import { deviceContract } from "@shared/ipc/modules/device";
import type { DeviceKind } from "@shared/account/deviceKind";
import type { Handlers } from "@shared/ipc/types";

// The account layer (main/ipc/modules/account.ts) owns the detection,
// the stored pick and the hub push, and main injects them at boot,
// following the setUpdaterImpl precedent.
type DeviceImpl = {
  detectedKind: () => Promise<DeviceKind>;
  setKind: (kind: DeviceKind) => Promise<DeviceKind>;
};

let impl: DeviceImpl | null = null;

export function setDeviceImpl(next: DeviceImpl): void {
  impl = next;
}

function deviceImpl(): DeviceImpl {
  if (impl === null) {
    throw new Error(
      "device handler invoked before setDeviceImpl registered one",
    );
  }
  return impl;
}

export const deviceHandlers: Handlers<typeof deviceContract> = {
  detectedKind: () => deviceImpl().detectedKind(),
  setKind: (kind) => deviceImpl().setKind(kind),
};
