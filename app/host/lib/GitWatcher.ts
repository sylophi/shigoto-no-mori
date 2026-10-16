// Watches every registered project's git directory so a commit, a
// checkout, a branch created or deleted, a rebase or a fetch made by
// ANY tool (an agent in a terminal, an editor, plain git) shows up in
// the app within a debounce, on this machine and on every device
// viewing it, instead of on the next focus or the minute sweep. The
// store's changes (engine StoreChanges) cover sm's own bookkeeping.
// The git facts a worktree row shows
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
// refetch into another refetch. Uncommitted file edits are not seen
// there: they live in the working trees.
//
// So each worktree's working tree is watched too, its own `.git` left
// out, and a change there is a second, quieter signal
// (worktrees:filesChanged): the project's rows are read again (each
// worktree's changed files), and nothing else moves. Which working
// trees a project has is read off its git directory (the main checkout,
// and each `worktrees/<name>/gitdir`), again whenever that changes.
//
// The signal is project scoped (git:projectChanged) rather than the
// broad externalChange sweep: a commit in one repo says nothing about
// another project's rows. The app's own git operations ping like any
// other tool's, so every view of the project follows them too.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { Project } from "@shigomori/contracts/schemas";
import { loadProjects } from "@host/lib/projects";
import { watchPath } from "@host/lib/watchPath";

const DEBOUNCE_MS = 300;
const EDIT_WINDOW = "1 second";

// Git-dir relative paths whose change means the project's git state
// moved. Paths arrive with the platform separator and are normalized
// to `/` before matching.
const RELEVANT = [
  /^(HEAD|ORIG_HEAD|packed-refs)$/,
  /^refs(\/|$)/,
  /^worktrees\/[^/]+(\/(HEAD|ORIG_HEAD))?$/,
  // A merge, rebase, cherry-pick, revert, squash or bisect starting or
  // ending, in the main checkout or a worktree's own git dir, for the
  // banner that offers to continue or abort it. The rebase dirs count by their
  // own appearing and going, not their contents' churn.
  /^(worktrees\/[^/]+\/)?(MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|SQUASH_MSG|BISECT_LOG|sequencer|rebase-merge|rebase-apply)$/,
];

// Any `.git` in a working tree (the main checkout's directory, a linked
// worktree's file, a submodule's) churns with every git command the
// app runs, its own reads of the rows included.
const GIT_SEGMENT = /(^|\/)\.git(\/|$)/;

export function isWorkingTreeChange(file: string): boolean {
  const normalized = file.includes("\\") ? file.replaceAll("\\", "/") : file;
  return !GIT_SEGMENT.test(normalized);
}

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
export const refsDirOf = (projectPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dotGit = path.join(projectPath, ".git");
    const stat = yield* fs.stat(dotGit).pipe(Effect.option);
    if (Option.isNone(stat)) return null;
    if (stat.value.type === "Directory") return dotGit;
    if (stat.value.type !== "File") return null;
    const text = yield* fs.readFileString(dotGit).pipe(Effect.option);
    if (Option.isNone(text)) return null;
    const pointed = /^gitdir:\s*(.+)$/m.exec(text.value)?.[1]?.trim();
    if (pointed === undefined) return null;
    const gitDir = path.isAbsolute(pointed)
      ? pointed
      : path.resolve(projectPath, pointed);
    // A linked worktree's git dir names its repository's common dir,
    // which is where the refs live.
    const common = yield* fs
      .readFileString(path.join(gitDir, "commondir"))
      .pipe(Effect.option);
    if (Option.isNone(common)) return gitDir;
    const dir = common.value.trim();
    return path.isAbsolute(dir) ? dir : path.resolve(gitDir, dir);
  });

// The working trees of a project: its own folder when it is a checkout,
// and every linked worktree its git directory lists, by the `.git` path
// each `worktrees/<name>/gitdir` names. Read off the files, with no git.
// By real path, and a tree inside another (a worktree kept under the
// main checkout) left to the outer one's watch, so no edit counts twice.
const workingTreesOf = (projectPath: string, gitDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const found = new Set<string>();
    const add = (tree: string) =>
      fs.realPath(tree).pipe(
        Effect.map((real) => {
          found.add(real);
        }),
        // Gone since git listed it.
        Effect.ignore,
      );
    if (
      yield* fs
        .exists(path.join(projectPath, ".git"))
        .pipe(Effect.orElseSucceed(() => false))
    ) {
      yield* add(projectPath);
    }
    const entries = yield* fs
      .readDirectory(path.join(gitDir, "worktrees"))
      .pipe(Effect.orElseSucceed((): string[] => []));
    for (const entry of entries) {
      const pointer = yield* fs
        .readFileString(path.join(gitDir, "worktrees", entry, "gitdir"))
        .pipe(Effect.option);
      if (Option.isNone(pointer)) continue;
      const dotGit = pointer.value.trim();
      if (dotGit === "") continue;
      yield* add(
        path.dirname(
          path.isAbsolute(dotGit) ? dotGit : path.resolve(gitDir, dotGit),
        ),
      );
    }
    const trees = new Set<string>();
    for (const tree of found) {
      const outer = [...found].some(
        (other) => other !== tree && tree.startsWith(other + path.sep),
      );
      if (!outer) trees.add(tree);
    }
    return trees;
  });

const treeKey = (projectId: string, tree: string) => `${projectId}\0${tree}`;

export type GitWatcherDeps = {
  onChange: (projectId: string) => void;
  // A file changed in one of the project's working trees.
  onFilesChanged: (projectId: string) => void;
  // The projects to follow. Defaults to the registry. The git-watcher
  // check injects its own list against a sandbox repository.
  projects?: () => Project[];
};

export class GitWatcher extends Context.Service<
  GitWatcher,
  {
    // Bring the watched set in line with the registry: one watch per
    // project whose git directory resolves, dropped when the project
    // leaves the registry or its git directory moves. Runs at boot and on
    // every store change, the terminal's or the app's own
    // (host/process/layer.ts), which together cover every way a project is
    // added, removed or relocated.
    readonly reconcile: Effect.Effect<void>;
  }
>()("sm/host/GitWatcher") {}

const make = (deps: GitWatcherDeps) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    // Each watched project's git directory and the fiber watching it.
    const watches = yield* FiberMap.make<string>();
    // Each watched working tree, by project and path, and its fiber.
    const treeWatches = yield* FiberMap.make<string>();
    const trees = new Map<string, ReadonlySet<string>>();
    // What each running watch watches. Written only under `serial`, so
    // two reconciles fired at once (an external change and a settled
    // mutation) cannot interleave their reads of the registry.
    const gitDirs = new Map<
      string,
      { readonly gitDir: string; readonly projectPath: string }
    >();
    const serial = yield* Semaphore.make(1);

    // One working tree's edits: a burst's first change opens a window,
    // and the window's end is one signal, so a tree that never goes
    // quiet (a build writing its output) still reports, at most once a
    // window. A tree that goes away drops its watch, which the next read
    // of the project's trees starts again if the tree is back.
    const watchTree = (projectId: string, tree: string) =>
      watchPath(fs, tree, { recursive: true }).pipe(
        Stream.filter((event) => isWorkingTreeChange(event.path)),
        Stream.groupedWithin(Number.POSITIVE_INFINITY, EDIT_WINDOW),
        Stream.runForEach(() =>
          Effect.sync(() => deps.onFilesChanged(projectId)),
        ),
        Effect.ignore,
      );

    // The project's working trees watched, and only those.
    const followTrees = (
      projectId: string,
      projectPath: string,
      gitDir: string,
    ) =>
      Effect.gen(function* () {
        const wanted = yield* workingTreesOf(projectPath, gitDir).pipe(
          Effect.provide(platform),
        );
        const held = trees.get(projectId) ?? new Set<string>();
        for (const tree of held) {
          if (!wanted.has(tree)) {
            yield* FiberMap.remove(treeWatches, treeKey(projectId, tree));
          }
        }
        for (const tree of wanted) {
          if (yield* FiberMap.has(treeWatches, treeKey(projectId, tree))) {
            continue;
          }
          yield* FiberMap.run(
            treeWatches,
            treeKey(projectId, tree),
            watchTree(projectId, tree),
          );
        }
        trees.set(projectId, wanted);
      });

    const dropTrees = (projectId: string) =>
      Effect.gen(function* () {
        for (const tree of trees.get(projectId) ?? []) {
          yield* FiberMap.remove(treeWatches, treeKey(projectId, tree));
        }
        trees.delete(projectId);
      });

    // One project's pings: its git directory's relevant changes,
    // debounced, and its working trees followed as worktrees come and go.
    const watch = (
      projectId: string,
      entry: { readonly gitDir: string; readonly projectPath: string },
    ) =>
      watchPath(fs, entry.gitDir, { recursive: true }).pipe(
        Stream.filter((event) => isRelevantGitPath(event.path)),
        Stream.debounce(DEBOUNCE_MS),
        Stream.runForEach(() =>
          Effect.sync(() => deps.onChange(projectId)).pipe(
            Effect.andThen(
              followTrees(projectId, entry.projectPath, entry.gitDir).pipe(
                serial.withPermits(1),
              ),
            ),
          ),
        ),
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
      const wanted = new Map<
        string,
        { readonly gitDir: string; readonly projectPath: string }
      >();
      for (const project of projects.value) {
        const gitDir = yield* refsDirOf(project.path).pipe(
          Effect.provide(platform),
        );
        if (gitDir !== null) {
          wanted.set(project.id, { gitDir, projectPath: project.path });
        }
      }
      for (const [projectId, { gitDir }] of gitDirs) {
        if (wanted.get(projectId)?.gitDir !== gitDir) {
          gitDirs.delete(projectId);
          yield* FiberMap.remove(watches, projectId);
        }
      }
      for (const projectId of trees.keys()) {
        if (!wanted.has(projectId)) yield* dropTrees(projectId);
      }
      for (const [projectId, entry] of wanted) {
        // A worktree moved by `sm` writes the store, which reconciles.
        yield* followTrees(projectId, entry.projectPath, entry.gitDir);
        if (gitDirs.has(projectId)) continue;
        gitDirs.set(projectId, entry);
        yield* FiberMap.run(watches, projectId, watch(projectId, entry));
      }
    }).pipe(serial.withPermits(1), Effect.withSpan("GitWatcher.reconcile"));

    yield* reconcile;
    return GitWatcher.of({ reconcile });
  });

export const layer = (deps: GitWatcherDeps) =>
  Layer.effect(GitWatcher, make(deps));
