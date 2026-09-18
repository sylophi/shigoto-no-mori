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
import type { CreatePhase } from "@shared/schemas";

const NO_PHASES: ReadonlySet<CreatePhase> = new Set();

export function usePullProgress(sourceWorktreeId: string): {
  frame: SyncPullProgress | null;
  // The create's lifecycle phases this run has reported so far. The
  // CLI only reports a phase it runs, so this is what the create did,
  // where the dialog's own reading of the project is what it expected.
  phasesSeen: ReadonlySet<CreatePhase>;
  reset: () => void;
} {
  const [frame, setFrame] = useState<SyncPullProgress | null>(null);
  const [phasesSeen, setPhasesSeen] = useState(NO_PHASES);
  useEffect(
    () =>
      window.api.sync.onPullProgress((evt) => {
        if (evt.sourceWorktreeId !== sourceWorktreeId) return;
        setFrame(evt);
        const phase = evt.createPhase;
        if (phase !== undefined) {
          setPhasesSeen((seen) =>
            seen.has(phase) ? seen : new Set(seen).add(phase),
          );
        }
      }),
    [sourceWorktreeId],
  );
  return {
    frame,
    phasesSeen,
    reset: () => {
      setFrame(null);
      setPhasesSeen(NO_PHASES);
    },
  };
}
