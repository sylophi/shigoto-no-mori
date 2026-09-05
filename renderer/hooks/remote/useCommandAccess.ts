import { queryOptions, useQueries, useQuery } from "@tanstack/react-query";
import { localDeviceId, queryKeysFor } from "@/lib/queryKeys";
import { useHostScope, type HostApi } from "@/hooks/remote/useHostScope";

export interface CommandAccess {
  granted: boolean;
  isLoading: boolean;
  // The preflight itself failed (no session to ask over, a transport
  // error), so `granted: false` is the fail-closed default, not the
  // peer's answer. A surface that would tell the user to flip the
  // peer's switch checks this first.
  isError: boolean;
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
    // A permission verdict only moves when the host grants or revokes,
    // which it pushes (remoteAccess:commandAccessChanged, handled in
    // remoteHostWatch), so the honest refreshes are that push, the
    // session-landed sweep (invalidateDeviceSession) and a window
    // focus -- not a hub round-trip per mount, which is what the
    // client's staleTime 0 would buy.
    staleTime: 30_000,
    meta: { silentError: true },
  });
}

// The local device is always granted by contract, so it never asks.
function verdictOf(
  deviceId: string,
  query:
    | { data?: { granted: boolean }; isPending: boolean; isError: boolean }
    | undefined,
): CommandAccess {
  if (deviceId === localDeviceId) {
    return { granted: true, isLoading: false, isError: false };
  }
  if (query === undefined) {
    return { granted: false, isLoading: true, isError: false };
  }
  return {
    granted: query.data?.granted ?? false,
    isLoading: query.isPending,
    isError: query.isError,
  };
}

// Does the CALLING device hold command access on the scoped host? Drives
// whether a scoped page renders mutation controls. The
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

// The verdict for one device out of a usePeerCommandAccess result: the
// local device is granted by contract, and a device the list was not
// asked about (a peer the hub has not rostered) is still loading, the
// same fail-closed reading verdictOf gives a query that has not run.
export function commandAccessOf(
  access: ReadonlyMap<string, CommandAccess>,
  deviceId: string,
): CommandAccess {
  return access.get(deviceId) ?? verdictOf(deviceId, undefined);
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
