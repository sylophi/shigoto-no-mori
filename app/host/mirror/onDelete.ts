// This device's side of the engine's MirrorsOnDelete: a worktree's
// mirror stops before its files go, its sessions here paused and the
// streams this device serves into it ended, so nothing crosses while
// they go. A mirror is one worktree on two devices, so once they have
// gone the other side goes too (`both`): the copy of an original here
// is deleted on its device, and the device holding the original of a
// copy here hears that both sides go. A worktree whose files didn't go
// ends its mirror, both sides left as worktrees of their own. A move's
// teardown, a removal that must happen, and a delete the other side
// asked for leave the other side alone (`this`).
import { worktreesContract } from "@shigomori/contracts/modules/worktrees";
import { MirrorsOnDelete } from "@shigomori/engine/MirrorsOnDelete";
import * as Effect from "effect/Effect";
import * as HostPushes from "@host/lib/HostPushes";
import { PeerReach } from "@host/ipc/PeerReach";
import {
  deleteCopiesOf,
  endMirrorsOfKept,
  holdRootChecks,
  pauseMirrorsOn,
} from "./registry";
import { holdServing } from "./serving";

export const mirrorsOnDelete = (sides: "both" | "this") =>
  Effect.gen(function* () {
    const reach = yield* PeerReach;
    const pushes = yield* HostPushes.HostPushes;
    return MirrorsOnDelete.of({
      stop: ({ projectId, worktreeId }) =>
        Effect.gen(function* () {
          // The root vanishing is this delete, which deals with the
          // mirror itself, not one behind the app's back.
          const releaseRoots = holdRootChecks([worktreeId]);
          yield* pauseMirrorsOn([worktreeId]).pipe(
            Effect.onError(() => Effect.sync(releaseRoots)),
          );
          const releaseServing = holdServing([worktreeId]);
          return (gone: boolean) =>
            Effect.gen(function* () {
              releaseServing();
              if (!gone || sides === "this") {
                if (!gone) yield* endMirrorsOfKept([worktreeId]);
                releaseRoots();
                return;
              }
              yield* HostPushes.push(worktreesContract, "removal", {
                projectId,
                worktreeId,
                state: "removed",
                bothSides: true,
              }).pipe(Effect.provideService(HostPushes.HostPushes, pushes));
              // The delete is done here: the copy's, a call to another
              // device, doesn't hold it up.
              yield* Effect.forkDetach(
                deleteCopiesOf([worktreeId]).pipe(
                  Effect.provideService(PeerReach, reach),
                  Effect.ensuring(Effect.sync(releaseRoots)),
                ),
              );
            });
        }),
    });
  });

// A delete from the terminal, which runs the engine in its own process
// and asks the app around the files going (the CLI's MirrorsOnDelete).
// A terminal gone between the two leaves its worktree's mirror paused.
const fromTerminal = new Map<
  string,
  Effect.Success<ReturnType<MirrorsOnDelete["Service"]["stop"]>>
>();

export const stopMirrorForDelete = (worktree: {
  readonly projectId: string;
  readonly worktreeId: string;
}) =>
  Effect.gen(function* () {
    // One a terminal gone before its answer left, kept.
    yield* mirrorDeleteDone({ worktreeId: worktree.worktreeId, gone: false });
    const mirrors = yield* mirrorsOnDelete("both");
    fromTerminal.set(worktree.worktreeId, yield* mirrors.stop(worktree));
  });

export const mirrorDeleteDone = ({
  worktreeId,
  gone,
}: {
  readonly worktreeId: string;
  readonly gone: boolean;
}) =>
  Effect.suspend(() => {
    const stopped = fromTerminal.get(worktreeId);
    fromTerminal.delete(worktreeId);
    return stopped === undefined ? Effect.void : stopped(gone);
  });
