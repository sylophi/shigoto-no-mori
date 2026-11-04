// The footer's verb for a worktree with a move queued on another device
// (hooks/remote/useMoveQueue.ts), in the transfers' place, and the
// dialog it opens (QueuedMoveView.tsx). A move that went through leaves
// the footer at once: its toast says so (QueuedMoveToasts.tsx).
import { useState } from "react";
import type { Worktree } from "@shigomori/contracts/schemas";
import { ModalShell } from "@shigomori/ui/primitives/modal-shell.tsx";
import {
  QueuedMoveButtonView,
  QueuedMoveDialogView,
} from "@shigomori/ui/views/worktreeDetail/QueuedMoveView.tsx";
import { useRemoteDeviceLabel } from "@/hooks/remote/useDevices";
import {
  payloadOf,
  refOf,
  useDropQueuedMove,
  useQueuedMoveOf,
  useQueueMove,
} from "@/hooks/remote/useMoveQueue";

export function QueuedMoveAction({ worktree }: { worktree: Worktree }) {
  const move = useQueuedMoveOf(worktree);
  const device = useRemoteDeviceLabel(move?.deviceId ?? "");
  const [open, setOpen] = useState(false);
  const drop = useDropQueuedMove();
  const queue = useQueueMove();
  if (move === undefined) return null;
  return (
    <>
      <QueuedMoveButtonView
        move={move}
        device={device}
        onOpen={() => setOpen(true)}
      />
      {open && (
        <ModalShell
          label="Queued move"
          onClose={() => setOpen(false)}
          popoverClassName="max-w-md"
        >
          <QueuedMoveDialogView
            move={move}
            device={device}
            pending={drop.isPending || queue.isPending}
            onCancel={() =>
              drop.mutate(refOf(move), { onSuccess: () => setOpen(false) })
            }
            onRetry={() => queue.mutate(payloadOf(move))}
            onClose={() => setOpen(false)}
          />
        </ModalShell>
      )}
    </>
  );
}
