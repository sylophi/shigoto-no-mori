// What the ledger's areas share about the sessions this device runs:
// which are being ended, looked at, re-opened or waiting on their peer,
// the worktrees a delete or a move holds, and what a daemon that wasn't
// running left to do. None of it outlives the process: the daemon
// persists the sessions, and their labels say what each is.
import * as Effect from "effect/Effect";
import type { Stamp } from "@shigomori/engine/keptAnswers";
import type { MirrorSessionRaw } from "../registry";

// Worktrees held by the operations working on them, counted, since a
// stack's delete holds several at once. Two holds are kept, and they
// stay apart. The roots a delete or a move holds (holdingRoots below)
// cover the sessions this device runs on its originals, for a move too,
// and last until a delete's copy is gone on its device. The streams a
// delete holds (streams.ts) cover what this device serves into its
// copies, end those at once, and last only until the files went. A move
// holds no stream: what this device serves a copy follows it by the id
// it had (serving.ts).
export const countedHolds = () => {
  const counts = new Map<string, number>();
  return {
    hold: (ids: readonly string[]): (() => void) => {
      for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
      return () => {
        for (const id of ids) {
          const left = (counts.get(id) ?? 1) - 1;
          if (left > 0) counts.set(id, left);
          else counts.delete(id);
        }
      };
    },
    has: (id: string): boolean => counts.has(id),
  };
};

export const makeMarks = () => {
  // The worktrees whose stop came while the daemon wasn't running
  // (restarting, or still starting at boot), for its first snapshot to
  // end what they name. The copy a peer holds stays a worktree of its
  // own.
  const pendingStops = new Set<string>();

  // The sessions whose end is under way (whileEnding): the sweep leaves
  // them, and so does a peer's announcement that their copy is gone.
  const endingSessions = new Set<string>();

  // The sessions whose root is being looked at, or was found gone and
  // ended, kept until the engine stops listing them: snapshots overlap,
  // and a sweep that starts between the end and the engine's next
  // snapshot would find the session listed still and end it twice. A
  // look that finds the root of a session not waiting on its peer, or
  // can't see a waiting one's, a session left to wait, a move the look
  // can't read, or an end that fails, forgets the mark, so the next
  // snapshot looks again. Apart from endingSessions: a look is not an
  // end, and a peer's announcement that the copy is gone still ends a
  // session the sweep is only looking at.
  const rootLooks = new Set<string>();

  // The sessions of an original deleted here whose copy is still to
  // delete (its peer away, or the delete failed there), each with its
  // peer, kept until the engine stops listing them. Their look waits for
  // the peer's next admission (lookAgainAt), rather than ask the peer
  // again on every snapshot. A quit forgets them, and their copies are
  // then kept as a root gone by hand keeps its.
  const copiesToDelete = new Map<string, string>();
  // The worktrees deleted here while the daemon wasn't running, whose
  // sessions join copiesToDelete once it is.
  const copiesToDeleteOn = new Set<string>();

  // The sessions of a moved original whose re-open waits for the peer to
  // take this device's calls, each with the id of the worktree the
  // original became, the folder it was last found at, and when the wait
  // began, kept until the engine stops listing them. Each is paused, so
  // neither the engine's retry nor an admission brings it back on the old
  // folder, which a worktree made there meanwhile would make another's.
  const waitingOnPeer = new Map<
    string,
    { id: string; path: string; since: Stamp }
  >();

  // Sessions a re-open is replacing right now (MirrorEngine's recreate,
  // for a move or a new ignore rule): the re-open ends the old one
  // itself once the new one is up, so the leftover sweep must not race
  // it to the terminate, an admission must not resume it, and a second
  // rule change (both devices' pages at once) would open another session
  // on the pair.
  const recreating = new Set<string>();

  // Worktrees an in-app delete or move is working on (Scripts
  // withDeletesInflight): their root vanishing is that mutation, whose
  // own follow-up stops or moves their mirrors, not a removal behind the
  // app's back.
  const holdingRoots = countedHolds();

  // The worktree a session's local side is now: a waiting one's is the
  // worktree its original became, which its labels don't say yet.
  const worktreeIdNow = (raw: MirrorSessionRaw): string =>
    waitingOnPeer.get(raw.session)?.id ?? raw.localWorktreeId;

  const whileEnding = <A, E, R>(session: string, run: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => endingSessions.add(session)),
      () => run,
      () => Effect.sync(() => endingSessions.delete(session)),
    );

  const whileRecreating = <A, E, R>(
    session: string,
    run: Effect.Effect<A, E, R>,
  ) =>
    Effect.acquireUseRelease(
      Effect.sync(() => recreating.add(session)),
      () => run,
      () => Effect.sync(() => recreating.delete(session)),
    );

  return {
    pendingStops,
    endingSessions,
    rootLooks,
    copiesToDelete,
    copiesToDeleteOn,
    waitingOnPeer,
    recreating,
    holdingRoots,
    worktreeIdNow,
    whileEnding,
    whileRecreating,
  };
};

export type Marks = ReturnType<typeof makeMarks>;
