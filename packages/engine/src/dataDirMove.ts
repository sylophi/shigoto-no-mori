// The data-folder move's recovery and the steps of it the engine owns
// (V3.md, Commit points): while a move's journal is in the data dir the
// store refuses every write but the move's own, and every process that
// opens the store settles the journal first or keeps refusing. The move
// itself is the app's (app/host/lib/dataDirMove.ts); the journal and the
// store's refusal are `dataDirMoveJournal.ts`'s.
import { isSameOrInside } from "@shigomori/contracts/git/worktreeLayout";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Types from "effect/Types";
import {
  JOURNAL,
  type Journal,
  JournalJson,
  retireStore,
  reviveStore,
  strandedJournal,
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
        { expect: entry.capture ?? null },
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
        { expect: entry.capture ?? null, back: true },
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

// The end of a move that landed at `at`: the old tree a copy left goes
// (its own copy only, its journal last), git's worktree links are
// re-pointed, every worktree git lists under the old folder included,
// and, where the store this process opened is the one at `at`
// (`revive`), the store writes again and the journal goes, last. Each
// step is idempotent, so a process that finds the journal runs it again.
export const finishMove = (
  journal: Journal,
  at: string,
  options: { readonly revive: boolean },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = yield* Git.Git;
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
    const cleaned =
      owner === "not" ||
      (owner === "ours" &&
        (yield* settled(
          removeOwnCopy(journal.from),
          "removing the old copy",
          "finishing",
        )));
    // What moved: the journal's entries, and any worktree git lists under
    // the old folder, which a terminal may have added after the plan.
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
    if (!(cleaned && repaired && options.revive)) return;
    const revived = yield* settled(
      reviveStore,
      "letting the store write",
      "finishing",
    );
    if (revived) {
      yield* Effect.ignore(fs.remove(path.join(at, JOURNAL), { force: true }));
    }
  });

// A move that never landed, undone where the data still is (`at`), by
// the journal's marks: each entry re-keyed back, last first, and marked
// before the next; a copy's partial or landed folder removed (its own,
// its journal last); then the store writes again, and the journal goes
// last of all.
export const undoMove = (journal: Journal, at: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries: Array<Entry> = journal.moved.map((entry) => ({ ...entry }));
    let rekeyed = true;
    for (const entry of entries.toReversed()) {
      const state = entry.state ?? "planned";
      if (state === "returned") continue;
      const back = Effect.gen(function* () {
        // A `planned` entry's re-key may have run before a crash took its
        // mark: anything under its new id is its re-key's, since a move
        // starts only with nothing there and nobody else writes after.
        if (state === "planned" && !(yield* keptUnderNewId(entry))) return;
        yield* rekeyBack(entry);
        entry.state = "returned";
        yield* writeJournal(at, { ...journal, moved: entries });
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
    if (!(rekeyed && removed)) return;
    if (yield* settled(reviveStore, "letting the store write", "undoing")) {
      yield* Effect.ignore(fs.remove(path.join(at, JOURNAL), { force: true }));
    }
  });

// A journal in the data dir `at` whose mover is gone, settled: finished
// at its destination, undone at its source. A live mover's is its own,
// and the store keeps refusing; one that can't be read is kept, and the
// store keeps refusing too.
export const resumeDataDirMove = (at: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(at, JOURNAL);
    const text = yield* fs.readFileString(file).pipe(
      Effect.map(Option.some),
      Effect.catchReason("PlatformError", "NotFound", () =>
        Effect.succeed(Option.none<string>()),
      ),
      Effect.catch((error) =>
        Effect.as(
          Effect.logWarning(
            `[data] a move journal at ${file} can't be read, kept for a look`,
            error,
          ),
          Option.none<string>(),
        ),
      ),
    );
    if (Option.isNone(text)) return;
    const journal = Schema.decodeUnknownOption(JournalJson)(text.value);
    if (Option.isNone(journal)) {
      return yield* Effect.logWarning(
        `[data] an unreadable move journal at ${file}, kept for a look`,
      );
    }
    // A graph settles as it comes up, when no move of its own process
    // can be under way, so its own pid's journal is a leftover too.
    if (journal.value.pid !== process.pid && !(yield* strandedJournal(at))) {
      return;
    }
    // The pointer may name the folder with a trailing slash.
    if (path.resolve(journal.value.to) === path.resolve(at)) {
      yield* Effect.logInfo(
        `[data] finishing the move from ${journal.value.from}`,
      );
      return yield* finishMove(journal.value, at, { revive: true });
    }
    yield* Effect.logInfo(`[data] undoing the move to ${journal.value.to}`);
    yield* undoMove(journal.value, at);
  });

// Every engine graph settles the data dir's journal as it comes up,
// before anything reads a worktree by its id. A failure is a log line:
// the store keeps refusing writes, and the next process tries again.
export const settleLayer = Layer.effectDiscard(
  Effect.flatMap(Paths.Paths, ({ dataDir }) => resumeDataDirMove(dataDir)).pipe(
    Effect.ignoreCause({
      log: "Warn",
      message: "[data] the unfinished move failed",
    }),
  ),
);
