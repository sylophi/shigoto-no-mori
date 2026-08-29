import { queryOptions, useQueries, useQuery } from "@tanstack/react-query";
import { localDeviceId, queryKeysFor } from "@/lib/queryKeys";
import { useHostScope, type HostApi } from "@/hooks/remote/useHostScope";

export interface CommandAccess {
  granted: boolean;
  isLoading: boolean;
}

// The per-caller preflight, as options so the scoped hook below and the
// picker's fan-out ask the same question under the same key. The api is
// optional because a device with no session has none: the query is
// disabled there, and the arm keeps that expressible without an
// assertion (same shape as projectsQueryOptions).
function commandAccessQueryOptions(deviceId: string, api: HostApi | undefined) {
  return queryOptions<{ granted: boolean }>({
    queryKey: queryKeysFor(deviceId).commandAccess(),
    queryFn: () =>
      api ? api.remoteAccess.commandAccess() : { granted: false },
    enabled: api !== undefined && deviceId !== localDeviceId,
    meta: { silentError: true },
  });
}

// The local device is always granted by contract, so it never asks.
function verdictOf(
  deviceId: string,
  query: { data?: { granted: boolean }; isPending: boolean } | undefined,
): CommandAccess {
  if (deviceId === localDeviceId) return { granted: true, isLoading: false };
  if (query === undefined) return { granted: false, isLoading: true };
  return { granted: query.data?.granted ?? false, isLoading: query.isPending };
}

// Does the CALLING device hold command access on the scoped host? Drives
// whether the remote forest renders mutation controls (v2 step 6). The
// local device is always granted by contract, so it short-circuits with
// no IPC. A remote device answers via the per-caller remoteAccess
// preflight, cached under its own host key. A refused verdict is a
// normal read-only state, not an error to toast — the UI reads `granted`
// and renders a read-only note instead.
export function useCommandAccess(): CommandAccess {
  const { deviceId, api } = useHostScope();
  return verdictOf(
    deviceId,
    useQuery(commandAccessQueryOptions(deviceId, api)),
  );
}

// The same verdict for a LIST of peers at once, for a chooser that has to
// grey out the machines that would refuse before anything is scoped to
// them (the new-worktree device picker). One query per device under that
// device's own key, so a card and a later HostScopeProvider over the same
// machine share the cache rather than re-asking.
export function usePeerCommandAccess(
  peers: readonly { deviceId: string; api?: HostApi }[],
): ReadonlyMap<string, CommandAccess> {
  return useQueries({
    queries: peers.map((peer) =>
      commandAccessQueryOptions(peer.deviceId, peer.api),
    ),
    combine: (results) =>
      new Map(
        peers.map((peer, index) => [
          peer.deviceId,
          verdictOf(peer.deviceId, results[index]),
        ]),
      ),
  });
}
