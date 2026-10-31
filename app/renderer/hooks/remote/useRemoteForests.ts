// Every registered remote device's forest at once, for the sidebar's
// merged tree. It is the only place a peer's forest is read, since remote
// work is meant to look local rather than live on a page of its own.
// Each peer's projects and each (device, project)'s worktrees are the
// host views the device-scoped pages read (useProjects, useWorktrees),
// streamed over the hub hop, so the two can never disagree. Its pull
// request map and project config are requests, a query per (device,
// project), so the inbox can file a peer's worktree exactly as it files
// a local one (its PR tells merged from live, its config says whether
// the primary shows). A device stays in the list whether or not a
// direct session is up: its views are asked again until one is, and
// meanwhile read what they last had.
import type { RemoteForestItem } from "@shigomori/ui/lib/forest.ts";
import { useQueries } from "@tanstack/react-query";
import type { Project } from "@shigomori/contracts/schemas";
import { shigomoriConfigQueryOptions } from "@/hooks/config/useShigomoriConfig";
import { showPrimaryInInbox } from "@shigomori/ui/lib/showPrimaryInInbox.ts";
import {
  pullRequestsKey,
  somePullRequestsAtom,
} from "@/hooks/projects/useProjectPullRequests";
import { projectsAtom } from "@/hooks/projects/useProjects";
import { deviceStatusView } from "@shigomori/ui/lib/deviceStatus.ts";
import type { RemoteDevice } from "@/lib/remote/devices";
import { combineFanOut } from "@/hooks/remote/hostForestScope";
import {
  someWorktreesAtom,
  worktreeListKey,
} from "@/hooks/worktrees/useWorktrees";
import { useAtomValue } from "@effect/atom-react";
import * as Atom from "effect/reactivity/Atom";
import { hostSessionAtom } from "@/lib/runtime/atoms";
import { useViews, viewsOf } from "@/lib/runtime/viewHooks";
import { useRemoteDevices } from "./useRemoteDevices";

// The peers' projects, each as its host streams it. A peer that has had
// a session on this page keeps its views while it has none, so its rows
// stay as the sidebar last had them (faded, as unreachable) while its
// views redial. One that never had one reads nothing.
const peersProjectsAtom = viewsOf((deviceId) => projectsAtom(deviceId));

// The devices among `joined` (ids, one separator apart) that had a
// session on this page.
const hadSessionAtom = Atom.family((joined: string) =>
  Atom.readable((get) =>
    joined === ""
      ? []
      : joined
          .split(SEPARATOR)
          .filter((deviceId) => get(hostSessionAtom(deviceId)) > 0),
  ),
);
const SEPARATOR = "\u0001";

type Peer = { readonly deviceId: string; readonly api?: unknown };

// Whether each of `devices`' views is read: while it can be asked, and
// after that for as long as the page lives once it had a session, so a
// surface that shows what a device holds keeps showing it while it is
// away.
export function useViewsWanted(
  devices: readonly Peer[],
): (device: Peer) => boolean {
  const had = new Set(
    useAtomValue(
      hadSessionAtom(devices.map((device) => device.deviceId).join(SEPARATOR)),
    ),
  );
  return (device) => device.api !== undefined || had.has(device.deviceId);
}

export interface RemoteForests {
  items: RemoteForestItem[];
  // True while any remote listing is actually fetching (isLoading, not
  // isPending: a disconnected device's disabled queries stay pending
  // forever). The web sidebar's empty state hangs on this so a slow
  // hub reads as loading, not as "no projects".
  loading: boolean;
  // The peers whose projects could not be read, by name.
  devicesFailed: readonly string[];
}

export interface RemoteForestsOptions {
  // True while the inbox shows: its per-project config read
  // (showPrimaryInInbox) is the one fact the tree never needs, so it
  // is asked for only then rather than on every device and project at
  // boot.
  inboxFacts?: boolean;
}

export interface RemoteProjectPair {
  device: RemoteDevice;
  project: Project;
}

// The projects half alone: every peer's registered projects as
// flattened (device, project) pairs, for the callers that only match a
// repo per device (the device targets behind the tab bars and the
// "Create on" pick) and have no use for the worktree, PR and config
// fan-outs the forests add on top. The forests compose this, so the
// two can never list different projects.
// A peer away keeps the projects it last had, for every caller (the
// sidebar's rows, a project's device tabs, the pickers): what a
// sleeping machine holds still exists.
export function useRemoteProjects(): {
  pairs: RemoteProjectPair[];
  loading: boolean;
  // Peers whose projects could not be read, after the retries.
  failed: readonly string[];
} {
  // A peer that isn't sharing lists nothing.
  const devices = useRemoteDevices().filter(
    (device) => device.status.phase !== "notSharing",
  );
  const wanted = useViewsWanted(devices);
  const projectViews = useViews(
    peersProjectsAtom,
    devices.map((device) => (wanted(device) ? device.deviceId : null)),
  );
  // A checkout the peer reports missing is left out, the same gate the
  // local fan-outs apply: every read on it would only throw.
  return {
    pairs: devices.flatMap((device, index) =>
      (projectViews[index]?.data ?? [])
        .filter((project) => project.pathExists !== false)
        .map((project) => ({ device, project })),
    ),
    loading: projectViews.some((view) => view.isLoading),
    failed: devices
      .filter((_, index) => projectViews[index]?.error != null)
      .map((device) => device.label),
  };
}

export function useRemoteForests(
  options: RemoteForestsOptions = {},
): RemoteForests {
  const { inboxFacts = false } = options;
  // Flattened (device, project) pairs, so the worktree fan-out is one
  // flat read whatever shape the forests have.
  const { pairs, loading: projectsLoading, failed } = useRemoteProjects();
  const wanted = useViewsWanted(pairs.map(({ device }) => device));
  const worktreeQueries = useViews(
    someWorktreesAtom,
    pairs.map(({ device, project }) =>
      wanted(device) ? worktreeListKey(device.deviceId, project.id) : null,
    ),
  );
  // The PR maps are the peers' views of their sweeps, and the config
  // their project.json read, which costs a peer no git or gh call and
  // only ever changes through a Configure save, which invalidates it.
  const pullRequestQueries = useViews(
    somePullRequestsAtom,
    pairs.map(({ device, project }) =>
      wanted(device) ? pullRequestsKey(device.deviceId, project.id) : null,
    ),
  );
  const configQueries = useQueries({
    queries: pairs.map(({ device, project }) => ({
      ...shigomoriConfigQueryOptions(project.id, {
        deviceId: device.deviceId,
        api: device.api,
      }),
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      meta: { silentError: true },
      ...(inboxFacts ? {} : { enabled: false }),
    })),
    combine: combineFanOut,
  });
  return {
    items: pairs.map(({ device, project }, index) => {
      const status = deviceStatusView(device.status);
      return {
        deviceId: device.deviceId,
        deviceLabel: device.label,
        deviceIcon: device.icon,
        reachable: status.reachable,
        tone: status.tone,
        project,
        worktrees: worktreeQueries[index]?.data ?? [],
        pullRequests: pullRequestQueries[index]?.data ?? {},
        showPrimaryInInbox: showPrimaryInInbox(configQueries[index]?.data),
        worktreesError: worktreeQueries[index]?.error != null,
      };
    }),
    loading:
      projectsLoading || worktreeQueries.some((query) => query.isLoading),
    devicesFailed: failed,
  };
}
