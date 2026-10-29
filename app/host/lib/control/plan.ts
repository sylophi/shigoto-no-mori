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
import { type Project, type Worktree } from "@shigomori/contracts/schemas";

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
  "not-sharing": "doesn't share with other devices",
  "no-project": "has no checkout of this repo",
  "no-grant": "doesn't accept commands",
  refused: "turned the ask away",
};

// How a device's switch is turned on: from its account page, or on
// Linux, where the host runs with no window, from its terminal.
const turnOn = (platform: string, verb: "share" | "control"): string =>
  platform === "linux"
    ? `turn it on there with \`devices ${verb} on\``
    : "turn it on from its account page, in Settings";

// A device's block as a sentence's end, with the peer's own words for
// a refusal and the way to turn a switch on.
export const blockWords = (
  device: Pick<ControlDevice, "block" | "refusal" | "platform">,
): string => {
  switch (device.block) {
    case "refused":
      return device.refusal === undefined
        ? BLOCK_REASON.refused
        : `${BLOCK_REASON.refused} (${device.refusal})`;
    case "not-sharing":
      return `${BLOCK_REASON["not-sharing"]} (${turnOn(device.platform, "share")})`;
    case "no-grant":
      return `${BLOCK_REASON["no-grant"]} (${turnOn(device.platform, "control")})`;
    default:
      return BLOCK_REASON[device.block ?? "offline"];
  }
};

export function matchDevices(peers: DeviceInfo[], query: string): DeviceInfo[] {
  const wanted = query.trim().toLowerCase();
  const byId = peers.filter((device) => device.deviceId === query);
  if (byId.length > 0) return byId;
  const exact = peers.filter(
    (device) => nameOf(device).toLowerCase() === wanted,
  );
  if (exact.length > 0) return exact;
  return peers.filter(
    (device) =>
      nameOf(device).toLowerCase().startsWith(wanted) ||
      device.deviceId.toLowerCase().startsWith(wanted),
  );
}

// Devices as a sentence lists them. A name two of them share carries
// the start of each one's id, which --to and --from take.
export const listed = (devices: Named[]): string =>
  devices
    .map(({ deviceId, name }) =>
      devices.filter((other) => other.name === name).length > 1
        ? `"${name}" (${deviceId.slice(0, 8)})`
        : `"${name}"`,
    )
    .join(", ");

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
    .map((device) => `"${device.name}" ${blockWords(device)}`)
    .join(", ");
  throw new ControlError(
    "device-blocked",
    query === undefined
      ? `No other device can take part: ${why}.`
      : `${why.charAt(0).toUpperCase()}${why.slice(1)}.`,
  );
}

// A project as a person names it: its id, its path there, or its
// name, any case.
const matchesProject = (project: Project, query: string): boolean =>
  project.id === query ||
  project.path === query ||
  project.name.toLowerCase() === query.toLowerCase();

// The one peer project a clone takes, among what each asked device
// holds. A device that couldn't be read is named, not taken for empty,
// and one that holds the project but can't serve it says why.
export function pickPeerProject(
  held: readonly {
    standing: ControlDevice;
    // Null: the device couldn't be read.
    projects: readonly Project[] | null;
  }[],
  query: string,
): { device: ControlDevice; project: Project } {
  const wanted = query.trim();
  const found = held.flatMap(({ standing, projects }) =>
    (projects ?? [])
      .filter((project) => matchesProject(project, wanted))
      .map((project) => ({ device: standing, project })),
  );
  const one = only(found);
  if (one !== undefined) {
    if (one.device.block !== undefined) {
      throw new ControlError(
        "device-blocked",
        `"${one.device.name}" ${blockWords(one.device)}.`,
      );
    }
    return one;
  }
  if (found.length > 1) {
    throw new ControlError(
      "ambiguous-project",
      `"${query}" names several projects: ${found
        .map(({ device, project }) => `${project.path} (${device.name})`)
        .join(", ")}. Name the device with --from, or the project by its path.`,
    );
  }
  const known = held
    .flatMap(({ standing, projects }) =>
      (projects ?? []).map((project) => `${project.name} (${standing.name})`),
    )
    .join(", ");
  const unread = held
    .filter(({ projects }) => projects === null)
    .map(({ standing }) => standing);
  throw new ControlError(
    "no-project",
    [
      `No project "${query}" on another device.`,
      known === "" ? "" : ` There: ${known}.`,
      unread.length === 0
        ? ""
        : ` Not looked at: ${unread.map((device) => `"${device.name}" ${blockWords(device)}`).join(", ")}.`,
    ].join(""),
  );
}
