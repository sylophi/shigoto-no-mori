// A peer's icon, changed from this device's Devices page. The pick is
// the peer's own (it lands in its account store and it pushes it to the
// device hub), so it rides the peer's command grant like any other
// mutation. See shared/ipc/modules/device.ts.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DeviceIcon } from "@shared/account/deviceIcon";
import { accountDevicesQueryOptions } from "@/hooks/account/useAccount";
import type { HostApi } from "@/hooks/remote/useHostScope";
import { queryKeysFor } from "@/lib/queryKeys";

// What the peer detected about itself, for the picker's "back to the
// default" tile. The answer doubles as the proof the peer's build can
// take a pick at all: an older one has no such call, and its row keeps
// the plain mark rather than offer a picker whose every pick fails.
// Asked once per session (the peer detects once per process) and never
// retried, since an unknown call stays unknown.
export function usePeerDetectedIcon(
  deviceId: string,
  api: HostApi | undefined,
  enabled: boolean,
): DeviceIcon | undefined {
  return useQuery<DeviceIcon>({
    queryKey: queryKeysFor(deviceId).detectedDeviceIcon(),
    queryFn: () => {
      if (api === undefined) throw new Error("no session to the device");
      return api.device.detectedIcon();
    },
    enabled: enabled && api !== undefined,
    staleTime: Infinity,
    retry: false,
    meta: { silentError: true },
  }).data;
}

// The pick itself. The peer tells its own windows, but nothing tells
// this one (the hub pushes no registry change), so the answer is
// written into the shared device list, the one copy every surface here
// draws peers from, rather than refetched: the peer's hub push is
// best-effort and may not have landed yet.
export function useSetPeerDeviceIcon(
  deviceId: string,
  api: HostApi,
  name: string,
) {
  const queryClient = useQueryClient();
  return useMutation<DeviceIcon, Error, DeviceIcon>({
    mutationFn: (icon) => api.device.setIcon(icon),
    onSuccess: (icon) => {
      queryClient.setQueryData(accountDevicesQueryOptions.queryKey, (devices) =>
        devices?.map((device) =>
          device.deviceId === deviceId ? { ...device, icon } : device,
        ),
      );
    },
    meta: { errorTitle: `Couldn't change ${name}'s icon` },
  });
}
