// Background `git fetch` for every registered project so refs/remotes/*
// doesn't drift between explicit pulls, plus the project-wide PR cache
// refresh (sidebar dots). One timer, ticking only while someone is
// looking: a window here is focused, or a peer said so through
// git:sweep within its lease. An unattended sweep is a git and a gh
// spawn per project every minute that nobody reads, and whoever
// returns (this window on focus, a peer on its focus or its session
// landing) asks for a pass at that moment. Broadcasts refsRefreshed
// and projectPullRequestsRefreshed when a pass changed something so
// the renderer, local or peer, can invalidate.
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
// focus events don't feel stale, long enough that the focus, sweep and
// pre-action paths collapse onto one network round-trip.
const FRESHNESS_MS = 3_000;

// The timer's cadence while attended, and the staleness a peer's
// request tolerates: a peer asking is the peer catching up on what the
// timer would have kept within this age anyway, so a request landing
// on a host that is already ticking is nearly free. The PR refresh
// uses it on every path, since gh is a rate-limited API call and the
// open worktree page refreshes its own PR on focus.
const SWEEP_INTERVAL_MS = 60_000;

// A peer's request keeps the timer ticking this long, so a peer that
// renews once per interval never sees it lapse.
const ATTENTION_LEASE_MS = 2 * SWEEP_INTERVAL_MS;

const lastFetchedAt = new Map<string, number>();
const fetchInFlight = new Map<string, Promise<void>>();
const lastPullRequestSweepAt = new Map<string, number>();
// Projects whose last fetch attempt failed, so a run of failures warns once.
const failingProjects = new Set<string>();
let sweepHandle: NodeJS.Timeout | null = null;
let attendedUntil = 0;

export function maybeFetchProject(
  projectId: string,
  projectPath: string,
  maxAgeMs = FRESHNESS_MS,
): Promise<void> {
  const ts = lastFetchedAt.get(projectId) ?? 0;
  if (Date.now() - ts < maxAgeMs) return Promise.resolve();
  // A request landing while a fetch is running joins it rather than
  // spawning a second git behind the same network round trip.
  const running = fetchInFlight.get(projectId);
  if (running) return running;
  const attempt = fetchProject(projectId, projectPath).finally(() => {
    fetchInFlight.delete(projectId);
  });
  fetchInFlight.set(projectId, attempt);
  return attempt;
}

async function fetchProject(
  projectId: string,
  projectPath: string,
): Promise<void> {
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
  const ts = lastPullRequestSweepAt.get(projectId) ?? 0;
  if (Date.now() - ts < SWEEP_INTERVAL_MS) return;
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

// The sweeps run from callbacks with nobody to catch for them (a
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

// One pass over every project. The timer and the window-focus handler
// take the fetch freshness default. A peer's request passes the sweep
// interval: what it wants is the timer's guarantee, not a fresh fetch.
export function sweepProjects(refsMaxAgeMs = FRESHNESS_MS): void {
  for (const project of projectsToSweep()) {
    void maybeFetchProject(project.id, project.path, refsMaxAgeMs);
    void sweepProjectPullRequests(project.id, project.path);
  }
}

// git:sweep. Returns the lease so the peer knows how often to renew.
export function sweepForPeer(): { leaseMs: number } {
  attendedUntil = Date.now() + ATTENTION_LEASE_MS;
  sweepProjects(SWEEP_INTERVAL_MS);
  return { leaseMs: ATTENTION_LEASE_MS };
}

function sweepIfAttended(): void {
  const attended =
    BrowserWindow.getFocusedWindow() !== null || Date.now() < attendedUntil;
  if (attended) sweepProjects();
}

export function startBackgroundFetch(): void {
  if (sweepHandle) return;
  sweepProjects();
  sweepHandle = setInterval(sweepIfAttended, SWEEP_INTERVAL_MS);
}
