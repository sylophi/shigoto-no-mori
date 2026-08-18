// Per-project action usage log and the sidebar sort preference. Same
// rolling-window algorithm as the launcher row and package.json scripts list
// (see ../util/useLog) so the "most used" sort behaves identically across the
// app. Stored in the global state.json — sort and usage are app-managed UI
// state, not the user-editable per-project shigomori config.
import type { ProjectSortMode } from "@shared/schemas";
import { stateStore } from "../config/store";
import { countWithin, maxTimestamp, pruneAndPush } from "../util/useLog";

const USE_LOG_KEY = "projectUseLog";
const SORT_KEY = "projectsSort";

type UseLog = Record<string, number[]>;

// "manual" is the implicit default: a fresh install reads back "manual"
// without the key ever being written, so existing users keep their
// drag-arranged order until they pick a different sort.
const IMPLICIT_MODE: ProjectSortMode = "manual";

export interface ProjectUsage {
  lastUsed: number;
  recentCount: number;
}

// One line per app run, for the same reason as usageFailureLogged
// below: the reads guarded here run on every sidebar render and every
// refetch, so an unreadable file would log forever. Its own flag
// rather than a shared one, which would let whichever failure came
// first hide the other.
let hintFailureLogged = false;

function noteHintFailure(error: unknown): void {
  if (hintFailureLogged) return;
  hintFailureLogged = true;
  console.warn(
    "[usage] project usage and sort unavailable, falling back:",
    error,
  );
}

// state.json is display-only from here on. The project list and the
// shelf live in registry.json, so an unreadable state.json should cost
// the sidebar its usage decoration and its sort preference, nothing
// more. The store throws on a read it can't trust, which is what stops
// a write from rebuilding the file out of nothing, and that guarantee
// belongs to writes. These two reads fall back instead, so the list
// still loads. bumpProjectUseCount below deliberately does not.
function readStateHint<T>(key: string, fallback: T): T {
  try {
    return stateStore.readKey<T>(key, fallback);
  } catch (error) {
    noteHintFailure(error);
    return fallback;
  }
}

export function readProjectSort(): ProjectSortMode {
  return readStateHint<ProjectSortMode>(SORT_KEY, IMPLICIT_MODE);
}

export function writeProjectSort(mode: ProjectSortMode): void {
  stateStore.writeKey<ProjectSortMode>(SORT_KEY, mode);
}

export function usageFor(projectIds: string[]): Record<string, ProjectUsage> {
  const log = readStateHint<UseLog>(USE_LOG_KEY, {});
  const now = Date.now();
  const out: Record<string, ProjectUsage> = {};
  for (const id of projectIds) {
    const timestamps = log[id] ?? [];
    out[id] = {
      lastUsed: maxTimestamp(timestamps),
      recentCount: countWithin(timestamps, now),
    };
  }
  return out;
}

export function bumpProjectUseCount(projectId: string): void {
  const log = stateStore.readKey<UseLog>(USE_LOG_KEY, {});
  log[projectId] = pruneAndPush(log[projectId] ?? [], Date.now());
  stateStore.writeKey<UseLog>(USE_LOG_KEY, log);
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
