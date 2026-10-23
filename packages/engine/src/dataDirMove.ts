// The data-folder move's recovery and the steps of it the engine owns:
// while a move's journal is in the data dir the store refuses every
// write but the move's own, and every engine graph but the doctor's
// settles the journal as it comes up, holding the data-folder lock alone
// (`DataDirLock`), or keeps refusing. The move itself is the app's
// (app/host/lib/dataDirMove.ts); the journal and the store's refusal are
// `dataDirMoveJournal.ts`'s.
import { isSameOrInside } from "@shigomori/contracts/git/worktreeLayout";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Types from "effect/Types";
import { DataDirLock } from "./DataDirLock.ts";
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
export type Entry = Types.Mutable<Journal["moved"][number]>;

// A write of the move's while its journal refuses everyone else's: one
// write transaction lets the store write, writes, and makes it refuse
// again, so no other connection ever finds it writable.
export const asMoveOwner = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
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
// The capture follows only if it is the one the journal names: forward,
// another fails the move (`changed`); back, another stays where it is.
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
// carries: a folder made there since, or one a removal already took,
// holds none; one that can't be read, or doesn't decode, can't be told.
const ownJournalAt = (dir: string, journal: Journal) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.readFileString(path.join(dir, JOURNAL)).pipe(
      Effect.map((text) => {
        const found = Schema.decodeUnknownOption(JournalJson)(text);
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
// next process to open the store to carry on.
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
          `[data] ${doing} a data-folder move, ${what} failed; the journal is kept for the next start`,
          cause,
        ),
        false,
      ),
    ),
  );

// The end of a move that landed at `at`, its journal at `file`. In the
// moving process (`settle` false) only git's links are re-pointed: its
// store is the old place's. The first process to open the store at the
// new place (`settle` true) then removes the old tree a copy left (its
// own copy only, its journal last), which waited till then so a power
// loss before the copy reached the disk still had it; re-points every
// link again, the journal's entries and any worktree git lists under the
// old folder; carries each entry's port-pool lease; removes the journal;
// and lets the store write, last. Each step is idempotent, so a process
// that finds the journal runs it again.
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
          `[data] finishing a data-folder move, whether ${journal.from} is its old copy can't be read; the journal is kept for the next start`,
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
    // now, its old place where the folder was; the moving process may have
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
// journal at `file`, by the journal's marks: each entry re-keyed back,
// last first, and marked before the next; a copy's partial or landed
// folder removed (its own, its journal last); then the journal goes, and
// the store writes again, last of all.
export const undoMove = (journal: Journal, at: string, file: string) =>
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
          `[data] undoing a data-folder move, whether ${journal.to} is its copy can't be read; the journal is kept for the next start`,
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
// its destination and undone when it still leads to its source; one that
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
        `[data] the data folder is at ${now} now; what a move left at ${at} is left for a start there`,
      );
    }
    const text = yield* fs.readFileString(file).pipe(
      Effect.map(Option.some),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
      Effect.orElseSucceed(() => Option.some("")),
    );
    if (Option.isNone(text)) {
      if (yield* retired) {
        yield* settled(reviveStore, "letting the store write", "undoing");
      }
      return;
    }
    const journal = Schema.decodeUnknownOption(JournalJson)(text.value);
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
