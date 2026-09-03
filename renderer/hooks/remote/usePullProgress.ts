// The pull orchestrator's running commentary (sync:pullProgress), for
// the surface that invoked it. Frames are keyed by the SOURCE worktree
// id because the local worktree does not exist until the create step
// lands. A local broadcast: main emits this machine's pulls, so the
// subscription rides window.api like the lifecycle store's, never the
// surrounding remote scope. Subscribed for the caller's lifetime. The
// caller clears it synchronously as it starts a run, so a frame that
// lands before React's next effect flush is the run's first, not a
// casualty of the reset.
import { useEffect, useState } from "react";
import type { SyncPullProgress } from "@shared/ipc/modules/sync";

export function usePullProgress(sourceWorktreeId: string): {
  frame: SyncPullProgress | null;
  reset: () => void;
} {
  const [frame, setFrame] = useState<SyncPullProgress | null>(null);
  useEffect(
    () =>
      window.api.sync.onPullProgress((evt) => {
        if (evt.sourceWorktreeId === sourceWorktreeId) setFrame(evt);
      }),
    [sourceWorktreeId],
  );
  return { frame, reset: () => setFrame(null) };
}
