// The two moves this device runs: a pull lands a peer's worktree
// here, and a send lands one of this device's on a peer. Both are the
// landing (landing.ts) against a source link, then the ignored files,
// the title and description, and the receipt the teardown reads
// (receipts.ts).
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import {
  pullBringsIgnoredFiles,
  type SyncPullWorktreePayloadSchema,
  SyncReceiveWorktreeResultSchema,
  type SyncSendWorktreePayloadSchema,
  syncContract,
} from "@shigomori/contracts/modules/sync";
import type { HandlerContext } from "@shared/ipc/transport";
import { errorMessageOf, isContractError } from "@shigomori/contracts/errors";
import { pullLandingBranch, pullWorktreeName } from "@shared/git/branches";
import { isRealBranch } from "@shigomori/contracts/schemas";
import {
  type TransferFilesResult,
  transferFilesOnce,
} from "@host/mirror/oneShot";
import {
  peerSyncApiFor,
  peerWorktreeOrUndefined,
  peerWorktreesApiFor,
} from "@host/ipc/peerSync";
import { getRepoIdentity } from "@host/lib/git/repoIdentity";
import { findProjectAndWorktreeOrThrow } from "@host/lib/projects";
import { followDescription } from "@host/lib/sync/worktreeDescription";
import { runCancellable, runMove, step } from "@host/lib/sync/moves";
import {
  offer,
  peerSource,
  type ProgressFrame,
} from "@host/lib/sync/sourceLink";
import { logFailure } from "@shared/log";
import { landWorktree, moveAttributes } from "./landing";
import { remember } from "./receipts";

// A worktree the send cannot move, refused before anything crosses.
class MoveRefusedError extends Schema.TaggedError<MoveRefusedError>()(
  "MoveRefusedError",
  { reason: Schema.Literals(["not-on-branch", "primary", "no-identity"]) },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-on-branch":
        return "Only a worktree on a branch of its own can be sent.";
      case "primary":
        return "The primary checkout can be mirrored but not sent: it is the project itself.";
      case "no-identity":
        return "This repository has no shared identity, so no other device can be matched to it.";
    }
  }
}

const decodeReceiveWorktreeResult = Schema.decodeUnknownSync(
  SyncReceiveWorktreeResultSchema,
);

// A move's running commentary, keyed by the source worktree id (the
// only id the caller holds until the create lands). Frames are
// droppable presence, never state: the result is the single source of
// truth.
function progressTo(
  ctx: HandlerContext,
  sourceWorktreeId: string,
): (frame: ProgressFrame) => void {
  const notify = ctx.notifier(syncContract, "pullProgress");
  return (frame) => notify({ sourceWorktreeId, ...frame });
}

// The pull: a peer's worktree lands here. Local-only by contract
// (remote:false). The landing runs here against a link to the peer's
// source (sync:openSource, the PEER's grant), opened on its first
// question, so this device's own refusals come before any of them.
// Then the ignored files, pulled by the mirror engine run once. A
// cancel during the files step removes the landed worktree: the move
// is one thing to the user, and half its files is not it.
export async function pullWorktree(
  {
    sourceDeviceId,
    sourceProjectId,
    sourceWorktreeId,
    sourceIdentity,
    branch,
    worktreeName,
    runSetup,
    ignoreMode,
    ignores,
    cloneInto,
  }: typeof SyncPullWorktreePayloadSchema.Type,
  ctx: HandlerContext,
) {
  const progress = progressTo(ctx, sourceWorktreeId);
  return runMove(ctx, sourceWorktreeId, (signal) =>
    runCancellable(
      signal,
      Effect.gen(function* () {
        const move = yield* Effect.scope;
        // The link to the source lives for the landing alone.
        const { receipt, ...landed } = yield* peerSource(
          peerSyncApiFor(sourceDeviceId),
          { projectId: sourceProjectId, worktreeId: sourceWorktreeId },
        ).pipe(
          Effect.flatMap((source) =>
            landWorktree(
              source,
              {
                identity: sourceIdentity,
                branch,
                landBranch: branch,
                worktreeName,
                runSetup,
                cloneInto,
                sourceWorktreeId,
              },
              ctx,
              progress,
              signal,
              move,
            ),
          ),
          Effect.scoped,
        );

        // The ignored files, once the tree has settled: the leave-out
        // rule admits them and git never carried them, so the mirror
        // engine runs once between the two worktrees
        // (host/mirror/oneShot.ts). Gitignored leaves nothing to carry.
        // Never fatal: the worktree is real, and the outcome rides the
        // result.
        let files: TransferFilesResult | undefined;
        if (pullBringsIgnoredFiles(ignoreMode)) {
          progress({ step: "files" });
          const source = yield* step(() =>
            peerWorktreeOrUndefined(
              sourceDeviceId,
              sourceProjectId,
              sourceWorktreeId,
            ),
          );
          files =
            source === undefined
              ? {
                  crossed: false,
                  conflicts: 0,
                  error: "the source worktree is no longer listed there",
                }
              : yield* step((stepSignal) =>
                  transferFilesOnce(
                    {
                      localRoot: landed.worktree.path,
                      localWorktreeId: landed.worktree.id,
                      sourceDeviceId,
                      sourceProjectId,
                      sourceWorktreeId,
                      remoteRoot: source.path,
                      name: branch,
                      ignores: ignores ?? [],
                    },
                    (bytes, totalBytes) =>
                      progress({ step: "files", bytes, totalBytes }),
                    stepSignal,
                  ),
                ).pipe(Effect.withSpan("Sync.files"));
        }
        yield* step(() =>
          logFailure("[sync] carrying the title and description failed", () =>
            followDescription(
              sourceDeviceId,
              {
                projectId: landed.worktree.projectId,
                worktreeId: landed.worktree.id,
              },
              { projectId: sourceProjectId, worktreeId: sourceWorktreeId },
            ),
          ),
        ).pipe(Effect.withSpan("Sync.description"));
        remember(
          {
            direction: "pull",
            deviceId: sourceDeviceId,
            projectId: sourceProjectId,
            worktreeId: sourceWorktreeId,
          },
          receipt,
        );
        return { ...landed, ...(files === undefined ? {} : { files }) };
      }).pipe(
        Effect.scoped,
        Effect.withSpan("Sync.pull", {
          attributes: moveAttributes("pull", sourceDeviceId),
        }),
      ),
    ),
  );
}

// A landing refusal is worded on the peer, where "this device" means
// the peer, so it is attributed before it reaches this device's user.
// A contract error (the command refusal, an entity gone) passes as it
// is, since surfaces branch on its class.
function fromPeer<T>(answer: Promise<T>): Promise<T> {
  return answer.catch((error: unknown) => {
    if (isContractError(error)) throw error;
    throw new Error(`The other device answered: ${errorMessageOf(error)}`);
  });
}

// The send: one of this device's worktrees lands on a peer.
// Local-only by contract (remote:false). The landing is the pull's,
// run on the peer (sync:receiveWorktree, the PEER's grant) against a
// link this device opened and answers on, so a send needs exactly what
// a pull needs: command access on the other device, none given here.
// The peer's progress frames come back over the link and go out here
// under this worktree's id, the create's phases included. Then the
// ignored files, pushed by the mirror engine run once, and the receipt
// the peer's landing made, kept for the teardown. What the caller
// names is only the worktree: the branch, the folder name and the
// identity are read off it here. The source it resolved rides back
// beside the result, for the mirror start built on this
// (mirror:startTo), which opens its session on that worktree.
//
// A cancel tears the link down, which the peer's landing runs under
// (receiveWorktree), so the create there dies with its setup script
// and the copy goes. A copy the cancel came too late for (the files
// step) is removed over the peer's grant, the same removal a failed
// mirror start makes. The mirror start runs this under a signal of
// its own (`signal`), since its session open comes after. A plain
// send registers itself.
export async function sendWorktree(
  input: typeof SyncSendWorktreePayloadSchema.Type,
  ctx: HandlerContext,
  // The mirror start's send: the one that may take a primary checkout
  // (it lands on the peer as mirror/<branch>, and the session then
  // keeps the pair in step). A plain send moves a worktree, and the
  // primary is the project itself.
  { mirror = false, signal }: { mirror?: boolean; signal?: AbortSignal } = {},
) {
  const send = (under: AbortSignal) =>
    runCancellable(
      under,
      sendWorktreeEffect(input, ctx, mirror).pipe(
        Effect.scoped,
        Effect.withSpan("Sync.send", {
          attributes: {
            ...moveAttributes("send", input.targetDeviceId),
            mirror,
          },
        }),
      ),
    );
  return signal === undefined
    ? runMove(ctx, input.worktreeId, send)
    : send(signal);
}

// Removes the copy a cancelled send left on the peer, best effort,
// like a failed mirror start's rollback. The peer's ordinary delete,
// so a peer set to keep branches keeps this one too, where the local
// rollback (rollBackLanded) takes it: the wire has no verb for that.
export function rollBackSent(
  targetDeviceId: string,
  copy: { projectId: string; id: string },
): Promise<void> {
  return logFailure(
    "[sync] could not remove the peer's copy of a cancelled move",
    () =>
      peerWorktreesApiFor(targetDeviceId).delete({
        projectId: copy.projectId,
        worktreeId: copy.id,
        force: true,
      }),
  );
}

const sendWorktreeEffect = (
  {
    targetDeviceId,
    projectId,
    worktreeId,
    runSetup,
    ignoreMode,
    ignores,
    cloneInto,
  }: typeof SyncSendWorktreePayloadSchema.Type,
  ctx: HandlerContext,
  mirror: boolean,
) =>
  Effect.gen(function* () {
    const progress = progressTo(ctx, worktreeId);

    // The local source. A detached head has no branch to land.
    const { project, worktree } = yield* step(() =>
      findProjectAndWorktreeOrThrow(projectId, worktreeId),
    );
    if (worktree.detached || !isRealBranch(worktree.branch)) {
      return yield* new MoveRefusedError({ reason: "not-on-branch" });
    }
    if (worktree.isPrimary && !mirror) {
      return yield* new MoveRefusedError({ reason: "primary" });
    }
    const identity = yield* step(() =>
      getRepoIdentity(project.path).catch(() => null),
    );
    if (identity === null) {
      return yield* new MoveRefusedError({ reason: "no-identity" });
    }
    const branch = worktree.branch;
    const landBranch = pullLandingBranch(worktree);

    // The landing, on the peer, asking back over the link. An interrupt
    // resets the link, which the peer's landing runs under.
    const peer = peerSyncApiFor(targetDeviceId);
    // The copy's removal is registered the moment the answer is in, with
    // no interrupt between the two: a cancel from then on (the files
    // step) removes it over the peer's grant, the same removal a failed
    // mirror start makes.
    const { receipt, ...landed } = yield* Effect.uninterruptibleMask(
      (restore) =>
        restore(
          offer(
            peer,
            project,
            worktreeId,
            (channelId) =>
              fromPeer(
                peer.receiveWorktree({
                  identity,
                  branch,
                  worktreeName: pullWorktreeName(worktree),
                  ...(landBranch === branch ? {} : { landBranch }),
                  sourceWorktreeId: worktreeId,
                  runSetup,
                  cloneInto,
                  channelId,
                }),
              ),
            progress,
            // A landing that answered as the cancel came: the copy is real
            // and goes the way the finalizer below would take it.
            (answer) =>
              rollBackSent(
                targetDeviceId,
                decodeReceiveWorktreeResult(answer).worktree,
              ),
          ).pipe(Effect.withSpan("Sync.offer")),
        ).pipe(
          Effect.map(decodeReceiveWorktreeResult),
          Effect.tap((answer) =>
            Effect.addFinalizer((exit) =>
              Exit.hasInterrupts(exit)
                ? Effect.promise(() =>
                    rollBackSent(targetDeviceId, answer.worktree),
                  )
                : Effect.void,
            ),
          ),
        ),
    );

    // The ignored files, pushed into the root the peer's landing
    // answered with (re-parsed above, like everything it sends).
    let files: TransferFilesResult | undefined;
    if (pullBringsIgnoredFiles(ignoreMode)) {
      progress({ step: "files" });
      files = yield* step((stepSignal) =>
        transferFilesOnce(
          {
            localRoot: worktree.path,
            localWorktreeId: worktree.id,
            sourceDeviceId: targetDeviceId,
            sourceProjectId: landed.worktree.projectId,
            sourceWorktreeId: landed.worktree.id,
            remoteRoot: landed.worktree.path,
            name: branch,
            ignores: ignores ?? [],
            direction: "push",
          },
          (bytes, totalBytes) => progress({ step: "files", bytes, totalBytes }),
          stepSignal,
        ),
      ).pipe(Effect.withSpan("Sync.files"));
    }
    yield* step(() =>
      logFailure("[sync] carrying the title and description failed", () =>
        followDescription(
          targetDeviceId,
          { projectId, worktreeId },
          {
            projectId: landed.worktree.projectId,
            worktreeId: landed.worktree.id,
          },
        ),
      ),
    ).pipe(Effect.withSpan("Sync.description"));
    remember(
      { direction: "send", deviceId: targetDeviceId, projectId, worktreeId },
      receipt,
    );
    return {
      source: worktree,
      result: { ...landed, ...(files === undefined ? {} : { files }) },
    };
  });
