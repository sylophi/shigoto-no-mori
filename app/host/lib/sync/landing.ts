// The landing: the copy a move makes on the destination, one function
// run there whichever device started the move. A pull runs it here
// against a link to the source (move.ts), a send asks the peer to run
// it (sync:receiveWorktree, landForSender below) against a link the
// sender answers on. The source's side is sourceLink.ts.
import {
  type SyncCloneInto,
  type SyncPullProgress,
  type SyncReceipt,
  syncContract,
} from "@shigomori/contracts/modules/sync";
import type { HandlerContext } from "@shared/ipc/transport";
import {
  pullBranchCollision,
  pullFolderCollision,
} from "@shared/pullCollision";
import { type Project, type Worktree } from "@shigomori/contracts/schemas";
import {
  createViaCli,
  dirtyApplyViaCli,
  forceRemoveViaCli,
  worktreeDestinationViaCli,
} from "@host/ipc/cliDelegate";
import { deleteAnyLocalBranch, listBranches } from "@host/lib/git/branches";
import { listWorktreeIdentities } from "@host/lib/git/worktrees";
import {
  deleteRef,
  hasCommit,
  localBranchTips,
  treeOf,
  updateRef,
} from "@host/lib/git/refs";
import {
  findProjectByIdentity,
  findProjectByIdentityOrThrow,
  findProjectOrThrow,
} from "@host/lib/projects";
import { cloneProjectFromPeer } from "@host/lib/sync/cloneFromPeer";
import {
  MoveCancelledError,
  throwIfCancelled,
  underSignal,
} from "@host/lib/sync/moves";
import {
  attachLinkFarEnd,
  incomingRefFor,
  type ProgressFrame,
  withLinkSource,
  type WorktreeSource,
} from "@host/lib/sync/sourceLink";
import { notifierFor } from "@host/ipc/modules/worktrees";
import { log, logFailure } from "@shared/log";
import { type Span, traced } from "@shared/trace";
import type { Handlers } from "@shigomori/contracts/types";
import { landInvitedMirror } from "@host/mirror/invites";

// The ref the CLI's dirty capture lands a worktree's uncommitted state
// under (cli/cmd_dirty.go owns the name on that side).
const dirtyRefFor = (worktreeId: string) =>
  `refs/shigomori/dirty/${worktreeId}`;

// Where a landing would refuse. Updating an existing branch is out of
// scope, so a held one refuses with the state the user can act on.
async function refuseLandingCollision(
  project: Project,
  branch: string,
  worktreeName: string | undefined,
): Promise<void> {
  const [{ local }, existing] = await Promise.all([
    listBranches(project.path),
    listWorktreeIdentities(project.id),
  ]);
  if (local.includes(branch)) {
    // Name the worktree holding it when one does: that is the thing
    // the user has to stop or delete.
    const holder = existing.find((w) => w.branch === branch);
    throw new Error(pullBranchCollision(branch, holder?.path));
  }
  // Git keeps refs in a directory tree, so a branch can sit neither
  // under an existing one nor above it: mirror/main is refused by a
  // branch named mirror, and a branch named mirror by mirror/main.
  // Refused here, before the transfer, rather than by the create.
  const inTheWay = local.find(
    (name) => name.startsWith(`${branch}/`) || branch.startsWith(`${name}/`),
  );
  if (inTheWay !== undefined) {
    throw new Error(
      `${branch} cannot be created here: a branch named ${inTheWay} is in the way (git allows one of the two). Rename that branch first.`,
    );
  }
  // The copy keeps the source's folder name, and the CLI create
  // refuses a taken one (a worktree of this project by that name,
  // case-insensitively, or anything at the path). That refusal lands at
  // the create, after the bundle crossed. The CLI's destination read
  // makes the same two checks here, before a byte moves.
  if (worktreeName !== undefined) {
    const { path, taken } = await worktreeDestinationViaCli(
      project.id,
      worktreeName,
    );
    if (taken) throw new Error(pullFolderCollision(worktreeName, path));
  }
}

// What names a move in the trace files of both devices: the source
// worktree is the key a move goes by on either side, so its spans on
// the device running it, the device landing it and the device answering
// for its source all carry it.
export const moveAttributes = (
  direction: "pull" | "send",
  peer: string | undefined,
  sourceWorktreeId: string,
) => ({
  "move.direction": direction,
  "move.peer": peer,
  "move.sourceWorktree": sourceWorktreeId,
});

// What a landing is told: which repo (by identity, re-resolved here),
// which branch the commits arrive under and which one the copy is
// created on (they differ for a primary's mirror, shared/git/
// branches.ts), the folder name, the setup switch, where to clone the
// repo when this device has none, and the source worktree's id (the
// key its capture ref arrives under).
export type Landing = {
  identity: string;
  branch: string;
  landBranch: string;
  worktreeName?: string;
  runSetup?: boolean;
  cloneInto?: SyncCloneInto;
  sourceWorktreeId: string;
};

// The landing, on the destination, whichever device started the move.
// Sequenced: the landing project (made first by a clone from the
// source when this device has none and was told where) -> the
// refusals, before a byte moves -> the tip, then the capture of the
// source's dirty state -> the branch and the capture fetched under
// refs/shigomori/ -> the worktree created through the ordinary CLI
// create (carry-over and setup ride along) -> the capture re-keyed and
// applied -> the incoming ref swept. The incoming ref is swept in a
// finally that opens BEFORE the fetch: the CLI's bundle unpack runs one
// non-atomic git fetch over several refspecs, so a partial fetch can
// land the incoming ref and then throw, and a survivor is NOT harmless
// -- a stale refs/shigomori/incoming/foo blocks any later ref named
// incoming/foo/bar at git's directory/file boundary. A failure before
// the create leaves at most the capture ref (a retry overwrites it).
// After the create, an apply failure resolves with dirtyApplied:false
// rather than throwing: the worktree and branch are real and useful,
// and the dirty state is still safe on the source device.
//
// A cancel (`signal`, the move's) fails whichever step is waiting (the
// link's question, the create's CLI child) and undoes what the landing
// made: a worktree the create had already made is removed, so the
// destination is as it was, bar a clone that got registered (which
// stays, a checkout at the place the user named) and a capture ref a
// retry overwrites.
export async function landWorktree(
  source: WorktreeSource,
  landing: Landing,
  ctx: HandlerContext,
  progress: (frame: ProgressFrame) => void,
  signal: AbortSignal,
  span: Span,
): Promise<{
  worktree: Worktree;
  captured: boolean;
  dirtyApplied: boolean;
  cloned?: Project;
  receipt: SyncReceipt;
}> {
  const { branch, landBranch, sourceWorktreeId } = landing;

  // 1. The landing project, re-resolved by identity from disk, or made
  // now: with none, and a place named for one, the repo is cloned from
  // the source first (cloneFromPeer.ts) and the copy lands in that. A
  // checkout this device has wins over the place named: the dialog
  // that named it was reading a stale list, and a second clone of a
  // repo already here is not what anyone asked for.
  throwIfCancelled(signal);
  let cloned: Project | undefined;
  let project: Project;
  const { cloneInto } = landing;
  if (cloneInto === undefined) {
    project = await findProjectByIdentityOrThrow(landing.identity);
  } else {
    const held = await findProjectByIdentity(landing.identity);
    if (held === undefined) progress({ step: "clone" });
    project =
      held ??
      (cloned = await span.step("Landing.clone", () =>
        cloneProjectFromPeer(
          source,
          cloneInto,
          landBranch,
          (bytes, totalBytes) => progress({ step: "clone", bytes, totalBytes }),
          signal,
        ),
      ));
  }

  // 2. Refuse up front what the create would refuse after the bundle
  // crossed.
  await span.step("Landing.refusals", () =>
    refuseLandingCollision(project, landBranch, landing.worktreeName),
  );

  // 3. The tip, then the capture. The tip decides whether the branch
  // needs transferring at all: `git bundle create` silently drops a
  // ref covered by a have, so requesting a branch whose tip we already
  // hold would corrupt the transfer, not thin it. Both answers are
  // re-parsed by the link: their hashes flow into LOCAL git argv.
  const branchTip = await span.step("Landing.tip", () => source.tip(branch));
  if (branchTip === null) {
    throw new Error(`${branch} no longer exists on the source device.`);
  }
  progress({ step: "capture" });
  const capture = await span.step("Landing.capture", () => source.capture());
  const captured = capture.captured && capture.commit !== undefined;
  span.annotate("captured", captured);

  // 4. Fetch what's missing. Tip already here + clean worktree means
  // nothing crosses at all.
  const tipIsLocal = await hasCommit(project.path, branchTip);
  const wantRefs = [
    ...(tipIsLocal ? [] : [`refs/heads/${branch}`]),
    ...(captured ? [dirtyRefFor(sourceWorktreeId)] : []),
  ];
  const incomingRef = incomingRefFor(branch);
  try {
    if (wantRefs.length > 0) {
      // The fetch opens the transfer step itself with its (0, total)
      // frame, so only the nothing-to-fetch case needs a bare tick.
      await span.step(
        "Landing.fetch",
        async () =>
          source.fetch({
            refs: wantRefs,
            into: project,
            onProgress: (bytes, totalBytes) =>
              progress({ step: "transfer", bytes, totalBytes }),
            // With the tip local the only novel commit is the capture, so
            // the tip itself is the perfect (and safe) have. Otherwise every
            // local branch tip thins the bundle, and none can cover the
            // branch tip: covering it would mean we already hold it. The
            // exception is a shallow clone, where a have can cover a tip
            // hasCommit said we lack, and that surfaces as a loud bundle error
            // before anything is mutated, never as silent corruption.
            haves: tipIsLocal
              ? [branchTip]
              : await localBranchTips(project.path),
          }),
        { refs: wantRefs.length },
      );
    } else {
      progress({ step: "transfer" });
    }
    // The first write here. Before it, a cancel fails the link's
    // questions. A landing with nothing to ask (the tip local, a clean
    // source) has only this to stop at.
    throwIfCancelled(signal);
    if (tipIsLocal) await updateRef(project.path, incomingRef, branchTip);

    // 5 and 6. The create on the incoming ref, then the capture
    // re-applied in it.
    const { worktree, dirtyApplied } = await landIncoming(
      project,
      {
        branch: landBranch,
        incomingRef,
        worktreeName: landing.worktreeName,
        runSetup: landing.runSetup,
        capture:
          captured && capture.commit !== undefined
            ? { sourceWorktreeId, commit: capture.commit }
            : undefined,
      },
      ctx,
      progress,
      signal,
      span,
    );
    return {
      worktree,
      captured,
      dirtyApplied,
      ...(cloned === undefined ? {} : { cloned }),
      receipt: {
        branch,
        branchTip,
        captured,
        dirtyApplied,
        ...(captured && capture.commit !== undefined
          ? { captureTree: await treeOf(project.path, capture.commit) }
          : {}),
      },
    };
  } finally {
    // Sweep the landing ref success or fail. A survivor is not
    // harmless: a stale incoming/foo blocks any later incoming/foo/bar
    // at git's directory/file ref boundary.
    await deleteRef(project.path, incomingRef).catch(() => {});
  }
}

// A send's landing: the source opened the link and answers on it,
// and the landing runs here exactly as a pull's does, its progress
// relayed back over the link. The identity is re-resolved from disk,
// the same wall the pull stands behind, so a send structurally
// cannot land in a repo that is not the sender's. Its cancel is the
// link: a sender that gives up (its own cancel, or its caller gone)
// tears the link down, and the landing runs under that as well as
// under this connection, so the create here dies with its setup
// script and the copy goes.
export const landForSender: Handlers<
  typeof syncContract,
  HandlerContext
>["receiveWorktree"] = ({ channelId, landBranch, ...landing }, ctx) => {
  const link = attachLinkFarEnd(ctx, channelId);
  return underSignal(AbortSignal.any([ctx.signal, link.closed]), (signal) =>
    withLinkSource(
      link,
      (source) =>
        traced(
          "Sync.receive",
          moveAttributes("send", ctx.callerDeviceId, landing.sourceWorktreeId),
          async (span) => {
            const { receipt, ...landed } = await landWorktree(
              source,
              { ...landing, landBranch: landBranch ?? landing.branch },
              ctx,
              (frame) => source.report(frame),
              signal,
              span,
            );
            // A cancel the landing's last step outran: the sender has
            // already given up on this answer, so the copy goes here.
            await rollBackIfCancelled(signal, landed.worktree);
            // A landing this device asked for (a mirror invited from
            // here, host/mirror/invites.ts): the invitation moves onto
            // the copy before the peer's next call names it.
            landInvitedMirror(ctx.callerDeviceId, landing.sourceWorktreeId, {
              projectId: landed.worktree.projectId,
              worktreeId: landed.worktree.id,
            });
            return { ...landed, receipt };
          },
        ),
      signal,
    ),
  );
};

// The landing proper: the worktree created on the incoming ref, then
// the capture re-applied in it. The caller owns the incoming ref and
// its sweep. `branch` is the one the copy is created on, which the
// incoming ref need not be named after. A cancel kills the create
// (the setup script with it) and removes the worktree it made, so a
// cancelled landing leaves none.
async function landIncoming(
  project: Project,
  input: {
    branch: string;
    incomingRef: string;
    worktreeName: string | undefined;
    runSetup: boolean | undefined;
    // The capture commit, and the worktree id its ref arrived under.
    capture: { sourceWorktreeId: string; commit: string } | undefined;
  },
  ctx: HandlerContext,
  progress: (frame: Pick<SyncPullProgress, "step" | "createPhase">) => void,
  signal: AbortSignal,
  span: Span,
): Promise<{ worktree: Worktree; dirtyApplied: boolean }> {
  // The ordinary create, on a new branch at the incoming ref.
  // checkout stays UNSET: checkout:true would leave the worktree ON
  // the incoming ref instead of the new branch. resolveOn "exit"
  // holds the mutation until carry-over and setup finished, so the
  // dirty apply below never races the setup scripts. The new
  // worktree's own lifecycle phases still reach its detail page as
  // usual. They are mirrored into the move's progress because the
  // caller cannot subscribe by an id that does not exist yet.
  progress({ step: "create" });
  const notify = notifierFor(ctx);
  const { worktree } = await span.step("Landing.create", () =>
    createViaCli(
      project,
      {
        branchName: input.branch,
        base: input.incomingRef,
        worktreeName: input.worktreeName,
        skipSetup: input.runSetup === false,
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
      { resolveOn: "exit", signal },
    ),
  );
  // A create the cancel cut short still resolved with its worktree
  // (cliDelegate.ts, runStreamingCreate), which goes again now. Also
  // a cancel that landed between the create and here: the worktree is
  // whole, and the user still asked for none.
  await rollBackIfCancelled(signal, worktree);

  // Capture refs are keyed by worktree id, and ids are derived
  // from paths (sha256(path)[:12]), so the source's id names the
  // worktree just created only when both devices minted the SAME
  // managed path (root/worktrees/<project>/<name> with the name from
  // a shared pool) -- rare, but real across same-username machines.
  // Re-key the ref to the local id, then apply and let the CLI
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
  if (input.capture !== undefined) {
    const sourceDirtyRef = dirtyRefFor(input.capture.sourceWorktreeId);
    const localDirtyRef = dirtyRefFor(worktree.id);
    await updateRef(project.path, localDirtyRef, input.capture.commit);
    if (localDirtyRef !== sourceDirtyRef) {
      await deleteRef(project.path, sourceDirtyRef);
    }
    try {
      await span.step("Landing.apply", () =>
        dirtyApplyViaCli(project, worktree.id),
      );
      dirtyApplied = true;
    } catch (error) {
      log.warn("[sync] dirty apply failed after create:", error);
    }
  }
  return { worktree, dirtyApplied };
}

// The rollback of a landed worktree a cancel came too late for (the
// create's own, the landing's last step, or the files step after it):
// the forced removal, its cleanup on a clock since the cancel is of
// something that hung, then the branch, which the move made and `sm
// rm` keeps when the project is set to keep branches (a retry would
// meet it). Best effort past that: what could not be removed is
// logged, and the cancel is still the answer.
const ROLLBACK_CLEANUP_MS = 60_000;
export async function rollBackIfCancelled(
  signal: AbortSignal,
  worktree: Pick<Worktree, "projectId" | "id" | "branch">,
): Promise<void> {
  if (!signal.aborted) return;
  await rollBackLanded(worktree);
  throw new MoveCancelledError();
}

function rollBackLanded(
  worktree: Pick<Worktree, "projectId" | "id" | "branch">,
): Promise<void> {
  return logFailure(
    "[sync] could not remove the worktree of a cancelled move",
    async () => {
      const project = await findProjectOrThrow(worktree.projectId);
      await forceRemoveViaCli(project, worktree.id, {
        timeoutMs: ROLLBACK_CLEANUP_MS,
      });
      await deleteAnyLocalBranch(project.path, worktree.branch, true).catch(
        () => {},
      );
    },
  );
}
