// The source teardown, which decides on what the move recorded (its
// receipt, kept by Moves): it runs only when the receipt proves nothing
// can be lost.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  type SyncMoveRef,
  type SyncReceipt,
  type SyncTeardownSourceResult,
} from "@shigomori/contracts/modules/sync";
import * as Moves from "@host/lib/sync/Moves";
import { errorWordsOf } from "@host/lib/errorWords";
import { movedSourceChange } from "@shigomori/contracts/movedSource";
import {
  DeleteWorktreeResultSchema,
  type MovedSource,
} from "@shigomori/contracts/schemas";
import { type PeerReach, peerWorktreesFor } from "@host/ipc/PeerReach";
import { findProject } from "@host/lib/projects";
import {
  localSource,
  type SourceFacts,
  peerSource,
} from "@host/lib/sync/sourceLink";

// No receipt for the move asked about, in the words of its direction.
class NoReceiptError extends Schema.TaggedError<NoReceiptError>()(
  "NoReceiptError",
  { pulled: Schema.Boolean },
) {
  override get message(): string {
    return this.pulled
      ? "No pull recorded for that worktree on this device. Bring it here first."
      : "No send recorded for that worktree on this device. Send it first.";
  }
}

// The source teardown, after either move. The move's own receipt
// (Moves.remember) decides whether it may run at all. Without one (no
// move, or a restart in between) the call refuses outright rather than
// guess. The receipt is kept until a teardown actually removes the
// source, so a refused or failed one can be retried. A pull's source is
// the peer's worktree, checked over a link and removed through the
// peer's grant-gated delete. A send's is this device's own.
export const teardownSource = Effect.fn("Sync.teardownSource")(function* <E, R>(
  move: SyncMoveRef,
  removeHere: (removal: {
    projectId: string;
    worktreeId: string;
    force: boolean;
    refuseRunningScripts: boolean;
    expect: MovedSource;
  }) => Effect.Effect<unknown, E, R>,
) {
  const moves = yield* Moves.Moves;
  const receipt = yield* moves.receiptOf(move);
  const pulled = move.direction === "pull";
  if (receipt === undefined) return yield* new NoReceiptError({ pulled });
  const target = {
    projectId: move.projectId,
    worktreeId: move.worktreeId,
  };
  const moved = movedOf(receipt);
  // Asked first, so a source that changed keeps its cleanup unrun; the
  // removal asks again right before its delete, after the cleanup.
  const changed = yield* pulled
    ? Effect.scoped(
        Effect.flatMap(peerSource(move.deviceId, target), (source) =>
          sourceChangedSince(source, moved, PULLED),
        ),
      )
    : Effect.flatMap(findProject(move.projectId), (here) =>
        sourceChangedSince(localSource(here, move.worktreeId), moved, SENT),
      );
  if (changed !== undefined) {
    return { sourceRemoved: false, sourceError: changed } as const;
  }
  const result = yield* tearDown<R | PeerReach>(
    receipt,
    pulled ? "here" : "on the other device",
    (force) => {
      const removal = {
        ...target,
        force,
        refuseRunningScripts: true,
        expect: moved,
      };
      return pulled
        ? peerWorktreesFor(move.deviceId).delete(removal)
        : removeHere(removal);
    },
  );
  if (result.sourceRemoved) yield* moves.forget(move);
  return result;
});

// Why a source no longer matches its receipt, in the words of the
// device asking: the peer's worktree after a pull, this device's own
// after a send.
type ChangedWords = { moved: string; changed: string; neverMoved: string };
const PULLED: ChangedWords = {
  moved: "the branch on the source device moved after it was brought here.",
  changed:
    "the source worktree changed after its uncommitted work was captured.",
  neverMoved:
    "the source worktree has uncommitted changes that were never brought here.",
};
const SENT: ChangedWords = {
  moved: "the branch moved after it was sent.",
  changed: "the worktree changed after its uncommitted work was captured.",
  neverMoved: "the worktree has uncommitted changes that were never sent.",
};

// What the move took of its source, by its receipt.
const movedOf = (receipt: SyncReceipt): MovedSource => ({
  branch: receipt.branch,
  branchTip: receipt.branchTip,
  ...(receipt.captured && receipt.captureTree !== undefined
    ? { captureTree: receipt.captureTree }
    : {}),
});

// The teardown may run any time after the move, so the source is
// checked against what moved (movedSourceChange): a fresh capture,
// compared by tree hash, since capture commits are not deterministic.
// Anything else is work that never crossed, and the reason comes back as
// the kept-source explanation.
const sourceChangedSince = Effect.fnUntraced(function* (
  source: SourceFacts,
  moved: MovedSource,
  words: ChangedWords,
) {
  const tip = yield* source.tip(moved.branch);
  const fresh = yield* source.capture;
  // A capture that names no tree can't be shown to be what moved.
  if (fresh.captured && fresh.tree === undefined) return words.changed;
  const change = movedSourceChange(moved, {
    tip,
    ...(fresh.captured && fresh.tree !== undefined
      ? { captureTree: fresh.tree }
      : {}),
  });
  return change === undefined
    ? undefined
    : change === "moved"
      ? words.moved
      : change === "changed"
        ? words.changed
        : words.neverMoved;
});

// The source teardown. It runs ONLY when nothing the capture describes
// can be lost: an unapplied capture means the uncommitted work still
// exists solely on the source, so the source is kept and the caller
// learns why via sourceError. Ignored files are outside what a capture
// describes and die with the source either way, forced or not: git's
// own pre-removal check refuses untracked and modified files, never
// ignored ones. Deliberately not a refusal here (the ignoredPaths note
// in the contract says why). The dialog lists them before the choice.
// Teardown failures never throw either -- by then the move succeeded
// and the worktree simply exists on both sides. An external (adopted)
// source worktree keeps its local branch after teardown because sm rm
// skips branch deletion for externals (Worktrees.remove in the
// engine), so the branch then exists on both
// devices, which is not lossy. `landed` is where the copy went, for
// the refusal's wording.
const tearDown = <R>(
  moved: { captured: boolean; dirtyApplied: boolean },
  landed: "here" | "on the other device",
  remove: (force: boolean) => Effect.Effect<unknown, unknown, R>,
): Effect.Effect<SyncTeardownSourceResult, never, R> => {
  if (moved.captured && !moved.dirtyApplied) {
    return Effect.succeed({
      sourceRemoved: false,
      sourceError: `the uncommitted changes could not be applied ${landed} and only exist on the source worktree`,
    });
  }
  return Effect.gen(function* () {
    // Force only when the dirty state was actually captured and
    // applied. The engine's force does more than skip its own
    // clean-tree guard (Worktrees' checkRemovable): it also switches to
    // `git worktree remove --force`, which skips git's own dirty check
    // and so would silently destroy work a capture cannot carry
    // (submodule-only dirt captures as clean,
    // see the engine's Dirty.ts) or edits made after the
    // capture. So on a capture that said clean, git's own pre-removal
    // check must independently agree before the source dies, and a
    // disagreement surfaces as sourceRemoved:false with the git
    // message instead of silent loss. Accepted cost: worktrees with
    // populated submodules report sourceRemoved:false on clean
    // transplants because git refuses non-forced removal of them.
    // refuseRunningScripts is the app-side guard the local
    // kill-then-delete path deliberately lacks.
    const removed = yield* Schema.decodeUnknownEffect(
      DeleteWorktreeResultSchema,
    )(yield* remove(moved.captured));
    if (removed.ok) return { sourceRemoved: true };
    // ok:false means the worktree was NOT removed: cleanup scripts
    // run before `git worktree remove` and a failure aborts the
    // pipeline with the worktree left in place (Worktrees.remove in the
    // engine).
    return {
      sourceRemoved: false,
      sourceError: `cleanup failed on the source device (${removed.cleanupError.phase})`,
    };
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        sourceRemoved: false,
        sourceError: errorWordsOf(error),
      }),
    ),
  );
};
