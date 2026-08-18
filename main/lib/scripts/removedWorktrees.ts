// Reaps scripts whose worktree was removed from outside the app.
//
// The app's own delete path kills first and removes second (see
// withDeleteInflight), so it never leaves anything behind. An `sm rm`
// run in a terminal cannot: the CLI is the engine and knows nothing
// about a GUI being attached, so the dev server the app started keeps
// running with its cwd deleted and its port still held. The state
// watcher's refresh is where the app finds out, and this is what it
// does about it.
//
// The diff needs a "worktrees that existed" side, and caching one here
// would be a second copy of state that goes stale the moment anything
// else moves. The running-script registry is that side already: a
// script only ever runs in a worktree that was there when it started,
// so every entry in getRunningScriptWorktrees() is a worktree the app
// watched exist. Nothing outlives the run it came from, and nothing is
// held per project.
import { existsSync } from "node:fs";
import type { Project } from "@shared/schemas";
import { listWorktreeIdentities } from "../git/worktrees";
import { loadProjects } from "../projects";
import {
  getInflightDeleteIds,
  getRunningScriptWorktrees,
  killScriptsForWorktree,
  type RunningScriptWorktree,
} from "./index";

// Worktrees whose kill chain is already running. A kill takes seconds
// in the worst case (SIGTERM, grace, SIGKILL) and the watcher can fire
// again inside that window, which would otherwise reap-and-report the
// same removal twice. Always cleared in a finally, so an entry can
// never outlive the kill it guards.
const reaping = new Set<string>();

// Killing a dev server the user is still using is worse than leaving a
// stray one running, so a worktree only counts as removed when two
// independent signals agree: git no longer lists it for the project,
// and its checkout is no longer on disk. A failed enumeration says
// nothing either way and is dropped whole (see below), and a listing
// that succeeds while the checkout's volume is offline still reports
// the worktree, so an unplugged drive reads as "still there".
async function findRemovedWorktrees(
  project: Project,
  candidates: RunningScriptWorktree[],
): Promise<RunningScriptWorktree[]> {
  let liveIds: Set<string>;
  try {
    const identities = await listWorktreeIdentities(project.id, project.path);
    liveIds = new Set(identities.map((identity) => identity.id));
  } catch {
    // Unreachable repo, mid-rebase index lock, a transient read error.
    // The enumeration failing is a fact about the enumeration, not
    // about the worktrees, so nothing in this project is a candidate.
    return [];
  }
  // A repo git can read always lists at least its primary checkout. An
  // empty result means the read went missing, not the worktrees.
  if (liveIds.size === 0) return [];
  return candidates.filter(
    (candidate) =>
      !liveIds.has(candidate.worktreeId) && !existsSync(candidate.worktreePath),
  );
}

function groupByProject(
  worktrees: RunningScriptWorktree[],
): Map<string, RunningScriptWorktree[]> {
  const byProject = new Map<string, RunningScriptWorktree[]>();
  for (const worktree of worktrees) {
    const bucket = byProject.get(worktree.projectId);
    if (bucket) bucket.push(worktree);
    else byProject.set(worktree.projectId, [worktree]);
  }
  return byProject;
}

// Returns the worktrees that were actually reaped so the caller can
// tell the renderer. Cheap when nothing is running: no scripts means no
// candidates and no git calls at all.
export async function reapScriptsForRemovedWorktrees(): Promise<
  RunningScriptWorktree[]
> {
  // An app-initiated delete or relocate already owns its worktree under
  // the tombstone protocol and has killed its scripts up front, so it
  // can never be double-fired from here.
  const inflight = getInflightDeleteIds();
  const candidates = getRunningScriptWorktrees().filter(
    (worktree) =>
      !inflight.has(worktree.worktreeId) && !reaping.has(worktree.worktreeId),
  );
  if (candidates.length === 0) return [];

  const projects = loadProjects();
  const perProject = await Promise.all(
    Array.from(groupByProject(candidates), ([projectId, group]) => {
      const project = projects.find((p) => p.id === projectId);
      // The project itself was unregistered. projects.remove reaps its
      // scripts on that path, and with no repo to ask there is nothing
      // to conclude here.
      return project ? findRemovedWorktrees(project, group) : [];
    }),
  );
  const removed = perProject.flat();
  if (removed.length === 0) return [];

  for (const worktree of removed) reaping.add(worktree.worktreeId);
  try {
    await Promise.all(
      removed.map((worktree) => killScriptsForWorktree(worktree.worktreeId)),
    );
  } finally {
    for (const worktree of removed) reaping.delete(worktree.worktreeId);
  }
  return removed;
}
