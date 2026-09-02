// The local port a peer's port lands on when forwarded, remembered per
// (device, remote port) in this app instance's client config (see the
// forwardLocalPorts note in shared/schemas/config.ts). Client-scoped on
// purpose: which local ports are free is a fact about THIS machine, not
// about the worktree being viewed. Absent means the default, the remote
// port number itself, so a preference equal to it is stored as nothing.
import type { ClientConfig } from "@shared/schemas";
import { useClientConfig } from "@/hooks/config/useClientConfig";
import { useClientConfigPatch } from "./useClientConfigPatch";

function withPreference(
  current: ClientConfig | undefined,
  key: string,
  localPort: number | undefined,
): Pick<ClientConfig, "forwardLocalPorts"> {
  const next = { ...current?.forwardLocalPorts };
  if (localPort === undefined) delete next[key];
  else next[key] = localPort;
  return { forwardLocalPorts: Object.keys(next).length > 0 ? next : undefined };
}

export function useForwardLocalPort(deviceId: string, remotePort: number) {
  const key = `${deviceId}:${remotePort}`;
  const { data } = useClientConfig();
  const preferred = data?.forwardLocalPorts?.[key];
  const patch = useClientConfigPatch(
    (next: number | undefined, current) => withPreference(current, key, next),
    "Couldn't remember the local port",
  );
  return {
    // The stored override, or the default when none is stored.
    localPort: preferred ?? remotePort,
    setLocalPort: (next: number) =>
      patch.mutate(next === remotePort ? undefined : next),
  };
}
