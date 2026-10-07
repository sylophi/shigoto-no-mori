// What the Live page draws, gathered around the worktrees things run
// in: a dev server, the port forwarded to it and the mirror keeping it
// in step are one worktree's news, so they share its card. Cards file
// under the device holding the worktree, this machine first. A forward
// switched on from the account page names no worktree, and gets its
// device's card of loose ports.
import type { PortForwardSummary } from "@shared/ipc/modules/portForward";
import type { RunningScript } from "@shared/schemas";
import type { HostScripts, LiveMirror } from "@/hooks/live/useLiveActivity";

type LiveItem =
  | { kind: "script"; run: RunningScript }
  | { kind: "mirror"; mirror: LiveMirror }
  | { kind: "forward"; forward: PortForwardSummary };

export type LiveCard = {
  key: string;
  deviceId: string;
  // Null for the card of a device's loose forwards.
  worktree: { projectId: string; worktreeId: string } | null;
  items: LiveItem[];
};

export type LiveDevice = { deviceId: string; cards: LiveCard[] };

export function buildLive({
  scripts,
  mirrors,
  forwards,
}: {
  // In device order, this machine first: the order the sections take.
  scripts: readonly HostScripts[];
  mirrors: readonly LiveMirror[];
  forwards: readonly PortForwardSummary[];
}): LiveDevice[] {
  const devices = new Map<string, Map<string, LiveCard>>(
    scripts.map((host) => [host.deviceId, new Map()]),
  );
  const add = (
    deviceId: string,
    worktree: LiveCard["worktree"],
    item: LiveItem,
  ) => {
    let cards = devices.get(deviceId);
    if (cards === undefined) {
      cards = new Map();
      devices.set(deviceId, cards);
    }
    const key = worktree
      ? `${deviceId}:${worktree.projectId}:${worktree.worktreeId}`
      : `${deviceId}:ports`;
    let card = cards.get(key);
    if (card === undefined) {
      card = { key, deviceId, worktree, items: [] };
      cards.set(key, card);
    }
    card.items.push(item);
  };

  // Added scripts first, then mirrors, then forwards, which is the
  // order a card lists them: what runs in the worktree before how it
  // is reached.
  for (const { deviceId, runs } of scripts) {
    for (const run of runs) {
      add(
        deviceId,
        { projectId: run.projectId, worktreeId: run.worktreeId },
        { kind: "script", run },
      );
    }
  }
  for (const mirror of mirrors) {
    const [deviceId, worktree] =
      mirror.kind === "session"
        ? [
            mirror.runnerDeviceId,
            {
              projectId: mirror.session.localProjectId,
              worktreeId: mirror.session.localWorktreeId,
            },
          ]
        : [
            mirror.copyDeviceId,
            {
              projectId: mirror.stream.projectId,
              worktreeId: mirror.stream.worktreeId,
            },
          ];
    add(deviceId, worktree, { kind: "mirror", mirror });
  }
  for (const forward of forwards) {
    add(forward.deviceId, forward.worktree ?? null, {
      kind: "forward",
      forward,
    });
  }

  const result: LiveDevice[] = [];
  for (const [deviceId, cards] of devices) {
    if (cards.size === 0) continue;
    // The loose ports close the device's cards.
    result.push({
      deviceId,
      cards: [...cards.values()].toSorted(
        (a, b) => Number(a.worktree === null) - Number(b.worktree === null),
      ),
    });
  }
  return result;
}

export function countLive(devices: readonly LiveDevice[]): {
  scripts: number;
  mirrors: number;
  forwards: number;
} {
  const counts = { scripts: 0, mirrors: 0, forwards: 0 };
  for (const device of devices) {
    for (const card of device.cards) {
      for (const item of card.items) {
        if (item.kind === "script") counts.scripts++;
        else if (item.kind === "mirror") counts.mirrors++;
        else counts.forwards++;
      }
    }
  }
  return counts;
}
