// The landing: the copy a move makes on the destination, one function
// run there whichever device started the move. A pull runs it here
// against a link to the source (move.ts), a send asks the peer to run
// it (sync:receiveWorktree, landForSender below) against a link the
// sender answers on. The source's side is sourceLink.ts.
import { callFailureOf } from "@shigomori/contracts/errors";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import {
  type MirrorIgnoreMode,
  pullBringsIgnoredFiles,
  type SyncCloneInto,
  type SyncPullProgress,
  type SyncReceipt,
  syncContract,
} from "@shigomori/contracts/modules/sync";
import type { HandlerContext } from "@shared/ipc/transport";
import { errorWordsOf } from "@host/lib/errorWords";
import {
  branchInTheWay,
  pullBranchCollision,
  pullBranchInTheWay,
  pullFolderCollision,
} from "@shared/pullCollision";
import { type Project } from "@shigomori/contracts/schemas";
import { changing } from "@host/lib/Engine";
import * as Ops from "@host/lib/engineOps";
import * as Worktrees from "@host/lib/Worktrees";
import { incomingRef as incomingRefFor } from "@shigomori/engine/Bundle";
import { dirtyRef } from "@shigomori/engine/Dirty";
import * as Git from "@shigomori/engine/Git";
import {
  addProject,
  findProjectByIdentity,
  findProjectByIdentityOrFail,
} from "@host/lib/projects";
import { cloneCheckoutFromPeer } from "@host/lib/sync/cloneFromPeer";
import { MoveCancelledError } from "@host/lib/sync/Moves";
import {
  attachLinkFarEnd,
  linkSource,
  type ProgressFrame,
  type WorktreeSource,
} from "@host/lib/sync/sourceLink";
import { worktreeNotifiers } from "@host/ipc/scriptRun";
import type { EffectHandlers } from "@shigomori/contracts/types";
import type { HostServices } from "@host/process/services";
import { landInvitedMirror } from "@host/mirror/invites";

// The branch the landing asked for is gone from the source.
class SourceBranchGoneError extends Schema.TaggedError<SourceBranchGoneError>()(
  "SourceBranchGoneError",
  { branch: Schema.String },
) {
  override get message(): string {
    return `${this.branch} no longer exists on the source device.`;
  }
}

// The clone landed, but could not be added as a project.
class CloneUnregisteredError extends Schema.TaggedError<CloneUnregisteredError>()(
  "CloneUnregisteredError",
  { path: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `Cloned into ${this.path}, but couldn't add it as a project: ${this.reason}`;
  }
}

// Where a landing would refuse. Updating an existing branch is out of
// scope, so a held one refuses with the state the user can act on.
class LandingCollisionError extends Schema.TaggedError<LandingCollisionError>()(
  "LandingCollisionError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

const refuseLandingCollision = Effect.fnUntraced(function* (
  project: Project,
  branch: string,
  worktreeName: string | undefined,
) {
  const [{ local }, existing] = yield* Effect.all(
    [
      Effect.flatMap(Git.Git, (git) => git.listBranches(project.path)),
      Ops.listWorktreeIdentities({ projectId: project.id }),
    ],
    { concurrency: 2 },
  );
  if (local.includes(branch)) {
    // Name the worktree holding it when one does: that is the thing
    // the user has to delete or unshelve.
    const holder = existing.find((w) => w.branch === branch);
    return yield* new LandingCollisionError({
      reason: pullBranchCollision(branch, holder),
    });
  }
  // Refused here, before the transfer, rather than by the create.
  const inTheWay = branchInTheWay(branch, local);
  if (inTheWay !== undefined) {
    return yield* new LandingCollisionError({
      reason: pullBranchInTheWay(branch, inTheWay),
    });
  }
  // The copy keeps the source's folder name, and the engine's create
  // refuses a taken one (a worktree of this project by that name,
  // case-insensitively, or anything at the path). That refusal lands at
  // the create, after the bundle crossed. The engine's destination read
  // makes the same two checks here, before a byte moves.
  if (worktreeName !== undefined) {
    const { path, taken } = yield* Ops.worktreeDestination(
      project.id,
      worktreeName,
    );
    if (taken) {
      return yield* new LandingCollisionError({
        reason: pullFolderCollision(worktreeName, path),
      });
    }
  }
});

// A move's span attributes. The peer's half of a move continues the
// same trace over the device link, so nothing else ties the two.
export const moveAttributes = (
  direction: "pull" | "send",
  peer: string | undefined,
) => ({ direction, peer });

// What a landing is told: which repo (by identity, re-resolved here),
// which branch the commits arrive under and which one the copy is
// created on (they differ for a primary's mirror, contracts' git/
// branches.ts), the folder name, the setup switch, where to clone the
// repo when this device has none, and the source worktree's id (the
// key its capture ref arrives under).
export type Landing = {
  identity: string;
  branch: string;
  landBranch: string;
  worktreeName?: string;
  runSetup?: boolean;
  // The move's leave-out rule, whose files step brings the source's
  // ignored files after the create.
  ignoreMode?: MirrorIgnoreMode;
  ignores?: readonly string[];
  cloneInto?: SyncCloneInto;
  sourceWorktreeId: string;
};

// The landing, on the destination, whichever device started the move.
// Sequenced: the landing project (made first by a clone from the
// source when this device has none and was told where) -> the
// refusals, before a byte moves -> the tip, then the capture of the
// source's dirty state -> the branch and the capture fetched under
// refs/shigomori/ -> the worktree created through the engine's ordinary
// create (carry-over and setup ride along) -> the capture re-keyed and
// applied -> the incoming ref swept. The sweep is a finalizer that
// opens BEFORE the fetch: the engine's bundle unpack runs one non-atomic
// git fetch over several refspecs, so a partial fetch can land the
// incoming ref and then fail, and a survivor is NOT harmless -- a stale
// refs/shigomori/incoming/foo blocks any later ref named
// incoming/foo/bar at git's directory/file boundary. A failure before
// the create leaves at most the capture ref (a retry overwrites it).
// After the create, an apply failure resolves with dirtyApplied:false
// rather than failing: the worktree and branch are real and useful,
// and the dirty state is still safe on the source device.
//
// The landing commits when it answers: the create is held in `move`
// (Worktrees.createHeld) until the caller runs the `keep` it answers
// with, once nothing of its own is left to fail, so a failure of any
// step after the create (the capture's ref) removes the copy, and so does
// an interrupt (the move's cancel) at any step of the move, which
// stops whichever step is waiting (the link's question, the engine's
// create). The destination is then as it was, bar a clone that got
// registered (which stays, a checkout at the place the user named) and
// a capture ref a retry overwrites.
export const landWorktree = (
  source: WorktreeSource,
  landing: Landing,
  ctx: HandlerContext,
  progress: (frame: ProgressFrame) => void,
  move: Scope.Scope,
) =>
  Effect.gen(function* () {
    const { branch, landBranch, sourceWorktreeId } = landing;

    // 1. The landing project, re-resolved by identity from disk, or made
    // now: with none, and a place named for one, the repo is cloned from
    // the source first (cloneFromPeer.ts), or the checkout of it already
    // there is registered, and the copy lands in that. A
    // checkout this device has wins over the place named: the dialog
    // that named it was reading a stale list, and a second clone of a
    // repo already here is not what anyone asked for.
    let cloned: Project | undefined;
    let project: Project;
    const { cloneInto } = landing;
    if (cloneInto === undefined) {
      project = yield* findProjectByIdentityOrFail(landing.identity);
    } else {
      const held = yield* findProjectByIdentity(landing.identity);
      if (held === undefined) progress({ step: "clone" });
      project =
        held ??
        (cloned = yield* cloneCheckoutFromPeer(
          source,
          cloneInto,
          landBranch,
          landing.identity,
          // A clone that got as far as its register stays: it is a
          // checkout of the repo at the place the user named, and a
          // retry lands in it. So a failed register says where it is: a
          // retry would only find the folder taken.
          (dest) =>
            addProject(dest).pipe(
              Effect.mapError(
                (error) =>
                  new CloneUnregisteredError({
                    path: dest,
                    reason: errorWordsOf(error),
                  }),
              ),
            ),
          (bytes, totalBytes) => progress({ step: "clone", bytes, totalBytes }),
        ).pipe(Effect.withSpan("Landing.clone")));
    }

    // 2. Refuse up front what the create would refuse after the bundle
    // crossed.
    yield* refuseLandingCollision(
      project,
      landBranch,
      landing.worktreeName,
    ).pipe(Effect.withSpan("Landing.refusals"));

    // 3. The tip, then the capture. The tip decides whether the branch
    // needs transferring at all: `git bundle create` silently drops a
    // ref covered by a have, so requesting a branch whose tip we already
    // hold would corrupt the transfer, not thin it. Both answers are
    // re-parsed by the link: their hashes flow into LOCAL git argv.
    const branchTip = yield* source
      .tip(branch)
      .pipe(Effect.withSpan("Landing.tip"));
    if (branchTip === null) {
      return yield* new SourceBranchGoneError({ branch });
    }
    progress({ step: "capture" });
    const capture = yield* source.capture.pipe(
      Effect.withSpan("Landing.capture"),
    );
    const captured = capture.captured && capture.commit !== undefined;
    yield* Effect.annotateCurrentSpan("captured", captured);

    // 4. Fetch what's missing. Tip already here + clean worktree means
    // nothing crosses at all.
    const git = yield* Git.Git;
    const tipIsLocal = yield* git.hasCommit(project.path, branchTip);
    const wantRefs = [
      ...(tipIsLocal ? [] : [`refs/heads/${branch}`]),
      ...(captured ? [dirtyRef(sourceWorktreeId)] : []),
    ];
    const incomingRef = incomingRefFor(branch);
    return yield* Effect.gen(function* () {
      if (wantRefs.length > 0) {
        // With the tip local the only novel commit is the capture, so
        // the tip itself is the perfect (and safe) have. Otherwise
        // every local branch tip thins the bundle, and none can cover
        // the branch tip: covering it would mean we already hold it.
        // The exception is a shallow clone, where a have can cover a
        // tip hasCommit said we lack, and that surfaces as a loud
        // bundle error before anything is mutated, never as silent
        // corruption.
        const haves = tipIsLocal
          ? [branchTip]
          : yield* git.localBranchTips(project.path);
        // The fetch opens the transfer step itself with its (0, total)
        // frame, so only the nothing-to-fetch case needs a bare tick.
        yield* source
          .fetch({
            refs: wantRefs,
            into: project,
            onProgress: (bytes, totalBytes) =>
              progress({ step: "transfer", bytes, totalBytes }),
            haves,
          })
          .pipe(
            Effect.withSpan("Landing.fetch", {
              attributes: { refs: wantRefs.length },
            }),
          );
      } else {
        progress({ step: "transfer" });
      }
      if (tipIsLocal) {
        yield* git.updateRef({
          repo: project.path,
          ref: incomingRef,
          commit: branchTip,
        });
      }

      // Read before the create, so nothing after it but the capture's
      // ref steps can fail the landing.
      const captureTree =
        captured && capture.commit !== undefined
          ? yield* git.treeOf(project.path, capture.commit as string)
          : undefined;

      // 5 and 6. The create on the incoming ref, then the capture
      // re-applied in it.
      const { worktree, dirtyApplied, keep } = yield* landIncoming(
        project,
        {
          branch: landBranch,
          incomingRef,
          worktreeName: landing.worktreeName,
          runSetup: landing.runSetup,
          ignoredFilesFollow: pullBringsIgnoredFiles(landing.ignoreMode)
            ? (landing.ignores ?? [])
            : undefined,
          capture:
            captured && capture.commit !== undefined
              ? { sourceWorktreeId, commit: capture.commit }
              : undefined,
        },
        ctx,
        progress,
        move,
      );
      return {
        keep,
        worktree,
        captured,
        dirtyApplied,
        ...(cloned === undefined ? {} : { cloned }),
        receipt: {
          branch,
          branchTip,
          captured,
          dirtyApplied,
          ...(captureTree === undefined ? {} : { captureTree }),
        } satisfies SyncReceipt,
      };
    }).pipe(
      // Swept success or fail.
      Effect.ensuring(Effect.ignore(git.deleteRef(project.path, incomingRef))),
    );
  });

// A send's landing: the source opened the link and answers on it,
// and the landing runs here exactly as a pull's does, its progress
// relayed back over the link. The identity is re-resolved from disk,
// the same wall the pull stands behind, so a send structurally
// cannot land in a repo that is not the sender's. Its cancel is the
// link: a sender that gives up (its own cancel, or its caller gone)
// tears the link down, and the landing is interrupted by that as well
// as by this call's, so the create here dies with its setup script and
// the copy goes. Cut short by the link, it fails with the cancel,
// whatever the step it was on said.
export const landForSender: EffectHandlers<
  typeof syncContract,
  HandlerContext,
  HostServices
>["receiveWorktree"] = ({ channelId, landBranch, ...landing }, ctx) => {
  const link = attachLinkFarEnd(ctx, channelId);
  return Effect.gen(function* () {
    const move = yield* Effect.scope;
    const source = yield* linkSource(link);
    const { receipt, keep, ...landed } = yield* landWorktree(
      source,
      { ...landing, landBranch: landBranch ?? landing.branch },
      ctx,
      (frame) => source.report(frame),
      move,
    );
    // A landing this device asked for (a mirror invited from here,
    // host/mirror/invites.ts): the invitation moves onto the copy
    // before the peer's next call names it.
    yield* landInvitedMirror(ctx.callerDeviceId, landing.sourceWorktreeId, {
      projectId: landed.worktree.projectId,
      worktreeId: landed.worktree.id,
    });
    yield* keep;
    return { ...landed, receipt };
  }).pipe(
    Effect.scoped,
    Effect.withSpan("Sync.receive", {
      attributes: moveAttributes("send", ctx.callerDeviceId),
    }),
    Effect.raceFirst(
      Effect.andThen(
        Deferred.await(link.closed),
        Effect.fail(new MoveCancelledError()),
      ),
    ),
    Effect.catch((error) =>
      Effect.flatMap(Deferred.isDone(link.closed), (cancelled) =>
        Effect.fail(cancelled ? new MoveCancelledError() : error),
      ),
    ),
  );
};

// The landing proper: the worktree created on the incoming ref, then
// the capture re-applied in it. The caller owns the incoming ref and
// its sweep. `branch` is the one the copy is created on, which the
// incoming ref need not be named after.
const landIncoming = (
  project: Project,
  input: {
    branch: string;
    incomingRef: string;
    worktreeName: string | undefined;
    runSetup: boolean | undefined;
    ignoredFilesFollow: readonly string[] | undefined;
    // The capture commit, and the worktree id its ref arrived under.
    capture: { sourceWorktreeId: string; commit: string } | undefined;
  },
  ctx: HandlerContext,
  progress: (frame: Pick<SyncPullProgress, "step" | "createPhase">) => void,
  move: Scope.Scope,
) =>
  // The create, the capture's ref and its apply, held as one change
  // while no data-folder move can start: a move between them would
  // carry the worktree to its new id and leave the ref under the old.
  changing(
    landWhole(project, input, ctx, progress, move),
    { projectId: project.id },
    "land",
  ).pipe(
    Effect.catchTag(
      ["DataDirMoving", "DataDirMoved", "DataDirLockUnavailable"],
      (error) => Effect.fail(callFailureOf(error)),
    ),
  );

const landWhole = (
  project: Project,
  input: Parameters<typeof landIncoming>[1],
  ctx: HandlerContext,
  progress: Parameters<typeof landIncoming>[3],
  move: Scope.Scope,
) =>
  Effect.gen(function* () {
    // The ordinary create, on a new branch at the incoming ref.
    // checkout stays UNSET: checkout:true would leave the worktree ON
    // the incoming ref instead of the new branch. Its run is waited out
    // whole, so the dirty apply below never races the setup scripts.
    // The new worktree's own lifecycle phases still reach its detail
    // page as usual. They are mirrored into the move's progress because
    // the caller cannot subscribe by an id that does not exist yet.
    progress({ step: "create" });
    const notify = worktreeNotifiers(ctx);
    const { worktree, keep } = yield* (yield* Worktrees.Worktrees)
      .createHeld(
        {
          projectId: project.id,
          branchName: input.branch,
          base: input.incomingRef,
          worktreeName: input.worktreeName,
          skipSetup: input.runSetup === false,
          ignoredFilesFollow: input.ignoredFilesFollow,
        },
        {
          ...notify,
          notifyPhase: (payload) => {
            notify.notifyPhase(payload);
            if (payload.phase !== "idle") {
              progress({ step: "create", createPhase: payload.phase });
            }
          },
        },
      )
      .pipe(Effect.withSpan("Landing.create"), Scope.provide(move));

    // Capture refs are keyed by worktree id, and ids are derived
    // from paths (sha256(path)[:12]), so the source's id names the
    // worktree just created only when both devices minted the SAME
    // managed path (root/wt/<project>/<name> with the name from
    // a shared pool) -- rare, but real across same-username machines.
    // Re-key the ref to the local id, then apply and let the engine
    // consume it. On that collision the re-key is a no-op and the
    // delete below is skipped, or it would discard the capture it just
    // parked. An apply refusal (a setup script left an untracked file,
    // say) does NOT throw away the successful create: the worktree is
    // real, the capture stays parked under the local id for sm dirty
    // apply, and the caller learns via dirtyApplied:false.
    // The frame is emitted either way, so the last step reads as
    // reached on a clean source too (and a mirror's session open,
    // which follows, is not mistaken for a stuck create).
    progress({ step: "apply" });
    let dirtyApplied = false;
    const { capture } = input;
    if (capture !== undefined) {
      const sourceDirtyRef = dirtyRef(capture.sourceWorktreeId);
      const localDirtyRef = dirtyRef(worktree.id);
      const git = yield* Git.Git;
      yield* git.updateRef({
        repo: project.path,
        ref: localDirtyRef,
        commit: capture.commit,
      });
      if (localDirtyRef !== sourceDirtyRef) {
        yield* git.deleteRef(project.path, sourceDirtyRef);
      }
      dirtyApplied = yield* Ops.dirtyApply(project, worktree.id).pipe(
        Effect.withSpan("Landing.apply"),
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning(
            "[sync] dirty apply failed after create:",
            error,
          ).pipe(Effect.as(false)),
        ),
      );
    }
    return { worktree, dirtyApplied, keep };
  });
