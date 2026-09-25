// Per-project action usage log: every successful action whose contract
// entry sets `tracksProjectUsage` counts as a use of its project. The
// app records the uses (they are the app's UI actions, not CLI verbs),
// and the CLI reads the log back into the project list's lastUsed and
// recentCount (`sm projects list`, cli/cmd_project_list.go), which
// feed the sidebar's recency and frequency sorts. Stored in the global
// state.json, since usage is app-managed state, not the user-editable
// per-project config.
import { stateStore } from "../config/store";

const USE_LOG_KEY = "projectUseLog";

// The rolling window the readers count uses in (useStatOf in
// cli/launchers.go): older timestamps are pruned on each bump.
const USE_LOG_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

type UseLog = Record<string, number[]>;

function bumpProjectUseCount(projectId: string): void {
  // updateKey so the read happens under the cross-process lock: the CLI
  // writes state.json too (its own use logs), and a read taken outside
  // the lock would clobber a concurrent write.
  stateStore.updateKey<UseLog>(USE_LOG_KEY, {}, (log) => {
    const now = Date.now();
    const cutoff = now - USE_LOG_WINDOW_MS;
    log[projectId] = [
      ...(log[projectId] ?? []).filter((t) => t >= cutoff),
      now,
    ];
    return log;
  });
}

function hasStringProjectId(input: unknown): input is { projectId: string } {
  return (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { projectId?: unknown }).projectId === "string" &&
    (input as { projectId: string }).projectId.length > 0
  );
}

// The store throws when state.json can't be read, and this runs after
// roughly every action, so an unreadable file would log on every click.
// One line per app run is enough to point at the cause, and the user's
// next real action (adding a project, shelving a worktree) goes through
// the same store and surfaces the error in the UI.
let usageFailureLogged = false;

// Called from the IPC registrar after an action whose contract entry sets
// `tracksProjectUsage` succeeds. Bumps the project named by the payload and
// returns its id so the caller can notify the renderer to refresh its
// usage-sorted list, or null if the payload had no project to attribute.
// Best-effort: never let a stats write break the handler.
export function recordProjectActionUsage(input: unknown): string | null {
  if (!hasStringProjectId(input)) return null;
  try {
    bumpProjectUseCount(input.projectId);
    return input.projectId;
  } catch (error) {
    // Usage tracking is best-effort, so the action the user asked for
    // still counts as a success. Log rather than swallow outright.
    if (!usageFailureLogged) {
      usageFailureLogged = true;
      console.warn("[usage] project use log not recorded:", error);
    }
    return null;
  }
}
