// What the Live page draws, gathered around the worktrees things run
// in: a dev server, the port forwarded to it and the mirror keeping it
// in step are one worktree's news, so they share its card, and so does
// an agent there waiting on you, which leads it. Cards file under the
// device holding the worktree, this machine first, the ones with an
// agent waiting on you first. A forward switched on from the account
// page names no worktree, and gets its device's card of loose ports.
import type { PortForwardSummary } from "@shared/ipc/modules/portForward";
import type { AgentSession, RunningScript } from "@shared/schemas";
import type { HostScripts, LiveMirror } from "@/hooks/live/useLiveActivity";
import type { WaitingAgent } from "@/lib/agentWatch";

export type LiveItem =
  | { kind: "agent"; session: AgentSession }
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
  agents,
  scripts,
  mirrors,
  forwards,
}: {
  // Longest wait first, the order their cards take.
  agents: readonly WaitingAgent[];
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

  // Added agents first, then scripts, then mirrors, then forwards,
  // which is the order a card lists them: what waits on you, then what
  // runs in the worktree before how it is reached.
  for (const { deviceId, projectId, worktreeId, session } of agents) {
    add(deviceId, { projectId, worktreeId }, { kind: "agent", session });
  }
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
    // The cards keep the order they were added in, so the agents
    // waiting on you lead, and the loose ports close the device's cards.
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
  agents: number;
  scripts: number;
  mirrors: number;
  forwards: number;
} {
  const counts = { agents: 0, scripts: 0, mirrors: 0, forwards: 0 };
  for (const device of devices) {
    for (const card of device.cards) {
      for (const item of card.items) {
        if (item.kind === "agent") counts.agents++;
        else if (item.kind === "script") counts.scripts++;
        else if (item.kind === "mirror") counts.mirrors++;
        else counts.forwards++;
      }
    }
  }
  return counts;
}
