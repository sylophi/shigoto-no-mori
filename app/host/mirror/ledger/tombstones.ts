// What a delete or a move of a worktree here does to its mirrors (the
// tombstone protocol, onDelete.ts and the worktrees' removing): the
// sessions on it paused while its files go, then stopped, ended with
// both sides kept, or ended with their copies deleted on their devices.
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import {
  type MirrorSession,
  mirrorStopBlocker,
} from "@shigomori/contracts/modules/mirror";
import type { MovedSource } from "@shigomori/contracts/schemas";
import { answerWithin } from "@shigomori/engine/liveness";
import type { Stopped } from "@shigomori/engine/MirrorsOnDelete";
import { PeerReach, peerMirrorFor } from "@host/ipc/PeerReach";
import { errorWordsOf } from "@host/lib/errorWords";
import { log } from "@shared/log";
import { PROBE_TIMEOUT_MS } from "@shared/remote/link";
import type { MirrorEngine } from "../MirrorEngine";
import { peerHolding } from "../peerHolding";
import {
  engineOrNull,
  findSession,
  type MirrorSessionRaw,
  mirrorSessions,
  onMirrorBranch,
  runningEngine,
} from "../registry";
import type { Ends } from "./ends";
import type { Marks } from "./marks";
import type { Streams } from "./streams";

const KEPT_DETAIL =
  "This worktree wasn't deleted, so its mirror ended. The copy on the other device stays as a worktree.";

// Why a copy stays, finishing "The copy on <device> stays, since …"
// like mirrorStopBlocker's words.
const UNREAD = "it couldn't be read there";
const NOT_DELETED = "it changed or couldn't be deleted there";

// What a delete's look found of a copy: what it holds, which its delete
// then expects, or why it stays.
export type CopyLook =
  | { readonly expect: MovedSource }
  | { readonly stays: string };

// A copy on `deviceId` that stayed when its original was deleted here.
export type Stayed = { readonly deviceId: string; readonly why: string };

export const makeTombstones = ({
  marks,
  ends,
  streams,
}: {
  readonly marks: Marks;
  readonly ends: Ends;
  readonly streams: Streams;
}) =>
  Effect.gen(function* () {
    const reach = yield* PeerReach;

    // A delete from the terminal, which runs the engine in its own
    // process and asks the app around the files going (onDelete.ts
    // stopMirrorForDelete): what its stop left to do once the files
    // went. A terminal gone between the two leaves its worktree's mirror
    // paused.
    const fromTerminal = new Map<string, Stopped>();

    // Every session whose local side is the named worktree, stopped. The
    // tombstone protocol calls this once a delete or a relocate has gone
    // through (withDeletesInflight says why after and not before): left
    // alone, the session sits halted on a root that is gone or moved and
    // the peer keeps calling its worktree mirrored. A relocate changes
    // the worktree id (it is path derived), but the label still carries
    // the old one, which is what the caller passes.
    const stopMirrorsForWorktree = Effect.fn(
      "MirrorLedger.stopMirrorsForWorktree",
    )(function* (localWorktreeId: string) {
      // Absent (a check that never mounts the daemon) there is nothing
      // mirroring anything.
      const daemon = yield* engineOrNull;
      if (daemon === null) return;
      if ((yield* daemon.status) === "running") {
        yield* ends.endSessionsOnWorktree(daemon, localWorktreeId);
      } else {
        marks.pendingStops.add(localWorktreeId);
      }
      // The worktree is gone, so its thread has no page left to show on.
      daemon.forgetHistory(localWorktreeId);
    });

    // The running daemon's sessions mirroring worktrees here, handed to
    // `use`. A daemon that isn't running mirrors nothing.
    const withSessionsOn = <E, R>(
      localWorktreeIds: readonly string[],
      use: (
        daemon: MirrorEngine["Service"],
        sessions: readonly MirrorSessionRaw[],
      ) => Effect.Effect<unknown, E, R>,
    ) =>
      Effect.gen(function* () {
        const daemon = yield* runningEngine;
        if (daemon === null) return;
        yield* use(
          daemon,
          (yield* mirrorSessions(daemon)).filter((raw) =>
            localWorktreeIds.includes(marks.worktreeIdNow(raw)),
          ),
        );
      });

    // A mirror is one worktree on two devices, so deleting either side
    // deletes both, once the two are in step: what a Stop checks before
    // it removes the copy (mirrorStopBlocker), git looked at again now as
    // there. A pair not in step may hold work on the other side that
    // exists nowhere else, so that side stays. What each session on a
    // worktree about to be deleted here finds of its copy: read on the
    // copy's device (peerHolding), then found in step, so what it read
    // is what was in step. One already not in step isn't read.
    const lookAtCopiesOf = Effect.fn("MirrorLedger.lookAtCopiesOf")(
      function* (localWorktreeId: string, branch: string) {
        const looks = new Map<string, CopyLook>();
        yield* withSessionsOn([localWorktreeId], (daemon, sessions) =>
          Effect.forEach(
            sessions,
            (raw) =>
              Effect.gen(function* () {
                const before = mirrorStopBlocker({
                  ...raw,
                  git: daemon.gitStatus(raw.session),
                });
                if (before !== undefined) {
                  looks.set(raw.session, { stays: before });
                  return;
                }
                const expect = yield* peerHolding(
                  raw.deviceId,
                  { projectId: raw.projectId, worktreeId: raw.worktreeId },
                  branch,
                );
                if (expect === undefined) {
                  looks.set(raw.session, { stays: UNREAD });
                  return;
                }
                const git = yield* daemon.refreshGit(raw.session);
                const live = (yield* findSession(daemon, raw.session)) ?? raw;
                const blocker = mirrorStopBlocker({ ...live, git });
                looks.set(
                  raw.session,
                  blocker === undefined ? { expect } : { stays: blocker },
                );
              }),
            { concurrency: "unbounded", discard: true },
          ),
        );
        return looks;
      },
      Effect.provideService(PeerReach, reach),
    );

    // The original of a copy here, read on its device (peerHolding),
    // when the device running the mirror says the two are in step,
    // asked before the delete ends the stream into the copy, after which
    // no mirror reads as in step. Its answer is its last verdict, and
    // its delete there expects what the read right after found. Only a
    // mirror running live has a stream here, a device that doesn't
    // answer within a probe's time confirms nothing, and a primary's
    // copy (on mirror/<branch>) takes nothing: a primary is never
    // deleted.
    const lookAtOriginalOf = Effect.fn("MirrorLedger.lookAtOriginalOf")(
      function* (worktreeId: string, branch: string) {
        const stream = streams.mirrorStreamInto(worktreeId);
        if (stream === undefined) return undefined;
        const listed = yield* answerWithin(
          peerMirrorFor(stream.peerDeviceId).list(),
          PROBE_TIMEOUT_MS,
        );
        if (Option.isNone(listed) || !Exit.isSuccess(listed.value)) {
          return undefined;
        }
        const session = listed.value.value.sessions.find(
          (running: MirrorSession) =>
            running.localWorktreeId === stream.peerWorktreeId &&
            mirrorStopBlocker(running) === undefined,
        );
        if (session === undefined || onMirrorBranch(session)) return undefined;
        return yield* peerHolding(
          stream.peerDeviceId,
          {
            projectId: session.localProjectId,
            worktreeId: session.localWorktreeId,
          },
          branch,
        );
      },
      Effect.provideService(PeerReach, reach),
    );

    // The sessions on worktrees about to be deleted here, paused, so
    // nothing crosses while their files go, answering the ones it paused.
    // One that doesn't pause fails, so the delete doesn't go ahead under
    // it.
    const pauseMirrorsOn = Effect.fn("MirrorLedger.pauseMirrorsOn")(function* (
      localWorktreeIds: readonly string[],
    ) {
      const paused: string[] = [];
      yield* withSessionsOn(localWorktreeIds, (daemon, sessions) =>
        Effect.forEach(
          sessions.filter((raw) => !raw.paused),
          (raw) =>
            Effect.map(daemon.pause(raw.session), () => {
              paused.push(raw.session);
            }),
          { concurrency: "unbounded", discard: true },
        ),
      );
      return paused;
    });

    // What a delete paused, going on once the delete stopped short of
    // the files. One that doesn't resume is logged.
    const resumeMirrors = Effect.fn("MirrorLedger.resumeMirrors")(function* (
      sessions: readonly string[],
    ) {
      const daemon = yield* runningEngine;
      if (daemon === null) return;
      yield* Effect.forEach(
        sessions,
        (session) =>
          daemon
            .resume(session)
            .pipe(
              Effect.catch((error) =>
                Effect.sync(() =>
                  log.warn(
                    `[mirror] could not resume a mirror: ${errorWordsOf(error)}`,
                  ),
                ),
              ),
            ),
        { concurrency: "unbounded", discard: true },
      );
    });

    // A delete that didn't go through ends the mirrors of what it kept,
    // both sides left as worktrees of their own, so neither is held to
    // the other's delete.
    const endMirrorsOfKept = Effect.fn("MirrorLedger.endMirrorsOfKept")(
      (localWorktreeIds: readonly string[]) =>
        withSessionsOn(localWorktreeIds, (daemon, sessions) =>
          ends.endSessions(
            daemon,
            sessions,
            "the mirror of a worktree kept",
            KEPT_DETAIL,
          ),
        ),
    );

    // The other side of a worktree deleted here: each session ended,
    // then its copy deleted on its device if the look found it in step,
    // expecting what it held then, and every other copy kept, a worktree
    // of its own, as is one whose delete fails or is refused there.
    // Answers the copies that stayed, and why. A daemon that isn't
    // running takes no copy: its sessions end once it is, their copies
    // kept.
    const deleteCopiesOf = Effect.fn("MirrorLedger.deleteCopiesOf")(function* (
      localWorktreeId: string,
      looks: ReadonlyMap<string, CopyLook>,
    ) {
      const daemon = yield* engineOrNull;
      if (daemon === null) return [];
      const stayed: Stayed[] = [];
      if ((yield* daemon.status) === "running") {
        yield* Effect.forEach(
          (yield* mirrorSessions(daemon)).filter(
            (raw) => marks.worktreeIdNow(raw) === localWorktreeId,
          ),
          (raw) => {
            const look = looks.get(raw.session);
            const stays = (why: string) =>
              Effect.sync(() => {
                stayed.push({ deviceId: raw.deviceId, why });
              });
            if (look === undefined || "stays" in look) {
              return Effect.andThen(
                ends.endOnce(raw.session, daemon.terminate(raw.session)),
                look === undefined ? Effect.void : stays(look.stays),
              );
            }
            return ends.endThenDeleteCopy(daemon, raw, look.expect).pipe(
              Effect.flatMap((failed) =>
                failed === undefined
                  ? Effect.void
                  : Effect.andThen(
                      Effect.sync(() =>
                        log.warn(
                          `[mirror] the copy of a deleted worktree stayed: ${failed}`,
                        ),
                      ),
                      stays(NOT_DELETED),
                    ),
              ),
              Effect.ignoreCause({
                log: "Warn",
                message: "[mirror] the mirror of a deleted worktree didn't end",
              }),
            );
          },
          { concurrency: "unbounded", discard: true },
        );
      } else {
        marks.pendingStops.add(localWorktreeId);
      }
      daemon.forgetHistory(localWorktreeId);
      return stayed;
    });

    const keepTerminalStop = (worktreeId: string, stopped: Stopped): void => {
      fromTerminal.set(worktreeId, stopped);
    };

    const takeTerminalStop = (worktreeId: string): Stopped | undefined => {
      const stopped = fromTerminal.get(worktreeId);
      fromTerminal.delete(worktreeId);
      return stopped;
    };

    return {
      stopMirrorsForWorktree,
      lookAtCopiesOf,
      lookAtOriginalOf,
      pauseMirrorsOn,
      resumeMirrors,
      endMirrorsOfKept,
      deleteCopiesOf,
      holdRootChecks: marks.holdingRoots.hold,
      keepTerminalStop,
      takeTerminalStop,
    };
  });
