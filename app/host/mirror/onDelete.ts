// This device's side of the engine's MirrorsOnDelete: a worktree's
// mirror stops before its delete's cleanup, its sessions here paused and
// the streams this device serves into it ended, so nothing crosses while
// the cleanup runs and the files go. A mirror is one worktree on two
// devices, so once they have gone the other side goes too (`both`) when
// the two were in step, judged before the pause and the streams' end
// (ledger/tombstones.ts), and only if it still holds what its own device
// read of it then, which its delete checks before its scripts stop and
// again right before its files go: the copy of an original here is
// deleted on its device, and the device holding the original of a copy
// here hears that both sides go. A mirror not in step ends with the
// other side kept, a worktree of its own, and so does one whose files
// git's step kept. One whose delete stopped short of that step (a
// cleanup that failed, a refusal, an interrupt) goes on. A move's
// teardown, a removal that must happen, and a delete the other side
// asked for leave the other side alone (`this`).
import { worktreesContract } from "@shigomori/contracts/modules/worktrees";
import type { MovedSource } from "@shigomori/contracts/schemas";
import * as Git from "@shigomori/engine/Git";
import {
  type DeleteEnd,
  MirrorsOnDelete,
} from "@shigomori/engine/MirrorsOnDelete";
import * as EngineWorktrees from "@shigomori/engine/Worktrees";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HostPushes from "@host/lib/HostPushes";
import { MirrorLedger } from "./MirrorLedger";

const NO_LOOK = {
  copies: new Map<string, MovedSource>(),
  original: undefined,
};

export const mirrorsOnDelete = (sides: "both" | "this") =>
  Effect.gen(function* () {
    const ledger = yield* MirrorLedger;
    const pushes = yield* HostPushes.HostPushes;
    const worktrees = yield* EngineWorktrees.Worktrees;
    const git = yield* Git.Git;

    // The other sides of a worktree about to be deleted, looked at while
    // its mirrors still run: its copies, and its original when it is a
    // copy, each against the branch's commit here. One with no branch
    // looks at nothing, so they stay. A cancel isn't held up by a device
    // slow to answer.
    const look = (projectId: string, worktreeId: string) =>
      Effect.gen(function* () {
        const { project, worktree } = yield* worktrees.resolveById(
          yield* worktrees.nowhere,
          { projectId, worktreeId },
        );
        if (worktree.detached) return NO_LOOK;
        const { branch } = worktree;
        const tip = yield* git.refTip(project.path, `refs/heads/${branch}`);
        if (Option.isNone(tip)) return NO_LOOK;
        return {
          copies: yield* ledger.lookAtCopiesOf(worktreeId, branch, tip.value),
          original: yield* ledger.lookAtOriginalOf(
            worktreeId,
            branch,
            tip.value,
          ),
        };
      }).pipe(
        Effect.orElseSucceed(() => NO_LOOK),
        Effect.interruptible,
      );

    return MirrorsOnDelete.of({
      stop: ({ projectId, worktreeId }) =>
        Effect.gen(function* () {
          const { copies, original } =
            sides === "both" ? yield* look(projectId, worktreeId) : NO_LOOK;
          // The root vanishing is this delete, which deals with the
          // mirror itself, not one behind the app's back.
          const releaseRoots = ledger.holdRootChecks([worktreeId]);
          const paused = yield* ledger
            .pauseMirrorsOn([worktreeId])
            .pipe(Effect.onError(() => Effect.sync(releaseRoots)));
          const releaseServing = ledger.holdServing([worktreeId]);
          return (end: DeleteEnd) =>
            Effect.gen(function* () {
              releaseServing();
              if (end === "short") yield* ledger.resumeMirrors(paused);
              if (end === "kept") yield* ledger.endMirrorsOfKept([worktreeId]);
              if (end !== "gone" || sides === "this") {
                releaseRoots();
                return;
              }
              yield* pushes.publish(worktreesContract, "removal", {
                projectId,
                worktreeId,
                state: "removed",
                ...(original === undefined ? {} : { expect: original }),
              });
              // The delete is done here: the copy's, a call to another
              // device, doesn't hold it up.
              yield* Effect.forkDetach(
                ledger
                  .deleteCopiesOf(worktreeId, copies)
                  .pipe(Effect.ensuring(Effect.sync(releaseRoots))),
              );
            });
        }),
    });
  });

// A delete from the terminal, which runs the engine in its own process
// and asks the app around its cleanup and its files going (the CLI's
// MirrorsOnDelete). A terminal gone between the two leaves its
// worktree's mirror paused.
const terminalDeleteEnded = (worktreeId: string, end: DeleteEnd) =>
  Effect.flatMap(MirrorLedger, (ledger) => {
    const stopped = ledger.takeTerminalStop(worktreeId);
    return stopped === undefined ? Effect.void : stopped(end);
  });

export const stopMirrorForDelete = (worktree: {
  readonly projectId: string;
  readonly worktreeId: string;
}) =>
  Effect.gen(function* () {
    // One a terminal gone before its answer left, kept.
    yield* terminalDeleteEnded(worktree.worktreeId, "kept");
    const mirrors = yield* mirrorsOnDelete("both");
    (yield* MirrorLedger).keepTerminalStop(
      worktree.worktreeId,
      yield* mirrors.stop(worktree),
    );
  });

export const mirrorDeleteDone = ({
  worktreeId,
  gone,
}: {
  readonly worktreeId: string;
  readonly gone: boolean;
}) => terminalDeleteEnded(worktreeId, gone ? "gone" : "kept");

export const mirrorDeleteStoppedShort = ({
  worktreeId,
}: {
  readonly worktreeId: string;
}) => terminalDeleteEnded(worktreeId, "short");
