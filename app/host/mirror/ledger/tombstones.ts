// What a delete or a move of a worktree here does to its mirrors (the
// tombstone protocol, onDelete.ts and the worktrees' removing): the
// sessions on it paused while its files go, then stopped, ended with
// both sides kept, or ended once their copies are deleted on their
// devices.
import * as Effect from "effect/Effect";
import type { Stopped } from "@shigomori/engine/MirrorsOnDelete";
import type { MirrorEngine } from "../MirrorEngine";
import {
  engineOrNull,
  type MirrorSessionRaw,
  mirrorSessions,
  runningEngine,
} from "../registry";
import type { Ends } from "./ends";
import type { Marks } from "./marks";

const KEPT_DETAIL =
  "This worktree wasn't deleted, so its mirror ended. The copy on the other device stays as a worktree.";

export const makeTombstones = ({
  marks,
  ends,
}: {
  readonly marks: Marks;
  readonly ends: Ends;
}) =>
  Effect.sync(() => {
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
    // deletes both. The sessions on worktrees about to be deleted here
    // are paused first, so nothing crosses while their files go. One that
    // doesn't pause fails, so the delete doesn't go ahead under it.
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

    // The other side of worktrees deleted here: each session's copy
    // deleted on its device, then the session ended. One whose copy
    // can't be deleted now stays, paused on a root that is gone, for the
    // sweep to finish when the peer comes, and so do the sessions of a
    // daemon that isn't running, read once it is.
    const deleteCopiesOf = Effect.fn("MirrorLedger.deleteCopiesOf")(function* (
      localWorktreeIds: readonly string[],
    ) {
      const daemon = yield* engineOrNull;
      if (daemon === null) return;
      if ((yield* daemon.status) === "running") {
        yield* Effect.forEach(
          (yield* mirrorSessions(daemon)).filter((raw) =>
            localWorktreeIds.includes(marks.worktreeIdNow(raw)),
          ),
          (raw) =>
            Effect.map(ends.deleteCopyThenEnd(daemon, raw), (ended) => {
              if (!ended) marks.copiesToDelete.set(raw.session, raw.deviceId);
            }),
          { concurrency: "unbounded", discard: true },
        );
      } else {
        for (const id of localWorktreeIds) marks.copiesToDeleteOn.add(id);
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
      endMirrorsOfKept,
      deleteCopiesOf,
      lookAgainAt,
      holdRootChecks: marks.holdingRoots.hold,
      keepTerminalStop,
      takeTerminalStop,
    };
  });
