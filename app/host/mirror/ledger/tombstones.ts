// What a delete or a move of a worktree here does to its mirrors (the
// tombstone protocol, onDelete.ts and the worktrees' removing): the
// sessions on it paused while its files go, then stopped, ended with
// both sides kept, or ended once their copies are deleted on their
// devices.
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { mirrorStopBlocker } from "@shigomori/contracts/modules/mirror";
import { answerWithin } from "@shigomori/engine/liveness";
import type { Stopped } from "@shigomori/engine/MirrorsOnDelete";
import { PeerReach, peerMirrorFor } from "@host/ipc/PeerReach";
import { PROBE_TIMEOUT_MS } from "@shared/remote/link";
import type { MirrorEngine } from "../MirrorEngine";
import {
  engineOrNull,
  type MirrorSessionRaw,
  mirrorSessions,
  runningEngine,
} from "../registry";
import type { Ends } from "./ends";
import type { Marks } from "./marks";
import type { Streams } from "./streams";

const KEPT_DETAIL =
  "This worktree wasn't deleted, so its mirror ended. The copy on the other device stays as a worktree.";

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
    // it removes the copy (mirrorStopBlocker), here on the git
    // follower's last verdict. A pair not in step may hold work on the
    // other side that exists nowhere else, so that side stays. The
    // sessions on worktrees about to be deleted here are paused first,
    // so nothing crosses while their files go, and answered with those
    // in step before their pause, whose copies the delete takes. One
    // that doesn't pause fails, so the delete doesn't go ahead under it.
    const pauseMirrorsOn = Effect.fn("MirrorLedger.pauseMirrorsOn")(function* (
      localWorktreeIds: readonly string[],
    ) {
      const inStep = new Set<string>();
      yield* withSessionsOn(localWorktreeIds, (daemon, sessions) => {
        for (const raw of sessions) {
          const git = daemon.gitStatus(raw.session);
          if (mirrorStopBlocker({ ...raw, git }) === undefined) {
            inStep.add(raw.session);
          }
        }
        return Effect.forEach(
          sessions.filter((raw) => !raw.paused),
          (raw) => daemon.pause(raw.session),
          { concurrency: "unbounded", discard: true },
        );
      });
      return inStep;
    });

    // Whether the mirror into a copy here is in step by the same check,
    // asked of the device running it before the delete ends the streams
    // into the copy, after which no mirror reads as in step. Only a
    // mirror running live has a stream here, and a device that doesn't
    // answer within a probe's time confirms nothing.
    const copyInStep = Effect.fn("MirrorLedger.copyInStep")(function* (
      worktreeId: string,
    ) {
      const stream = streams
        .listServing()
        .find((served) => served.worktreeId === worktreeId);
      if (stream === undefined) return false;
      const listed = yield* answerWithin(
        peerMirrorFor(stream.peerDeviceId).list(),
        PROBE_TIMEOUT_MS,
      ).pipe(Effect.provideService(PeerReach, reach));
      return Option.exists(
        listed,
        (exit) =>
          Exit.isSuccess(exit) &&
          exit.value.sessions.some(
            (session) =>
              session.localWorktreeId === stream.peerWorktreeId &&
              mirrorStopBlocker(session) === undefined,
          ),
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

    // The other side of worktrees deleted here: the copy of each session
    // `inStep` names deleted on its device, then the session ended, and
    // every other session ended with its copy kept, a worktree of its
    // own. One whose copy can't be deleted now stays, paused on a root
    // that is gone, for the sweep to finish when the peer comes. A
    // daemon that isn't running takes no copy: its sessions end once it
    // is, their copies kept.
    const deleteCopiesOf = Effect.fn("MirrorLedger.deleteCopiesOf")(function* (
      localWorktreeIds: readonly string[],
      inStep: ReadonlySet<string>,
    ) {
      const daemon = yield* engineOrNull;
      if (daemon === null) return;
      if ((yield* daemon.status) === "running") {
        yield* Effect.forEach(
          (yield* mirrorSessions(daemon)).filter((raw) =>
            localWorktreeIds.includes(marks.worktreeIdNow(raw)),
          ),
          (raw) =>
            inStep.has(raw.session)
              ? Effect.map(ends.deleteCopyThenEnd(daemon, raw), (ended) => {
                  if (!ended) {
                    marks.copiesToDelete.set(raw.session, raw.deviceId);
                  }
                })
              : Effect.asVoid(
                  ends.endOnce(raw.session, daemon.terminate(raw.session)),
                ),
          { concurrency: "unbounded", discard: true },
        );
      } else {
        for (const id of localWorktreeIds) marks.pendingStops.add(id);
      }
      for (const id of localWorktreeIds) daemon.forgetHistory(id);
    });

    // A peer taking this device's calls again: the copies still to
    // delete there are looked at again.
    const lookAgainAt = (deviceId: string) => {
      for (const [session, peer] of marks.copiesToDelete) {
        if (peer === deviceId) marks.rootLooks.delete(session);
      }
    };

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
      pauseMirrorsOn,
      copyInStep,
      endMirrorsOfKept,
      deleteCopiesOf,
      lookAgainAt,
      holdRootChecks: marks.holdingRoots.hold,
      keepTerminalStop,
      takeTerminalStop,
    };
  });
