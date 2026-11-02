// This device's side of the engine's MirrorsOnDelete: a worktree's
// mirror stops before its delete's cleanup, its sessions here paused and
// the streams this device serves into it ended, so nothing crosses while
// the cleanup runs and the files go. A mirror is one worktree on two
// devices, so once they have gone the other side goes too (`both`) when
// the two were in step, judged before the pause and the streams' end
// (ledger/tombstones.ts), and only if it still holds what this side did
// once nothing crossed any more, which its delete checks right before
// its files go: the copy of an original here is deleted on its device,
// and the device holding the original of a copy here hears that both
// sides go. A mirror not in step ends with the other side kept, a
// worktree of its own, and so does one whose worktree's files didn't
// go. A move's teardown, a removal that must happen, and a delete the
// other side asked for leave the other side alone (`this`).
import { originalBranchOf } from "@shigomori/contracts/git/branches";
import { worktreesContract } from "@shigomori/contracts/modules/worktrees";
import type { MovedSource } from "@shigomori/contracts/schemas";
import * as Dirty from "@shigomori/engine/Dirty";
import * as Git from "@shigomori/engine/Git";
import { MirrorsOnDelete } from "@shigomori/engine/MirrorsOnDelete";
import * as EngineWorktrees from "@shigomori/engine/Worktrees";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HostPushes from "@host/lib/HostPushes";
import { MirrorLedger } from "./MirrorLedger";
import { onMirrorBranch } from "./registry";

export const mirrorsOnDelete = (sides: "both" | "this") =>
  Effect.gen(function* () {
    const ledger = yield* MirrorLedger;
    const pushes = yield* HostPushes.HostPushes;
    const worktrees = yield* EngineWorktrees.Worktrees;
    const dirty = yield* Dirty.Dirty;
    const git = yield* Git.Git;

    // What a worktree holds now: its branch at its tip, and the tree of
    // a capture of its uncommitted work, compared by tree since capture
    // commits differ. One that can't be read (no branch, a capture that
    // failed) is no proof of anything, so its other side stays.
    const holdingNow = (projectId: string, worktreeId: string) =>
      Effect.gen(function* () {
        const { project, worktree } = yield* worktrees.resolveById(
          yield* worktrees.nowhere,
          { projectId, worktreeId },
        );
        if (worktree.detached) return undefined;
        const tip = yield* git.refTip(
          project.path,
          `refs/heads/${worktree.branch}`,
        );
        if (Option.isNone(tip)) return undefined;
        const fresh = yield* dirty.capture({
          projectPath: project.path,
          worktreePath: worktree.path,
          worktreeId: worktree.id,
        });
        return {
          branch: worktree.branch,
          branchTip: tip.value,
          ...(fresh.captured
            ? { captureTree: yield* git.treeOf(project.path, fresh.commit) }
            : {}),
        } satisfies MovedSource;
      }).pipe(Effect.orElseSucceed(() => undefined));

    return MirrorsOnDelete.of({
      stop: ({ projectId, worktreeId }) =>
        Effect.gen(function* () {
          const inStep =
            sides === "both"
              ? yield* ledger.mirrorsInStepOn([worktreeId])
              : new Set<string>();
          const into =
            sides === "both"
              ? yield* ledger.mirrorInStepInto(worktreeId)
              : undefined;
          // The root vanishing is this delete, which deals with the
          // mirror itself, not one behind the app's back.
          const releaseRoots = ledger.holdRootChecks([worktreeId]);
          yield* ledger
            .pauseMirrorsOn([worktreeId])
            .pipe(Effect.onError(() => Effect.sync(releaseRoots)));
          const releaseServing = ledger.holdServing([worktreeId]);
          const holding =
            inStep.size > 0 || into !== undefined
              ? yield* holdingNow(projectId, worktreeId)
              : undefined;
          // A primary's copy is on mirror/<branch>, which the original
          // holds as <branch>.
          const branch =
            holding === undefined || into === undefined
              ? null
              : onMirrorBranch(into)
                ? originalBranchOf(holding.branch)
                : holding.branch;
          return (gone: boolean) =>
            Effect.gen(function* () {
              releaseServing();
              if (!gone || sides === "this") {
                if (!gone) yield* ledger.endMirrorsOfKept([worktreeId]);
                releaseRoots();
                return;
              }
              yield* HostPushes.push(worktreesContract, "removal", {
                projectId,
                worktreeId,
                state: "removed",
                ...(holding === undefined || branch === null
                  ? {}
                  : { expect: { ...holding, branch } }),
              }).pipe(Effect.provideService(HostPushes.HostPushes, pushes));
              // The delete is done here: the copy's, a call to another
              // device, doesn't hold it up.
              yield* Effect.forkDetach(
                ledger
                  .deleteCopiesOf(worktreeId, inStep, holding)
                  .pipe(Effect.ensuring(Effect.sync(releaseRoots))),
              );
            });
        }),
    });
  });

// A delete from the terminal, which runs the engine in its own process
// and asks the app around the files going (the CLI's MirrorsOnDelete).
// A terminal gone between the two leaves its worktree's mirror paused.
export const stopMirrorForDelete = (worktree: {
  readonly projectId: string;
  readonly worktreeId: string;
}) =>
  Effect.gen(function* () {
    // One a terminal gone before its answer left, kept.
    yield* mirrorDeleteDone({ worktreeId: worktree.worktreeId, gone: false });
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
}) =>
  Effect.flatMap(MirrorLedger, (ledger) => {
    const stopped = ledger.takeTerminalStop(worktreeId);
    return stopped === undefined ? Effect.void : stopped(gone);
  });
