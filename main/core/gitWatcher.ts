// Watches every registered project's git directory so a commit, a
// checkout, a branch created or deleted, a rebase or a fetch made by
// ANY tool (an agent in a terminal, an editor, plain git) shows up in
// the app within a debounce, on this machine and on every device
// viewing it, instead of on the next focus or the minute sweep. The
// state watcher (stateWatcher.ts) covers the managed root, which is
// where sm's own bookkeeping lives. The git facts a worktree row shows
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
// big to watch). Dirty state still refreshes on focus and on every
// other ping, and the moment the edit is committed the ref moves and
// this fires.
//
// The signal is project scoped (git:projectChanged) rather than the
// broad externalChange sweep: a commit in one repo says nothing about
// another project's rows. The app's own git operations move refs the
// same way, so the owner injects a suppression (a running sm CLI
// child, the echo window after an app-run mutating git command) and
// those are skipped exactly like the state watcher skips the app's
// own root writes: their callers already invalidate their targets.
//
// One fiber per watched project: the fs.watch events feed a Stream,
// debounced, and each element is one change signal. The watch handle
// is owned by the stream's scope, so dropping a project is interrupting
// its fiber and there is no timer to clear.
import { type FSWatcher, readFileSync, statSync, watch } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { Effect, Fiber, Queue, Stream } from "effect";
import type { Project } from "@shared/schemas";
import { loadProjects } from "@host/lib/projects";

const DEBOUNCE_MS = 300;

// Git-dir relative paths whose change means the project's git state
// moved. Paths arrive with the platform separator and are normalized
// to `/` before matching.
const RELEVANT = [
  /^(HEAD|ORIG_HEAD|packed-refs)$/,
  /^refs(\/|$)/,
  /^worktrees\/[^/]+(\/(HEAD|ORIG_HEAD))?$/,
];

// Exported for the git-watcher check, which pins the allowlist: the
// loop-safety of this watcher rests on it.
export function isRelevantGitPath(file: string): boolean {
  // Every ref write goes through a `.lock` sibling that is renamed
  // into place. The rename lands as an event for the final name, so
  // the lock itself is noise.
  if (file.endsWith(".lock")) return false;
  const normalized = file.includes("\\") ? file.replaceAll("\\", "/") : file;
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
  fiber: Fiber.Fiber<void>;
};

export type GitWatcherDeps = {
  onChange: (projectId: string) => void;
  // Whether events from the named git directory should be dropped
  // right now: the app's own git activity there (a running sm CLI
  // child, an app-run mutating git command in flight or just done),
  // already invalidated by its caller.
  suppressed: (gitDir: string) => boolean;
  // The projects to follow. Defaults to the registry. The git-watcher
  // check injects its own list against a sandbox repository.
  projects?: () => Project[];
};

const watched = new Map<string, Watched>();
let deps: GitWatcherDeps | null = null;

// The relevant, unsuppressed events of one git directory, as they
// land. The watch handle lives in the stream's scope: it opens when
// the stream starts and closes when the stream ends, however it ends.
// A watch that cannot open (vanished between the stat and the watch,
// or a platform without recursive watches), or that errors later (the
// repository deleted or unmounted), ends the stream, and a later
// reconcile tries again.
function gitDirEvents(
  gitDir: string,
  suppressed: (gitDir: string) => boolean,
): Stream.Stream<string> {
  return Stream.callback<string>((queue) =>
    Effect.acquireRelease(
      // A synchronous throw from fs.watch is the "not watchable" case,
      // so it is caught here: inside Effect.sync it would be a defect,
      // which no catch below would see.
      Effect.sync(() => {
        let watcher: FSWatcher;
        try {
          watcher = watch(gitDir, { recursive: true, persistent: false });
        } catch {
          return null;
        }
        watcher.on("change", (_eventType, file) => {
          if (typeof file !== "string" || !isRelevantGitPath(file)) return;
          // Checked at event time, not after the debounce, mirroring
          // the state watcher: a CLI child finishing right after an
          // external commit must not swallow the refresh that commit
          // deserves.
          if (suppressed(gitDir)) return;
          Queue.offerUnsafe(queue, file);
        });
        watcher.on("error", () => {
          Queue.endUnsafe(queue);
        });
        return watcher;
      }),
      (watcher) =>
        Effect.sync(() => {
          if (watcher === null) Queue.endUnsafe(queue);
          else watcher.close();
        }),
    ).pipe(
      // A watch that never opened ends the stream at once.
      Effect.flatMap((watcher) =>
        watcher === null ? Queue.end(queue) : Effect.succeed(true),
      ),
    ),
  );
}

function watchProject(
  projectId: string,
  gitDir: string,
  current: GitWatcherDeps,
): Effect.Effect<void> {
  return gitDirEvents(gitDir, current.suppressed).pipe(
    Stream.debounce(DEBOUNCE_MS),
    Stream.runForEach(() =>
      Effect.sync(() => {
        // Contained: a throw would end this project's watch with a
        // defect nothing reports.
        try {
          current.onChange(projectId);
        } catch (error) {
          console.warn(`[git-watcher] onChange threw: ${String(error)}`);
        }
      }),
    ),
  );
}

function closeWatched(projectId: string, entry: Watched): void {
  if (watched.get(projectId) === entry) watched.delete(projectId);
  Effect.runFork(Fiber.interrupt(entry.fiber));
}

function openWatched(
  projectId: string,
  gitDir: string,
  current: GitWatcherDeps,
): void {
  const entry: Watched = {
    gitDir,
    fiber: Effect.runFork(
      watchProject(projectId, gitDir, current).pipe(
        // However the stream ends (the watch failed to open, the
        // repository went away), the entry goes with it so the next
        // reconcile can open it again.
        Effect.ensuring(
          Effect.sync(() => {
            if (watched.get(projectId) === entry) watched.delete(projectId);
          }),
        ),
      ),
    ),
  };
  watched.set(projectId, entry);
}

// Bring the watched set in line with the registry: one watch per
// project whose git directory resolves, dropped when the project
// leaves the registry or its git directory moves. Runs at boot, on
// every managed-root change (a CLI or an external write) and after
// every settled host mutation (an app-side add or remove runs as a CLI
// child whose write the state watcher drops as the app's own), which
// together cover every way a project is added, removed or relocated.
export function reconcileGitWatchers(): void {
  if (deps === null) return;
  const current = deps;
  let projects: Project[];
  try {
    projects = (current.projects ?? loadProjects)();
  } catch {
    // The registry is unreadable right now, so keep what is watched.
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
    if (!watched.has(projectId)) openWatched(projectId, gitDir, current);
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
