import { useHostScope, type HostScope } from "@/hooks/remote/useHostScope";
import { useLiveApi } from "@/hooks/remote/useDevices";

// The device a read goes to, and its api, undefined for a peer that
// can't be asked. With no deviceId it rides the surrounding host scope
// (a device-scoped page, or the local default). With one it names a
// machine, whose api is there only while it can be asked, read through
// a selector, so the surfaces that
// mention a project from another device outside its scope (the merged
// sidebar's remote headers, the device chips on /account, the home
// grid's tiles) neither mount a DeviceScope for a single read
// nor re-render on every roster transition.
export function useDeviceApi(deviceId?: string): {
  deviceId: string;
  api: HostScope["api"] | undefined;
} {
  const scope = useHostScope();
  const api = useLiveApi(deviceId);
  return deviceId === undefined ? scope : { deviceId, api };
}
