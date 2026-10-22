// What is running across the account right now, for the Live page
// (components/live/LivePage.tsx) and the sidebar's Live mark: the
// scripts and the terminals each host runs, the forwards this machine
// holds, the mirrors every host runs. (The agents waiting on you come
// off the worktree lists, lib/agentWatch.ts.) Each part is read the way
// its own surfaces read it: the scripts, the terminals and the mirrors
// as their hosts' views (scripts:watch, terminals:list, mirror:watch),
// the forwards off portForward:changed, so nothing here polls.
import { callOf } from "@shigomori/contracts/contract";
import { scriptsContract } from "@shigomori/contracts/modules/scripts";
import * as Atom from "effect/reactivity/Atom";
import type {
  MirrorDaemonStatus,
  MirrorListResult,
  MirrorServing,
  MirrorSession,
} from "@shigomori/contracts/modules/mirror";
import type { RunningScript, Terminal } from "@shigomori/contracts/schemas";
import type { HostApi } from "@/hooks/remote/useHostScope";
import { useEveryHostMirrors } from "@/hooks/remote/useMirrors";
import { usePortForwardCount } from "@/hooks/remote/usePortForwards";
import { useAtomValue } from "@effect/atom-react";
import { commandAccessOf } from "@/hooks/remote/useCommandAccess";
import {
  useEveryHost,
  useRemoteDevices,
} from "@/hooks/remote/useRemoteDevices";
import { remoteDevicesAtom } from "@/lib/remote/devices";
import { terminalsAtom } from "@/hooks/terminals/useTerminals";
import { useApi } from "@/lib/runtime/pageApi";
import { hostViewAtom } from "@/lib/runtime/atoms";
import { useView, useViews, viewsOf } from "@/lib/runtime/viewHooks";

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
    view: callOf(scriptsContract, "watch"),
    input: undefined,
  }),
);

// Whether this device may read a device's runs: its own always, a
// peer's while that peer runs commands from here (its registry entry),
// or before the registry says. A peer that refuses lists none, settled,
// rather than a view the refusal keeps asking.
export function readsRunsOf(
  localDeviceId: string,
  deviceId: string,
  accepts: boolean | undefined,
) {
  return commandAccessOf(localDeviceId, deviceId, { acceptsCommands: accepts })
    .canCommand;
}

// One device's runs, nothing while it has no api or refuses commands
// from here.
export function useDeviceRunningScripts(
  deviceId: string,
  api: HostApi | undefined,
): readonly RunningScript[] | undefined {
  const localDeviceId = useApi().deviceId;
  const accepts = useAtomValue(
    remoteDevicesAtom,
    (devices) =>
      devices.find((entry) => entry.deviceId === deviceId)?.acceptsCommands,
  );
  const reads =
    api !== undefined && readsRunsOf(localDeviceId, deviceId, accepts);
  return useView(reads ? runningScriptsAtom(deviceId) : null).data?.runs;
}

const hostsScriptsAtom = viewsOf((deviceId) => runningScriptsAtom(deviceId));
const hostsTerminalsAtom = viewsOf((deviceId) => terminalsAtom(deviceId));

// Every host, and whether this device reads its runs and terminals: a
// peer out of reach lists none, as its last list could name a dev
// server that has since stopped, and nothing here could stop it anyway.
// Nor does one that runs no commands from here (the views are gated),
// settled.
function useCommandedHosts() {
  const hosts = useEveryHost();
  const localDeviceId = useApi().deviceId;
  const registry = useRemoteDevices();
  return hosts.map(({ deviceId, api }) => ({
    deviceId,
    api,
    reads:
      api !== undefined &&
      readsRunsOf(
        localDeviceId,
        deviceId,
        registry.find((entry) => entry.deviceId === deviceId)?.acceptsCommands,
      ),
  }));
}

// Every host's running scripts. A peer whose app predates the view ends
// it, and lists none.
export function useRunningScripts(): HostScripts[] {
  const hosts = useCommandedHosts();
  const views = useViews(
    hostsScriptsAtom,
    hosts.map(({ deviceId, reads }) => (reads ? deviceId : null)),
  );
  return hosts.map(({ deviceId, api, reads }, index) => ({
    deviceId,
    api,
    runs: reads ? (views[index]?.data?.runs ?? NO_RUNS) : NO_RUNS,
    loading: reads && views[index]?.isPending === true,
  }));
}

const NO_RUNS: RunningScript[] = [];

// A host's open terminals.
export type HostTerminals = {
  deviceId: string;
  terminals: readonly Terminal[];
  // The first read is still on its way.
  loading: boolean;
};

// Every host's open terminals, read as its runs are.
export function useOpenTerminals(): HostTerminals[] {
  const hosts = useCommandedHosts();
  const views = useViews(
    hostsTerminalsAtom,
    hosts.map(({ deviceId, reads }) => (reads ? deviceId : null)),
  );
  return hosts.map(({ deviceId, reads }, index) => ({
    deviceId,
    terminals: reads
      ? (views[index]?.data?.terminals ?? NO_TERMINALS)
      : NO_TERMINALS,
    loading: reads && views[index]?.isPending === true,
  }));
}

const NO_TERMINALS: Terminal[] = [];

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
      engineFailure: string | undefined;
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
        engineFailure: data?.daemonFailure,
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

// How many things are live, for the sidebar's mark. An open terminal
// is not: a shell kept open in a drawer is how a day's work goes, and
// would keep the mark lit. Live lists them.
export function useLiveCount(): number {
  const scripts = useRunningScripts().reduce(
    (sum, host) => sum + host.runs.length,
    0,
  );
  return scripts + usePortForwardCount() + useLiveMirrors().length;
}
