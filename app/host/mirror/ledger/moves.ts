// A worktree here re-keyed: its id is path derived, so a move put it
// under a new one. What is kept under the old id follows: its thread,
// and each session on it, re-opened on the new path (MirrorEngine's
// recreate, the git follower's agreement carried across by the replaces
// label). The engine halted the old session the moment its root went,
// so nothing crossed meanwhile. A daemon that isn't running re-opens
// nothing: its first snapshot finds the session's root gone and the
// move recorded, and the sweep runs this again once the peer takes this
// device's calls, within 2 minutes (sweep.ts). A re-open the peer
// cannot answer (it is away: the engine opens a session only against
// both sides) ends the mirror instead, the copy kept, and the thread
// says so. A session waiting to re-open into the worktree that moved is
// the moved one's now (worktreeIdNow).
import * as Effect from "effect/Effect";
import { errorWordsOf } from "@host/lib/errorWords";
import { carriedLabels, engineOrNull, mirrorSessions } from "../registry";
import type { Ends } from "./ends";
import type { Marks } from "./marks";

export const makeMoves = ({
  marks,
  ends,
}: {
  readonly marks: Marks;
  readonly ends: Ends;
}) =>
  Effect.sync(() => {
    const moveMirrorsOfWorktree = Effect.fn(
      "MirrorLedger.moveMirrorsOfWorktree",
    )(function* (oldId: string, moved: { id: string; path: string }) {
      const daemon = yield* engineOrNull;
      if (daemon === null) return;
      daemon.moveHistory(oldId, moved.id);
      for (const [session, waiting] of marks.waitingOnPeer) {
        if (waiting.id === oldId) {
          marks.waitingOnPeer.set(session, { ...waiting, id: moved.id });
        }
      }
      if ((yield* daemon.status) !== "running") return;
      const sessions = (yield* mirrorSessions(daemon)).filter(
        (raw) => raw.localWorktreeId === oldId,
      );
      yield* Effect.forEach(
        sessions,
        (raw) =>
          daemon
            .recreate(raw.session, {
              localRoot: moved.path,
              deviceId: raw.deviceId,
              projectId: raw.projectId,
              worktreeId: raw.worktreeId,
              remoteRoot: raw.remoteRoot,
              name: raw.name,
              localWorktreeId: moved.id,
              labels: carriedLabels(raw, {}),
              ignores: raw.ignores,
            })
            .pipe(
              Effect.tap(() =>
                Effect.sync(() =>
                  daemon.noteEvent(moved.id, "resumed", "This worktree moved"),
                ),
              ),
              Effect.catch((error) =>
                Effect.gen(function* () {
                  yield* ends.endOnce(
                    raw.session,
                    daemon.terminate(raw.session),
                  );
                  daemon.noteEvent(
                    moved.id,
                    "stopped",
                    `This worktree moved and the mirror could not re-open (${errorWordsOf(error)}). The copy on the other device stays as a worktree.`,
                  );
                }),
              ),
            ),
        { concurrency: "unbounded", discard: true },
      );
    });

    return { moveMirrorsOfWorktree };
  });

export type Moves = Effect.Success<ReturnType<typeof makeMoves>>;
