// Which device a project header's `+` creates on when the project spans
// several machines. A client preference by repo identity (the merged
// header IS the identity group), kept in clientConfig like the forward
// local-port picks. Undefined means no pick: the header falls back to
// its first live device, this machine first.
import { useClientConfig } from "./useClientConfig";
import { useClientConfigPatch } from "./useClientConfigPatch";

// The read alone, for every header: one observer on the client config
// doc, no mutation.
export function useQuickCreateDeviceId(
  identity: string | null | undefined,
): string | undefined {
  const { data: config } = useClientConfig();
  return identity == null ? undefined : config?.quickCreateDevices?.[identity];
}

// The writer, for the surfaces that offer the pick (a menu that is
// mostly closed, the Configure page). A no-op for an identity-less
// project: there is only ever one checkout of it to create in.
export function useSetQuickCreateDevice(identity: string | null | undefined) {
  const patch = useClientConfigPatch<string>(
    (deviceId, current) => ({
      quickCreateDevices: {
        ...current?.quickCreateDevices,
        ...(identity == null ? {} : { [identity]: deviceId }),
      },
    }),
    "Couldn't save the create device",
  );
  return (deviceId: string) => {
    if (identity != null) patch.mutate(deviceId);
  };
}
