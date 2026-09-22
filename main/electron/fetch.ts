// Background `git fetch` for every registered project so refs/remotes/*
// doesn't drift between explicit pulls. Triggered on app ready, on window
// focus, and on a slow periodic timer. Broadcasts GitRefsRefreshed when a
// fetch actually ran so the renderer can invalidate ref-dependent queries.
// The periodic sweep also refreshes the project-wide PR cache (sidebar
// dots); focus does not, since the open worktree page has its own
// fresher per-branch PR query.
import { errorMessageOf } from "@shared/errors";
import { gitContract } from "@shared/ipc/modules/git";
import { githubCliContract } from "@shared/ipc/modules/githubCli";
import type { Project } from "@shared/schemas";
import { fetchAllRemotes, snapshotRemoteRefs } from "@host/lib/git/remotes";
import {
  pullRequestMapsEqual,
  readCachedProjectPullRequests,
  refreshProjectPullRequests,
} from "@host/lib/githubCli/pullRequests";
import { loadProjects } from "@host/lib/projects";
import { runningScriptWorktreeIds } from "@host/lib/scripts";
import { sweepAutoPull } from "@host/lib/worktrees/autoPullSweep";
import { announceProjectChanged } from "../ipc/handlers";
import { broadcastAll } from "../ipc/register";

// Skip if a fetch finished within this window. Short enough that rapid
// focus events don't feel stale, long enough that the focus + sweep +
// pre-action paths collapse onto one network round-trip.
const FRESHNESS_MS = 3_000;

// Periodic sweep keeps refs fresh even when the user never refocuses.
const SWEEP_INTERVAL_MS = 60_000;

const lastFetchedAt = new Map<string, number>();
// Projects whose last fetch attempt failed, so a run of failures warns once.
const failingProjects = new Set<string>();
// Per project, the worktrees whose auto-pull failed on the last sweep,
// so a run of failures warns once. Replaced whole on every sweep: a
// worktree that stops failing (pulled, skipped, unmarked, removed)
// drops out, and its next failure warns again.
const failingAutoPulls = new Map<string, ReadonlySet<string>>();
let sweepHandle: NodeJS.Timeout | null = null;

// Resolves to whether a fetch ran (false inside the freshness window).
export async function maybeFetchProject(
  projectId: string,
  projectPath: string,
): Promise<boolean> {
  const ts = lastFetchedAt.get(projectId) ?? 0;
  if (Date.now() - ts < FRESHNESS_MS) return false;
  broadcastAll(gitContract, "fetchActive", { projectId, active: true });
  try {
    const before = await snapshotRemoteRefs(projectPath);
    await fetchAllRemotes(projectPath);
    lastFetchedAt.set(projectId, Date.now());
    failingProjects.delete(projectId);
    const after = await snapshotRemoteRefs(projectPath);
    if (before !== after) {
      broadcastAll(gitContract, "refsRefreshed", { projectId });
    }
    // After every successful fetch, not only one that moved a ref: a
    // marked worktree that was dirty or busy at the last pass and is
    // clean now has the same upstream and still wants pulling.
    await autoPullProject(projectId, projectPath);
    return true;
  } catch (error) {
    // Leave refs stale and let the next attempt retry. Warn only on the way
    // into the failed state: lastFetchedAt advances on success only, so a
    // project that stays broken (offline, expired credentials) would
    // otherwise warn on every sweep, focus and navigation. Nothing else
    // reports it. The one caller that awaits this, refreshProject, voids
    // the promise, so the alternative is ahead/behind counts that quietly
    // stop moving.
    if (!failingProjects.has(projectId)) {
      failingProjects.add(projectId);
      console.warn(`[fetch] ${projectPath}: ${errorMessageOf(error)}`);
    }
  } finally {
    broadcastAll(gitContract, "fetchActive", { projectId, active: false });
  }
  return false;
}

// The explicit git:refreshProject request. Unlike the focus and timer
// paths it always ends in an auto-pull pass: the renderer sends it
// right after marking a worktree, and a fetch skipped as fresh must
// not leave that first pull waiting for the minute sweep.
export async function refreshProject(
  projectId: string,
  projectPath: string,
): Promise<void> {
  const fetched = await maybeFetchProject(projectId, projectPath);
  if (!fetched) await autoPullProject(projectId, projectPath);
}

// Fast-forward the project's auto-pull worktrees (autoPullSweep.ts).
// The merge is an app-run git command, so the git-directory watcher
// drops its ref move as the app's own: the project-scoped announcement
// the watcher would have made for an external pull comes from here.
// Never throws: a failed pull is one worktree's problem and must not
// read as a failed fetch.
async function autoPullProject(
  projectId: string,
  projectPath: string,
): Promise<void> {
  try {
    const { pulled, failed } = await sweepAutoPull(
      projectId,
      projectPath,
      runningScriptWorktreeIds(),
    );
    for (const { worktree, commits } of pulled) {
      console.log(
        `[auto-pull] ${worktree.path}: fast-forwarded ${commits} commit(s)`,
      );
    }
    const wasFailing = failingAutoPulls.get(projectId);
    for (const { worktree, message } of failed) {
      if (wasFailing?.has(worktree.id)) continue;
      console.warn(`[auto-pull] ${worktree.path}: ${message}`);
    }
    failingAutoPulls.set(projectId, new Set(failed.map((f) => f.worktree.id)));
    if (pulled.length > 0) announceProjectChanged(projectId);
  } catch (error) {
    console.warn(`[auto-pull] ${projectPath}: ${errorMessageOf(error)}`);
  }
}

async function sweepProjectPullRequests(
  projectId: string,
  projectPath: string,
): Promise<void> {
  try {
    const before = readCachedProjectPullRequests(projectPath);
    const after = await refreshProjectPullRequests(projectPath);
    if (!pullRequestMapsEqual(before, after)) {
      broadcastAll(githubCliContract, "projectPullRequestsRefreshed", {
        projectId,
      });
    }
  } catch {
    // PR data is decorative; swallow.
  }
}

// Both sweeps below run from callbacks with nobody to catch for them (a
// timer, the window-focus handler), and loadProjects throws when
// registry.json is unreadable. Skip the round rather than throw out of a
// callback: refs going stale is the mild half of that problem, and the
// UI's own reads of the same file report it.
function projectsToSweep(): Project[] {
  try {
    return loadProjects();
  } catch (error) {
    console.warn("[fetch] skipping sweep, projects unreadable:", error);
    return [];
  }
}

// Git-only refresh used by the window-focus handler. The PR sweep is
// timer-driven only. The open worktree page has its own per-branch
// query that handles focus.
export function refreshAllProjectGitRefs(): void {
  for (const project of projectsToSweep()) {
    void maybeFetchProject(project.id, project.path);
  }
}

function sweepAllProjects(): void {
  for (const project of projectsToSweep()) {
    void maybeFetchProject(project.id, project.path);
    void sweepProjectPullRequests(project.id, project.path);
  }
}

export function startBackgroundFetch(): void {
  if (sweepHandle) return;
  sweepAllProjects();
  sweepHandle = setInterval(sweepAllProjects, SWEEP_INTERVAL_MS);
}
