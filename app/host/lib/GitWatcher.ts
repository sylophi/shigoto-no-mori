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
//
// The events are a fast hint, not the record: a platform watch can drop
// one, or end. So every BACKSTOP the watcher reconciles anyway (as the
// store's changes do, engine StoreChanges): it starts again any watch
// that ended, signals a project whose git state moved since it last
// looked (gitStateOf, read with no git), and a project whose working
// tree's watch had ended, whose edits meanwhile went unseen.
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Semaphore from "effect/Semaphore";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import type { Project } from "@shigomori/contracts/schemas";
import { loadProjects } from "@host/lib/projects";
import { watchPath } from "@host/lib/watchPath";

const DEBOUNCE_MS = 300;
const EDIT_WINDOW = "1 second";
const BACKSTOP = Duration.seconds(10);
// A project's reconcile that takes longer is a volume that stalls.
const STEP_TIMEOUT = Duration.seconds(5);

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

// What a project's git directory says about the state its rows show,
// read with no git: HEAD and each worktree's HEAD, packed-refs, every
// loose ref but a lock (a ref is written by a rename into place, so a
// new inode), and which stopped-operation markers exist. Two equal
// readings mean nothing the allowlist above cares about moved between
// them. A file that isn't there reads as absent; any other failure (a
// directory git removed mid-walk, a volume that stalls) fails the
// reading, which the caller skips rather than read as a change.
const isNotFound = (error: PlatformError.PlatformError) =>
  Predicate.isTagged(error.reason, "NotFound");

const gitStateOf = (gitDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stamp = (relative: string) =>
      fs.stat(path.join(gitDir, relative)).pipe(
        Effect.map((info) => {
          const ino = Option.getOrElse(info.ino, () => 0);
          const mtime = Option.match(info.mtime, {
            onNone: () => 0,
            onSome: (date) => date.getTime(),
          });
          return `${relative}@${ino}:${mtime}:${info.size}`;
        }),
        Effect.catchIf(isNotFound, () => Effect.succeed(`${relative}@-`)),
      );
    const read = (relative: string) =>
      fs
        .readFileString(path.join(gitDir, relative))
        .pipe(Effect.catchIf(isNotFound, () => Effect.succeed("")));
    const listed = (relative: string, recursive: boolean) =>
      fs
        .readDirectory(path.join(gitDir, relative), { recursive })
        .pipe(Effect.catchIf(isNotFound, () => Effect.succeed<string[]>([])));
    const worktrees = (yield* listed("worktrees", false)).toSorted();
    const dirs = ["", ...worktrees.map((name) => `worktrees/${name}/`)];
    const parts = [yield* stamp("packed-refs")];
    for (const dir of dirs) {
      parts.push(
        dir,
        yield* read(`${dir}HEAD`),
        yield* read(`${dir}ORIG_HEAD`),
      );
      for (const marker of OPERATION_MARKERS) {
        parts.push(yield* stamp(`${dir}${marker}`));
      }
    }
    for (const ref of (yield* listed("refs", true)).toSorted()) {
      if (ref.endsWith(".lock")) continue;
      parts.push(yield* stamp(path.join("refs", ref)));
    }
    return parts.join("\n");
  });

const OPERATION_MARKERS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "SQUASH_MSG",
  "BISECT_LOG",
  "sequencer",
  "rebase-merge",
  "rebase-apply",
];

const treeKey = (projectId: string, tree: string) => `${projectId}\0${tree}`;

export type GitWatcherDeps = {
  onChange: (projectId: string) => void;
  // A file changed in one of the project's working trees.
  onFilesChanged: (projectId: string) => void;
  // The projects to follow. Defaults to the registry. The git-watcher
  // check injects its own list against a sandbox repository.
  projects?: () => Project[];
  // Test seams: how a path is watched, and how often the watcher
  // reconciles regardless. Real callers take the defaults.
  watch?: (
    path: string,
  ) => Stream.Stream<FileSystem.WatchEvent, PlatformError.PlatformError>;
  backstop?: Duration.Input;
  gitState?: (
    gitDir: string,
  ) =>
    | Effect.Effect<string, unknown, FileSystem.FileSystem | Path.Path>
    | undefined;
};

export class GitWatcher extends Context.Service<
  GitWatcher,
  {
    // Bring the watched set in line with the registry: one watch per
    // project whose git directory resolves, dropped when the project
    // leaves the registry or its git directory moves, and a change no
    // event said signalled. Runs at boot, on every store change, the
    // terminal's or the app's own (host/process/layer.ts), which together
    // cover every way a project is added, removed or relocated, and every
    // BACKSTOP.
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
    const watchOf = (path: string) =>
      deps.watch?.(path) ?? watchPath(fs, path, { recursive: true });
    // Each watched project's git state as last seen. The projects whose
    // watch has heard a change not yet signalled (its debounce running),
    // by the beat it first heard one in, which the backstop leaves to it
    // for a beat. And the projects whose files didn't answer in time (a
    // volume that hangs an open, #932), skipped until a later beat on a
    // doubling wait.
    const states = new Map<string, string>();
    const hearing = new Map<string, number>();
    const stalled = new Map<
      string,
      { readonly until: number; readonly tries: number }
    >();
    let beats = 0;
    // The working trees whose watch ended as it started, signalled once
    // until one hears an event.
    const failing = new Set<string>();
    // Each project's read of its files in flight. A read that hangs is
    // left to finish rather than abandoned and asked again, so a project
    // never holds more than one stuck open on the thread pool, and no
    // lock is held while one is out.
    const reads = yield* FiberMap.make<string>();

    // What a project's files say, read with no lock held: its git
    // directory, its working trees and its git state (none for a reading
    // that failed, which says nothing about a change).
    const readProject = (projectPath: string) =>
      Effect.gen(function* () {
        const gitDir = yield* refsDirOf(projectPath);
        if (gitDir === null) return { gitDir, trees: new Set<string>() };
        const found = yield* workingTreesOf(projectPath, gitDir);
        const state = yield* (
          deps.gitState?.(gitDir) ?? gitStateOf(gitDir)
        ).pipe(Effect.option);
        return { gitDir, trees: found, state };
      }).pipe(Effect.provide(platform));
    type ProjectRead = Effect.Success<ReturnType<typeof readProject>>;

    // The project's read, waited on for STEP_TIMEOUT at most: "busy" while
    // an earlier one is still out (a stuck volume), "late" when this one
    // ran past the deadline.
    const readOf = (projectId: string, projectPath: string) =>
      Effect.gen(function* () {
        if (yield* FiberMap.has(reads, projectId)) return "busy" as const;
        const fiber = yield* FiberMap.run(
          reads,
          projectId,
          readProject(projectPath),
        );
        const read = yield* Fiber.join(fiber).pipe(
          Effect.timeoutOption(STEP_TIMEOUT),
          Effect.orElseSucceed(() => Option.none<ProjectRead>()),
        );
        return Option.isSome(read) ? read.value : ("late" as const);
      });

    const stall = (projectId: string) => {
      const tries = (stalled.get(projectId)?.tries ?? 0) + 1;
      stalled.set(projectId, {
        until: beats + 2 ** Math.min(tries, 5),
        tries,
      });
    };

    // One working tree's edits: a burst's first change opens a window,
    // and the window's end is one signal, so a tree that never goes
    // quiet (a build writing its output) still reports, at most once a
    // window. A tree that goes away drops its watch, which the next read
    // of the project's trees starts again if the tree is back.
    const watchTree = (projectId: string, tree: string) =>
      watchOf(tree).pipe(
        Stream.tap(() =>
          Effect.sync(() => failing.delete(treeKey(projectId, tree))),
        ),
        Stream.filter((event) => isWorkingTreeChange(event.path)),
        Stream.groupedWithin(Number.POSITIVE_INFINITY, EDIT_WINDOW),
        Stream.runForEach(() =>
          Effect.sync(() => deps.onFilesChanged(projectId)),
        ),
        Effect.ignore,
      );

    // The project's working trees watched, and only `wanted`.
    const followTrees = (projectId: string, wanted: ReadonlySet<string>) =>
      Effect.gen(function* () {
        const held = trees.get(projectId) ?? new Set<string>();
        for (const tree of held) {
          if (!wanted.has(tree)) {
            yield* FiberMap.remove(treeWatches, treeKey(projectId, tree));
            failing.delete(treeKey(projectId, tree));
          }
        }
        let ended = false;
        for (const tree of wanted) {
          const key = treeKey(projectId, tree);
          if (yield* FiberMap.has(treeWatches, key)) continue;
          // Held, but its watch ended: edits since went unseen.
          if (held.has(tree) && !failing.has(key)) {
            ended = true;
            failing.add(key);
          }
          yield* FiberMap.run(treeWatches, key, watchTree(projectId, tree));
        }
        trees.set(projectId, wanted);
        if (ended) deps.onFilesChanged(projectId);
      });

    const dropTrees = (projectId: string) =>
      Effect.gen(function* () {
        for (const tree of trees.get(projectId) ?? []) {
          yield* FiberMap.remove(treeWatches, treeKey(projectId, tree));
          failing.delete(treeKey(projectId, tree));
        }
        trees.delete(projectId);
      });

    // One project's pings: its git directory's relevant changes,
    // debounced, its state and working trees read again with each.
    const watch = (
      projectId: string,
      entry: { readonly gitDir: string; readonly projectPath: string },
    ) =>
      watchOf(entry.gitDir).pipe(
        Stream.filter((event) => isRelevantGitPath(event.path)),
        Stream.tap(() =>
          Effect.sync(() => {
            if (!hearing.has(projectId)) hearing.set(projectId, beats);
          }),
        ),
        Stream.debounce(DEBOUNCE_MS),
        Stream.runForEach(() =>
          Effect.gen(function* () {
            // A stalled project's files wait for its beat.
            const read = stalled.has(projectId)
              ? ("busy" as const)
              : yield* readOf(projectId, entry.projectPath);
            if (read === "late") stall(projectId);
            if (typeof read !== "string") {
              yield* apply(projectId, entry.projectPath, read, false);
            }
            hearing.delete(projectId);
            deps.onChange(projectId);
          }),
        ),
        // The repository went away (deleted, unmounted), or is not
        // watchable right now: the watch drops, and a later reconcile
        // re-adds it if it comes back.
        Effect.ignore,
        // Only its own entry: a reconcile may have replaced it already.
        Effect.ensuring(
          Effect.sync(() => {
            hearing.delete(projectId);
            if (gitDirs.get(projectId) === entry) gitDirs.delete(projectId);
          }),
        ),
      );

    // A project brought in line with what its files said, under `serial`
    // and with no file read of its own: its git directory watched (a new
    // one, or one that moved or whose watch ended), its working trees
    // followed, and with `signal`, what moved that no event said
    // signalled (a watch that dropped an event, or ended).
    function apply(
      projectId: string,
      projectPath: string,
      read: ProjectRead,
      signal: boolean,
    ): Effect.Effect<void> {
      return Effect.gen(function* () {
        const held = gitDirs.get(projectId);
        if (held !== undefined && held.gitDir !== read.gitDir) {
          gitDirs.delete(projectId);
          states.delete(projectId);
          yield* FiberMap.remove(watches, projectId);
        }
        if (read.gitDir === null) return yield* dropTrees(projectId);
        // A worktree moved by `sm` writes the store, which reconciles.
        yield* followTrees(projectId, read.trees);
        if (!gitDirs.has(projectId)) {
          const entry = { gitDir: read.gitDir, projectPath };
          gitDirs.set(projectId, entry);
          yield* FiberMap.run(watches, projectId, watch(projectId, entry));
        }
        if (!("state" in read) || Option.isNone(read.state)) return;
        const last = states.get(projectId);
        states.set(projectId, read.state.value);
        if (signal && last !== undefined && last !== read.state.value) {
          deps.onChange(projectId);
        }
      }).pipe(serial.withPermits(1));
    }

    const forget = (projectId: string) =>
      Effect.gen(function* () {
        yield* FiberMap.remove(watches, projectId);
        gitDirs.delete(projectId);
        states.delete(projectId);
        hearing.delete(projectId);
        stalled.delete(projectId);
        yield* dropTrees(projectId);
      }).pipe(serial.withPermits(1));

    // Each project's files read with no lock held and at most one read
    // out per project, so one on a volume that hangs holds up nothing
    // but itself, and is skipped after on a doubling wait. One pass at a
    // time, so two (the beat's and a store change's) don't read alike.
    const passes = yield* Semaphore.make(1);
    const reconcileNow = Effect.gen(function* () {
      const projects = yield* Effect.try(() =>
        (deps.projects ?? loadProjects)(),
      ).pipe(Effect.option);
      // The registry is unreadable right now, so keep what is watched.
      if (Option.isNone(projects)) return;
      const ids = new Set(projects.value.map((project) => project.id));
      const known = [
        ...gitDirs.keys(),
        ...trees.keys(),
        ...states.keys(),
        ...stalled.keys(),
      ];
      for (const projectId of new Set(known)) {
        if (!ids.has(projectId)) yield* forget(projectId);
      }
      for (const project of projects.value) {
        if ((stalled.get(project.id)?.until ?? -1) > beats) continue;
        const read = yield* readOf(project.id, project.path);
        if (read === "busy" || read === "late") {
          stall(project.id);
          continue;
        }
        stalled.delete(project.id);
        const quiet = (hearing.get(project.id) ?? -2) < beats - 1;
        yield* apply(project.id, project.path, read, quiet);
      }
    }).pipe(passes.withPermits(1));
    const reconcile = reconcileNow.pipe(
      Effect.withSpan("GitWatcher.reconcile"),
    );

    yield* reconcile;
    // Without a span: one every beat would crowd out the spans a restart's
    // log reads back.
    yield* Effect.forkScoped(
      Effect.sleep(deps.backstop ?? BACKSTOP).pipe(
        Effect.andThen(
          Effect.sync(() => {
            beats += 1;
          }),
        ),
        Effect.andThen(reconcileNow),
        Effect.forever,
      ),
    );
    return GitWatcher.of({ reconcile });
  });

export const layer = (deps: GitWatcherDeps) =>
  Layer.effect(GitWatcher, make(deps));
