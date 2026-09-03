// Watches every registered project's git directory so a commit, a
// checkout, a branch created or deleted, a rebase or a fetch made by
// ANY tool (an agent in a terminal, an editor, plain git) shows up in
// the app within a debounce, on this machine and on every device
// viewing it, instead of on the next focus or the minute sweep. The
// state watcher (stateWatcher.ts) covers the managed root, which is
// where sm's own bookkeeping lives; the git facts a worktree row shows
// (branch, tip, ahead/behind) live in the PROJECT's git directory, and
// a linked worktree's metadata lives under its `worktrees/<name>/`
// there too, so one recursive watch per project covers every worktree
// of it.
//
// What counts as a change is an ALLOWLIST of git-dir paths (HEAD,
// packed-refs, refs/**, a worktree's HEAD, a worktree entry appearing
// or vanishing), not "anything under .git": objects/ churns on every
// commit, logs/ mirrors every ref update, FETCH_HEAD is rewritten by
// the app's own minute sweep, and `index` is refreshed by the very
// `git status` the app runs to list a worktree, which would loop a
// refetch into another refetch. Uncommitted file edits are therefore
// NOT observed here (they live in the working tree, which is far too
// big to watch); dirty state still refreshes on focus and on every
// other ping, and the moment the edit is committed the ref moves and
// this fires.
//
// The signal is project scoped (git:projectChanged) rather than the
// broad externalChange sweep: a commit in one repo says nothing about
// another project's rows, and the app's own git operations trip this
// watcher too (the ref moves the same way), so the ping must stay
// cheap enough to be redundant beside the mutation's own targeted
// invalidation. Writes by a running sm CLI child are skipped exactly
// like the state watcher does: those are the app's own lifecycle
// operations, already invalidating their targets.
import { type FSWatcher, readFileSync, statSync, watch } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Project } from "@shared/schemas";
import { loadProjects } from "@host/lib/projects";

const DEBOUNCE_MS = 300;

// Git-dir relative paths whose change means the project's git state
// moved. Paths arrive with the platform separator; normalized to `/`
// before matching.
const RELEVANT = [
  /^HEAD$/,
  /^ORIG_HEAD$/,
  /^packed-refs$/,
  /^refs(\/|$)/,
  /^worktrees\/[^/]+$/,
  /^worktrees\/[^/]+\/(HEAD|ORIG_HEAD)$/,
];

// Exported for the git-watcher check, which pins the allowlist: the
// loop-safety of this watcher rests on it.
export function isRelevantGitPath(file: string): boolean {
  // Every ref write goes through a `.lock` sibling that is renamed
  // into place; the rename lands as an event for the final name, so
  // the lock itself is noise.
  if (file.endsWith(".lock")) return false;
  const normalized = file.split("\\").join("/");
  return RELEVANT.some((pattern) => pattern.test(normalized));
}

// The directory holding a project's refs: `.git` itself for an
// ordinary checkout, or the common dir behind a `.git` FILE (the
// project path is itself a linked worktree, or a submodule). Null
// when the path has no git directory (missing, or not a repo).
export function gitDirOf(projectPath: string): string | null {
  const dotGit = join(projectPath, ".git");
  let text: string;
  try {
    const stat = statSync(dotGit);
    if (stat.isDirectory()) return dotGit;
    if (!stat.isFile()) return null;
    text = readFileSync(dotGit, "utf8");
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(text);
  if (match === null) return null;
  const pointed = match[1].trim();
  const gitDir = isAbsolute(pointed) ? pointed : resolve(projectPath, pointed);
  // A linked worktree's git dir names its repository's common dir,
  // which is where the refs live.
  try {
    const common = readFileSync(join(gitDir, "commondir"), "utf8").trim();
    return isAbsolute(common) ? common : resolve(gitDir, common);
  } catch {
    return gitDir;
  }
}

type Watched = {
  gitDir: string;
  watcher: FSWatcher;
  timer: NodeJS.Timeout | null;
};

export type GitWatcherDeps = {
  onChange: (projectId: string) => void;
  // Whether events should be dropped right now (a running sm CLI
  // child, whose ref writes are the app's own lifecycle operation).
  suppressed: () => boolean;
  // The projects to follow. Defaults to the registry; the git-watcher
  // check injects its own list against a sandbox repository.
  projects?: () => Project[];
};

const watched = new Map<string, Watched>();
let deps: GitWatcherDeps | null = null;

function closeWatched(projectId: string, entry: Watched): void {
  if (entry.timer !== null) clearTimeout(entry.timer);
  entry.watcher.close();
  if (watched.get(projectId) === entry) watched.delete(projectId);
}

function openWatched(projectId: string, gitDir: string): void {
  let watcher: FSWatcher;
  try {
    watcher = watch(gitDir, { recursive: true, persistent: false });
  } catch {
    // Not watchable right now (vanished between the stat and the
    // watch, or a platform without recursive watches). The next
    // reconcile tries again.
    return;
  }
  const entry: Watched = { gitDir, watcher, timer: null };
  watcher.on("change", (_eventType, file) => {
    if (deps === null || typeof file !== "string" || !isRelevantGitPath(file))
      return;
    // Checked at event time, not timer time, mirroring the state
    // watcher: a CLI child finishing right after an external commit
    // must not swallow the refresh that commit deserves.
    if (deps.suppressed()) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      deps?.onChange(projectId);
    }, DEBOUNCE_MS);
  });
  watcher.on("error", () => {
    // The repository went away (deleted, unmounted). Drop the watch;
    // a later reconcile re-adds it if it comes back.
    closeWatched(projectId, entry);
  });
  watched.set(projectId, entry);
}

// Bring the watched set in line with the registry: one watch per
// project whose git directory resolves, dropped when the project
// leaves the registry or its git directory moves. Cheap (one small
// JSON read plus a stat per project), so it runs at boot, on every
// managed-root change and after every host mutation settles, which
// together cover every way a project is added, removed or relocated.
export function reconcileGitWatchers(): void {
  if (deps === null) return;
  let projects: Project[];
  try {
    projects = (deps.projects ?? loadProjects)();
  } catch {
    // The registry is unreadable right now; keep what is watched.
    return;
  }
  const wanted = new Map<string, string>();
  for (const project of projects) {
    const gitDir = gitDirOf(project.path);
    if (gitDir !== null) wanted.set(project.id, gitDir);
  }
  for (const [projectId, entry] of watched) {
    if (wanted.get(projectId) !== entry.gitDir) closeWatched(projectId, entry);
  }
  for (const [projectId, gitDir] of wanted) {
    if (!watched.has(projectId)) openWatched(projectId, gitDir);
  }
}

export function startGitWatcher(next: GitWatcherDeps): void {
  deps = next;
  reconcileGitWatchers();
}

// Close every watch and forget the deps, for the check's teardown (the
// app never stops watching: the watches are non-persistent handles
// that die with the process).
export function stopGitWatcher(): void {
  for (const [projectId, entry] of watched) closeWatched(projectId, entry);
  deps = null;
}
