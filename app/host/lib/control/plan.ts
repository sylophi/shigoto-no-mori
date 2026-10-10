// The control ops' decisions (ops.ts): which device or worktree a
// name means, why a device can't take part, and how a mirror reads
// from either side. Pure.
import { only } from "@shigomori/contracts/util/only";
import {
  type ControlDevice,
  ControlError,
  type ControlMirror,
  type ControlPeerWorktree,
} from "@shigomori/contracts/modules/control";
import { type MirrorSession } from "@shigomori/contracts/modules/mirror";
import { hostsProjects } from "@shigomori/contracts/platform";
import type { DeviceInfo } from "@shigomori/contracts/hubProtocol";
import { type Worktree } from "@shigomori/contracts/schemas";

export type Named = { deviceId: string; name: string };

// A device with no name of its own still has to be told apart.
export const nameOf = (device: DeviceInfo): string =>
  device.name.trim() === "" ? device.deviceId : device.name;

// The registry's other hosts. A browser on the account is a device
// too, but hosts no forest.
export function peersOf(devices: DeviceInfo[], hereId: string): DeviceInfo[] {
  return devices.filter(
    (device) => device.deviceId !== hereId && hostsProjects(device.platform),
  );
}

export const BLOCK_REASON: Record<
  NonNullable<ControlDevice["block"]>,
  string
> = {
  offline: "not connected",
  "not-sharing":
    "doesn't share with other devices (turn it on from its account page, in Settings)",
  "no-project": "has no checkout of this repo",
  "no-grant":
    "doesn't accept commands (turn it on from its account page, in Settings)",
};

export function matchDevices(peers: DeviceInfo[], query: string): DeviceInfo[] {
  const wanted = query.trim().toLowerCase();
  const byId = peers.filter((device) => device.deviceId === query);
  if (byId.length > 0) return byId;
  const exact = peers.filter(
    (device) => nameOf(device).toLowerCase() === wanted,
  );
  if (exact.length > 0) return exact;
  return peers.filter((device) =>
    nameOf(device).toLowerCase().startsWith(wanted),
  );
}

export const listed = (devices: { name: string }[]): string =>
  devices.map((device) => `"${device.name}"`).join(", ");

const nameFor = (deviceId: string, devices: Named[]): string =>
  devices.find((device) => device.deviceId === deviceId)?.name ?? deviceId;

export function mirrorView(
  session: MirrorSession,
  devices: Named[],
): ControlMirror {
  return {
    session: session.session,
    device: {
      deviceId: session.deviceId,
      name: nameFor(session.deviceId, devices),
    },
    localProjectId: session.localProjectId,
    localWorktreeId: session.localWorktreeId,
    localRoot: session.localRoot,
    remoteRoot: session.remoteRoot,
    // The session runs on the original's device, so the copy is the
    // runner's peer.
    copySide: "remote",
    paused: session.paused,
    status: session.status,
    statusText: session.statusText,
    ...(session.git === undefined
      ? {}
      : { git: session.git.status, gitDetail: session.git.detail }),
    conflicts: session.conflicts.length,
  };
}

// Names for the mirror views. A signed-out or unreachable registry
// leaves the ids standing in, since a list must still answer.
export function namesOf(devices: DeviceInfo[]): Named[] {
  return devices.map((device) => ({
    deviceId: device.deviceId,
    name: nameOf(device),
  }));
}

// A session and the device running it.
export type Running = { deviceId: string; session: MirrorSession };

// A peer's session as this device sees it: the runner's view with the
// two sides swapped, the peer being the other device, and the copy a
// stop removes the one here.
export function peerMirrorView(
  { deviceId, session }: Running,
  devices: Named[],
): ControlMirror {
  return {
    ...mirrorView(session, devices),
    device: { deviceId, name: nameFor(deviceId, devices) },
    localProjectId: session.projectId,
    localWorktreeId: session.worktreeId,
    localRoot: session.remoteRoot,
    remoteRoot: session.localRoot,
    copySide: "local",
  };
}

const matchesWorktree = (worktree: Worktree, query: string): boolean =>
  worktree.id === query || worktree.name === query || worktree.branch === query;

export function pickWorktree(
  all: ControlPeerWorktree[],
  query: string,
  unreachable: ControlDevice[],
): ControlPeerWorktree {
  const found = all.filter((entry) => matchesWorktree(entry.worktree, query));
  const one = only(found);
  if (one !== undefined) return one;
  if (found.length > 1) {
    throw new ControlError(
      "ambiguous-worktree",
      `"${query}" is on several devices: ${listed(found.map((entry) => entry.device))}. Name one with --from.`,
    );
  }
  const known = all
    .map((entry) => `${entry.worktree.name} (${entry.device.name})`)
    .join(", ");
  throw new ControlError(
    "no-worktree",
    [
      `No worktree "${query}" on another device.`,
      known === "" ? "" : ` There: ${known}.`,
      unreachable.length === 0
        ? ""
        : ` Not reached, so not looked at: ${listed(unreachable)}.`,
    ].join(""),
  );
}

// The one device a send goes to. A device with no checkout of the repo
// takes it too (it clones the repo first, as the dialogs offer), but
// only when no device holding the repo could: left unnamed, a send
// lands where the repo already is.
export function chooseTarget(
  standings: readonly ControlDevice[],
  query: string | undefined,
): ControlDevice {
  const holding = standings.filter((device) => device.block === undefined);
  const ready =
    holding.length > 0
      ? holding
      : standings.filter((device) => device.block === "no-project");
  const target = only(ready);
  if (target !== undefined) return target;
  if (ready.length > 1) {
    throw new ControlError(
      "ambiguous-device",
      `Several devices could take part: ${listed(ready)}. Name one.`,
    );
  }
  const why = standings
    .map(
      (device) => `"${device.name}" ${BLOCK_REASON[device.block ?? "offline"]}`,
    )
    .join(", ");
  throw new ControlError(
    "device-blocked",
    query === undefined
      ? `No other device can take part: ${why}.`
      : `${why.charAt(0).toUpperCase()}${why.slice(1)}.`,
  );
}
