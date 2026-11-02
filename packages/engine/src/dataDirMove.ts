// Moves the data dir to a new parent directory, or back to its default
// place: the folder moves under the flavor's name (.sm / .smd, which
// also renames a pre-2.0 ~/shigomori), and the pointer file (Paths)
// records the new place for the app's and the CLI's next start, or goes
// when that place is the default, so a pointer always means a moved
// folder. The app asks for it (host/lib/dataDirMove.ts), with the checks
// and holds only it can make as `hooks`, and relaunches right after: the
// data dir is a boot-time constant every module has derived paths from.
//
// Two kinds of stored paths go stale and are carried along: worktree
// ids are hashes of the worktree's absolute path, so everything the
// engine keys by the id of every managed worktree under the data dir
// (marks, the worktree's data, a pending dirty capture) is re-keyed
// (Worktrees' rekey), and git's own worktree links are re-pointed by
// `git worktree repair`.
//
// The move is the one change under way: it holds the data-folder lock
// alone from its first step to its last (`DataDirLock`). A move a crash
// cuts short is finished or undone at the next start: the move keeps a
// journal in the data dir from before its re-key to its end, and a copy
// to another volume goes into a sibling of the destination, flushed to
// disk and renamed in only once whole. While the journal is there the
// store refuses every write but the move's own, and every engine graph
// but the doctor's settles it as it comes up (`settleLayer`), or keeps
// refusing.
//
// The journal (`dataDirMoveJournal.ts`) holds an entry per worktree that
// moves, marked `planned`, `rekeyed` or `returned`. A strict read takes
// an error as an error, never as absence: a capture ref git can't open
// or parse (`Git.readRef`), a journal that can't be read or decoded. The
// steps, and what a crash after each leaves:
//  0. The lock alone, waiting 30 s for the changes under way (one still
//     running refuses the move), then an earlier journal settled. Until
//     it is, the move is refused and the store keeps refusing writes.
//  1. The app's last checks, scripts killed (`ready`), the pointer
//     staged and flushed. A staged pointer naming a folder that never
//     came, which Paths ignores: its rescue needs a journal.
//  2. The store refusing, then the journal, with no entries. Before the
//     journal, a refusing store with none, which the next settle lets
//     write; after it, an undo with nothing to reverse.
//  3. The plan: git's listing of each project's worktrees, made holding
//     the lock alone, so no create, adopt or move can change it. A
//     listing that fails refuses the move, unless the project's folder
//     is gone. As 2.
//  4. The preflight: nothing kept under any entry's new id (marks,
//     sessions, shelf, data rows, a capture read strictly), or the move
//     is refused. As 2.
//  5. The snapshot: each entry's capture, read strictly, and every entry
//     `planned`. An undo with nothing to reverse.
//  6. Each entry re-keyed (its rows in one transaction, the capture only
//     if it is the snapshot's, else the move fails), then marked
//     `rekeyed`. One re-keyed but still `planned` is reversed by the
//     undo, since only its re-key can have put anything under its new id
//     (2 and 4).
//  7. What holds the folder let go (`releasing`): the store's watcher,
//     the updater's bridge, the loopback's address file. As 6.
//  8. The folder moved and flushed: a rename, one step with its mark that
//     a cancel can't cut, or a copy, `partial` set first, holding the
//     store's write lock, every file and folder flushed past the drive's
//     cache, then renamed in. Before it, an undo at the source; after
//     it, the journal is at the destination with the pointer unmoved,
//     which Paths' rescue commits (a rename) or the source's journal
//     undoes (a copy).
//  9. The pointer committed, renamed in (or removed, for the default
//     place) and its folder flushed. Finished at the destination.
// 10. The finish (`finishMove`), here for git's links only, then in full
//     in the first engine graph to come up at the new place. A crash
//     leaves it to the next one there, and a copy's old tree takes its
//     space until then.
//
// Not covered: `SHIGOMORI_DATA_DIR` naming the folder a move moved still
// names the old place; a write from outside sm into a copy's old tree
// before the relaunch goes with the old tree; a copy can take a mirrored
// file mid-write (the peer's next cycle sends it again); under reftable
// a capture ref git can't open reads as absent.
import { isSameOrInside } from "@shigomori/contracts/git/worktreeLayout";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Types from "effect/Types";
import { DataDirLock } from "./DataDirLock.ts";
import { dirtyRef } from "./Dirty.ts";
import {
  JOURNAL,
  type Journal,
  JournalJson,
  retired,
  retireStore,
  reviveStore,
  writeJournal,
} from "./dataDirMoveJournal.ts";
import * as Git from "./Git.ts";
import * as Paths from "./Paths.ts";
import * as Registry from "./Registry.ts";
import { worktreeIdFromPath } from "./worktreeLayout.ts";
import * as Worktrees from "./Worktrees.ts";

// A journal entry, its mark set as the move goes.
type Entry = Types.Mutable<Journal["moved"][number]>;

// A write of the move's while its journal refuses everyone else's: one
// write transaction lets the store write, writes, and makes it refuse
// again, so no other connection ever finds it writable.
const asMoveOwner = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.withTransaction(
      reviveStore.pipe(
        Effect.andThen(effect),
        Effect.tap(() => retireStore),
      ),
    ),
  );

const projectOf = (projectId: string) =>
  Effect.flatMap(Registry.Registry, (registry) =>
    Effect.flatMap(registry.listed, (projects) =>
      Effect.fromNullishOr(projects.find(({ id }) => id === projectId)),
    ),
  );

// Carries what the engine keys by a moved worktree's id from its old id
// to the one its new path hashes to, or back, as the move's own write.
// The capture follows only if it is the one the journal names. Forward,
// another fails the move (`changed`). Back, another stays where it is.
export const rekeyForward = (entry: Entry) =>
  Effect.gen(function* () {
    const project = yield* projectOf(entry.projectId);
    yield* asMoveOwner(
      (yield* Worktrees.Worktrees).rekey(
        project,
        worktreeIdFromPath(entry.oldPath),
        entry.newPath,
        { expect: entry.capture, fromPath: entry.oldPath },
      ),
    );
  });

const rekeyBack = (entry: Entry) =>
  Effect.gen(function* () {
    const project = yield* projectOf(entry.projectId);
    yield* asMoveOwner(
      (yield* Worktrees.Worktrees).rekey(
        project,
        worktreeIdFromPath(entry.newPath),
        entry.oldPath,
        { expect: entry.capture, back: true, fromPath: entry.newPath },
      ),
    );
  });

// Whether anything is kept under an entry's new id, the capture read
// strictly: what the preflight requires absent, and what an undo reads
// as its own re-key's.
export const keptUnderNewId = (entry: {
  readonly projectId: string;
  readonly newPath: string;
}) =>
  Effect.gen(function* () {
    const project = yield* projectOf(entry.projectId);
    return yield* (yield* Worktrees.Worktrees).keptUnder(
      project,
      worktreeIdFromPath(entry.newPath),
    );
  });

// Whether the folder at `dir` is this move's copy, by the journal it
// carries. A folder made there since, or one a removal already took,
// holds none. One that can't be read, or doesn't decode, can't be told.
const ownJournalAt = (dir: string, journal: Journal) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.readFileString(path.join(dir, JOURNAL)).pipe(
      Effect.map((text) => {
        const found = Schema.decodeOption(JournalJson)(text);
        if (Option.isNone(found)) return "unknown" as const;
        return found.value.from === journal.from &&
          found.value.partial === journal.partial
          ? ("ours" as const)
          : ("not" as const);
      }),
      Effect.catchReason("PlatformError", "NotFound", () =>
        Effect.succeed("not" as const),
      ),
      Effect.orElseSucceed(() => "unknown" as const),
    );
  });

// A folder that is this move's copy removed with its journal last, so a
// removal cut short still reads as the move's when tried again.
const removeOwnCopy = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = yield* fs.readDirectory(dir);
    yield* Effect.forEach(
      entries.filter((entry) => entry !== JOURNAL),
      (entry) =>
        fs.remove(path.join(dir, entry), { recursive: true, force: true }),
      { discard: true },
    );
    yield* fs.remove(dir, { recursive: true, force: true });
  });

// A step of a finish or an undo that failed keeps the journal, for the
// next engine graph to come up (not the doctor's) to carry on.
const settled = <A, E, R>(
  step: Effect.Effect<A, E, R>,
  what: string,
  doing: "undoing" | "finishing",
) =>
  step.pipe(
    Effect.as(true),
    Effect.catchCause((cause) =>
      Effect.as(
        Effect.logWarning(
          `[data] ${doing} a data-folder move, ${what} failed, so the journal is kept for the next start`,
          cause,
        ),
        false,
      ),
    ),
  );

// The end of a move that landed at `at`, its journal at `file`. In the
// moving process (`settle` false) only git's links are re-pointed: its
// store is the old place's. The first engine graph to come up at the
// new place (`settle` true, and not the doctor's) then:
//  1. removes the old tree a copy left (its own copy only, its journal
//     last), which waited till then so a power loss before the copy
//     reached the disk still had it.
//  2. re-points every link again, the journal's entries and any worktree
//     git lists under the old folder.
//  3. carries each entry's port-pool lease.
//  4. removes the journal.
//  5. lets the store write.
// Each step is idempotent, so a process that finds the journal runs it
// again.
export const finishMove = (
  journal: Journal,
  at: string,
  options: { readonly settle: boolean; readonly file: string },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = yield* Git.Git;
    let cleaned = true;
    if (options.settle) {
      const owner =
        journal.partial === null ||
        path.resolve(journal.from) === path.resolve(at)
          ? ("not" as const)
          : yield* ownJournalAt(journal.from, journal);
      if (owner === "unknown") {
        yield* Effect.logWarning(
          `[data] finishing a data-folder move, whether ${journal.from} is its old copy can't be read, so the journal is kept for the next start`,
        );
      }
      cleaned =
        owner === "not" ||
        (owner === "ours" &&
          (yield* settled(
            removeOwnCopy(journal.from),
            "removing the old copy",
            "finishing",
          )));
    }
    // What moved: the journal's entries, and any worktree git lists under
    // the old folder. A project whose folder is gone has nothing to repair.
    const repairs = new Map<string, Set<string>>();
    for (const m of journal.moved) {
      repairs.set(
        m.projectId,
        (repairs.get(m.projectId) ?? new Set()).add(m.newPath),
      );
    }
    const listed = yield* Effect.flatMap(Registry.Registry, (r) => r.listed);
    const worktrees = yield* Worktrees.Worktrees;
    const repaired = yield* Effect.forEach(
      listed,
      (project) =>
        Effect.gen(function* () {
          if (
            !(yield* fs
              .exists(project.path)
              .pipe(Effect.orElseSucceed(() => true)))
          ) {
            return;
          }
          const found = yield* worktrees.identities(project);
          const paths = repairs.get(project.id) ?? new Set<string>();
          for (const one of found) {
            if (!one.isPrimary && isSameOrInside(one.path, journal.from)) {
              paths.add(path.join(at, path.relative(journal.from, one.path)));
            }
          }
          if (paths.size === 0) return;
          yield* git.run(project.path, ["worktree", "repair", ...paths]);
        }),
      { discard: true },
    ).pipe((repair) => settled(repair, "a moved worktree's link", "finishing"));
    // Only at the new place does the layout count a moved worktree as
    // managed, which is what port-pool's lease there hangs on. What moved
    // is the journal's entries and whatever git lists inside the folder
    // now, its old place where the folder was. The moving process may have
    // repaired the latter's links already.
    if (options.settle && repaired) {
      yield* Effect.forEach(
        listed,
        (project) =>
          Effect.gen(function* () {
            const found = yield* worktrees.identities(project);
            const from = new Map(
              found.flatMap((one) =>
                !one.isPrimary && isSameOrInside(one.path, at)
                  ? [
                      [
                        one.path,
                        path.join(journal.from, path.relative(at, one.path)),
                      ] as const,
                    ]
                  : [],
              ),
            );
            for (const entry of journal.moved) {
              if (entry.projectId === project.id) {
                from.set(entry.newPath, entry.oldPath);
              }
            }
            for (const one of found) {
              const oldPath = from.get(one.path);
              if (oldPath !== undefined) {
                yield* worktrees.carryLease(oldPath, one);
              }
            }
          }).pipe(Effect.ignore),
        { discard: true },
      );
    }
    if (!(options.settle && cleaned && repaired)) return;
    yield* letGo(options.file, "finishing");
  });

// The journal gone, then the store writing again: a crash between leaves
// a store refusing with no journal, which the next settle lets write.
const letGo = (file: string, doing: "undoing" | "finishing") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (
      yield* settled(
        fs.remove(file, { force: true }),
        "removing the journal",
        doing,
      )
    ) {
      yield* settled(reviveStore, "letting the store write", doing);
    }
  });

// A move that never landed, undone where the data still is (`at`), its
// journal at `file`, by the journal's marks. Each entry is re-keyed back,
// last first, and marked before the next. A copy's partial or landed
// folder is removed (its own, its journal last). Then the journal goes,
// and the store writes again, last of all.
const undoMove = (journal: Journal, at: string, file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries: Array<Entry> = journal.moved.map((entry) => ({ ...entry }));
    let rekeyed = true;
    for (const entry of entries.toReversed()) {
      const state = entry.state;
      if (state === "returned") continue;
      const back = Effect.gen(function* () {
        // A `planned` entry's re-key may have run before a crash took its
        // mark: anything under its new id is its re-key's, since a move
        // starts only with nothing there and holds the lock alone after.
        if (state === "planned" && !(yield* keptUnderNewId(entry))) return;
        yield* rekeyBack(entry);
        entry.state = "returned";
        yield* writeJournal(file, { ...journal, moved: entries });
      });
      rekeyed = (yield* settled(back, "the re-key back", "undoing")) && rekeyed;
    }
    let removed = true;
    if (journal.partial !== null) {
      removed = yield* settled(
        fs.remove(journal.partial, { recursive: true, force: true }),
        "removing the partial copy",
        "undoing",
      );
      // A copy renamed in before the pointer moved: this move's own, as
      // the journal it carries says, and never the data the pointer names.
      const landed =
        path.resolve(journal.to) === path.resolve(at)
          ? ("not" as const)
          : yield* ownJournalAt(journal.to, journal);
      if (landed === "ours") {
        removed =
          (yield* settled(
            removeOwnCopy(journal.to),
            "removing the landed copy",
            "undoing",
          )) && removed;
      } else if (landed === "unknown") {
        yield* Effect.logWarning(
          `[data] undoing a data-folder move, whether ${journal.to} is its copy can't be read, so the journal is kept for the next start`,
        );
        removed = false;
      }
    }
    if (rekeyed && removed) yield* letGo(file, "undoing");
  });

// What a move left in the data dir `at` settled, by a process holding
// the data-folder lock alone, so no move is under way but this process's
// own, and only while the data dir is still found at `at`: what one this
// process found before a move took it elsewhere is left for the process
// the pointer leads to. A journal is finished when the pointer leads to
// its destination and undone when it still leads to its source. One that
// can't be read is kept, and the store keeps refusing. With no journal,
// a store a move left refusing writes again.
export const resumeDataDirMove = (at: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(at, JOURNAL);
    // The pointer may name the folder with a trailing slash.
    const now = path.resolve(yield* (yield* Paths.Paths).current);
    if (now !== path.resolve(at)) {
      return yield* Effect.logWarning(
        `[data] the data folder is at ${now} now, so what a move left at ${at} is left for a start there`,
      );
    }
    const text = yield* fs.readFileString(file).pipe(
      Effect.asSome,
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
      Effect.orElseSucceed(() => Option.some("")),
    );
    if (Option.isNone(text)) {
      if (yield* retired) {
        yield* settled(reviveStore, "letting the store write", "undoing");
      }
      return;
    }
    const journal = Schema.decodeOption(JournalJson)(text.value);
    // Kept: it may be the only record of what a move left half done.
    if (Option.isNone(journal)) {
      return yield* Effect.logWarning(
        `[data] a move journal at ${file} can't be read, kept for a look`,
      );
    }
    if (path.resolve(journal.value.to) === now) {
      yield* Effect.logInfo(
        `[data] finishing the move from ${journal.value.from}`,
      );
      return yield* finishMove(journal.value, at, { settle: true, file });
    }
    yield* Effect.logInfo(`[data] undoing the move to ${journal.value.to}`);
    yield* undoMove(journal.value, at, file);
  });

// A move refused before anything moved: an earlier move still owed.
class EarlierMoveUnfinished extends Schema.TaggedError<EarlierMoveUnfinished>()(
  "EarlierMoveUnfinished",
  {},
) {
  override get message(): string {
    return (
      "An earlier move of the data folder isn't finished or undone yet. " +
      "It's tried again at every start; see the log for what stops it."
    );
  }
}

// A move refused before anything moved: a project whose folder is there
// that git can't list.
class ProjectUnlisted extends Schema.TaggedError<ProjectUnlisted>()(
  "ProjectUnlisted",
  { project: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Couldn't list the worktrees of "${this.project}", so what they keep couldn't follow them. Try again.`;
  }
}

// A move refused before anything moved: something kept under the id the
// worktree at `oldPath` would take.
class KeptUnderNewId extends Schema.TaggedError<KeptUnderNewId>()(
  "KeptUnderNewId",
  { oldPath: Schema.String, newPath: Schema.String },
) {
  override get message(): string {
    return `Something is still kept for a worktree that was once at ${this.newPath}, so ${this.oldPath} can't take its place there. Move the data folder somewhere else.`;
  }
}

// The store held still while a copy reads it: a write transaction open
// for the copy's length (an UPDATE that changes nothing still takes the
// write lock), so a write from the terminal or a hook waits rather than
// tearing the copy, and the store left behind retired in the same
// transaction (`retireStore`).
export const holdingStore = <A, E, R>(copy: Effect.Effect<A, E, R>) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE changes SET version = version WHERE 0`;
        const copied = yield* copy;
        yield* retireStore;
        return copied;
      }),
    ),
  );

// A rename refused because the two paths are on different volumes.
const crossesVolumes = (error: PlatformError.PlatformError) =>
  (error.reason.cause as { readonly code?: unknown } | undefined)?.code ===
  "EXDEV";

// The data dir `from` moved to `to`, by the steps above.
export const moveDataDir = Effect.fnUntraced(function* <E, R>(
  move: {
    readonly from: string;
    // `from` by each spelling git may name a path under it with: git
    // spells one under a folder reached through a link by its target.
    readonly spellings: ReadonlyArray<string>;
    readonly to: string;
    // `to` by its parent's real path, which git will name the moved
    // worktrees by and their new ids hash.
    readonly toReal: string;
    // The pointer that will lead to `to`, none for the default place
    // (`toDefault`), and the pre-2.0 one that goes either way.
    readonly pointerFile: string;
    readonly legacyPointerFile: string | null;
    readonly toDefault: boolean;
  },
  hooks: {
    // Once an earlier move is settled: the app's last checks, and its
    // scripts stopped (step 1).
    readonly ready: Effect.Effect<void, E, R>;
    // The worktrees that move, held from the app's scripts until the
    // move ends (step 4).
    readonly holding: (
      worktreeIds: ReadonlyArray<string>,
    ) => Effect.Effect<void, E, R | Scope.Scope>;
    // What holds the folder let go (step 7).
    readonly releasing: Effect.Effect<void, E, R>;
    // The tree at `from` copied into `to` and flushed whole, holding the
    // store with `holdingStore` (step 8).
    readonly copy: (
      from: string,
      to: string,
    ) => Effect.Effect<void, E, R | SqlClient.SqlClient>;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* Git.Git;
  const registry = yield* Registry.Registry;
  const worktrees = yield* Worktrees.Worktrees;
  const { from, to, pointerFile, legacyPointerFile } = move;
  // A file or folder flushed to disk (on macOS, past the drive's cache).
  const flushed = (at: string) =>
    Effect.scoped(
      Effect.flatMap(fs.open(at, { flag: "r" }), (handle) => handle.sync),
    );
  const underFrom = (at: string) =>
    move.spellings.find((dir) => isSameOrInside(at, dir));
  const suffix = (yield* Random.nextInt).toString(36);
  // The pointer is written beside itself under a name of its own, then
  // renamed in.
  const pointerTmp = `${pointerFile}.tmp.${suffix}`;
  const journal: Omit<Types.Mutable<Journal>, "moved"> & {
    moved: Array<Entry>;
  } = { from, to, partial: null, moved: [] };
  const journalFile = path.join(from, JOURNAL);
  const journalHere = Effect.suspend(() => writeJournal(journalFile, journal));
  let pointerStaged = false;
  let storeRetired = false;
  let journaled = false;
  let renamed = false;
  const moving = Effect.gen(function* () {
    // An earlier move's journal is the only record of what it still owes:
    // settled first, as a start settles it, and a move waits while it
    // can't be, rather than write its own over it.
    yield* resumeDataDirMove(from).pipe(Effect.ignoreCause({ log: "Warn" }));
    if (yield* fs.exists(journalFile).pipe(Effect.orElseSucceed(() => true))) {
      return yield* new EarlierMoveUnfinished();
    }
    yield* hooks.ready;
    // Read holding the lock, so no project is added after.
    const projects = yield* registry.listed;
    // Staged before anything moves: a move that succeeds but leaves the
    // pointer unwritable would strand the data where no boot can find
    // it. Staged last of the preconditions so a failure above can't
    // orphan the temp file. The default location needs no pointer.
    if (!move.toDefault) {
      yield* fs.makeDirectory(path.dirname(pointerFile), { recursive: true });
      yield* fs.writeFileString(pointerTmp, `${to}\n`);
      yield* flushed(pointerTmp);
      pointerStaged = true;
    }
    yield* retireStore;
    storeRetired = true;
    yield* journalHere;
    journaled = true;

    // The managed worktrees whose checkout sits under the data dir. The
    // listing's own writes (an idle worktree shelved) are the move's.
    const { rows, skipped } = yield* asMoveOwner(
      worktrees.identityList(projects, { primaryRef: false }),
    );
    // A project whose folder is gone has nothing to carry. One that is
    // there but can't be listed would have its worktrees land with what
    // they keep left under their old ids.
    for (const { project, error } of skipped) {
      if (
        yield* fs.exists(project.path).pipe(Effect.orElseSucceed(() => true))
      ) {
        return yield* new ProjectUnlisted({
          project: project.name,
          cause: error,
        });
      }
    }
    const entries = rows.flatMap((i): Array<Entry & { oldId: string }> => {
      const under = underFrom(i.path);
      if (i.isPrimary || under === undefined) return [];
      return [
        {
          oldId: i.id,
          projectId: i.projectId,
          oldPath: i.path,
          newPath: path.join(
            move.toReal,
            i.path.slice(under.length).replace(/^[/\\]/, ""),
          ),
          capture: null,
          state: "planned",
        },
      ];
    });
    // Nothing may be kept under an id a worktree is about to take: the
    // undo reads anything there as its own re-key's.
    for (const entry of entries) {
      const held = yield* keptUnderNewId(entry).pipe(
        Effect.orElseSucceed(() => true),
      );
      if (held) {
        const { oldPath, newPath } = entry;
        return yield* new KeptUnderNewId({ oldPath, newPath });
      }
    }
    yield* hooks.holding(entries.map(({ oldId }) => oldId));
    const repoOf = new Map(projects.map((one) => [one.id, one.path]));
    journal.moved = yield* Effect.forEach(entries, ({ oldId, ...entry }) =>
      git.readRef(repoOf.get(entry.projectId) ?? "", dirtyRef(oldId)).pipe(
        Effect.map(
          (capture): Entry => ({
            ...entry,
            capture: Option.getOrNull(capture),
          }),
        ),
      ),
    );
    yield* journalHere;

    // Re-keyed while the engine still reads the old location.
    for (const entry of journal.moved) {
      yield* rekeyForward(entry);
      entry.state = "rekeyed";
      yield* journalHere;
    }

    yield* hooks.releasing;

    // rename() can't cross volumes. Then the tree is copied into a
    // sibling of the destination and renamed in. Either way the folders
    // the rename changed are flushed before the pointer commits, so no
    // power loss leaves a pointer naming a folder that isn't on disk.
    // A rename and its mark are one step: one a cancel cut short after
    // the folder left would be undone where the data no longer is.
    const landed = Effect.sync(() => {
      renamed = true;
    });
    const sameVolume = yield* fs.rename(from, to).pipe(
      Effect.andThen(landed),
      Effect.as(true),
      Effect.catchIf(crossesVolumes, () => Effect.succeed(false)),
      Effect.uninterruptible,
    );
    if (!sameVolume) {
      const partial = `${to}.partial-${suffix}`;
      journal.partial = partial;
      yield* journalHere;
      yield* hooks.copy(from, partial);
      yield* fs
        .rename(partial, to)
        .pipe(Effect.andThen(landed), Effect.uninterruptible);
    }
    yield* flushed(path.dirname(to));
    if (sameVolume) yield* flushed(path.dirname(from));

    // Renamed in, so no reader sees a half-written path, and committed
    // before the old copy goes. Moving to the default removes the pointer
    // instead, and the pre-2.0 pointer goes either way: exactly one file
    // may ever redirect a boot. A start that found the folder gone may
    // have committed it first (Paths' rescue).
    yield* move.toDefault
      ? fs.remove(pointerFile, { force: true })
      : fs
          .rename(pointerTmp, pointerFile)
          .pipe(
            Effect.catch((error) =>
              Effect.flatMap(
                fs
                  .readFileString(pointerFile)
                  .pipe(Effect.orElseSucceed(() => "")),
                (now) => (now.trim() === to ? Effect.void : Effect.fail(error)),
              ),
            ),
          );
    if (legacyPointerFile !== null) {
      yield* fs.remove(legacyPointerFile, { force: true });
    }
    yield* flushed(path.dirname(pointerFile));
    // The store this process holds is the old place's: the first engine
    // graph to come up at the new place (not the doctor's) removes the old
    // tree, the journal, and lets it write.
    yield* finishMove(journal, to, {
      settle: false,
      file: path.join(to, JOURNAL),
    });
  }).pipe(
    Effect.onError(() =>
      Effect.gen(function* () {
        // A rename that failed may still have moved the folder (a network
        // volume's lost answer): the folder gone counts as landed.
        if (
          !renamed &&
          !(yield* fs.exists(from).pipe(Effect.orElseSucceed(() => true)))
        ) {
          renamed = true;
        }
        // Once the folder landed, the staged pointer is how a start finds
        // it (Paths' rescue).
        if (pointerStaged && !renamed) {
          yield* Effect.ignore(fs.remove(pointerTmp, { force: true }));
        }
        if (journaled && !renamed) {
          yield* undoMove(journal, from, journalFile);
        } else if (storeRetired && !journaled) {
          yield* Effect.ignore(reviveStore);
        }
      }),
    ),
    Effect.scoped,
  );
  const lock = yield* DataDirLock;
  yield* lock.alone(moving, "30 seconds");
});

// Every engine graph built on `engineServices` (all but the doctor's,
// `doctorLayer`) settles what a move left in its data dir as it comes
// up, before anything reads a worktree by its id. A failure, or a
// move under way that keeps the lock, is a log line: the store keeps
// refusing writes, and the next process tries again.
export const settleLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { dataDir } = yield* Paths.Paths;
    const owed =
      (yield* fs
        .exists(path.join(dataDir, JOURNAL))
        .pipe(Effect.orElseSucceed(() => true))) ||
      (yield* retired.pipe(Effect.orElseSucceed(() => true)));
    if (!owed) return;
    const lock = yield* DataDirLock;
    yield* lock.alone(resumeDataDirMove(dataDir), "2 seconds");
  }).pipe(
    Effect.ignoreCause({
      log: "Warn",
      message: "[data] the unfinished move failed",
    }),
  ),
);
