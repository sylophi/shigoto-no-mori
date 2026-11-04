// Where a local worktree can go: the account's other devices that host
// projects (shared/deviceTargets.ts), for the two flows that start on
// this device's own page (transplant to, mirror to). One holding a
// checkout of the same repo takes the worktree into it, one with none
// clones the repo first (flow/cloneDestination.tsx), as a pull here
// does. The pick is made in the review's destination column
// (PullReview.tsx), which lists them all: with one device ready the
// dialog opens on it, with several it opens on none and Start waits
// for the pick. An offline device can be picked too, and the flow to it
// is queued for when it is back (hooks/remote/useMoveQueue.ts). The
// handlers re-verify the identity match on the peer, so this gate is
// UX.
import { only } from "@shigomori/contracts/util/only";
import { useState } from "react";
import type { Project } from "@shigomori/contracts/schemas";
import { useDeviceTabs } from "@/components/shared/DeviceTabs";
import { isHolder, useDeviceTargets } from "@/components/shared/deviceTargets";
import { useLocalDeviceName } from "@/hooks/account/useAccount";
import type {
  DestinationPick,
  PeerTarget as ViewPeerTarget,
} from "@shigomori/ui/views/worktreeDetail/flow/PullReviewView.tsx";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { type HostApi, useHostScope } from "@/hooks/remote/useHostScope";
import {
  type Landing,
  landsOnPeer,
} from "@shigomori/ui/views/worktreeDetail/flow/pullSteps.ts";

// A peer target with the API scoped to it, which the flow runs on.
export type PeerTarget = ViewPeerTarget & { api: HostApi | undefined };

export function usePeerTargets(project: Project): PeerTarget[] {
  // A device without a checkout reads "no-project" among the targets,
  // which is no block here: its tab's own block is the one that holds.
  const tabs = useDeviceTabs();
  return useDeviceTargets(project).flatMap((target): PeerTarget[] => {
    if (target.isThisDevice) return [];
    const block = isHolder(target)
      ? target.block
      : tabs.find((tab) => tab.deviceId === target.deviceId)?.block;
    return [
      {
        ...target,
        block,
        ready: block === undefined && target.api !== undefined,
      },
    ];
  });
}

// What a dialog to a peer hands its flow: the pick, and the landing
// side it resolves to. Until a device is picked the landing project is
// absent and the words name no device. The pick is held as the target
// it was when picked, not re-read from the live list: a run takes
// minutes, and a peer whose session or grant blips meanwhile must not
// pull the destination (and the running view with it) out from under
// the flow. A peer that really went away fails the run, which says so.
export function usePeerDestination(targets: PeerTarget[]): {
  picked: PeerTarget | null;
  flow: {
    localProject: Project | undefined;
    sourceDeviceLabel: string;
    thisDeviceLabel: string;
    landing: Landing;
    toPeer: DestinationPick;
    waitsFor: string | null;
  };
} {
  const pickable = targets.filter(
    (target) => target.ready || target.block === "offline",
  );
  // The one ready device, or with none ready the one it can wait for.
  const ready = pickable.filter((target) => target.ready);
  const [picked, setPicked] = useState<PeerTarget | null>(
    only(ready.length > 0 ? ready : pickable) ?? null,
  );
  const onPick = (deviceId: string) =>
    setPicked(pickable.find((target) => target.deviceId === deviceId) ?? null);
  const label = picked?.label ?? "another device";
  // Whether it is offline now, off the live list: one that came back
  // takes the flow at once, one that went takes it queued.
  const live =
    targets.find((target) => target.deviceId === picked?.deviceId) ?? picked;
  return {
    picked,
    flow: {
      localProject: picked?.project,
      sourceDeviceLabel: useLocalDeviceName(),
      thisDeviceLabel: label,
      landing: landsOnPeer(label),
      toPeer: { targets, pickedId: picked?.deviceId ?? null, onPick },
      waitsFor: live?.block === "offline" ? label : null,
    },
  };
}

function useScopedPeerOffline(): boolean {
  const { deviceId } = useHostScope();
  return (
    useDeviceTabs().find((tab) => tab.deviceId === deviceId)?.block ===
    "offline"
  );
}

// What a dialog bringing the scoped peer's worktree here waits for: the
// peer, named, while it is offline, which queues the flow.
export function useSourceWaits(sourceDeviceLabel: string): string | null {
  return useScopedPeerOffline() ? sourceDeviceLabel : null;
}

// Whether this device may move the scoped host's worktrees. An offline
// peer's grant can't be read until it's back, so one not refused yet
// offers the move, which waits for it and its grant (MoveQueue.ts).
export function useMayTransfer(): boolean {
  const { granted, canCommand } = useCommandAccess();
  const offline = useScopedPeerOffline();
  return granted || (offline && canCommand);
}
