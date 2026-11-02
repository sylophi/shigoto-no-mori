// A worktree here re-keyed: its id is path derived, so a move put it
// under a new one. What is kept under the old id follows: its thread,
// and each session on it, re-opened on the new path (MirrorEngine's
// recreate, the git follower's agreement carried across by the replaces
// label). The engine halted the old session the moment its root went,
// so nothing crossed meanwhile. The engine opens a session only against
// both sides, so one whose peer doesn't take this device's calls (not
// reached at a start, away, or a switch of its off) waits for it,
// paused, and the sweep runs this again once the peer comes, within 2
// minutes (sweep.ts). So does every session of a daemon that isn't
// running: its first snapshot finds the session's root gone and the
// move recorded. A re-open that fails all the same ends the mirror
// instead, the copy kept, and the thread says so. A session waiting to
// re-open into the worktree that moved is the moved one's now
// (worktreeIdNow).
import * as Effect from "effect/Effect";
import { stamp } from "@shigomori/engine/keptAnswers";
import { PeerReach } from "@host/ipc/PeerReach";
import { errorWordsOf } from "@host/lib/errorWords";
import type { MirrorEngine } from "../MirrorEngine";
import {
  carriedLabels,
  engineOrNull,
  type MirrorSessionRaw,
  mirrorSessions,
} from "../registry";
import type { Ends } from "./ends";
import type { Marks } from "./marks";

type Moved = { readonly id: string; readonly path: string };

export const makeMoves = ({
  marks,
  ends,
}: {
  readonly marks: Marks;
  readonly ends: Ends;
}) =>
  Effect.gen(function* () {
    const reach = yield* PeerReach;

    const reopen = (
      daemon: MirrorEngine["Service"],
      raw: MirrorSessionRaw,
      moved: Moved,
    ) =>
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
              yield* ends.endOnce(raw.session, daemon.terminate(raw.session));
              daemon.noteEvent(
                moved.id,
                "stopped",
                `This worktree moved and the mirror could not re-open (${errorWordsOf(error)}). The copy on the other device stays as a worktree.`,
              );
            }),
          ),
        );

    // Looked at again when the peer comes (MirrorEngineLayer's
    // admissions), the wait counted from when it began.
    const waitOnPeer = (
      daemon: MirrorEngine["Service"],
      raw: MirrorSessionRaw,
      moved: Moved,
    ) =>
      Effect.gen(function* () {
        marks.waitingOnPeer.set(raw.session, {
          ...moved,
          since: marks.waitingOnPeer.get(raw.session)?.since ?? (yield* stamp),
        });
        marks.rootLooks.delete(raw.session);
        if (!raw.paused) {
          yield* Effect.ignoreCause(daemon.pause(raw.session), {
            log: "Warn",
            message: "[mirror] a session waiting on its peer didn't pause",
          });
        }
      });

    const moveMirrorsOfWorktree = Effect.fn(
      "MirrorLedger.moveMirrorsOfWorktree",
    )(function* (oldId: string, moved: Moved) {
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
          reach.admits(raw.deviceId)
            ? reopen(daemon, raw, moved)
            : waitOnPeer(daemon, raw, moved),
        { concurrency: "unbounded", discard: true },
      );
    });

    return { moveMirrorsOfWorktree };
  });

export type Moves = Effect.Success<ReturnType<typeof makeMoves>>;
