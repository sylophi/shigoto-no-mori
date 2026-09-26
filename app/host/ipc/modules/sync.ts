// Host side of moving a worktree between devices. The landing (the
// copy made on the destination) is ONE function, landWorktree, run on
// the destination whichever device started the move: a pull runs it
// here against a link it opened to the source, a send asks the peer to
// run it (sync:receiveWorktree) against a link this device opened and
// answers on. The source's side of either is host/lib/sync/
// sourceLink.ts. What stays per direction is what the grant decides:
// the files step (the mirror engine run once, from the device holding
// the grant) and the teardown (the source's delete, on its own device
// or over the peer's grant).
import type { z } from "zod";
import {
  pullBringsIgnoredFiles,
  type SyncCloneInto,
  type SyncMoveRef,
  type SyncPullProgress,
  type SyncPullWorktreePayloadSchema,
  type SyncReceipt,
  SyncReceiveWorktreeResultSchema,
  type SyncSendWorktreePayloadSchema,
  SYNC_IGNORED_PATHS_LIMIT,
  type SyncTeardownSourceResult,
  syncContract,
} from "@shared/ipc/modules/sync";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shared/ipc/types";
import { errorMessageOf } from "@shared/errors";
import {
  pullBranchCollision,
  pullFolderCollision,
} from "@shared/pullCollision";
import { pullLandingBranch, pullWorktreeName } from "@shared/git/branches";
import {
  DeleteWorktreeResultSchema,
  isRealBranch,
  type Project,
  type Worktree,
} from "@shared/schemas";
import {
  type TransferFilesResult,
  transferFilesOnce,
} from "@host/mirror/oneShot";
import {
  createViaCli,
  dirtyApplyViaCli,
  worktreeDestinationViaCli,
} from "@host/ipc/cliDelegate";
import {
  peerSyncApiFor,
  peerWorktreeOrUndefined,
  peerWorktreesApiFor,
} from "@host/ipc/peerSync";
import { isCommandRefusedError } from "@shared/ipc/socket/frames";
import { listBranches } from "@host/lib/git/branches";
import { listIgnoreRules } from "@host/lib/git/ignoreRules";
import {
  cachedIgnoredPaths,
  listWorktreeFolder,
} from "@host/lib/worktrees/carryOver";
import { getRepoIdentity } from "@host/lib/git/repoIdentity";
import { listWorktreeIdentities } from "@host/lib/git/worktrees";
import {
  deleteRef,
  hasCommit,
  localBranchTips,
  treeOf,
  updateRef,
} from "@host/lib/git/refs";
import {
  findProjectAndWorktreeOrThrow,
  findProjectByIdentity,
  findProjectByIdentityOrThrow,
  findProjectOrThrow,
  findWorktreePathOrThrow,
} from "@host/lib/projects";
import { cloneProjectFromPeer } from "@host/lib/sync/cloneFromPeer";
import {
  attachLinkFarEnd,
  incomingRefFor,
  localSource,
  offerSource,
  type ProgressFrame,
  serveSource,
  type SourceFacts,
  withLinkSource,
  withPeerSource,
  type WorktreeSource,
} from "@host/lib/sync/sourceLink";
import { notifierFor, worktreesHandlers } from "./worktrees";

// The ref the CLI's dirty capture lands a worktree's uncommitted state
// under (cli/cmd_dirty.go owns the name on that side).
const dirtyRefFor = (worktreeId: string) =>
  `refs/shigomori/dirty/${worktreeId}`;

// What each move captured and applied, by source worktree, for the
// teardown that may follow, kept by the device that ran the move (the
// destination after a pull, the source after a send, which the
// destination's landing hands its receipt). Read by the teardown, so
// the data-loss rule runs on the hosts' own facts: a caller cannot
// claim a capture landed when it did not. The branch tip and the
// capture's tree let the teardown prove the source is still exactly
// what moved, however long the user took to decide. Ephemeral by
// design (a restart forgets, and the teardown then refuses), bounded
// so a host that moves worktrees for weeks never grows it.
const RECEIPT_LIMIT = 64;
const receipts = new Map<string, SyncReceipt>();
const receiptKey = (move: SyncMoveRef) =>
  `${move.direction}:${move.deviceId}/${move.projectId}/${move.worktreeId}`;
function remember(move: SyncMoveRef, receipt: SyncReceipt): void {
  const key = receiptKey(move);
  receipts.delete(key);
  receipts.set(key, receipt);
  for (const oldest of receipts.keys()) {
    if (receipts.size <= RECEIPT_LIMIT) break;
    receipts.delete(oldest);
  }
}

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

export const syncHandlers: Handlers<typeof syncContract, HandlerContext> = {
  hasCommits: async ({ projectId, commits }) => {
    const project = await findProjectOrThrow(projectId);
    const present: string[] = [];
    for (const commit of commits) {
      // oxlint-disable-next-line no-await-in-loop -- a handful of cheap probes
      if (await hasCommit(project.path, commit)) present.push(commit);
    }
    return { present };
  },

  worktreeFolder: async ({ relative, ...input }) =>
    listWorktreeFolder(await findWorktreePathOrThrow(input), relative),

  // The ignored files a capture leaves behind (see the contract note):
  // listed against the worktree, not the project, so a peer's
  // transplant dialog can name what a teardown would take with it.
  ignoredPaths: async (input) => {
    const path = await findWorktreePathOrThrow(input);
    const [paths, patterns] = await Promise.all([
      cachedIgnoredPaths(path),
      listIgnoreRules(path),
    ]);
    return {
      paths: paths.slice(0, SYNC_IGNORED_PATHS_LIMIT),
      total: paths.length,
      patterns,
    };
  },

  // A pull's link (and the git follower's fetch): this host is the
  // source, answering until the peer is done. The open returns once
  // the link is attached, and the serving runs on without it.
  openSource: async ({ projectId, worktreeId, channelId }, ctx) => {
    const link = attachLinkFarEnd(ctx, channelId);
    let project: Project;
    try {
      ({ project } = await findProjectAndWorktreeOrThrow(
        projectId,
        worktreeId,
      ));
    } catch (error) {
      link.reset();
      throw error;
    }
    void serveSource(link, project, worktreeId).catch(() => {});
  },

  // A send's landing: the source opened the link and answers on it,
  // and the landing runs here exactly as a pull's does, its progress
  // relayed back over the link. The identity is re-resolved from disk,
  // the same wall the pull stands behind, so a send structurally
  // cannot land in a repo that is not the sender's.
  receiveWorktree: async ({ channelId, landBranch, ...landing }, ctx) => {
    const link = attachLinkFarEnd(ctx, channelId);
    return withLinkSource(link, async (source) => {
      const { receipt, ...landed } = await landWorktree(
        source,
        { ...landing, landBranch: landBranch ?? landing.branch },
        ctx,
        (frame) => source.report(frame),
      );
      return { ...landed, receipt };
    });
  },

  // The git follower's push: the peer opened the link, and this host
  // asks it for the one bundle and unpacks it under refs/shigomori/.
  receiveBundle: async ({ projectId, refs, haves, channelId }, ctx) => {
    const link = attachLinkFarEnd(ctx, channelId);
    return withLinkSource(link, async (source) =>
      source.fetch({ refs, haves, into: await findProjectOrThrow(projectId) }),
    );
  },

  pullWorktree: runPullWorktree,

  sendWorktree: async (input, ctx) => (await sendWorktree(input, ctx)).result,

  // The source teardown, after either move. The move's own receipt
  // decides whether it may run at all. Without one (no move, or a
  // restart in between) the call refuses outright rather than guess.
  // The receipt is kept until a teardown actually removes the source,
  // so a refused or failed one can be retried. A pull's source is the
  // peer's worktree, checked over a link and removed through the
  // peer's grant-gated delete. A send's is this device's own.
  teardownSource: async (move, ctx) => {
    const key = receiptKey(move);
    const receipt = receipts.get(key);
    const pulled = move.direction === "pull";
    if (receipt === undefined) {
      throw new Error(
        pulled
          ? "No pull recorded for that worktree on this device. Bring it here first."
          : "No send recorded for that worktree on this device. Send it first.",
      );
    }
    const target = {
      projectId: move.projectId,
      worktreeId: move.worktreeId,
    };
    const changed = pulled
      ? await withPeerSource(peerSyncApiFor(move.deviceId), target, (source) =>
          sourceChangedSince(source, receipt, PULLED),
        )
      : await sourceChangedSince(
          localSource(
            await findProjectOrThrow(move.projectId),
            move.worktreeId,
          ),
          receipt,
          SENT,
        );
    if (changed !== undefined) {
      return { sourceRemoved: false, sourceError: changed };
    }
    const result = await tearDown(
      receipt,
      pulled ? "here" : "on the other device",
      (force) => {
        const removal = { ...target, force, refuseRunningScripts: true };
        return pulled
          ? peerWorktreesApiFor(move.deviceId).delete(removal)
          : worktreesHandlers.delete(removal, ctx);
      },
    );
    if (result.sourceRemoved) receipts.delete(key);
    return result;
  },
};

// Why a source no longer matches its receipt, in the words of the
// device asking: the peer's worktree after a pull, this device's own
// after a send.
type ChangedWords = { moved: string; changed: string; neverMoved: string };
const PULLED: ChangedWords = {
  moved: "the branch on the source device moved after it was brought here.",
  changed:
    "the source worktree changed after its uncommitted work was captured.",
  neverMoved:
    "the source worktree has uncommitted changes that were never brought here.",
};
const SENT: ChangedWords = {
  moved: "the branch moved after it was sent.",
  changed: "the worktree changed after its uncommitted work was captured.",
  neverMoved: "the worktree has uncommitted changes that were never sent.",
};

// The teardown may run any time after the move, so the source is
// re-checked against the receipt first: the branch tip must not have
// moved, and the uncommitted state must still be exactly the tree the
// move captured (a fresh capture, compared by tree hash, since capture
// commits are not deterministic). Anything else is work that never
// crossed, and the reason comes back as the kept-source explanation.
async function sourceChangedSince(
  source: SourceFacts,
  receipt: SyncReceipt,
  words: ChangedWords,
): Promise<string | undefined> {
  if ((await source.tip(receipt.branch)) !== receipt.branchTip) {
    return words.moved;
  }
  const fresh = await source.capture();
  if (!fresh.captured) return receipt.captured ? words.changed : undefined;
  if (!receipt.captured || receipt.captureTree === undefined) {
    return words.neverMoved;
  }
  return fresh.tree === receipt.captureTree ? undefined : words.changed;
}

// The source teardown. It runs ONLY when nothing the capture describes
// can be lost: an unapplied capture means the uncommitted work still
// exists solely on the source, so the source is kept and the caller
// learns why via sourceError. Ignored files are outside what a capture
// describes and die with the source either way, forced or not: git's
// own pre-removal check refuses untracked and modified files, never
// ignored ones. Deliberately not a refusal here (the ignoredPaths note
// in the contract says why). The dialog lists them before the choice.
// Teardown failures never throw either -- by then the move succeeded
// and the worktree simply exists on both sides. An external (adopted)
// source worktree keeps its local branch after teardown because sm rm
// skips branch deletion for externals (cli/gitx.go
// deleteBranchAfterWorktreeRemoval), so the branch then exists on both
// devices, which is not lossy. `landed` is where the copy went, for
// the refusal's wording.
async function tearDown(
  moved: { captured: boolean; dirtyApplied: boolean },
  landed: "here" | "on the other device",
  remove: (force: boolean) => unknown,
): Promise<SyncTeardownSourceResult> {
  if (moved.captured && !moved.dirtyApplied) {
    return {
      sourceRemoved: false,
      sourceError: `the uncommitted changes could not be applied ${landed} and only exist on the source worktree`,
    };
  }
  try {
    // Force only when the dirty state was actually captured and
    // applied. The CLI's --force does more than skip its own
    // clean-tree guard (cmd_rm.go requireClean): it also switches to
    // `git worktree remove --force`, which skips git's own dirty check
    // and so would silently destroy work a capture cannot carry
    // (submodule-only dirt captures as clean,
    // see the cli/cmd_dirty.go header) or edits made after the
    // capture. So on a capture that said clean, git's own pre-removal
    // check must independently agree before the source dies, and a
    // disagreement surfaces as sourceRemoved:false with the git
    // message instead of silent loss. Accepted cost: worktrees with
    // populated submodules report sourceRemoved:false on clean
    // transplants because git refuses non-forced removal of them.
    // refuseRunningScripts is the app-side guard the local
    // kill-then-delete path deliberately lacks.
    const removed = DeleteWorktreeResultSchema.parse(
      await remove(moved.captured),
    );
    if (removed.ok) return { sourceRemoved: true };
    // ok:false means the worktree was NOT removed: cleanup scripts
    // run before `git worktree remove` and a failure aborts the
    // pipeline with the worktree left in place (cli/cmd_rm.go).
    return {
      sourceRemoved: false,
      sourceError: `cleanup failed on the source device (${removed.cleanupError.phase})`,
    };
  } catch (error) {
    return { sourceRemoved: false, sourceError: errorMessageOf(error) };
  }
}

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

// What a landing is told: which repo (by identity, re-resolved here),
// which branch the commits arrive under and which one the copy is
// created on (they differ for a primary's mirror, shared/git/
// branches.ts), the folder name, the setup switch, where to clone the
// repo when this device has none, and the source worktree's id (the
// key its capture ref arrives under).
type Landing = {
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
async function landWorktree(
  source: WorktreeSource,
  landing: Landing,
  ctx: HandlerContext,
  progress: (frame: ProgressFrame) => void,
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
  let cloned: Project | undefined;
  let project: Project;
  if (landing.cloneInto === undefined) {
    project = await findProjectByIdentityOrThrow(landing.identity);
  } else {
    const held = await findProjectByIdentity(landing.identity);
    if (held === undefined) progress({ step: "clone" });
    project =
      held ??
      (cloned = await cloneProjectFromPeer(
        source,
        landing.cloneInto,
        landBranch,
        (bytes, totalBytes) => progress({ step: "clone", bytes, totalBytes }),
      ));
  }

  // 2. Refuse up front what the create would refuse after the bundle
  // crossed.
  await refuseLandingCollision(project, landBranch, landing.worktreeName);

  // 3. The tip, then the capture. The tip decides whether the branch
  // needs transferring at all: `git bundle create` silently drops a
  // ref covered by a have, so requesting a branch whose tip we already
  // hold would corrupt the transfer, not thin it. Both answers are
  // re-parsed by the link: their hashes flow into LOCAL git argv.
  const branchTip = await source.tip(branch);
  if (branchTip === null) {
    throw new Error(`${branch} no longer exists on the source device.`);
  }
  progress({ step: "capture" });
  const capture = await source.capture();
  const captured = capture.captured && capture.commit !== undefined;

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
      await source.fetch({
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
        haves: tipIsLocal ? [branchTip] : await localBranchTips(project.path),
      });
    } else {
      progress({ step: "transfer" });
    }
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

// The landing proper: the worktree created on the incoming ref, then
// the capture re-applied in it. The caller owns the incoming ref and
// its sweep. `branch` is the one the copy is created on, which the
// incoming ref need not be named after.
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
  const { worktree } = await createViaCli(
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
    { resolveOn: "exit" },
  );

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
      await dirtyApplyViaCli(project, worktree.id);
      dirtyApplied = true;
    } catch (error) {
      console.warn("[sync] dirty apply failed after create:", error);
    }
  }
  return { worktree, dirtyApplied };
}

// The pull: a peer's worktree lands here. Local-only by contract
// (remote:false). The landing runs here against a link to the peer's
// source (sync:openSource, the PEER's grant), opened on its first
// question, so this device's own refusals come before any of them.
// Then the ignored files, pulled by the mirror engine run once.
async function runPullWorktree(
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
  }: z.infer<typeof SyncPullWorktreePayloadSchema>,
  ctx: HandlerContext,
) {
  const progress = progressTo(ctx, sourceWorktreeId);
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
      ),
  );

  // The ignored files, once the tree has settled: the leave-out rule
  // admits them and git never carried them, so the mirror engine runs
  // once between the two worktrees (host/mirror/oneShot.ts).
  // Gitignored leaves nothing to carry. Never fatal: the worktree is
  // real, and the outcome rides the result.
  let files: TransferFilesResult | undefined;
  if (pullBringsIgnoredFiles(ignoreMode)) {
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
        : await transferFilesOnce(
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
          );
  }
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
}

// A landing refusal is worded on the peer, where "this device" means
// the peer, so it is attributed before it reaches this device's user.
// The command refusal passes as it is: surfaces match on its text.
function fromPeer<T>(answer: Promise<T>): Promise<T> {
  return answer.catch((error: unknown) => {
    if (isCommandRefusedError(error)) throw error;
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
export async function sendWorktree(
  {
    targetDeviceId,
    projectId,
    worktreeId,
    runSetup,
    ignoreMode,
    ignores,
    cloneInto,
  }: z.infer<typeof SyncSendWorktreePayloadSchema>,
  ctx: HandlerContext,
  // The mirror start's send: the one that may take a primary checkout
  // (it lands on the peer as mirror/<branch>, and the session then
  // keeps the pair in step). A plain send moves a worktree, and the
  // primary is the project itself.
  { mirror = false }: { mirror?: boolean } = {},
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

  // The landing, on the peer, asking back over the link.
  const peer = peerSyncApiFor(targetDeviceId);
  const { receipt, ...landed } = SyncReceiveWorktreeResultSchema.parse(
    await offerSource(
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
    ),
  );

  // The ignored files, pushed into the root the peer's landing
  // answered with (re-parsed above, like everything it sends).
  let files: TransferFilesResult | undefined;
  if (pullBringsIgnoredFiles(ignoreMode)) {
    progress({ step: "files" });
    files = await transferFilesOnce(
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
    );
  }
  remember(
    { direction: "send", deviceId: targetDeviceId, projectId, worktreeId },
    receipt,
  );
  return {
    source: worktree,
    result: { ...landed, ...(files === undefined ? {} : { files }) },
  };
}
