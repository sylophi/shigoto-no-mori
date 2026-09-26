import { z } from "zod";
import { errorMessageOf } from "@shared/errors";
import { MIRROR_IGNORES_LIMIT } from "@shared/mirrorIgnores";
import { isValidWorktreeDirName } from "@shared/git/branches";
import { isSafeRelPath } from "@shared/git/gitPaths";
import { broadcast, defineContract, invoke } from "@shared/ipc/contract";
import { HexId32Schema } from "@shared/ipc/hexId";
import { DeviceIdSchema } from "@shared/hub/protocol";
import {
  CloneProjectPayloadSchema,
  CommitHashSchema,
  CreatePhaseSchema,
  GitRefNameSchema,
  ProjectSchema,
  WorktreeIdSchema,
  WorktreeSchema,
} from "@shared/schemas";

// Moving a worktree between devices. Commits cross on a SOURCE LINK:
// one byte channel (shared/ipc/socket/channels.ts) between the device
// holding the worktree (the source) and the one landing it (the
// destination), carrying the destination's questions and the source's
// answers, bundles as raw bytes (host/lib/sync/sourceLink.ts has the
// conversation). Whichever device opened the channel, the conversation
// is the same, and the device asked to open it is the one whose grant
// gates it:
//   - openSource: a pull (and the git follower fetching). The
//     destination asks the source for its link, so the source's grant
//     is the wall.
//   - receiveWorktree: a send. The source asks the destination to land
//     one of its worktrees, and the destination runs the same landing
//     a pull runs, asking back over the link the source opened. The
//     destination's grant is the wall, and the source is never asked
//     for anything gated.
//   - receiveBundle: the git follower pushing commits to the peer it
//     mirrors with, which asks back for the one bundle and unpacks it.
// All three are {remote:true, gated:true}. The byte-channel surface
// already rides the command grant (a revoke drops every channel), so
// the link needs no gate of its own.
//
// pullWorktree and sendWorktree are the LOCAL orchestrators a device's
// own renderer (or the CLI's control wire) invokes: bring a peer's
// worktree here, or send one of this device's to a peer. Tagged
// {remote:false}, so they are never registered on any remote wire
// (main/ipc/register.ts only forwards remote:true) and the web
// loopback refuses them as mutations. teardownSource is a move's
// second half, either way round: tearing the source down once the
// copy is safe, which runs only when nothing can be lost (the dirty
// state landed, or there was none) and rides the source device's
// ordinary worktrees:delete (the peer's grant-gated one after a pull,
// this device's own after a send). The two are separate verbs so the
// transplant dialog can show the landed worktree before the user
// decides what happens to the copy on the source device. pullProgress
// is a move's running commentary back to the renderer that invoked it
// (local-only, like the orchestrators themselves), keyed by the source
// worktree either way: a send relays the destination's frames.

// The refs a peer may request into a bundle, fail-closed: a branch
// (refs/heads/<name>), a dirty-state capture
// (refs/shigomori/dirty/<worktreeId>, see cli/cmd_dirty.go) or a
// mirror's index snapshot (refs/shigomori/index/<worktreeId>, see
// host/mirror/gitState.ts). The
// charset is deliberately conservative -- these strings cross the
// device boundary into git argv on the host. This gate and the CLI's
// (bundleRefRe in cli/cmd_bundle.go) are deliberately DIFFERENT, not a
// mirror: this one pins the exact namespaces but still admits a
// trailing "/" or ".lock", while the CLI admits any refs/* yet bans
// those tails. Two complementary sieves, defense in depth -- their
// intersection is fail-closed, so nothing that clears both is exotic.
const BUNDLE_REF_RE =
  /^refs\/(heads\/[A-Za-z0-9][A-Za-z0-9._/-]*|shigomori\/(dirty|index)\/[0-9a-f]{12})$/;

export const SyncBundleRefSchema = z
  .string()
  .regex(BUNDLE_REF_RE, { message: "Ref outside the sync allowlist" })
  .refine((ref) => !ref.includes("..") && !ref.includes("//"), {
    message: "Ref outside the sync allowlist",
  });

// Where an unpacked ref may land (the CLI enforces the same prefix
// fail-closed): the app-owned namespace, never a branch or a tag. Also
// the refs a mirror apply may sweep afterwards.
export const SyncLandingRefSchema = z
  .string()
  .regex(/^refs\/shigomori\/[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine((ref) => !ref.includes("..") && !ref.includes("//"), {
    message: "Ref outside the app's namespace",
  });

// A capture of a worktree's uncommitted state: its commit under
// refs/shigomori/dirty/<worktreeId> (cli/cmd_dirty.go), and that
// commit's tree, which is what a teardown compares (capture commits
// are not deterministic, their trees are).
export const SyncCaptureSchema = z.strictObject({
  captured: z.boolean(),
  commit: CommitHashSchema.optional(),
  tree: CommitHashSchema.optional(),
});
export type SyncCapture = z.infer<typeof SyncCaptureSchema>;

// What a capture leaves behind. The dirty capture has `git add -A`
// semantics (cli/cmd_dirty.go), so ignored files never cross a
// transfer, and a teardown removes them with the source. Near every
// real worktree carries ignored content (build output, node_modules),
// so refusing the teardown over it would make the teardown
// unreachable. Instead the transplant dialog lists these so the user
// decides in the know. This is the one place that reasoning lives.
// Same shape as the carry-over listing (host/lib/git/branches.ts
// listIgnoredPaths): fully-ignored directories collapse to one
// trailing-slash entry.
const SyncIgnoredPathsPayloadSchema = z.strictObject({
  projectId: z.string().min(1),
  worktreeId: WorktreeIdSchema,
});

// Capped on the wire: a worktree with scattered per-file ignores can
// hold thousands. Wide enough for the mirror dialog's picker to list a
// whole worktree, and past the cap it counts the rest.
export const SYNC_IGNORED_PATHS_LIMIT = 32;
// The rules ride under the engine's own cap (MIRROR_IGNORES_LIMIT),
// not the path list's: a repo's gitignore files easily hold more than
// 32 lines.
export const SyncIgnoredPathsResultSchema = z.strictObject({
  paths: z.array(z.string()).max(SYNC_IGNORED_PATHS_LIMIT),
  total: z.number().int().nonnegative(),
  // The gitignore rules behind them (the root .gitignore and
  // info/exclude, host/lib/git/ignoreRules.ts), for a mirror that
  // leaves gitignored files behind: a rule keeps out what is ignored
  // tomorrow, where the paths above only cover today.
  patterns: z.array(z.string()).max(MIRROR_IGNORES_LIMIT),
});
export type SyncIgnoredPathsResult = z.infer<
  typeof SyncIgnoredPathsResultSchema
>;

// One folder of a worktree, for the mirror dialog's picker of what
// stays behind: the same browse the carry-over picker offers, over one
// checkout instead of the union. `ignored` is git's verdict there (a
// folder a rule names counts even when it holds a tracked file, since
// the engine reads the rules and stays out of it whole), and only
// ignored entries take an exception (a tracked file kept back would
// leave the two git states disagreeing). .git is never listed.
const SyncWorktreeFolderPayloadSchema = SyncIgnoredPathsPayloadSchema.extend({
  relative: z.string().refine(isSafeRelPath, {
    message: "Path must stay within the worktree",
  }),
});
export const SyncWorktreeFolderEntrySchema = z.strictObject({
  name: z.string().min(1),
  isDirectory: z.boolean(),
  ignored: z.boolean(),
});
export type SyncWorktreeFolderEntry = z.infer<
  typeof SyncWorktreeFolderEntrySchema
>;

// The local pull orchestration's input: which peer, which of ITS
// project/worktree ids, and the branch to land here. sourceIdentity is
// the repo identity the renderer matched a local project on; the
// handler recomputes the local side and refuses on mismatch, so the
// call structurally cannot be aimed at a non-matching local repo. The
// branch refine pins it to the bundle allowlist up front, so a name
// the source link would reject fails here with a clear message instead
// of deep inside the transfer.
// What a move (and the mirror built on the send) leaves out. Everything:
// only .git stays put, the default (ignored files cross too).
// Gitignored: what git ignores on the source stays there, so a build
// folder or a .env never crosses. Custom: the user picked which of the
// ignored paths stay behind. Bring: the gitignored rule turned around,
// what git ignores stays there bar the ignored paths the user picked
// to bring (the carry-over list's shape, for one pull or mirror). A
// mirror remembers the mode on the session (a label) so its page can
// say which rule is in force. The patterns themselves are the engine's
// ignore list, in its gitignore-like syntax (a leading / anchors to
// the root, ! negates, the last match wins).
export const MirrorIgnoreModeSchema = z.enum([
  "everything",
  "gitignored",
  "custom",
  "bring",
]);
export type MirrorIgnoreMode = z.infer<typeof MirrorIgnoreModeSchema>;
const MirrorIgnorePatternSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((pattern) => !/[\r\n]/.test(pattern), {
    message: "Ignore pattern must be one line",
  });
export const MirrorIgnoresSchema = z
  .array(MirrorIgnorePatternSchema)
  .max(MIRROR_IGNORES_LIMIT);

// Whether a pull with this rule has ignored files to bring: the
// capture never carries them, and gitignored leaves every one of them
// behind, so only the other rules reach the files step. The host, the
// lab and the dialogs all read this one answer.
export function pullBringsIgnoredFiles(
  mode: MirrorIgnoreMode | undefined,
): boolean {
  return mode !== undefined && mode !== "gitignored";
}

// A new checkout's place on this device: the folder it goes in and
// its name, one segment (the add-project dialog's clone takes the
// same pair, CloneProjectPayloadSchema). `~` is expanded by the host.
export const SyncCloneIntoSchema = z.strictObject({
  parentDir: z.string().min(1),
  name: CloneProjectPayloadSchema.shape.name.unwrap(),
});
export type SyncCloneInto = z.infer<typeof SyncCloneIntoSchema>;

export const SyncPullWorktreePayloadSchema = z.strictObject({
  sourceDeviceId: DeviceIdSchema,
  sourceProjectId: z.string().min(1),
  sourceWorktreeId: WorktreeIdSchema,
  sourceIdentity: z.string().min(1),
  branch: GitRefNameSchema.refine(
    (name) => SyncBundleRefSchema.safeParse(`refs/heads/${name}`).success,
    { message: "Branch name outside the sync allowlist" },
  ),
  // The source worktree's folder name, so the copy lands under the
  // same name here and the two sides read as one worktree. Omitted
  // when the source's name is not a valid managed dirname (an external
  // worktree with an odd folder), in which case the create picks a
  // fresh pool name. The handler refuses, rather than renaming, when
  // that folder already exists on this device.
  worktreeName: z
    .string()
    .min(1)
    .refine(isValidWorktreeDirName, { message: "Not a valid folder name" })
    .optional(),
  // Whether the create here runs the project's setup script. The
  // dialogs default it by the ignore rule and the user can flip it.
  // Absent reads as yes, the create's ordinary lifecycle.
  runSetup: z.boolean().optional(),
  // The ignored files to bring across once the worktree is here, as
  // the leave-out rule and its patterns: the capture has `git add -A`
  // semantics, so this is the only way an ignored file travels. A
  // one-shot run of the mirror engine carries them (the "files" step).
  // Absent: nothing beyond the capture, the move as the mirror start
  // drives it (its own session brings the files and keeps bringing
  // them). Gitignored leaves nothing to carry, so it skips the step.
  ignoreMode: MirrorIgnoreModeSchema.optional(),
  ignores: MirrorIgnoresSchema.optional(),
  // Where to clone the repo when this device has no checkout of it
  // yet: the pull's landing project is made first (the peer's default
  // branch, fetched over the device link like the branch itself, so a
  // repo with no remote crosses too), registered, and the copy lands
  // in it as usual. Ignored when a local project already matches: the
  // dialog that offered it was reading a stale list, and the pull
  // takes the checkout it has. Without it, a device with no checkout
  // refuses as before.
  cloneInto: SyncCloneIntoSchema.optional(),
});

// The pull's progress, one frame per step change and per transferred
// chunk, keyed by the SOURCE worktree id (the only id the caller holds
// before the local worktree exists). `create` frames carry the new
// worktree's ordinary lifecycle phase as it streams (carry-over, setup,
// port provision). `transfer` frames carry the byte count, and so do
// `clone` frames, for the repo's own bundle.
export const SyncPullStepSchema = z.enum([
  // The repo cloned here first, a pull with `cloneInto` alone.
  "clone",
  "capture",
  "transfer",
  "create",
  "apply",
  // The ignored files, through the mirror engine run once. Only a pull
  // with a leave-out rule reaches it, and `bytes`/`totalBytes` carry the
  // staging figures.
  "files",
]);
export type SyncPullStep = z.infer<typeof SyncPullStepSchema>;

export const SyncPullProgressSchema = z.strictObject({
  sourceWorktreeId: WorktreeIdSchema,
  step: SyncPullStepSchema,
  bytes: z.number().int().nonnegative().optional(),
  totalBytes: z.number().int().nonnegative().optional(),
  createPhase: CreatePhaseSchema.optional(),
});
export type SyncPullProgress = z.infer<typeof SyncPullProgressSchema>;

export const SyncPullWorktreeResultSchema = z.strictObject({
  worktree: WorktreeSchema,
  // captured && !dirtyApplied is the partial-success case: the source
  // had uncommitted changes, the worktree landed, but the apply was
  // refused. The capture stays parked under the local worktree id and
  // the source still holds the original dirty state.
  captured: z.boolean(),
  dirtyApplied: z.boolean(),
  // The "files" step's outcome, present when a leave-out rule asked
  // for it. crossed:false with the reason means the ignored files are
  // still only on the source. conflicts counts the paths both sides
  // held differently, which keep this side's version.
  files: z
    .strictObject({
      crossed: z.boolean(),
      conflicts: z.number().int().nonnegative(),
      error: z.string().optional(),
    })
    .optional(),
  // The project the pull made for the copy to land in (`cloneInto`),
  // as registered. Absent when the copy landed in a checkout this
  // device already had.
  cloned: ProjectSchema.optional(),
});
export type SyncPullWorktreeResult = z.infer<
  typeof SyncPullWorktreeResultSchema
>;

// The send's input: which peer, and which of THIS device's worktrees.
// The branch, the folder name and the repo identity are read off the
// worktree by the handler, never taken from the caller. The setup
// switch, the leave-out rule and the clone are the pull's: with no
// checkout of the repo on the peer, the peer clones it from here first
// (the destination's landing is the pull's, so it takes a pull's
// `cloneInto`, named in the peer's own terms).
export const SyncSendWorktreePayloadSchema = z.strictObject({
  targetDeviceId: DeviceIdSchema,
  projectId: z.string().min(1),
  worktreeId: WorktreeIdSchema,
  runSetup: SyncPullWorktreePayloadSchema.shape.runSetup,
  ignoreMode: SyncPullWorktreePayloadSchema.shape.ignoreMode,
  ignores: SyncPullWorktreePayloadSchema.shape.ignores,
  cloneInto: SyncPullWorktreePayloadSchema.shape.cloneInto,
});

// The id of a source link's channel, minted by the device that opens
// it (shared/ipc/socket/channels.ts).
const ChannelIdSchema = HexId32Schema;

// A pull's source link: the source worktree on this host, which the
// link captures and whose repo it bundles.
const SyncOpenSourcePayloadSchema = z.strictObject({
  projectId: z.string().min(1),
  worktreeId: WorktreeIdSchema,
  channelId: ChannelIdSchema,
});

// What a move recorded, for the teardown that may follow: the branch
// and the tip it had, what was captured (and its tree), and whether the
// capture was applied at the destination. Computed by the landing and
// kept by the device that ran the move, so the data-loss rule runs on
// the hosts' own facts, never on a caller's say-so.
export const SyncReceiptSchema = z.strictObject({
  branch: GitRefNameSchema,
  branchTip: CommitHashSchema,
  captured: z.boolean(),
  dirtyApplied: z.boolean(),
  captureTree: CommitHashSchema.optional(),
});
export type SyncReceipt = z.infer<typeof SyncReceiptSchema>;

// The send's landing, asked of the destination: the pull's landing
// input with the facts a pull reads off the source's list (the
// identity, the branch, the folder name) supplied by the source
// itself, plus the link it opened. `landBranch` is the branch the copy
// is created on when it is not the source's own (a primary's mirror
// lands on mirror/<branch>, shared/git/branches.ts). The commits still
// arrive under `branch`.
export const SyncReceiveWorktreePayloadSchema = z.strictObject({
  identity: z.string().min(1),
  branch: SyncPullWorktreePayloadSchema.shape.branch,
  worktreeName: SyncPullWorktreePayloadSchema.shape.worktreeName,
  landBranch: GitRefNameSchema.optional(),
  sourceWorktreeId: WorktreeIdSchema,
  runSetup: SyncPullWorktreePayloadSchema.shape.runSetup,
  cloneInto: SyncPullWorktreePayloadSchema.shape.cloneInto,
  channelId: ChannelIdSchema,
});
export const SyncReceiveWorktreeResultSchema =
  SyncPullWorktreeResultSchema.omit({ files: true }).extend({
    receipt: SyncReceiptSchema,
  });

// The git follower's push (host/mirror/gitFollow.ts): the refs to land
// under refs/shigomori/ here and the tips this host already holds,
// which it asks the link for as one bundle.
const SyncReceiveBundlePayloadSchema = z.strictObject({
  projectId: z.string().min(1),
  refs: z.array(SyncBundleRefSchema).min(1).max(64),
  haves: z.array(CommitHashSchema).max(256),
  channelId: ChannelIdSchema,
});
export const SyncFetchedSchema = z.strictObject({
  fetched: z.array(
    z.strictObject({ ref: z.string(), commit: CommitHashSchema }),
  ),
});

// The teardown's fate. A refused or failed teardown never fails the
// call: by then the move succeeded and the state is safe on both
// sides, so the caller learns via sourceRemoved:false with sourceError
// carrying the stable marker or message ("scripts-running", a
// cleanup-script failure, a dirty state that did not land).
const SyncTeardownSourceResultSchema = z.strictObject({
  sourceRemoved: z.boolean(),
  sourceError: z.string().optional(),
});
export type SyncTeardownSourceResult = z.infer<
  typeof SyncTeardownSourceResultSchema
>;

// Which move a teardown follows, as the device that ran it names it:
// the direction, the peer the worktree came from or went to, and the
// SOURCE worktree (the peer's after a pull, this device's after a
// send). What the move captured and applied is NOT on the wire: the
// host reads back its own receipt.
export const SyncMoveDirectionSchema = z.enum(["pull", "send"]);
export type SyncMoveDirection = z.infer<typeof SyncMoveDirectionSchema>;
export const SyncTeardownSourcePayloadSchema = z.strictObject({
  direction: SyncMoveDirectionSchema,
  deviceId: DeviceIdSchema,
  projectId: z.string().min(1),
  worktreeId: WorktreeIdSchema,
});
export type SyncMoveRef = z.infer<typeof SyncTeardownSourcePayloadSchema>;

// A move's cancel, keyed the way the caller keys its progress: by the
// SOURCE worktree id, since the copy has no id of its own until the
// create lands. Served to peers on the command grant: the device that
// asked for a move it does not run (a mirror from the copy's side,
// which the original's device runs) cancels it there. A host only ever
// finds the moves of the device asking (host/lib/sync/moves.ts keys on
// the caller), so nothing else's move can be cancelled, and the
// landing a send asks of a peer needs no cancel of its own: the sender
// tears the link down, which the landing runs under. `cancelled` is
// false when nothing by that key is in flight here, which a caller
// reads as "already over".
const SyncCancelMovePayloadSchema = z.strictObject({
  sourceWorktreeId: WorktreeIdSchema,
});
const SyncCancelMoveResultSchema = z.strictObject({
  cancelled: z.boolean(),
});

// How a cancelled move fails, as text: Electron's IPC flattens an
// error to its message, and a peer's answer arrives re-worded ("The
// other device answered: ..."), so the marker is matched anywhere in
// it (see isMoveCancelledError). The destination is left as it was,
// the source untouched: the dialog's cancelled step says so.
export const MOVE_CANCELLED = "The move was cancelled";

export function isMoveCancelledError(error: unknown): boolean {
  return errorMessageOf(error).includes(MOVE_CANCELLED);
}

// Which of the named commits the host already holds, so a sender can
// thin a bundle (and skip a ref whose tip the receiver has, which
// `git bundle create` would otherwise drop silently).
export const SYNC_HAS_COMMITS_LIMIT = 64;
const SyncHasCommitsPayloadSchema = z.strictObject({
  projectId: z.string().min(1),
  commits: z.array(CommitHashSchema).min(1).max(SYNC_HAS_COMMITS_LIMIT),
});

export const SyncHasCommitsResultSchema = z.strictObject({
  present: z.array(CommitHashSchema),
});

export const syncContract = defineContract("host", {
  // A read that discloses repo state (the names of ignored files), so
  // it rides the command grant.
  worktreeFolder: invoke(
    "sync:worktreeFolder",
    SyncWorktreeFolderPayloadSchema,
    z.array(SyncWorktreeFolderEntrySchema),
    { remote: true, gated: true, movesHostState: false },
  ),
  ignoredPaths: invoke(
    "sync:ignoredPaths",
    SyncIgnoredPathsPayloadSchema,
    SyncIgnoredPathsResultSchema,
    { remote: true, gated: true, movesHostState: false },
  ),
  hasCommits: invoke(
    "sync:hasCommits",
    SyncHasCommitsPayloadSchema,
    SyncHasCommitsResultSchema,
    { remote: true, gated: true, movesHostState: false },
  ),
  // The link opens and the call returns: what crosses after is bytes on
  // the channel, and a capture it takes is announced by the git
  // watcher like any ref write, so the open itself pings no viewer.
  openSource: invoke("sync:openSource", SyncOpenSourcePayloadSchema, z.void(), {
    remote: true,
    gated: true,
    movesHostState: false,
  }),
  // Both land refs (and a worktree), so both keep the viewer ping,
  // which fires once they are done.
  receiveWorktree: invoke(
    "sync:receiveWorktree",
    SyncReceiveWorktreePayloadSchema,
    SyncReceiveWorktreeResultSchema,
    { remote: true, gated: true },
  ),
  receiveBundle: invoke(
    "sync:receiveBundle",
    SyncReceiveBundlePayloadSchema,
    SyncFetchedSchema,
    { remote: true, gated: true },
  ),
  // The local orchestrators (see the header note): remote:false keeps
  // them off every remote wire, gated:true documents intent and keeps
  // the web loopback's fail-closed refusal.
  pullWorktree: invoke(
    "sync:pullWorktree",
    SyncPullWorktreePayloadSchema,
    SyncPullWorktreeResultSchema,
    { remote: false, gated: true },
  ),
  sendWorktree: invoke(
    "sync:sendWorktree",
    SyncSendWorktreePayloadSchema,
    SyncPullWorktreeResultSchema,
    { remote: false, gated: true },
  ),
  // The cancel reaches the device running the move or its landing (the
  // payload's note), so it rides the grant like the moves themselves.
  // Whether it moved host state is the cancelled call's own news (its
  // rollback resolves under that call), so this one skips the ping.
  cancelMove: invoke(
    "sync:cancelMove",
    SyncCancelMovePayloadSchema,
    SyncCancelMoveResultSchema,
    { remote: true, gated: true, movesHostState: false },
  ),
  // A move's second half, local-only like the moves: its remote half,
  // after a pull, is the peer's ordinary grant-gated worktrees:delete.
  teardownSource: invoke(
    "sync:teardownSource",
    SyncTeardownSourcePayloadSchema,
    SyncTeardownSourceResultSchema,
    { remote: false, gated: true },
  ),
  // Untagged (local-only): the move runs on the device whose renderer
  // invoked it, and the notifier hands the frames back to that caller.
  pullProgress: broadcast("sync:pullProgress", SyncPullProgressSchema),
});
