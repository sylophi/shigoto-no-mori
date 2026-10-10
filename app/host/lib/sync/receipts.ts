// What each move recorded, and the source teardown that decides on it:
// the teardown runs only when the receipt proves nothing can be lost.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { fromPromise } from "@host/lib/util/fromPromise";
import {
  type SyncMoveRef,
  type SyncReceipt,
  type SyncTeardownSourceResult,
} from "@shigomori/contracts/modules/sync";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { DeleteWorktreeResultSchema } from "@shigomori/contracts/schemas";
import { peerSyncApiFor, peerWorktreesApiFor } from "@host/ipc/peerSync";
import * as Engine from "@host/lib/engine";
import { findProject } from "@host/lib/projects";
import {
  localSource,
  type SourceFacts,
  withPeerSource,
} from "@host/lib/sync/sourceLink";

// What each move captured and applied, by source worktree, for the
// teardown that may follow, kept by the device that ran the move (the
// destination after a pull, the source after a send, which the
// destination's landing hands its receipt). Read by the teardown, so
// the data-loss rule runs on the hosts' own facts: a caller cannot
// claim a capture landed when it did not. The branch tip and the
// capture's tree let the teardown prove the source is still exactly
// what moved, however long the user took to decide. Ephemeral by
// design (a restart forgets, and the teardown then refuses), bounded
// so a host that moves worktrees for weeks never grows it.
const RECEIPT_LIMIT = 64;
const receipts = new Map<string, SyncReceipt>();
const receiptKey = (move: SyncMoveRef) =>
  `${move.direction}:${move.deviceId}/${move.projectId}/${move.worktreeId}`;
export function remember(move: SyncMoveRef, receipt: SyncReceipt): void {
  const key = receiptKey(move);
  receipts.delete(key);
  receipts.set(key, receipt);
  for (const oldest of receipts.keys()) {
    if (receipts.size <= RECEIPT_LIMIT) break;
    receipts.delete(oldest);
  }
}

// The source teardown, after either move. The move's own receipt
// decides whether it may run at all. Without one (no move, or a
// restart in between) the call refuses outright rather than guess.
// The receipt is kept until a teardown actually removes the source,
// so a refused or failed one can be retried. A pull's source is the
// peer's worktree, checked over a link and removed through the
// peer's grant-gated delete. A send's is this device's own.
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

export const teardownSource = Effect.fn("Sync.teardownSource")(function* <E, R>(
  move: SyncMoveRef,
  removeHere: (removal: {
    projectId: string;
    worktreeId: string;
    force: boolean;
    refuseRunningScripts: boolean;
  }) => Effect.Effect<unknown, E, R>,
) {
  const key = receiptKey(move);
  const receipt = receipts.get(key);
  const pulled = move.direction === "pull";
  if (receipt === undefined) return yield* new NoReceiptError({ pulled });
  const target = {
    projectId: move.projectId,
    worktreeId: move.worktreeId,
  };
  const engine = yield* Engine.handle;
  const here = pulled ? undefined : yield* findProject(move.projectId);
  const changed = yield* fromPromise(() =>
    here === undefined
      ? withPeerSource(
          peerSyncApiFor(move.deviceId),
          target,
          (source) => sourceChangedSince(source, receipt, PULLED),
          engine,
        )
      : sourceChangedSince(
          localSource(here, move.worktreeId, engine),
          receipt,
          SENT,
        ),
  );
  if (changed !== undefined) {
    return { sourceRemoved: false, sourceError: changed } as const;
  }
  const result = yield* tearDown(
    receipt,
    pulled ? "here" : "on the other device",
    (force) => {
      const removal = { ...target, force, refuseRunningScripts: true };
      return pulled
        ? fromPromise(() => peerWorktreesApiFor(move.deviceId).delete(removal))
        : removeHere(removal);
    },
  );
  if (result.sourceRemoved) receipts.delete(key);
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

// The teardown may run any time after the move, so the source is
// re-checked against the receipt first: the branch tip must not have
// moved, and the uncommitted state must still be exactly the tree the
// move captured (a fresh capture, compared by tree hash, since capture
// commits are not deterministic). Anything else is work that never
// crossed, and the reason comes back as the kept-source explanation.
async function sourceChangedSince(
  source: SourceFacts,
  receipt: SyncReceipt,
  words: ChangedWords,
): Promise<string | undefined> {
  if ((await source.tip(receipt.branch)) !== receipt.branchTip) {
    return words.moved;
  }
  const fresh = await source.capture();
  if (!fresh.captured) return receipt.captured ? words.changed : undefined;
  if (!receipt.captured || receipt.captureTree === undefined) {
    return words.neverMoved;
  }
  return fresh.tree === receipt.captureTree ? undefined : words.changed;
}

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
    // applied. The CLI's --force does more than skip its own
    // clean-tree guard (cmd_rm.go requireClean): it also switches to
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
        sourceError: errorMessageOf(error),
      }),
    ),
  );
};
