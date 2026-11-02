// What a delete or a move of a worktree here does to its mirrors (the
// tombstone protocol, onDelete.ts and the worktrees' removing): the
// sessions on it paused while its files go, then stopped, ended with
// both sides kept, or ended with their copies deleted on their devices.
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { mirrorBranchFor } from "@shigomori/contracts/git/branches";
import {
  type MirrorSession,
  mirrorStopBlocker,
} from "@shigomori/contracts/modules/mirror";
import type { MovedSource } from "@shigomori/contracts/schemas";
import { answerWithin } from "@shigomori/engine/liveness";
import type { Stopped } from "@shigomori/engine/MirrorsOnDelete";
import { PeerReach, peerMirrorFor } from "@host/ipc/PeerReach";
import { log } from "@shared/log";
import { PROBE_TIMEOUT_MS } from "@shared/remote/link";
import type { MirrorEngine } from "../MirrorEngine";
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
    // exists nowhere else, so that side stays. The sessions on worktrees
    // about to be deleted here found in step.
    const mirrorsInStepOn = Effect.fn("MirrorLedger.mirrorsInStepOn")(
      function* (localWorktreeIds: readonly string[]) {
        const inStep = new Set<string>();
        yield* withSessionsOn(localWorktreeIds, (daemon, sessions) =>
          Effect.forEach(
            sessions,
            (raw) =>
              Effect.gen(function* () {
                const git = yield* daemon.refreshGit(raw.session);
                const live = (yield* findSession(daemon, raw.session)) ?? raw;
                if (mirrorStopBlocker({ ...live, git }) === undefined) {
                  inStep.add(raw.session);
                }
              }),
            { concurrency: "unbounded", discard: true },
          ),
        );
        return inStep;
      },
    );

    // The mirror into a copy here, when it is in step by the same check,
    // asked of the device running it before the delete ends the streams
    // into the copy, after which no mirror reads as in step. Its answer
    // is its last verdict, so the delete there expects what the copy
    // holds then. Only a mirror running live has a stream here, and a
    // device that doesn't answer within a probe's time confirms nothing.
    const mirrorInStepInto = Effect.fn("MirrorLedger.mirrorInStepInto")(
      function* (worktreeId: string) {
        const stream = streams
          .listServing()
          .find((served) => served.worktreeId === worktreeId);
        if (stream === undefined) return undefined;
        const listed = yield* answerWithin(
          peerMirrorFor(stream.peerDeviceId).list(),
          PROBE_TIMEOUT_MS,
        ).pipe(Effect.provideService(PeerReach, reach));
        if (Option.isNone(listed) || !Exit.isSuccess(listed.value)) {
          return undefined;
        }
        return listed.value.value.sessions.find(
          (session: MirrorSession) =>
            session.localWorktreeId === stream.peerWorktreeId &&
            mirrorStopBlocker(session) === undefined,
        );
      },
    );

    // The sessions on worktrees about to be deleted here, paused, so
    // nothing crosses while their files go. One that doesn't pause
    // fails, so the delete doesn't go ahead under it.
    const pauseMirrorsOn = Effect.fn("MirrorLedger.pauseMirrorsOn")(
      (localWorktreeIds: readonly string[]) =>
        withSessionsOn(localWorktreeIds, (daemon, sessions) =>
          Effect.forEach(
            sessions.filter((raw) => !raw.paused),
            (raw) => daemon.pause(raw.session),
            { concurrency: "unbounded", discard: true },
          ),
        ),
    );

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
    // then the copy of each one `inStep` names deleted on its device if
    // it still holds what the original held (`holding`, read once the
    // pause left nothing crossing), and every other copy kept, a
    // worktree of its own, as is one whose delete fails or is refused
    // there. A daemon that isn't running takes no copy: its sessions end
    // once it is, their copies kept.
    const deleteCopiesOf = Effect.fn("MirrorLedger.deleteCopiesOf")(function* (
      localWorktreeId: string,
      inStep: ReadonlySet<string>,
      holding: MovedSource | undefined,
    ) {
      const daemon = yield* engineOrNull;
      if (daemon === null) return;
      if ((yield* daemon.status) === "running") {
        yield* Effect.forEach(
          (yield* mirrorSessions(daemon)).filter(
            (raw) => marks.worktreeIdNow(raw) === localWorktreeId,
          ),
          (raw) =>
            holding !== undefined && inStep.has(raw.session)
              ? ends
                  .endThenDeleteCopy(daemon, raw, {
                    ...holding,
                    // A primary's copy is on mirror/<branch>.
                    branch: onMirrorBranch(raw)
                      ? mirrorBranchFor(holding.branch)
                      : holding.branch,
                  })
                  .pipe(
                    Effect.tap((stayed) =>
                      stayed === undefined
                        ? Effect.void
                        : Effect.sync(() =>
                            log.warn(
                              `[mirror] the copy of a deleted worktree stayed: ${stayed}`,
                            ),
                          ),
                    ),
                    Effect.ignoreCause({
                      log: "Warn",
                      message:
                        "[mirror] the mirror of a deleted worktree didn't end",
                    }),
                  )
              : Effect.asVoid(
                  ends.endOnce(raw.session, daemon.terminate(raw.session)),
                ),
          { concurrency: "unbounded", discard: true },
        );
      } else {
        marks.pendingStops.add(localWorktreeId);
      }
      daemon.forgetHistory(localWorktreeId);
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
      mirrorsInStepOn,
      mirrorInStepInto,
      pauseMirrorsOn,
      endMirrorsOfKept,
      deleteCopiesOf,
      holdRootChecks: marks.holdingRoots.hold,
      keepTerminalStop,
      takeTerminalStop,
    };
  });
