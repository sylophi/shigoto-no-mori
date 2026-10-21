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
// What counts as a change is an ALLOWLIST of git-dir paths (HEAD and
// ORIG_HEAD, packed-refs, refs/** but the app's own refs/shigomori/**,
// a worktree's HEAD and ORIG_HEAD, a worktree entry appearing or
// vanishing, a stopped operation's markers), not "anything under .git":
// objects/ churns on every commit, logs/ mirrors every ref update,
// FETCH_HEAD is rewritten by the app's own minute sweep, and `index` is
// rewritten by every stage and by another program's `git status` or
// `git diff` (a person's, a prompt's dirty check), while a stage moves
// no ref (its own signal, below). refs/shigomori/ holds the app's own
// bookkeeping (dirty captures, a transfer's landing refs, the mirror's
// staged-tree commits, discard undos), which no view reads. Uncommitted
// file edits are not seen in the git directory: they live in the
// working trees.
//
// So each worktree's working tree is watched too, its own `.git` left
// out, and a change there is a second, quieter signal
// (worktrees:filesChanged): the project's rows are read again (each
// worktree's changed files), and nothing else moves. Which working
// trees a project has is read off its git directory (the main checkout,
// and each `worktrees/<name>/gitdir`), again whenever that changes.
//
// A checkout's `index` written (the main checkout's or a worktree's)
// is a third, host only (indexWritten), for the views of what it holds:
// the changes page's list, staged or not, and an operation's conflicts
// and squash. A burst of writes (an agent's `git status`, `git add` and
// `git diff` in a row) is one, after the debounce. The app's own reads
// never write the index (the engine's git runner), so a read it brings
// brings no other. A mirror watches its worktree's index itself
// (mirror/gitState.ts).
//
// The signal is project scoped (git:projectChanged) rather than the
// broad externalChange sweep: a commit in one repo says nothing about
// another project's rows. The app's own git operations ping like any
// other tool's, so every view of the project follows them too.
//
// The events are a fast hint, not the record: a platform watch can drop
// one, or end. So every BACKSTOP the watcher reconciles anyway (as the
// store's changes do, engine StoreChanges): it starts again any watch
// that ended, signals a project whose git state or index moved since it
// last looked (gitStateOf, read with no git), and a project whose
// working tree's watch had ended, whose edits meanwhile went unseen.
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import type { Project } from "@shigomori/contracts/schemas";
import * as Git from "@shigomori/engine/Git";
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
// The app's own refs: under refs/, yet none of them counts.
const OWN_REFS = /^refs\/shigomori(\/|$)/;
// A checkout's index, the main checkout's or a worktree's.
const INDEX = /^(worktrees\/[^/]+\/)?index$/;

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
  if (OWN_REFS.test(normalized)) return false;
  return RELEVANT.some((pattern) => pattern.test(normalized));
}

// Exported for the git-watcher check, as the allowlist is.
export function isIndexPath(file: string): boolean {
  const normalized = file.includes("\\") ? file.replaceAll("\\", "/") : file;
  return INDEX.test(normalized);
}

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
// read with no git: HEAD and ORIG_HEAD and each worktree's,
// packed-refs, every loose ref the allowlist counts (a ref is written
// by a rename into place, so a new inode), and the stopped-operation
// markers (a directory by being there). Two equal readings mean nothing
// the allowlist above cares about moved between them. And apart, each
// checkout's index by its stamp (written by a rename into place too),
// for the index's own signal. A file that isn't there reads as absent;
// any other failure (a directory git removed mid-walk, a volume that
// stalls) fails the reading, which the caller skips rather than read as
// a change.
const isNotFound = (error: PlatformError.PlatformError) =>
  Predicate.isTagged(error.reason, "NotFound");

type GitState = { readonly refs: string; readonly indexes: string };

const gitStateOf = (gitDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // Undefined for a file that isn't there.
    const stampIfThere = (relative: string) =>
      fs.stat(path.join(gitDir, relative)).pipe(
        Effect.map((info) => {
          // A directory counts by being there: its mtime moves with any
          // lock file made and removed inside it, as a fetch that moves
          // nothing does in refs/remotes/<remote>.
          if (info.type === "Directory") return `${relative}@dir`;
          const ino = Option.getOrElse(info.ino, () => 0);
          const mtime = Option.match(info.mtime, {
            onNone: () => 0,
            onSome: (date) => date.getTime(),
          });
          return `${relative}@${ino}:${mtime}:${info.size}`;
        }),
        Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
      );
    const stamp = (relative: string) =>
      Effect.map(stampIfThere(relative), (seen) => seen ?? `${relative}@-`);
    const read = (relative: string) =>
      fs
        .readFileString(path.join(gitDir, relative))
        .pipe(Effect.catchIf(isNotFound, () => Effect.succeed("")));
    // A recursive listing fails NotFound for a directory gone below it
    // as well as for its own.
    const listed = (relative: string, recursive: boolean) => {
      const dir = path.join(gitDir, relative);
      return fs
        .readDirectory(dir, { recursive })
        .pipe(
          Effect.catchIf(isNotFound, (error) =>
            Effect.flatMap(fs.exists(dir), (there) =>
              there ? Effect.fail(error) : Effect.succeed<string[]>([]),
            ),
          ),
        );
    };
    const worktrees = (yield* listed("worktrees", false)).toSorted();
    const dirs = ["", ...worktrees.map((name) => `worktrees/${name}/`)];
    const parts = [yield* stamp("packed-refs")];
    const indexes: string[] = [];
    for (const dir of dirs) {
      parts.push(
        dir,
        yield* read(`${dir}HEAD`),
        yield* read(`${dir}ORIG_HEAD`),
      );
      for (const marker of OPERATION_MARKERS) {
        parts.push(yield* stamp(`${dir}${marker}`));
      }
      indexes.push(yield* stamp(`${dir}index`));
    }
    for (const ref of (yield* listed("refs", true)).toSorted()) {
      const relative = path.join("refs", ref);
      if (!isRelevantGitPath(relative)) continue;
      // One gone since the listing reads as the next listing will.
      const seen = yield* stampIfThere(relative);
      if (seen !== undefined) parts.push(seen);
    }
    return {
      refs: parts.join("\n"),
      indexes: indexes.join("\n"),
    } satisfies GitState;
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
    | Effect.Effect<GitState, unknown, FileSystem.FileSystem | Path.Path>
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
    // The projects whose index git wrote (a stage, an unstage, another
    // program's refresh of it), from the moment this returns and for
    // the scope's length: a view subscribes before it reads, so a write
    // in between isn't lost. Host only, never a push.
    readonly indexWritten: Effect.Effect<
      Stream.Stream<string>,
      never,
      Scope.Scope
    >;
  }
>()("sm/host/GitWatcher") {}

// One project's index writes, for a view's `also` (Views.view): none
// where the watcher didn't start.
export const indexWrittenIn = (projectId: string) =>
  Effect.flatMap(
    Effect.serviceOption(GitWatcher),
    Option.match({
      onNone: () => Effect.succeed(Stream.empty),
      onSome: (watcher) =>
        Effect.map(
          watcher.indexWritten,
          Stream.filter((written) => written === projectId),
        ),
    }),
  );

// What a project's reading found moved since the last: its git state
// (or its git directory), or only an index.
type Moved = "git" | "index" | undefined;

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
    const indexWrites = yield* Effect.acquireRelease(
      PubSub.unbounded<string>(),
      PubSub.shutdown,
    );
    const watchOf = (path: string) =>
      deps.watch?.(path) ?? watchPath(fs, path, { recursive: true });
    // Each watched project's git state as last seen. The projects whose
    // watch has heard a change not yet signalled (its debounce running),
    // by the beat it first heard one in, which the backstop leaves to it
    // for a beat, and those of them owed a git signal: their watch heard
    // more than an index, or a beat found the git state moved while it
    // left them be. And the projects whose files didn't answer in time
    // (a volume that hangs an open), skipped until a later beat on a
    // doubling wait.
    const states = new Map<string, GitState>();
    const hearing = new Map<string, number>();
    const hearingGit = new Set<string>();
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
        const gitDir = yield* Git.commonDirOf(projectPath);
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
        // Never a second read in place of one already out.
        const fiber = yield* FiberMap.run(
          reads,
          projectId,
          readProject(projectPath),
          { onlyIfMissing: true },
        );
        const read = yield* Fiber.join(fiber).pipe(
          Effect.timeoutOption(STEP_TIMEOUT),
          Effect.exit,
        );
        // A read that failed says nothing, and one a racing ask started
        // first comes back interrupted: neither is a stall.
        if (Exit.isFailure(read)) return "busy" as const;
        return Option.isSome(read.value) ? read.value.value : ("late" as const);
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

    // What moved, said: the git state on every wire, an index to the
    // views that read it.
    const signal = (projectId: string, moved: Moved) => {
      if (moved === "git") return Effect.sync(() => deps.onChange(projectId));
      if (moved === "index") return PubSub.publish(indexWrites, projectId);
      return Effect.void;
    };

    // One project's pings: its git directory's relevant changes and its
    // indexes written, debounced, its state and working trees read again
    // with each. A burst that wrote nothing but an index says so alone,
    // unless the read finds the git state moved too (an event lost).
    const watch = (
      projectId: string,
      entry: { readonly gitDir: string; readonly projectPath: string },
    ) =>
      watchOf(entry.gitDir).pipe(
        Stream.filter(
          (event) => isRelevantGitPath(event.path) || isIndexPath(event.path),
        ),
        Stream.tap((event) =>
          Effect.sync(() => {
            if (!hearing.has(projectId)) hearing.set(projectId, beats);
            if (!isIndexPath(event.path)) hearingGit.add(projectId);
          }),
        ),
        Stream.debounce(DEBOUNCE_MS),
        Stream.runForEach(() =>
          Effect.gen(function* () {
            // Taken now: one heard while this reads is the next burst's.
            const heardGit = hearingGit.delete(projectId);
            // A stalled project's files wait for its beat.
            const read = stalled.has(projectId)
              ? ("busy" as const)
              : yield* readOf(projectId, entry.projectPath);
            if (read === "late") stall(projectId);
            // A moved or missing git directory is the reconcile's: its
            // apply ends this very watch.
            const moved =
              typeof read !== "string" && read.gitDir === entry.gitDir
                ? yield* apply(projectId, entry.projectPath, read)
                : undefined;
            hearing.delete(projectId);
            yield* signal(
              projectId,
              heardGit || moved === "git" ? "git" : "index",
            );
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
            hearingGit.delete(projectId);
            if (gitDirs.get(projectId) === entry) gitDirs.delete(projectId);
          }),
        ),
      );

    // A project brought in line with what its files said, under `serial`
    // and with no file read of its own: its git directory watched (a new
    // one, or one that moved or whose watch ended), its working trees
    // followed. Says what moved since the last reading, for the caller
    // to signal what no event did (a watch that dropped an event, or
    // ended).
    function apply(
      projectId: string,
      projectPath: string,
      read: ProjectRead,
    ): Effect.Effect<Moved> {
      return Effect.gen(function* () {
        let moved: Moved;
        const held = gitDirs.get(projectId);
        if (held !== undefined && held.gitDir !== read.gitDir) {
          gitDirs.delete(projectId);
          states.delete(projectId);
          yield* FiberMap.remove(watches, projectId);
          // The repository moved or went: its rows say otherwise.
          moved = "git";
        }
        if (read.gitDir === null) {
          yield* dropTrees(projectId);
          return moved;
        }
        // A worktree moved by `sm` writes the store, which reconciles.
        yield* followTrees(projectId, read.trees);
        if (!gitDirs.has(projectId)) {
          const entry = { gitDir: read.gitDir, projectPath };
          gitDirs.set(projectId, entry);
          yield* FiberMap.run(watches, projectId, watch(projectId, entry));
        }
        if (!("state" in read) || Option.isNone(read.state)) return moved;
        const last = states.get(projectId);
        const now = read.state.value;
        states.set(projectId, now);
        if (last === undefined) return moved;
        if (last.refs !== now.refs) return "git";
        return last.indexes === now.indexes ? undefined : "index";
      }).pipe(serial.withPermits(1));
    }

    const forget = (projectId: string) =>
      Effect.gen(function* () {
        yield* FiberMap.remove(watches, projectId);
        gitDirs.delete(projectId);
        states.delete(projectId);
        hearing.delete(projectId);
        hearingGit.delete(projectId);
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
        // A read still out is left to finish, a stuck one stalls.
        if (read === "busy") continue;
        if (read === "late") {
          stall(project.id);
          continue;
        }
        stalled.delete(project.id);
        const quiet = (hearing.get(project.id) ?? -2) < beats - 1;
        const moved = yield* apply(project.id, project.path, read);
        // Owed even while the watch is heard: its fire reads past it.
        if (moved === "git") hearingGit.add(project.id);
        if (quiet) {
          yield* signal(
            project.id,
            hearingGit.delete(project.id) ? "git" : moved,
          );
        }
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
    return GitWatcher.of({
      reconcile,
      indexWritten: PubSub.subscribe(indexWrites).pipe(
        Effect.map(Stream.fromSubscription),
      ),
    });
  });

export const layer = (deps: GitWatcherDeps) =>
  Layer.effect(GitWatcher, make(deps));
