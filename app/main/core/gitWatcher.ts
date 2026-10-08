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
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Project } from "@shigomori/contracts/schemas";
import { loadProjects } from "@host/lib/projects";
import * as PromiseAdapter from "@host/lib/util/promiseAdapter";

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
  const pointed = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
  if (pointed === undefined) return null;
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

export class GitWatcher extends Context.Service<
  GitWatcher,
  {
    // Bring the watched set in line with the registry: one watch per
    // project whose git directory resolves, dropped when the project
    // leaves the registry or its git directory moves. Runs at boot, on
    // every managed-root change (a CLI or an external write) and after
    // every settled host mutation (an app-side add or remove runs as a
    // CLI child whose write the state watcher drops as the app's own),
    // which together cover every way a project is added, removed or
    // relocated.
    readonly reconcile: Effect.Effect<void>;
  }
>()("sm/main/GitWatcher") {}

const make = (deps: GitWatcherDeps) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // Each watched project's git directory and the fiber watching it.
    const watches = yield* FiberMap.make<string>();
    // What each running watch watches. Written only under `serial`, so
    // two reconciles fired at once (an external change and a settled
    // mutation) cannot interleave their reads of the registry.
    const gitDirs = new Map<string, { readonly gitDir: string }>();
    const serial = yield* Semaphore.make(1);

    // One project's pings: its git directory's relevant changes,
    // debounced. Suppression is checked at event time, not when the
    // debounce fires, mirroring the state watcher: a CLI child finishing
    // right after an external commit must not swallow the refresh that
    // commit deserves.
    const watch = (projectId: string, entry: { readonly gitDir: string }) =>
      fs.watch(entry.gitDir, { recursive: true }).pipe(
        Stream.filter(
          (event) =>
            isRelevantGitPath(event.path) && !deps.suppressed(entry.gitDir),
        ),
        Stream.debounce(DEBOUNCE_MS),
        Stream.runForEach(() => Effect.sync(() => deps.onChange(projectId))),
        // The repository went away (deleted, unmounted), or is not
        // watchable right now: the watch drops, and a later reconcile
        // re-adds it if it comes back.
        Effect.ignore,
        // Only its own entry: a reconcile may have replaced it already.
        Effect.ensuring(
          Effect.sync(() => {
            if (gitDirs.get(projectId) === entry) gitDirs.delete(projectId);
          }),
        ),
      );

    const reconcile = Effect.gen(function* () {
      const projects = yield* Effect.try(() =>
        (deps.projects ?? loadProjects)(),
      ).pipe(Effect.option);
      // The registry is unreadable right now, so keep what is watched.
      if (Option.isNone(projects)) return;
      const wanted = new Map<string, string>();
      for (const project of projects.value) {
        const gitDir = gitDirOf(project.path);
        if (gitDir !== null) wanted.set(project.id, gitDir);
      }
      for (const [projectId, { gitDir }] of gitDirs) {
        if (wanted.get(projectId) !== gitDir) {
          gitDirs.delete(projectId);
          yield* FiberMap.remove(watches, projectId);
        }
      }
      for (const [projectId, gitDir] of wanted) {
        if (gitDirs.has(projectId)) continue;
        const entry = { gitDir };
        gitDirs.set(projectId, entry);
        yield* FiberMap.run(watches, projectId, watch(projectId, entry));
      }
    }).pipe(serial.withPermits(1), Effect.withSpan("GitWatcher.reconcile"));

    yield* reconcile;
    return GitWatcher.of({ reconcile });
  });

export const layer = (deps: GitWatcherDeps) =>
  Layer.effect(GitWatcher, make(deps));

// For the callers that are not Effect yet.
const promiseAdapter = PromiseAdapter.make<GitWatcher>("The git watcher");
export const adapter = promiseAdapter.layer;

export function reconcileGitWatchers(): void {
  void promiseAdapter
    .run(
      Effect.gen(function* () {
        yield* (yield* GitWatcher).reconcile;
      }),
    )
    .catch(() => {});
}
