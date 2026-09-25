import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { peerReadOnlyNote } from "@/lib/commandAccessCopy";
import {
  scriptKey,
  type ScriptKey,
  type ScriptRunState,
  type ScriptSlot,
} from "@/store/scriptRuns";
import type { ScriptName, Worktree } from "@shared/schemas";
import { useScriptRuns, useScriptRunState } from "./useScriptRuns";

type NonPackageSlot =
  | { kind: "setup" }
  | { kind: "teardown" }
  | { kind: "portPool"; phase: "provision" | "release" };

function slotToScriptName(slot: NonPackageSlot): ScriptName {
  if (slot.kind === "setup") return "setup";
  if (slot.kind === "teardown") return "teardown";
  return slot.phase === "provision"
    ? "port-pool-provision"
    : "port-pool-release";
}

export interface ScriptRunner {
  key: ScriptKey;
  state: ScriptRunState;
  busy: boolean;
  // Whether a run can be dispatched from here. A run is a command, so
  // on a peer it waits for that device's grant. Locally always true.
  // `disabledReason` is the title the UI shows on the dead affordance.
  canRun: boolean;
  disabledReason: string | undefined;
  start: () => void;
  stop: () => void;
  // Drops a finished run's log and state (a no-op while it runs).
  clear: () => void;
}

// Bundles the per-script run state with the start/stop dispatch tied
// to the correct IPC (lifecycle vs package), on whichever device the
// host scope names: the run is dispatched over that device's api and
// its output streams back into that device's store. Lets row/console
// UIs stay one-liners.
export function useScriptRunner(
  worktree: Worktree,
  slot: ScriptSlot,
): ScriptRunner {
  const { api } = useHostScope();
  const store = useScriptRuns();
  const { canCommand: canRun } = useCommandAccess();
  const key = scriptKey(worktree.projectId, worktree.id, slot);
  const state = useScriptRunState(key);
  const busy = state.status === "starting" || state.status === "running";

  const start = () => {
    if (!canRun) return;
    void store
      .run({
        key,
        worktreeId: worktree.id,
        slot,
        runner: () => {
          if (slot.kind === "package") {
            return api.packageScripts.run({
              projectId: worktree.projectId,
              worktreeId: worktree.id,
              scriptName: slot.name,
            });
          }
          return api.scripts.run({
            projectId: worktree.projectId,
            worktreeId: worktree.id,
            script: slotToScriptName(slot),
          });
        },
      })
      .catch(() => {
        // Failure surfaces on state.status === "errored".
      });
  };

  const stop = () => {
    void store.cancel(key);
  };

  const clear = () => store.clear(key);

  return {
    key,
    state,
    busy,
    canRun,
    disabledReason: canRun ? undefined : peerReadOnlyNote(),
    start,
    stop,
    clear,
  };
}
