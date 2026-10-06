import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { runningScriptsQueryOptions } from "@/hooks/live/useLiveActivity";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { peerReadOnlyNote } from "@/lib/commandAccessCopy";
import { notifyError } from "@/lib/toast";
import {
  EMPTY_STATE,
  scriptKey,
  type ScriptKey,
  type ScriptRunState,
  type ScriptSlot,
} from "@/store/scriptRuns";
import { lifecycleScriptName, type Worktree } from "@shared/schemas";
import { useScriptRuns, useScriptRunState } from "./useScriptRuns";

export interface ScriptRunner {
  key: ScriptKey;
  // This window's run of the slot, or one the host has that this window
  // does not hold (started by another window or device, or before a
  // reload), read as running from the host's list.
  state: ScriptRunState;
  busy: boolean;
  // Whether a run can be dispatched from here. A run is a command, so
  // on a peer it waits for that device's grant. Locally always true.
  // `disabledReason` is the tip the UI shows on the dead affordance.
  canRun: boolean;
  disabledReason: string | undefined;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  // Drops a finished run's log and state (a no-op while it runs).
  clear: () => void;
}

// Bundles the per-script run state with the start/stop dispatch tied
// to the correct IPC (lifecycle vs package), on whichever device the
// host scope names: the run is dispatched over that device's api and
// its output streams back into that device's store. Lets row/console
// UIs stay one-liners.
//
// A run held elsewhere reads as running here off the host's list, and
// stops by its id. Its output is only followed (`follow`, attaching
// this window to the run) where it is shown, the console: a button
// that only needs to know the run is up costs no stream.
export function useScriptRunner(
  worktree: Pick<Worktree, "projectId" | "id">,
  slot: ScriptSlot,
  { follow = false }: { follow?: boolean } = {},
): ScriptRunner {
  const { api, deviceId } = useHostScope();
  const store = useScriptRuns();
  const { canCommand: canRun } = useCommandAccess();
  const key = scriptKey(worktree.projectId, worktree.id, slot);
  const held = useScriptRunState(key);
  const listed = useQuery({
    ...runningScriptsQueryOptions(deviceId, api),
    select: (runs) =>
      runs.find(
        (run) => scriptKey(run.projectId, run.worktreeId, run.slot) === key,
      ),
  }).data;
  const elsewhere =
    listed !== undefined &&
    listed.runId !== held.runId &&
    held.status !== "starting"
      ? listed
      : undefined;
  useEffect(() => {
    if (follow && canRun && elsewhere) void store.attach(elsewhere);
  }, [follow, canRun, elsewhere, store]);

  // A stop of a run held elsewhere has no record here to say so, so
  // this one does until the run leaves the list.
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null);
  const state: ScriptRunState = elsewhere
    ? {
        ...EMPTY_STATE,
        runId: elsewhere.runId,
        status: "running",
        interactive: elsewhere.interactive,
        startedAt: elsewhere.startedAt,
        cancelling: stoppingRunId === elsewhere.runId,
      }
    : held;
  const busy = state.status === "starting" || state.status === "running";

  const start = () => {
    if (!canRun) return Promise.resolve();
    return store
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
            script: lifecycleScriptName(slot),
          });
        },
      })
      .catch(() => {
        // Failure surfaces on state.status === "errored".
      });
  };

  const stop = async () => {
    if (!elsewhere) return store.cancel(key);
    setStoppingRunId(elsewhere.runId);
    try {
      await store.stopRun(elsewhere);
    } catch (error) {
      setStoppingRunId(null);
      notifyError("Couldn't stop the script", error);
    }
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
