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
  start: () => void;
  stop: () => void;
}

// Bundles the per-script run state with the start/stop dispatch tied
// to the correct IPC (lifecycle vs package). Lets row/console UIs
// stay one-liners.
export function useScriptRunner(
  worktree: Worktree,
  slot: ScriptSlot,
): ScriptRunner {
  const key = scriptKey(worktree.projectId, worktree.id, slot);
  const state = useScriptRunState(key);
  const busy = state.status === "starting" || state.status === "running";

  const start = () => {
    void scriptRuns
      .start({
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

  return { key, state, busy, start, stop };
}
