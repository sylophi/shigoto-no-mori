// Opt-in: fire the project's chosen launch set on a worktree that has
// just finished being created. Sits next to the lifecycle store rather
// than inside the detail page because setup can outlast the page --
// the user creates a worktree, wanders off to another one, and the
// tools should still open in the worktree they asked for.
//
// Nothing here runs for a project without `autoLaunchSetId`, which is
// every project until someone flips the switch in Configure.
import { runLaunchSet } from "@/lib/launchSet";
import { notifyError } from "@/lib/toast";
import { scriptKey, scriptRuns } from "./scriptRuns";

interface CreateSettled {
  projectId: string;
  worktreeId: string;
}

// Re-entrancy guard only. Main emits one terminal phase per create, so
// this isn't what makes the launch happen once; it just makes a repeat
// event a no-op. Ids clear when the run finishes, because worktree ids
// are path-derived: recreating a worktree at the same path reuses the
// id and deserves its tools again.
const inFlight = new Set<string>();

export async function autoLaunchOnCreate(evt: CreateSettled): Promise<void> {
  const { projectId, worktreeId } = evt;
  if (inFlight.has(worktreeId)) return;
  inFlight.add(worktreeId);
  try {
    // Read through IPC rather than the query cache: this fires without
    // any component mounted, so there may be no cached config at all.
    const config = await window.api.shigomori.read(projectId);
    const setId = config?.autoLaunchSetId;
    if (!setId) return;
    const set = config?.launchSets?.find((s) => s.id === setId);
    if (!set || set.launcherIds.length === 0) return;
    if (setupFailed(projectId, worktreeId)) return;
    await runLaunchSet({ projectId, worktreeId, set });
  } catch (err) {
    // runLaunchSet reports its own failures; anything here is the config
    // read falling over, which the user can't otherwise see.
    notifyError("Couldn't check auto-launch settings", err);
  } finally {
    inFlight.delete(worktreeId);
  }
}

// A worktree whose setup script failed isn't ready, and opening an
// editor plus an agent on it papers over the warning the user just got.
// The exit is already recorded here: main awaits the script before it
// emits the terminal phase, and both travel the same ordered channel.
// A setup script that never ran leaves the slot idle, which is fine --
// most projects have no setup at all.
function setupFailed(projectId: string, worktreeId: string): boolean {
  const state = scriptRuns.snapshot(
    scriptKey(projectId, worktreeId, { kind: "setup" }),
  );
  if (state.status === "errored") return true;
  // Cancelled runs land here too (null exit code), and a worktree whose
  // setup the user killed shouldn't spring open either.
  return state.status === "exited" && state.exitCode !== 0;
}
