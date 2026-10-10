// What is running across the account right now, for the Live page
// (components/live/LivePage.tsx) and the sidebar's Live mark: the
// scripts each host runs, the forwards this machine holds, the
// mirrors every host runs. (The agents waiting on you come off the
// worktree lists, lib/agentWatch.ts.) Each part is read the way its own
// surfaces read it: the scripts and the mirrors as their hosts' views
// (scripts:watch, mirror:watch), the forwards off portForward:changed,
// so nothing here polls.
import { callOf } from "@shigomori/contracts/contract";
import { scriptsContract } from "@shigomori/contracts/modules/scripts";
import * as Atom from "effect/reactivity/Atom";
import type {
  MirrorDaemonStatus,
  MirrorListResult,
  MirrorServing,
  MirrorSession,
} from "@shigomori/contracts/modules/mirror";
import type { RunningScript } from "@shigomori/contracts/schemas";
import type { HostApi } from "@/hooks/remote/useHostScope";
import { useEveryHostMirrors } from "@/hooks/remote/useMirrors";
import { usePortForwardCount } from "@/hooks/remote/usePortForwards";
import { useEveryHost } from "@/hooks/remote/useRemoteDevices";
import { hostViewAtom } from "@/lib/runtime/atoms";
import { useView, useViews, viewsOf } from "@/lib/runtime/viewHooks";
import { localDeviceId } from "@/lib/queryKeys";

// A host's running scripts. The api is undefined while a peer has no
// session.
export type HostScripts = {
  deviceId: string;
  api: HostApi | undefined;
  runs: readonly RunningScript[];
  // The first read is still on its way.
  loading: boolean;
};

// One device's running scripts, the view every surface that lists or
// adopts them shares (the Live page, a worktree's script buttons and
// console).
const runningScriptsAtom = Atom.family((deviceId: string) =>
  hostViewAtom({
    deviceId,
    localDeviceId,
    view: callOf(scriptsContract, "watch"),
    input: undefined,
  }),
);

// One device's runs, nothing while it has no api.
export function useDeviceRunningScripts(
  deviceId: string,
  api: HostApi | undefined,
): readonly RunningScript[] | undefined {
  return useView(api === undefined ? null : runningScriptsAtom(deviceId)).data
    ?.runs;
}

const hostsScriptsAtom = viewsOf((deviceId) => runningScriptsAtom(deviceId));

// Every host's running scripts. A peer out of reach lists none: its
// last list could name a dev server that has since stopped, and
// nothing here could stop it anyway. A peer whose app predates the
// view ends it, and lists none too.
export function useRunningScripts(): HostScripts[] {
  const hosts = useEveryHost();
  const views = useViews(
    hostsScriptsAtom,
    hosts.map(({ deviceId, api }) => (api === undefined ? null : deviceId)),
  );
  return hosts.map(({ deviceId, api }, index) => ({
    deviceId,
    api,
    runs: api === undefined ? NO_RUNS : (views[index]?.data?.runs ?? NO_RUNS),
    loading: api !== undefined && views[index]?.isPending === true,
  }));
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

function liveMirrorsOf(
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
