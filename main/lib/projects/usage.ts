// Per-project action usage log and the sidebar's per-user view state
// (sort preference, collapsed set). Usage uses the same rolling-window
// algorithm as the launcher row and package.json scripts list (see
// ../util/useLog) so the "most used" sort behaves identically across the
// app. Stored in the global state.json — all of this is app-managed UI
// state, not the user-editable per-project shigomori config.
import type { ProjectSortMode } from "@shared/schemas";
import { readKey, writeKey } from "../config/store";
import { countWithin, maxTimestamp, pruneAndPush } from "../util/useLog";

const USE_LOG_KEY = "projectUseLog";
const SORT_KEY = "projectsSort";
const COLLAPSED_KEY = "projectsCollapsed";

type UseLog = Record<string, number[]>;

// "manual" is the implicit default: a fresh install reads back "manual"
// without the key ever being written, so existing users keep their
// drag-arranged order until they pick a different sort.
const IMPLICIT_MODE: ProjectSortMode = "manual";

export interface ProjectUsage {
  lastUsed: number;
  recentCount: number;
}

export function readProjectSort(): ProjectSortMode {
  return readKey<ProjectSortMode>(SORT_KEY, IMPLICIT_MODE);
}

export function writeProjectSort(mode: ProjectSortMode): void {
  writeKey<ProjectSortMode>(SORT_KEY, mode);
}

export function readCollapsedProjects(): string[] {
  return readKey<string[]>(COLLAPSED_KEY, []);
}

export function writeCollapsedProjects(ids: string[]): void {
  writeKey<string[]>(COLLAPSED_KEY, ids);
}

export function usageFor(projectIds: string[]): Record<string, ProjectUsage> {
  const log = readKey<UseLog>(USE_LOG_KEY, {});
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
  const log = readKey<UseLog>(USE_LOG_KEY, {});
  log[projectId] = pruneAndPush(log[projectId] ?? [], Date.now());
  writeKey<UseLog>(USE_LOG_KEY, log);
}

function hasStringProjectId(input: unknown): input is { projectId: string } {
  return (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { projectId?: unknown }).projectId === "string" &&
    (input as { projectId: string }).projectId.length > 0
  );
}

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
  } catch {
    // Usage tracking is best-effort; swallow so it can't fail the action.
    return null;
  }
}
