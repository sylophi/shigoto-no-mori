import { useHostScope, type HostScope } from "@/hooks/remote/useHostScope";
import { useRemoteDeviceApi } from "@/hooks/remote/useRemoteDevices";
import { localDeviceId } from "@/lib/queryKeys";

// The device a read goes to, and its api, undefined for a peer with no
// session. With no deviceId it rides the surrounding host scope (a
// device-scoped page, or the local default). With one it names another
// machine, and the api comes from the remote device store through a
// selector, so the surfaces that mention a project from another device
// outside its scope (the merged sidebar's remote headers, the device
// chips on /account, the home grid's tiles) neither mount a
// HostScopeProvider for a single read nor re-render on every roster
// transition.
export function useDeviceApi(deviceId?: string): {
  deviceId: string;
  api: HostScope["api"] | undefined;
} {
  const scope = useHostScope();
  const targetId = deviceId ?? scope.deviceId;
  // The store never lists this machine, so naming it explicitly from
  // inside a peer's scope must resolve to window.api, not to nothing.
  const known = targetId === scope.deviceId || targetId === localDeviceId;
  const peerApi = useRemoteDeviceApi(known ? undefined : targetId);
  const api =
    targetId === scope.deviceId
      ? scope.api
      : targetId === localDeviceId
        ? window.api
        : peerApi;
  return { deviceId: targetId, api };
}
