// The two moves this device runs: a pull lands a peer's worktree
// here, and a send lands one of this device's on a peer. Both are the
// landing (landing.ts) against a source link, then the ignored files,
// the title and description, and the receipt the teardown reads
// (receipts.ts).
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
import { MoveCancelledError, runMove } from "@host/lib/sync/moves";
import {
  offerSource,
  type ProgressFrame,
  withPeerSource,
} from "@host/lib/sync/sourceLink";
import { logFailure } from "@shared/log";
import { landWorktree, moveAttributes, rollBackIfCancelled } from "./landing";
import { type Span, traced } from "@shared/trace";
import { remember } from "./receipts";

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
  const attributes = moveAttributes("pull", sourceDeviceId, sourceWorktreeId);
  return runMove(ctx, sourceWorktreeId, (signal) =>
    traced("Sync.pull", attributes, async (span) => {
      const { receipt, ...landed } = await withPeerSource(
        peerSyncApiFor(sourceDeviceId),
        { projectId: sourceProjectId, worktreeId: sourceWorktreeId },
        (source) =>
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
            span,
          ),
        signal,
      );

      // The ignored files, once the tree has settled: the leave-out rule
      // admits them and git never carried them, so the mirror engine runs
      // once between the two worktrees (host/mirror/oneShot.ts).
      // Gitignored leaves nothing to carry. Never fatal: the worktree is
      // real, and the outcome rides the result.
      let files: TransferFilesResult | undefined;
      if (pullBringsIgnoredFiles(ignoreMode) && !signal.aborted) {
        progress({ step: "files" });
        const source = await peerWorktreeOrUndefined(
          sourceDeviceId,
          sourceProjectId,
          sourceWorktreeId,
        );
        files =
          source === undefined
            ? {
                crossed: false,
                conflicts: 0,
                error: "the source worktree is no longer listed there",
              }
            : await span.step("Sync.files", () =>
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
                  signal,
                ),
              );
      }
      await rollBackIfCancelled(signal, landed.worktree);
      await logFailure("[sync] carrying the title and description failed", () =>
        span.step("Sync.description", () =>
          followDescription(
            sourceDeviceId,
            {
              projectId: landed.worktree.projectId,
              worktreeId: landed.worktree.id,
            },
            { projectId: sourceProjectId, worktreeId: sourceWorktreeId },
          ),
        ),
      );
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
    }),
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
    traced(
      "Sync.send",
      {
        ...moveAttributes("send", input.targetDeviceId, input.worktreeId),
        mirror,
      },
      (span) => sendWorktreeUnder(input, ctx, mirror, under, span),
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

async function sendWorktreeUnder(
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
  signal: AbortSignal,
  span: Span,
) {
  const progress = progressTo(ctx, worktreeId);

  // The local source. A detached head has no branch to land.
  const { project, worktree } = await findProjectAndWorktreeOrThrow(
    projectId,
    worktreeId,
  );
  if (worktree.detached || !isRealBranch(worktree.branch)) {
    throw new Error("Only a worktree on a branch of its own can be sent.");
  }
  if (worktree.isPrimary && !mirror) {
    throw new Error(
      "The primary checkout can be mirrored but not sent: it is the project itself.",
    );
  }
  const identity = await getRepoIdentity(project.path).catch(() => null);
  if (identity === null) {
    throw new Error(
      "This repository has no shared identity, so no other device can be matched to it.",
    );
  }
  const branch = worktree.branch;
  const landBranch = pullLandingBranch(worktree);

  // The landing, on the peer, asking back over the link. A cancel
  // resets the link (offerSource), which the peer's landing runs under.
  const peer = peerSyncApiFor(targetDeviceId);
  const { receipt, ...landed } = decodeReceiveWorktreeResult(
    await span.step("Sync.offer", () =>
      offerSource(
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
        signal,
        // A landing that answered as the cancel came: the copy is real
        // and goes the way a copy the files step outran does.
        (answer) =>
          rollBackSent(
            targetDeviceId,
            decodeReceiveWorktreeResult(answer).worktree,
          ),
      ),
    ),
  );

  // The ignored files, pushed into the root the peer's landing
  // answered with (re-parsed above, like everything it sends).
  let files: TransferFilesResult | undefined;
  if (pullBringsIgnoredFiles(ignoreMode)) {
    progress({ step: "files" });
    files = await span.step("Sync.files", () =>
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
        signal,
      ),
    );
  }
  if (signal.aborted) {
    await rollBackSent(targetDeviceId, landed.worktree);
    throw new MoveCancelledError();
  }
  await logFailure("[sync] carrying the title and description failed", () =>
    span.step("Sync.description", () =>
      followDescription(
        targetDeviceId,
        { projectId, worktreeId },
        {
          projectId: landed.worktree.projectId,
          worktreeId: landed.worktree.id,
        },
      ),
    ),
  );
  remember(
    { direction: "send", deviceId: targetDeviceId, projectId, worktreeId },
    receipt,
  );
  return {
    source: worktree,
    result: { ...landed, ...(files === undefined ? {} : { files }) },
  };
}
