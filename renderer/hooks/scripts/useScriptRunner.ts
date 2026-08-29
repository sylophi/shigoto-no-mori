import { useHostScope } from "@/hooks/remote/useHostScope";
import {
  scriptKey,
  scriptRuns,
  type ScriptKey,
  type ScriptRunState,
  type ScriptSlot,
  useScriptRunState,
} from "@/store/scriptRuns";
import type { ScriptName, Worktree } from "@shared/schemas";

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
  // False under a remote scope: the run IPC and the output stream are
  // this machine's, so a run there cannot be dispatched or watched yet.
  // `disabledReason` is the title the UI shows on the dead affordance.
  canRun: boolean;
  disabledReason: string | undefined;
  start: () => void;
  stop: () => void;
}

const REMOTE_RUNS_REASON = "Remote script runs stream back in a later update";

// Bundles the per-script run state with the start/stop dispatch tied
// to the correct IPC (lifecycle vs package). Lets row/console UIs
// stay one-liners.
export function useScriptRunner(
  worktree: Worktree,
  slot: ScriptSlot,
): ScriptRunner {
  // The scope defaults to the local device with no provider mounted, so
  // every local caller keeps running exactly as before.
  const { remote } = useHostScope();
  const key = scriptKey(worktree.projectId, worktree.id, slot);
  const state = useScriptRunState(key);
  const busy = state.status === "starting" || state.status === "running";

  const start = () => {
    if (remote) return;
    void scriptRuns
      .run({
        key,
        worktreeId: worktree.id,
        slot,
        runner: () => {
          if (slot.kind === "package") {
            return window.api.packageScripts.run({
              projectId: worktree.projectId,
              worktreeId: worktree.id,
              scriptName: slot.name,
            });
          }
          return window.api.scripts.run({
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
    void scriptRuns.cancel(key);
  };

  return {
    key,
    state,
    busy,
    canRun: !remote,
    disabledReason: remote ? REMOTE_RUNS_REASON : undefined,
    start,
    stop,
  };
}
