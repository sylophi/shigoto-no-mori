// What became of a move queued on another device (hooks/remote/
// useMoveQueue.ts), told once it ran, whichever page is open: one that
// went through as a toast with the way to the copy, which then leaves
// the queue, and one that failed as a toast, which stays on its
// worktree's footer to retry or dismiss.
import { useEffect, useEffectEvent, useRef } from "react";
import {
  queuedMoveKey,
  type SyncQueuedMove,
} from "@shigomori/contracts/modules/sync";
import { UNNAMED_DEVICE } from "@shigomori/ui/lib/deviceRoster.ts";
import { usePeers } from "@/hooks/remote/useDevices";
import {
  refOf,
  useDropQueuedMove,
  useQueuedMoves,
} from "@/hooks/remote/useMoveQueue";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { notifyError, toast } from "@/lib/toast";

function doneTitle(move: SyncQueuedMove, device: string): string {
  if (move.kind === "mirror") return `Mirroring ${move.branch} with ${device}`;
  return move.direction === "send"
    ? `Transplanted ${move.branch} to ${device}`
    : `Transplanted ${move.branch} here from ${device}`;
}

export function QueuedMoveToasts() {
  const moves = useQueuedMoves();
  const peers = usePeers();
  const nav = useWorktreeNav();
  const drop = useDropQueuedMove();
  // The failures told already, by move, so each is told once.
  const told = useRef(new Set<string>());

  const report = useEffectEvent((queued: readonly SyncQueuedMove[]) => {
    const nameOf = (deviceId: string) =>
      peers.find((peer) => peer.deviceId === deviceId)?.label ?? UNNAMED_DEVICE;
    for (const move of queued) {
      const key = queuedMoveKey(move);
      const device = nameOf(move.deviceId);
      const { state } = move;
      if (state.status === "done") {
        drop.mutate(refOf(move));
        const source = move.direction === "send" ? "this device" : device;
        toast.success(doneTitle(move, device), {
          id: `queued:${key}`,
          description:
            state.sourceError === undefined
              ? undefined
              : `The copy on ${source} stayed: ${state.sourceError}`,
          action: {
            label: "Open",
            onClick: () =>
              nav.toDeviceWorktree(
                state.landed.deviceId,
                state.landed.projectId,
                state.landed.worktreeId,
              ),
          },
        });
      } else if (state.status === "failed") {
        if (told.current.has(key)) continue;
        told.current.add(key);
        notifyError(
          `The queued ${move.kind} ${move.direction === "send" ? "to" : "from"} ${device} failed`,
          state.error,
        );
      } else {
        told.current.delete(key);
      }
    }
  });
  useEffect(() => report(moves), [moves]);

  return null;
}
