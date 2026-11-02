// What every snapshot of a running daemon is checked against (the root
// wires it to the daemon's onChange):
//   - the stops that came while the daemon was down, replayed,
//   - a session whose original is gone (removed from Finder, or while
//     the app was not running, neither of which passes the delete that
//     stops its mirror): every session's root is looked at on every
//     snapshot, and one whose root is missing ends with its copy kept.
//     One whose original moved (the move recorded) re-opens there
//     instead, once its peer takes this device's calls, and ends if
//     another worktree takes the old folder first, if the worktree it
//     became is mirrored meanwhile, or if the peer comes too late.
//     The engine has more than one word for a root that went (a halt
//     when the copy stood still, a conflict at the root when the copy
//     had changed too, a problem at the root when the parent folder
//     went with it), and the look is one stat on a snapshot the engine
//     only sends on a change, so no word is waited for. Ended rather
//     than left there, since its Stop would otherwise remove the copy
//     that is now the only one there is, and the git half keeps
//     failing to read a worktree that is not there,
//   - a session a re-open replaced (MIRROR_LABEL_REPLACES) that
//     outlived it (a quit or a failed terminate between the re-open's
//     create and its terminate), so a pair never has two sessions.
// A terminate that fails is logged and asked again on a later
// snapshot.
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { MIRROR_LABEL_REPLACES } from "@shigomori/contracts/modules/mirror";
import { ageOf, stamp } from "@shigomori/engine/keptAnswers";
import { worktreeIdFromPath } from "@shigomori/engine/worktreeLayout";
import * as Worktrees from "@shigomori/engine/Worktrees";
import type { MirrorEngine } from "../MirrorEngine";
import {
  type MirrorSessionRaw,
  mirrorSessions,
  ORIGINAL_GONE_DETAIL,
  pathVisible,
  rootExists,
  runningEngine,
} from "../registry";
import type { Ends } from "./ends";
import type { Marks } from "./marks";
import type { Moves } from "./moves";

const FOLDER_TAKEN_DETAIL =
  "This worktree moved, and another worktree took its old folder before the other device could be reached to re-open the mirror, so the mirror ended. The copy on the other device stays as a worktree.";

const PEER_LATE_DETAIL =
  "This worktree moved, and the other device wasn't reached within 2 minutes to re-open the mirror, so the mirror ended. The copy on the other device stays as a worktree.";

const MIRRORED_AGAIN_DETAIL =
  "This worktree moved, and it was mirrored again before the device its earlier mirror waited on could be reached to re-open that one, so that mirror ended. Its copy there stays as a worktree.";

// The longest a re-open waits for the peer: a peer coming up just after
// this device. A re-open is a new session, with no record of what the
// two sides last agreed on, so whatever changed on either side since
// the old session's last cycle comes back as a creation or a conflict,
// which host/mirror/sessions.ts's reopenMirror refuses on a pair that isn't
// settled. That includes the time the app was closed, which no wait
// bounds: the bound keeps the wait from adding much to it. A peer
// that comes later (asleep, or a v3 migration's peer upgraded later)
// finds the mirror ended, its copy kept.
const PEER_WAIT_MS = 2 * 60_000;

// Where the store records a folder moved to, null when it records no
// move, undefined when the read fails: the store's read dies on a
// failure rather than fail, and a look that can't read the record leaves
// the session to the next one.
const recordedMove = (path: string) =>
  Effect.map(
    Effect.exit(
      Effect.flatMap(Worktrees.Worktrees, (worktrees) =>
        worktrees.movedTo(path),
      ),
    ),
    (read) => (Exit.isSuccess(read) ? Option.getOrNull(read.value) : undefined),
  );

export const makeSweep = ({
  marks,
  ends,
  moves,
}: {
  readonly marks: Marks;
  readonly ends: Ends;
  readonly moves: Moves;
}) =>
  Effect.sync(() => {
    const {
      pendingStops,
      endingSessions,
      rootLooks,
      waitingOnPeer,
      recreating,
      holdingRoots,
      worktreeIdNow,
    } = marks;

    // One session of a snapshot looked at: `sessions` is the whole
    // snapshot, `replaced` the sessions a re-open replaced, and
    // `reopening` the roots whose re-open this sweep began.
    const lookAt = Effect.fnUntraced(function* (
      daemon: MirrorEngine["Service"],
      raw: MirrorSessionRaw,
      {
        sessions,
        replaced,
        reopening,
      }: {
        readonly sessions: readonly MirrorSessionRaw[];
        readonly replaced: ReadonlySet<string>;
        readonly reopening: Set<string>;
      },
    ) {
      if (endingSessions.has(raw.session)) return;
      if (replaced.has(raw.session)) {
        if (!recreating.has(raw.session)) {
          yield* ends.endOnce(raw.session, daemon.terminate(raw.session));
        }
        return;
      }
      if (holdingRoots.has(worktreeIdNow(raw))) return;
      if (rootLooks.has(raw.session)) return;
      rootLooks.add(raw.session);
      const waiting = waitingOnPeer.get(raw.session);
      const end = (detail: string, worktreeId?: string) =>
        Effect.gen(function* () {
          const ended = yield* ends.endOnce(
            raw.session,
            ends.endMirrorKeepingCopy(daemon, raw, detail, worktreeId),
          );
          if (!ended) rootLooks.delete(raw.session);
        });
      if (yield* Effect.promise(() => rootExists(raw.localRoot))) {
        // The worktree came back to its folder (the folder it was
        // found at moved back): the wait is over, and the session
        // stays paused for a person's Resume, which keeps what the
        // pair agreed on.
        if (waiting !== undefined) {
          const movedBack = yield* recordedMove(waiting.path);
          if (movedBack === undefined) {
            rootLooks.delete(raw.session);
            return;
          }
          if (
            movedBack !== null &&
            worktreeIdFromPath(movedBack) === raw.localWorktreeId
          ) {
            waitingOnPeer.delete(raw.session);
          }
        }
        // A waiting session's old folder, there to see, is another
        // worktree's now. One the look can't see (its volume not
        // mounted) keeps waiting.
        const taken =
          waitingOnPeer.has(raw.session) &&
          (yield* Effect.promise(() => pathVisible(raw.localRoot)));
        if (taken) yield* end(FOLDER_TAKEN_DETAIL);
        else rootLooks.delete(raw.session);
        return;
      }
      // The v3 migration moved the original into wt/: the mirror
      // re-opens there, as after a move.
      const movedTo = yield* recordedMove(raw.localRoot);
      if (movedTo === undefined) {
        rootLooks.delete(raw.session);
        return;
      }
      if (
        movedTo !== null &&
        (yield* Effect.promise(() => rootExists(movedTo)))
      ) {
        const movedId = worktreeIdFromPath(movedTo);
        // The worktree it became mirrors on its own now, and a
        // worktree has one mirror.
        if (sessions.some((other) => other.localWorktreeId === movedId)) {
          yield* end(MIRRORED_AGAIN_DETAIL, movedId);
          return;
        }
        const now = yield* stamp;
        if (waiting !== undefined && ageOf(waiting.since, now) > PEER_WAIT_MS) {
          yield* end(PEER_LATE_DETAIL, movedId);
          return;
        }
        // The re-open needs the peer (the engine opens a session
        // only against both sides): one not taking this device's
        // calls yet (not reached at a start, away, or a switch of
        // its off) waits, paused, and is looked at again when it
        // comes to (MirrorEngineLayer's admissions).
        if (!reach.admits(raw.deviceId)) {
          waitingOnPeer.set(raw.session, {
            id: movedId,
            path: movedTo,
            since: waiting?.since ?? now,
          });
          rootLooks.delete(raw.session);
          if (!raw.paused) {
            yield* Effect.ignoreCause(daemon.pause(raw.session), {
              log: "Warn",
              message: "[mirror] a session waiting on its peer didn't pause",
            });
          }
          return;
        }
        // One re-open per worktree carries all of its sessions.
        if (reopening.has(raw.localRoot)) return;
        reopening.add(raw.localRoot);
        yield* moves.moveMirrorsOfWorktree(raw.localWorktreeId, {
          id: movedId,
          path: movedTo,
        });
        return;
      }
      // A delete here that began since the look did deals with it.
      if (holdingRoots.has(worktreeIdNow(raw))) {
        rootLooks.delete(raw.session);
        return;
      }
      yield* end(ORIGINAL_GONE_DETAIL);
    });

    const settleMirrorBookkeeping = Effect.gen(function* () {
      const daemon = yield* runningEngine;
      // Off the running daemon's own snapshot: its ready comes before it.
      if (daemon === null || !(yield* daemon.fresh)) return;
      const ids = [...pendingStops];
      pendingStops.clear();
      yield* Effect.forEach(
        ids,
        (id) => ends.endSessionsOnWorktree(daemon, id),
        { concurrency: "unbounded", discard: true },
      );

      const sessions = yield* mirrorSessions(daemon);
      const reopening = new Set<string>();
      const live = new Set(sessions.map((raw) => raw.session));
      for (const id of rootLooks) if (!live.has(id)) rootLooks.delete(id);
      for (const id of waitingOnPeer.keys()) {
        if (!live.has(id)) waitingOnPeer.delete(id);
      }
      const replaced = new Set(
        sessions
          .map((raw) => raw.labels[MIRROR_LABEL_REPLACES])
          .filter((id): id is string => id !== undefined),
      );
      yield* Effect.forEach(
        sessions,
        (raw) => lookAt(daemon, raw, { sessions, replaced, reopening }),
        { concurrency: "unbounded", discard: true },
      );
    }).pipe(Effect.withSpan("MirrorLedger.settleMirrorBookkeeping"));

    return { settleMirrorBookkeeping };
  });
