// The moves this machine holds for another device to come online
// (host/lib/sync/MoveQueue.ts): a transplant or a mirror asked for while
// a send's destination or a pull's source was offline. The host runs
// each when that device is back, so the queue is this machine's
// whichever page asked: its view, streamed as an atom, and the two
// requests that change it.
import * as Atom from "effect/reactivity/Atom";
import { useMutation } from "@tanstack/react-query";
import {
  syncContract,
  type SyncQueuedMove,
  type SyncMoveRef,
  type SyncQueueMovePayload,
} from "@shigomori/contracts/modules/sync";
import type { Worktree } from "@shigomori/contracts/schemas";
import type { PendingQueuedMove } from "@shigomori/ui/views/worktreeDetail/QueuedMoveView.tsx";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useHasLocalHost } from "@/lib/localHost";
import { hostViewAtom } from "@/lib/runtime/atoms";
import { useApi } from "@/lib/runtime/pageApi";
import { useView } from "@/lib/runtime/viewHooks";

const NONE: readonly SyncQueuedMove[] = [];

const queuedAtom = Atom.family((deviceId: string) =>
  hostViewAtom({
    deviceId,
    view: (api) => api.view(syncContract, "queued", undefined),
  }),
);

export function useQueuedMoves(): readonly SyncQueuedMove[] {
  const localDeviceId = useApi().deviceId;
  const hasLocalHost = useHasLocalHost();
  return useView(hasLocalHost ? queuedAtom(localDeviceId) : null).data ?? NONE;
}

// The move queued for the worktree on the page, until it went through:
// this machine's own, sent off, or the scoped peer's, brought here.
export function useQueuedMoveOf(
  worktree: Pick<Worktree, "id">,
): PendingQueuedMove | undefined {
  const { remote, deviceId } = useHostScope();
  return useQueuedMoves().find(
    (move): move is PendingQueuedMove =>
      move.state.status !== "done" &&
      (remote
        ? move.direction === "pull" &&
          move.deviceId === deviceId &&
          move.worktreeId === worktree.id
        : move.direction === "send" && move.worktreeId === worktree.id),
  );
}

export function useQueueMove() {
  const api = useApi();
  return useMutation({
    mutationFn: (move: SyncQueueMovePayload) =>
      api.run(api.sync.queueMove(move)),
    meta: { errorTitle: "Couldn't queue the move" },
  });
}

export function useDropQueuedMove() {
  const api = useApi();
  return useMutation({
    mutationFn: (ref: SyncMoveRef) => api.run(api.sync.dropQueuedMove(ref)),
    meta: { errorTitle: "Couldn't cancel the queued move" },
  });
}

// The payload that queued it, for a retry, and its name in the queue.
export function payloadOf(move: SyncQueuedMove): SyncQueueMovePayload {
  const { state: _state, ...payload } = move;
  return payload;
}

export function refOf(move: SyncQueuedMove): SyncMoveRef {
  const { direction, deviceId, projectId, worktreeId } = move;
  return { direction, deviceId, projectId, worktreeId };
}
