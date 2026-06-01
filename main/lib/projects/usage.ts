// Per-project action usage log and the sidebar sort preference. Same
// rolling-window algorithm as the launcher row and package.json scripts list
// (see ../util/useLog) so the "most used" sort behaves identically across the
// app. Stored in the global state.json — sort and usage are app-managed UI
// state, not the user-editable per-project shigomori config.
import type { ProjectSortMode } from "@shared/schemas";
import { readKey, writeKey } from "../config/store";
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

export function readProjectSort(): ProjectSortMode {
  return readKey<ProjectSortMode>(SORT_KEY, IMPLICIT_MODE);
}

export function writeProjectSort(mode: ProjectSortMode): void {
  writeKey<ProjectSortMode>(SORT_KEY, mode);
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

// Channels that read/observe project state, or only change how it's viewed,
// without the user "doing" anything with the project. Excluded from usage
// tracking so merely viewing a project (or tweaking a view preference like the
// scripts sort) never bumps its rank.
const READ_CHANNELS = new Set<string>([
  "projects:list",
  "projects:defaultBranch",
  "projects:listBranches",
  "projects:pickWorktreeName",
  "projects:listIgnoredPaths",
  "projects:icon",
  "worktrees:list",
  "worktrees:diff",
  "worktrees:commitDiff",
  "worktrees:listCommits",
  "packageScripts:list",
  "packageScripts:getSort",
  // View-only preference: which order the scripts list is shown in.
  "packageScripts:setSort",
  "shigomori:read",
  "worktreeData:read",
  "githubCli:readiness",
  "githubCli:projectPullRequests",
  "githubCli:worktreePullRequest",
  "githubCli:repoMergeConfig",
  "githubCli:pullRequestDiff",
  "launchers:forProject",
  "portPool:isActive",
]);

function hasStringProjectId(input: unknown): input is { projectId: string } {
  return (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { projectId?: unknown }).projectId === "string" &&
    (input as { projectId: string }).projectId.length > 0
  );
}

// Called from the IPC registrar after a handler succeeds. Any project-scoped
// action (anything carrying a projectId that isn't a passive read) counts as
// using that project. Returns the bumped projectId so the caller can notify
// the renderer to refresh its usage-sorted list, or null if nothing was
// recorded. Best-effort: never let a stats write break the handler.
export function recordProjectActionUsage(
  channel: string,
  input: unknown,
): string | null {
  if (READ_CHANNELS.has(channel)) return null;
  if (!hasStringProjectId(input)) return null;
  try {
    bumpProjectUseCount(input.projectId);
    return input.projectId;
  } catch {
    // Usage tracking is best-effort; swallow so it can't fail the action.
    return null;
  }
}
