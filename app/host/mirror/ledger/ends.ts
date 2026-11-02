// How a session ends, and what becomes of its copy on the peer. Most
// ends keep the copy, a worktree of its own: it may be all that is left
// of the work (the original gone, or moved out of the mirror's reach), a
// delete would need a peer no longer on the account to confirm nothing
// is held here alone, the original wasn't deleted after all or was
// deleted while the two weren't in step, or there is nothing to delete
// (the copy is gone, or a re-open replaced the session). Two delete it,
// a person's stop of a live original and the original's delete here
// while the two were in step, through endThenDeleteCopy: the session
// ends first, since the other way round the copy's own delete would
// stop the session itself, mid-delete (its device announces the
// removal), and a delete that failed is looked into (copyIsGone) before
// the copy reads as stayed. The delete is forced, since the copy holds
// the original's uncommitted state by design, and expects what the
// copy's device read of it when the two were found in step, so a copy
// changed since stays.
import * as Effect from "effect/Effect";
import type { MovedSource } from "@shigomori/contracts/schemas";
import { errorWordsOf } from "@host/lib/errorWords";
import { PeerReach, peerWorktree, peerWorktreesFor } from "@host/ipc/PeerReach";
import { log } from "@shared/log";
import type { MirrorEngine } from "../MirrorEngine";
import { isTransferSession, type MirrorSessionRaw } from "../registry";
import type { Marks } from "./marks";

type Daemon = MirrorEngine["Service"];

export type Copy = Pick<
  MirrorSessionRaw,
  "deviceId" | "projectId" | "worktreeId"
>;

// Whether the peer answers, within a few seconds, that it no longer
// lists the session's copy. A peer that fails or stalls is no answer.
// A folder deleted by hand still lists until git prunes it.
const COPY_PROBE_MS = 5_000;

// A session's end, noted on the original's thread. A moved original's
// is the worktree it became (worktreeIdNow, read before the terminate:
// the daemon's snapshot without the session can come before its
// answer, and the bookkeeping then forgets the wait), its thread
// carried there first, so a worktree made at the old folder doesn't
// inherit it.
const noteEnded = (
  daemon: Daemon,
  raw: MirrorSessionRaw,
  detail: string,
  worktreeId: string,
) => {
  if (worktreeId === "") return;
  daemon.moveHistory(raw.localWorktreeId, worktreeId);
  daemon.noteEvent(worktreeId, "stopped", detail);
};

export const makeEnds = ({ marks }: { readonly marks: Marks }) =>
  Effect.gen(function* () {
    const reach = yield* PeerReach;

    // The copy deleted on its device, or why it stayed: a cleanup step
    // that failed there, or what `failed` makes of a call that did.
    const deleteCopy = (
      raw: MirrorSessionRaw,
      expect: MovedSource | undefined,
      failed: (error: unknown) => Effect.Effect<string | undefined>,
    ) =>
      peerWorktreesFor(raw.deviceId)
        .delete({
          projectId: raw.projectId,
          worktreeId: raw.worktreeId,
          force: true,
          oneSide: true,
          ...(expect === undefined ? {} : { expect }),
        })
        .pipe(
          Effect.map((removed) =>
            removed.ok
              ? undefined
              : `its ${removed.cleanupError.phase} step failed`,
          ),
          Effect.catch(failed),
          Effect.provideService(PeerReach, reach),
        );

    // Why the copy stayed, or undefined once it is gone.
    const endThenDeleteCopy = Effect.fn("MirrorLedger.endThenDeleteCopy")(
      function* (daemon: Daemon, raw: MirrorSessionRaw, expect?: MovedSource) {
        yield* daemon.terminate(raw.session);
        return yield* deleteCopy(raw, expect, (error) =>
          Effect.map(copyIsGone(raw), (gone) =>
            gone ? undefined : errorWordsOf(error),
          ),
        );
      },
    );

    const copyIsGone = (raw: Copy) =>
      peerWorktree(raw.deviceId, raw.projectId, raw.worktreeId).pipe(
        Effect.map((copy) => copy === undefined),
        Effect.timeoutOrElse({
          duration: COPY_PROBE_MS,
          orElse: () => Effect.succeed(false),
        }),
        Effect.orElseSucceed(() => false),
        Effect.provideService(PeerReach, reach),
      );

    // The end of a mirror whose original is gone, the original's thread
    // saying why.
    const endMirrorKeepingCopy = (
      daemon: Daemon,
      raw: MirrorSessionRaw,
      detail: string,
      worktreeId = marks.worktreeIdNow(raw),
    ) =>
      Effect.gen(function* () {
        yield* daemon.terminate(raw.session);
        noteEnded(daemon, raw, detail, worktreeId);
      });

    // True once the session ended. One that refuses is logged.
    const endOnce = <E, R>(
      session: string,
      end: Effect.Effect<unknown, E, R>,
    ) =>
      marks.whileEnding(
        session,
        end.pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.sync(() => {
              log.warn(
                `[mirror] could not end a session: ${errorWordsOf(error)}`,
              );
              return false;
            }),
          ),
        ),
      );

    // Each session ended, then noted "stopped" on its original's thread.
    // A session that refuses to end is logged, not thrown.
    const endSessions = (
      daemon: Daemon,
      doomed: readonly MirrorSessionRaw[],
      what: string,
      detail: string,
    ) =>
      Effect.forEach(
        doomed,
        (raw) => {
          const worktreeId = marks.worktreeIdNow(raw);
          return daemon.terminate(raw.session).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (!isTransferSession(raw)) {
                  noteEnded(daemon, raw, detail, worktreeId);
                }
              }),
            ),
            Effect.catch((error) =>
              Effect.sync(() =>
                log.warn(
                  `[mirror] could not end ${what}: ${errorWordsOf(error)}`,
                ),
              ),
            ),
          );
        },
        { concurrency: "unbounded", discard: true },
      );

    // The sessions on a worktree deleted or moved here, ended. One that
    // refuses is logged, not thrown: the delete is what was asked for,
    // and a stuck mirror must not be what blocks it.
    const endSessionsOnWorktree = (daemon: Daemon, localWorktreeId: string) =>
      Effect.flatMap(daemon.sessions, (sessions) =>
        Effect.forEach(
          sessions.filter(
            (raw) => marks.worktreeIdNow(raw) === localWorktreeId,
          ),
          (raw) =>
            daemon.terminate(raw.session).pipe(
              // A waiting session's old id has no worktree of its own:
              // what was noted there since the move goes too, so a
              // worktree made at the old folder doesn't inherit it.
              Effect.tap(() =>
                Effect.sync(() => {
                  const labelled = raw.localWorktreeId;
                  if (labelled !== localWorktreeId) {
                    daemon.forgetHistory(labelled);
                  }
                }),
              ),
              Effect.catch((error) =>
                Effect.sync(() =>
                  log.warn(
                    `[mirror] could not stop the mirror of a worktree being deleted: ${errorWordsOf(error)}`,
                  ),
                ),
              ),
            ),
          { concurrency: "unbounded", discard: true },
        ),
      );

    return {
      endThenDeleteCopy,
      copyIsGone,
      endMirrorKeepingCopy,
      endOnce,
      endSessions,
      endSessionsOnWorktree,
    };
  });

export type Ends = Effect.Success<ReturnType<typeof makeEnds>>;
