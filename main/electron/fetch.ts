// Background `git fetch` for every registered project so refs/remotes/*
// doesn't drift between explicit pulls, plus the project-wide PR cache
// refresh (sidebar dots). Runs on app ready, on window focus, on a slow
// periodic timer while a window here is focused, and on a peer's
// git:sweep request (a peer asks when its own window focuses). The
// timer sits out while nothing here is focused: the results go to
// this window (fresh again on the focus sweep) and to peers (who ask
// for themselves), so an unattended sweep is a git and a gh spawn per
// project every minute that nobody reads. Broadcasts GitRefsRefreshed
// when a fetch actually changed something so the renderer can
// invalidate ref-dependent queries.
import { BrowserWindow } from "electron";
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
import { broadcastAll } from "../ipc/register";

// Skip if a fetch finished within this window. Short enough that rapid
// focus events don't feel stale, long enough that the focus, sweep,
// peer-request and pre-action paths collapse onto one network
// round-trip.
const FRESHNESS_MS = 3_000;

// Periodic sweep keeps refs fresh while the user sits on the window
// without refocusing it.
const SWEEP_INTERVAL_MS = 60_000;

const lastFetchedAt = new Map<string, number>();
const lastPullRequestSweepAt = new Map<string, number>();
// Projects whose last fetch attempt failed, so a run of failures warns once.
const failingProjects = new Set<string>();
let sweepHandle: NodeJS.Timeout | null = null;

export async function maybeFetchProject(
  projectId: string,
  projectPath: string,
): Promise<void> {
  const ts = lastFetchedAt.get(projectId) ?? 0;
  if (Date.now() - ts < FRESHNESS_MS) return;
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
}

async function sweepProjectPullRequests(
  projectId: string,
  projectPath: string,
): Promise<void> {
  // Same freshness window as the git fetch, so a focus landing on a
  // timer tick (or two peers focusing together) runs gh once.
  const ts = lastPullRequestSweepAt.get(projectId) ?? 0;
  if (Date.now() - ts < FRESHNESS_MS) return;
  lastPullRequestSweepAt.set(projectId, Date.now());
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

// One full pass: refs and PRs for every project. The window-focus
// handler and a peer's git:sweep call this directly, so returning to
// the window (here or on a peer) catches the sidebar dots up at once
// rather than on the next timer tick.
export function sweepProjects(): void {
  for (const project of projectsToSweep()) {
    void maybeFetchProject(project.id, project.path);
    void sweepProjectPullRequests(project.id, project.path);
  }
}

function sweepIfAttended(): void {
  if (BrowserWindow.getFocusedWindow() === null) return;
  sweepProjects();
}

export function startBackgroundFetch(): void {
  if (sweepHandle) return;
  sweepProjects();
  sweepHandle = setInterval(sweepIfAttended, SWEEP_INTERVAL_MS);
}
