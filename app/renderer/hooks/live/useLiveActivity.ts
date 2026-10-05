// What is running across the account right now, for the Live page
// (components/live/LivePage.tsx) and the sidebar's Live mark: the
// scripts each host runs, the forwards this machine holds, and the
// mirrors every host runs. Each part is read the way its own surfaces
// read it and kept live by its own broadcast (scripts:changed through
// lib/hostWatch.ts, portForward:changed, mirror:changed), so nothing
// here polls.
import { queryOptions, skipToken, useQueries } from "@tanstack/react-query";
import type {
  MirrorDaemonStatus,
  MirrorListResult,
  MirrorServing,
  MirrorSession,
} from "@shared/ipc/modules/mirror";
import type { RunningScript } from "@shared/schemas";
import type { HostApi } from "@/hooks/remote/useHostScope";
import { useEveryHostMirrors } from "@/hooks/remote/useMirrors";
import { usePortForwardCount } from "@/hooks/remote/usePortForwards";
import { useHostDevices } from "@/hooks/remote/useRemoteDevices";
import { hasLocalHost } from "@/lib/localHost";
import { localDeviceId, queryKeysFor } from "@/lib/queryKeys";

// A device that can run things: this machine when it hosts projects,
// and every peer that does. The api is undefined while a peer has no
// session.
export type LiveHost = { deviceId: string; api: HostApi | undefined };

function useLiveHosts(): LiveHost[] {
  const devices = useHostDevices();
  return [
    ...(hasLocalHost ? [{ deviceId: localDeviceId, api: window.api }] : []),
    ...devices.map((device) => ({
      deviceId: device.deviceId,
      api: device.api,
    })),
  ];
}

export type HostScripts = LiveHost & { runs: RunningScript[] };

// One device's running scripts, the read every surface that lists or
// adopts them shares (the Live page, a worktree's script buttons and
// console), refreshed by the device's scripts:changed.
export function runningScriptsQueryOptions(
  deviceId: string,
  api: HostApi | undefined,
) {
  return queryOptions({
    queryKey: queryKeysFor(deviceId).runningScripts(),
    queryFn:
      api === undefined
        ? skipToken
        : async () => (await api.scripts.list()).runs,
    meta: { silentError: true },
  });
}

// Every host's running scripts. A peer out of reach lists none: its
// last list could name a dev server that has since stopped, and
// nothing here could stop it anyway. A peer whose app predates the
// list refuses the read, and lists none too.
export function useRunningScripts(): HostScripts[] {
  const hosts = useLiveHosts();
  return useQueries({
    queries: hosts.map(({ deviceId, api }) =>
      runningScriptsQueryOptions(deviceId, api),
    ),
    combine: (results) =>
      hosts.map(({ deviceId, api }, index) => ({
        deviceId,
        api,
        runs: api === undefined ? NO_RUNS : (results[index]?.data ?? NO_RUNS),
      })),
  });
}

const NO_RUNS: RunningScript[] = [];

// One mirror as the Live page lists it. A session comes off the list
// of the device running it (the one holding the original). A stream
// another device serves stands in for a session whose runner's list is
// not in hand (that device asleep, or an app that predates it).
export type LiveMirror =
  | {
      kind: "session";
      runnerDeviceId: string;
      runnerApi: HostApi | undefined;
      engine: MirrorDaemonStatus;
      session: MirrorSession;
    }
  | { kind: "served"; copyDeviceId: string; stream: MirrorServing };

export function liveMirrorsOf(
  lists: readonly {
    deviceId: string;
    api: HostApi | undefined;
    data: MirrorListResult | undefined;
  }[],
): LiveMirror[] {
  const mirrors: LiveMirror[] = [];
  for (const { deviceId, api, data } of lists) {
    for (const session of data?.sessions ?? []) {
      mirrors.push({
        kind: "session",
        runnerDeviceId: deviceId,
        runnerApi: api,
        engine: data?.daemon ?? "running",
        session,
      });
    }
  }
  for (const { deviceId, data } of lists) {
    for (const stream of data?.serving ?? []) {
      const listed = mirrors.some(
        (mirror) =>
          mirror.kind === "session" &&
          mirror.runnerDeviceId === stream.peerDeviceId &&
          mirror.session.deviceId === deviceId &&
          mirror.session.worktreeId === stream.worktreeId,
      );
      if (!listed) {
        mirrors.push({ kind: "served", copyDeviceId: deviceId, stream });
      }
    }
  }
  return mirrors;
}

export function useLiveMirrors(): LiveMirror[] {
  return liveMirrorsOf(useEveryHostMirrors());
}

// How many things are live, for the sidebar's mark.
export function useLiveCount(): number {
  const scripts = useRunningScripts().reduce(
    (sum, host) => sum + host.runs.length,
    0,
  );
  return scripts + usePortForwardCount() + useLiveMirrors().length;
}
