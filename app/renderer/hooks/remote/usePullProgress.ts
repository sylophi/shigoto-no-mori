// The move orchestrator's running commentary (sync:pullProgress), for
// the surface that invoked it. Frames are keyed by the SOURCE worktree
// id because the local worktree does not exist until the create step
// lands. A move this machine runs (a pull, a send) streams on
// window.api like the lifecycle store's. A mirror of a peer's worktree
// here runs on that peer (its mirror:startTo), whose frames come back
// as its pushes, so under a peer's scope that scope's stream is heard
// too: it only ever carries the frames of calls made from here.
// Subscribed for the caller's lifetime. The caller clears it
// synchronously as it starts a run, so a frame that lands before
// React's next effect flush is the run's first, not a casualty of the
// reset.
import { useEffect, useState } from "react";
import type { SyncPullProgress } from "@shared/ipc/modules/sync";
import type { CreatePhase } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";

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
  const { api, remote } = useHostScope();
  useEffect(() => {
    const onFrame = (evt: SyncPullProgress) => {
      if (evt.sourceWorktreeId !== sourceWorktreeId) return;
      setFrame(evt);
      const phase = evt.createPhase;
      if (phase !== undefined) {
        setPhasesSeen((seen) =>
          seen.has(phase) ? seen : new Set(seen).add(phase),
        );
      }
    };
    const stops = [
      window.api.sync.onPullProgress(onFrame),
      ...(remote ? [api.sync.onPullProgress(onFrame)] : []),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }, [sourceWorktreeId, api, remote]);
  return {
    frame,
    phasesSeen,
    reset: () => {
      setFrame(null);
      setPhasesSeen(NO_PHASES);
    },
  };
}
