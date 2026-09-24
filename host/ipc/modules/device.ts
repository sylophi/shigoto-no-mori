import { deviceContract } from "@shared/ipc/modules/device";
import type { DeviceIcon } from "@shared/account/deviceIcon";
import type { Handlers } from "@shared/ipc/types";

// The account layer (main/ipc/modules/account.ts) owns the detection,
// the stored pick and the hub push, and main injects them at boot,
// following the setUpdaterImpl precedent.
type DeviceImpl = {
  detectedIcon: () => Promise<DeviceIcon>;
  setIcon: (icon: DeviceIcon) => Promise<DeviceIcon>;
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
  detectedIcon: () => deviceImpl().detectedIcon(),
  setIcon: (icon) => deviceImpl().setIcon(icon),
};
