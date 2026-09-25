// Where a local worktree can go: the account's other devices holding a
// checkout of the same repo (shared/deviceTargets.ts), for the two
// flows that start on this device's own page (transplant to, mirror
// to). The pick is made in the review's destination column
// (PullReview.tsx), which lists them all: with one device ready the
// dialog opens on it, with several it opens on none and Start waits
// for the pick. The handlers re-verify the identity match on the peer,
// so this gate is UX.
import { useState } from "react";
import type { Project } from "@shared/schemas";
import {
  type DeviceTarget,
  isHolder,
  useDeviceTargets,
} from "@/components/shared/deviceTargets";
import { useLocalDeviceName } from "@/hooks/account/useAccount";
import type { HostApi } from "@/hooks/remote/useHostScope";
import type { DestinationPick } from "./PullReview";
import { type Landing, landsOnPeer } from "./pullSteps";

// A peer holding the repo. Its `block` says why it cannot take the
// worktree right now (asleep, or not granting this device control).
export type PeerTarget = DeviceTarget & { project: Project };
type ReadyPeerTarget = PeerTarget & { api: HostApi };

export function isReadyTarget(target: PeerTarget): target is ReadyPeerTarget {
  return target.block === undefined && target.api !== undefined;
}

export function usePeerTargets(project: Project): PeerTarget[] {
  return useDeviceTargets(project).filter(
    (target): target is PeerTarget => !target.isThisDevice && isHolder(target),
  );
}

// What a dialog to a peer hands its flow: the pick, and the landing
// side it resolves to. Until a device is picked the landing project is
// absent and the words name no device. The pick is held as the target
// it was when picked, not re-read from the live list: a run takes
// minutes, and a peer whose session or grant blips meanwhile must not
// pull the destination (and the running view with it) out from under
// the flow. A peer that really went away fails the run, which says so.
export function usePeerDestination(targets: PeerTarget[]): {
  picked: ReadyPeerTarget | null;
  flow: {
    localProject: Project | undefined;
    sourceDeviceLabel: string;
    thisDeviceLabel: string;
    landing: Landing;
    toPeer: DestinationPick;
  };
} {
  const ready = targets.filter(isReadyTarget);
  const [picked, setPicked] = useState<ReadyPeerTarget | null>(
    ready.length === 1 ? ready[0] : null,
  );
  const onPick = (deviceId: string) =>
    setPicked(ready.find((target) => target.deviceId === deviceId) ?? null);
  const label = picked?.label ?? "another device";
  return {
    picked,
    flow: {
      localProject: picked?.project,
      sourceDeviceLabel: useLocalDeviceName(),
      thisDeviceLabel: label,
      landing: landsOnPeer(label),
      toPeer: { targets, pickedId: picked?.deviceId ?? null, onPick },
    },
  };
}
