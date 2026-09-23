import { Schema, Struct } from "effect";
import { MIRROR_IGNORES_LIMIT } from "@shared/mirrorIgnores";
import { isValidWorktreeDirName } from "@shared/git/branches";
import { isSafeRelPath } from "@shared/git/gitPaths";
import { broadcast, defineContract, invoke } from "@shared/ipc/contract";
import { HexId32Schema } from "@shared/ipc/hexId";
import { ChunkB64Schema } from "@shared/ipc/socket/frames";
import { DeviceIdSchema } from "@shared/hub/protocol";
import {
  CommitHashSchema,
  CreatePhaseSchema,
  GitRefNameSchema,
  WorktreeIdSchema,
  WorktreeSchema,
} from "@shared/schemas";
import { strictStruct } from "@shared/schemas/strict";
import { NonNegativeInt } from "@shared/schemas/ints";

const ProjectIdSchema = Schema.NonEmptyString;

// Device-sync transfer plumbing: git bundles move
// between devices as chunked, grant-gated invoke responses over the
// existing device connection. No new wire protocol, no sidecar port:
// start registers a bundle on the host, chunk streams it out in
// WIRE_CHUNK_BYTES pieces, abort cleans up a receiver that gave up. Every
// transfer verb (refTips through bundleAbort) is {remote:true,
// mutating:true}, so that whole surface rides the per-peer command
// grant -- and the LAN wire, read-only by policy, refuses it outright.
// The transfer verbs also set movesHostState:false: serving a transfer
// moves no state a remote viewer caches, and without the opt-out every
// chunk resolution of a multi-minute pull would fire the registrar's
// cache ping (git:externalChange to every viewing peer). captureDirty
// is the exception and KEEPS the ping -- it writes a capture ref, real
// host state.
// Responses to awaited invokes are reliable on the device wire (pushes
// are droppable), which is why the transfer is invoke/response only.
//
// pullWorktree (slice C) is the odd one out: it is the LOCAL
// orchestrator a device's own renderer invokes to pull a peer's
// worktree here, driving the remote verbs above against that peer.
// Tagged {remote:false}, so it is never registered on any remote wire
// (main/ipc/register.ts only forwards remote:true) and the web
// loopback refuses it as a mutation. teardownSource (step 9) is the
// transplant's second half: tearing the source worktree down on the
// peer after a pull landed here, which runs only when nothing can be
// lost (the dirty state landed here, or there was none) and rides the
// peer's ordinary grant-gated worktrees:delete. The two are separate
// verbs so the transplant dialog can show the landed worktree before
// the user decides what happens to the copy on the source device.
// pullProgress is the pull's running commentary back to the renderer
// that invoked it (local-only, like the orchestrators themselves).
//
// sendWorktree is the pull turned around: the LOCAL orchestrator that
// sends one of this device's worktrees to a peer. This device captures
// and pushes (pushStart through pushFinish), then asks the peer to
// land what arrived (landCheck before a byte moves, landWorktree
// after), so a send rides the same single grant a pull does: the
// peer's. teardownSent is its second half, tearing down the local
// source once the copy is safe on the peer. Its progress rides
// pullProgress, keyed by the local source worktree.

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

const hasNoDotDotOrDoubleSlash = (ref: string): boolean =>
  !ref.includes("..") && !ref.includes("//");

const SyncBundleRefSchema = Schema.String.check(
  Schema.isPattern(BUNDLE_REF_RE, {
    message: "Ref outside the sync allowlist",
  }),
  Schema.makeFilter(hasNoDotDotOrDoubleSlash, {
    message: "Ref outside the sync allowlist",
  }),
);
const isSyncBundleRef = Schema.is(SyncBundleRefSchema);

// Where an unpacked ref may land (the CLI enforces the same prefix
// fail-closed): the app-owned namespace, never a branch or a tag. Also
// the refs a mirror apply may sweep afterwards.
export const SyncLandingRefSchema = Schema.String.check(
  Schema.isPattern(/^refs\/shigomori\/[A-Za-z0-9][A-Za-z0-9._/-]*$/),
  Schema.makeFilter(hasNoDotDotOrDoubleSlash, {
    message: "Ref outside the app's namespace",
  }),
);
const isSyncLandingRef = Schema.is(SyncLandingRefSchema);

// One `src:dst` for the push direction's unpack on the receiver.
const SyncRefspecSchema = Schema.String.check(
  Schema.isMaxLength(512),
  Schema.makeFilter(
    (spec: string) => {
      const colon = spec.indexOf(":");
      if (colon <= 0) return false;
      const src = spec.slice(0, colon);
      const dst = spec.slice(colon + 1);
      return isSyncBundleRef(src) && isSyncLandingRef(dst);
    },
    { message: "Refspec outside the sync allowlist" },
  ),
);

// transferIds are host-minted (shared/ipc/hexId.ts pins the shape), so
// a peer can only replay an id it was given, never probe with crafted
// ones.
const TransferIdSchema = HexId32Schema;

const SyncRefTipSchema = strictStruct({
  ref: SyncBundleRefSchema,
  commit: CommitHashSchema,
});

const SyncCaptureDirtyPayloadSchema = strictStruct({
  projectId: ProjectIdSchema,
  worktreeId: WorktreeIdSchema,
});

// A requested ref list: at least one, at most 64.
const SyncBundleRefsSchema = Schema.Array(SyncBundleRefSchema).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
);

// Tip negotiation for the pull orchestration. Load bearing for
// thinness AND correctness: `git bundle create` silently DROPS a
// requested ref whose tip is already covered by a have (and refuses an
// all-covered bundle outright), so the receiver must learn the tip
// first and only request the branch when it lacks that commit.
const SyncRefTipsPayloadSchema = strictStruct({
  projectId: ProjectIdSchema,
  refs: SyncBundleRefsSchema,
});

export const SyncRefTipsResultSchema = strictStruct({
  // Requested refs that exist on the host, with their tips. A missing
  // ref is simply absent, not an error: the caller decides what a gone
  // branch means.
  tips: Schema.Array(SyncRefTipSchema),
});

const SyncBundleStartPayloadSchema = strictStruct({
  projectId: ProjectIdSchema,
  refs: SyncBundleRefsSchema,
  // Tips the receiver already holds, thinning the bundle. Hex-pinned
  // like every hash that travels toward git argv.
  haves: Schema.Array(CommitHashSchema).check(Schema.isMaxLength(256)),
});

const SyncBundleChunkPayloadSchema = strictStruct({
  transferId: TransferIdSchema,
  offset: NonNegativeInt,
});

const SyncBundleAbortPayloadSchema = strictStruct({
  transferId: TransferIdSchema,
});

export const SyncCaptureDirtyResultSchema = strictStruct({
  captured: Schema.Boolean,
  commit: Schema.optional(CommitHashSchema),
});

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
const SyncIgnoredPathsPayloadSchema = strictStruct({
  projectId: ProjectIdSchema,
  worktreeId: WorktreeIdSchema,
});

// Capped on the wire: a worktree with scattered per-file ignores can
// hold thousands. Wide enough for the mirror dialog's picker to list a
// whole worktree, and past the cap it counts the rest.
export const SYNC_IGNORED_PATHS_LIMIT = 32;
// The rules ride under the engine's own cap (MIRROR_IGNORES_LIMIT),
// not the path list's: a repo's gitignore files easily hold more than
// 32 lines.
export const SyncIgnoredPathsResultSchema = strictStruct({
  paths: Schema.Array(Schema.String).check(
    Schema.isMaxLength(SYNC_IGNORED_PATHS_LIMIT),
  ),
  total: NonNegativeInt,
  // The gitignore rules behind them (the root .gitignore and
  // info/exclude, host/lib/git/ignoreRules.ts), for a mirror that
  // leaves gitignored files behind: a rule keeps out what is ignored
  // tomorrow, where the paths above only cover today.
  patterns: Schema.Array(Schema.String).check(
    Schema.isMaxLength(MIRROR_IGNORES_LIMIT),
  ),
});
export type SyncIgnoredPathsResult = typeof SyncIgnoredPathsResultSchema.Type;

// One folder of a worktree, for the mirror dialog's picker of what
// stays behind: the same browse the carry-over picker offers, over one
// checkout instead of the union. `ignored` is git's verdict there (a
// folder a rule names counts even when it holds a tracked file, since
// the engine reads the rules and stays out of it whole), and only
// ignored entries take an exception (a tracked file kept back would
// leave the two git states disagreeing). .git is never listed.
const SyncWorktreeFolderPayloadSchema = strictStruct({
  ...SyncIgnoredPathsPayloadSchema.fields,
  relative: Schema.String.check(
    Schema.makeFilter(isSafeRelPath, {
      message: "Path must stay within the worktree",
    }),
  ),
});
export const SyncWorktreeFolderEntrySchema = strictStruct({
  name: Schema.NonEmptyString,
  isDirectory: Schema.Boolean,
  ignored: Schema.Boolean,
});
export type SyncWorktreeFolderEntry = typeof SyncWorktreeFolderEntrySchema.Type;

export const SyncBundleStartResultSchema = strictStruct({
  transferId: TransferIdSchema,
  bytes: NonNegativeInt,
});

const SyncBundleChunkResultSchema = strictStruct({
  dataB64: ChunkB64Schema,
  eof: Schema.Boolean,
});

// The local pull orchestration's input: which peer, which of ITS
// project/worktree ids, and the branch to land here. sourceIdentity is
// the repo identity the renderer matched a local project on; the
// handler recomputes the local side and refuses on mismatch, so the
// call structurally cannot be aimed at a non-matching local repo. The
// branch refine pins it to the bundle allowlist up front, so a name
// the transfer surface would reject fails here with a clear message
// instead of deep inside the peer's schema.
// What a pull (and the mirror built on it) leaves out. Everything:
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
export const MirrorIgnoreModeSchema = Schema.Literals([
  "everything",
  "gitignored",
  "custom",
  "bring",
]);
export type MirrorIgnoreMode = typeof MirrorIgnoreModeSchema.Type;
const MirrorIgnorePatternSchema = Schema.NonEmptyString.check(
  Schema.isMaxLength(1024),
  Schema.makeFilter((pattern: string) => !/[\r\n]/.test(pattern), {
    message: "Ignore pattern must be one line",
  }),
);
export const MirrorIgnoresSchema = Schema.Array(
  MirrorIgnorePatternSchema,
).check(Schema.isMaxLength(MIRROR_IGNORES_LIMIT));

// Whether a pull with this rule has ignored files to bring: the
// capture never carries them, and gitignored leaves every one of them
// behind, so only the other rules reach the files step. The host, the
// lab and the dialogs all read this one answer.
export function pullBringsIgnoredFiles(
  mode: MirrorIgnoreMode | undefined,
): boolean {
  return mode !== undefined && mode !== "gitignored";
}

export const SyncPullWorktreePayloadSchema = strictStruct({
  sourceDeviceId: DeviceIdSchema,
  sourceProjectId: ProjectIdSchema,
  sourceWorktreeId: WorktreeIdSchema,
  sourceIdentity: Schema.NonEmptyString,
  branch: GitRefNameSchema.check(
    Schema.makeFilter((name: string) => isSyncBundleRef(`refs/heads/${name}`), {
      message: "Branch name outside the sync allowlist",
    }),
  ),
  // The source worktree's folder name, so the copy lands under the
  // same name here and the two sides read as one worktree. Omitted
  // when the source's name is not a valid managed dirname (an external
  // worktree with an odd folder), in which case the create picks a
  // fresh pool name. The handler refuses, rather than renaming, when
  // that folder already exists on this device.
  worktreeName: Schema.optional(
    Schema.NonEmptyString.check(
      Schema.makeFilter(isValidWorktreeDirName, {
        message: "Not a valid folder name",
      }),
    ),
  ),
  // Whether the create here runs the project's setup script. The
  // dialogs default it by the ignore rule and the user can flip it.
  // Absent reads as yes, the create's ordinary lifecycle.
  runSetup: Schema.optional(Schema.Boolean),
  // The ignored files to bring across once the worktree is here, as
  // the leave-out rule and its patterns: the capture has `git add -A`
  // semantics, so this is the only way an ignored file travels. A
  // one-shot run of the mirror engine carries them (the "files" step).
  // Absent: nothing beyond the capture, the pull as the mirror start
  // drives it (its own session brings the files and keeps bringing
  // them). Gitignored leaves nothing to carry, so it skips the step.
  ignoreMode: Schema.optional(MirrorIgnoreModeSchema),
  ignores: Schema.optional(MirrorIgnoresSchema),
});

// The pull's progress, one frame per step change and per transferred
// chunk, keyed by the SOURCE worktree id (the only id the caller holds
// before the local worktree exists). `create` frames carry the new
// worktree's ordinary lifecycle phase as it streams (carry-over, setup,
// port provision). `transfer` frames carry the byte count.
export const SyncPullStepSchema = Schema.Literals([
  "capture",
  "transfer",
  "create",
  "apply",
  // The ignored files, through the mirror engine run once. Only a pull
  // with a leave-out rule reaches it, and `bytes`/`totalBytes` carry the
  // staging figures.
  "files",
]);
export type SyncPullStep = typeof SyncPullStepSchema.Type;

const SyncPullProgressSchema = strictStruct({
  sourceWorktreeId: WorktreeIdSchema,
  step: SyncPullStepSchema,
  bytes: Schema.optional(NonNegativeInt),
  totalBytes: Schema.optional(NonNegativeInt),
  createPhase: Schema.optional(CreatePhaseSchema),
});
export type SyncPullProgress = typeof SyncPullProgressSchema.Type;

export const SyncPullWorktreeResultSchema = strictStruct({
  worktree: WorktreeSchema,
  // captured && !dirtyApplied is the partial-success case: the source
  // had uncommitted changes, the worktree landed, but the apply was
  // refused. The capture stays parked under the local worktree id and
  // the source still holds the original dirty state.
  captured: Schema.Boolean,
  dirtyApplied: Schema.Boolean,
  // The "files" step's outcome, present when a leave-out rule asked
  // for it. crossed:false with the reason means the ignored files are
  // still only on the source. conflicts counts the paths both sides
  // held differently, which keep this side's version.
  files: Schema.optional(
    strictStruct({
      crossed: Schema.Boolean,
      conflicts: NonNegativeInt,
      error: Schema.optional(Schema.String),
    }),
  ),
});
export type SyncPullWorktreeResult = typeof SyncPullWorktreeResultSchema.Type;

// The send's input: which peer, and which of THIS device's worktrees.
// The branch, the folder name and the repo identity are read off the
// worktree by the handler, never taken from the caller. The setup
// switch and the leave-out rule are the pull's.
export const SyncSendWorktreePayloadSchema = strictStruct({
  targetDeviceId: DeviceIdSchema,
  projectId: ProjectIdSchema,
  worktreeId: WorktreeIdSchema,
  runSetup: SyncPullWorktreePayloadSchema.fields.runSetup,
  ignoreMode: SyncPullWorktreePayloadSchema.fields.ignoreMode,
  ignores: SyncPullWorktreePayloadSchema.fields.ignores,
});

// Where a sent worktree would land, asked of the receiving peer before
// a byte moves: the pull's own refusals (no project of that identity,
// the branch or the folder name already taken), run on the device
// they are about. The answer is the peer's project id, which the push
// unpacks into.
const SyncLandTargetSchema = strictStruct({
  identity: Schema.NonEmptyString,
  branch: SyncPullWorktreePayloadSchema.fields.branch,
  worktreeName: SyncPullWorktreePayloadSchema.fields.worktreeName,
});
export const SyncLandCheckResultSchema = strictStruct({
  projectId: ProjectIdSchema,
});

// The landing itself, once the push has unpacked: the create on the
// branch tip and the re-apply of the capture, the pull's steps 5 and 6
// run by the receiver. The tip is named because a branch the receiver
// already held the tip of never crossed, and the capture by its commit
// and the SENDER's worktree id, the key its ref arrived under.
export const SyncLandWorktreePayloadSchema = strictStruct({
  ...SyncLandTargetSchema.fields,
  branchTip: CommitHashSchema,
  runSetup: SyncPullWorktreePayloadSchema.fields.runSetup,
  capture: Schema.optional(
    strictStruct({
      sourceWorktreeId: WorktreeIdSchema,
      commit: CommitHashSchema,
    }),
  ),
});
export const SyncLandWorktreeResultSchema = strictStruct({
  worktree: WorktreeSchema,
  dirtyApplied: Schema.Boolean,
});

// The teardown's fate. A refused or failed teardown never fails the
// call: by then the pull succeeded and the state is safe on both
// sides, so the caller learns via sourceRemoved:false with sourceError
// carrying the stable marker or message ("scripts-running", a
// cleanup-script failure, a dirty state that did not land here).
const SyncTeardownSourceResultSchema = strictStruct({
  sourceRemoved: Schema.Boolean,
  sourceError: Schema.optional(Schema.String),
});
export type SyncTeardownSourceResult =
  typeof SyncTeardownSourceResultSchema.Type;

// The teardown's input: which peer worktree. What the preceding pull
// captured and applied is NOT on the wire: the host records its own
// pull's outcome and reads it back here, so the data-loss rule runs
// on facts the host produced, never on a caller's say-so.
// The push direction of the transfer (the mirror's git follower,
// host/mirror/gitFollow.ts, ships local commits to the peer): the
// sender announces a bundle's size, streams it in the same chunks the
// pull direction uses, and names the landing refspecs for the
// receiver's unpack. Same fail-closed namespaces, same host-minted
// transfer ids.
const SyncPushStartPayloadSchema = strictStruct({
  projectId: ProjectIdSchema,
  bytes: NonNegativeInt,
});

const SyncPushStartResultSchema = strictStruct({
  transferId: TransferIdSchema,
  // This host takes chunks the sender did not await one by one: in
  // offset order still, but several in flight. Absent from an older
  // host, which refuses a chunk sent before the last was answered, so
  // a sender without it stays one at a time.
  pipelined: Schema.optional(Schema.Literal(true)),
});

const SyncPushChunkPayloadSchema = strictStruct({
  transferId: TransferIdSchema,
  offset: NonNegativeInt,
  dataB64: ChunkB64Schema,
});

const SyncPushFinishPayloadSchema = strictStruct({
  transferId: TransferIdSchema,
  refspecs: Schema.Array(SyncRefspecSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
  ),
});

const SyncPushFinishResultSchema = strictStruct({
  fetched: Schema.Array(
    strictStruct({ ...SyncRefTipSchema.fields, ref: Schema.String }),
  ),
});

// Which of the named commits the host already holds, so a sender can
// thin a bundle (and skip a ref whose tip the receiver has, which
// `git bundle create` would otherwise drop silently).
export const SYNC_HAS_COMMITS_LIMIT = 64;
const SyncHasCommitsPayloadSchema = strictStruct({
  projectId: ProjectIdSchema,
  commits: Schema.Array(CommitHashSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(SYNC_HAS_COMMITS_LIMIT),
  ),
});

export const SyncHasCommitsResultSchema = strictStruct({
  present: Schema.Array(CommitHashSchema),
});

export const SyncTeardownSourcePayloadSchema = strictStruct(
  Struct.pick(SyncPullWorktreePayloadSchema.fields, [
    "sourceDeviceId",
    "sourceProjectId",
    "sourceWorktreeId",
  ]),
);

// The sent worktree's teardown: which peer it went to and which local
// worktree that was. Like teardownSource, what the send captured and
// applied is the host's own record, never the caller's claim.
export const SyncTeardownSentPayloadSchema = strictStruct({
  targetDeviceId: DeviceIdSchema,
  projectId: ProjectIdSchema,
  worktreeId: WorktreeIdSchema,
});

export const syncContract = defineContract("host", {
  refTips: invoke(
    "sync:refTips",
    SyncRefTipsPayloadSchema,
    SyncRefTipsResultSchema,
    // A read, but it discloses repo state, so it rides the command
    // grant with the rest of the transfer surface.
    { remote: true, mutating: true, movesHostState: false },
  ),
  // Writes a capture ref, so unlike the transfer verbs around it this
  // one KEEPS the viewer cache ping (no movesHostState opt-out).
  captureDirty: invoke(
    "sync:captureDirty",
    SyncCaptureDirtyPayloadSchema,
    SyncCaptureDirtyResultSchema,
    { remote: true, mutating: true },
  ),
  // A read that discloses repo state (the names of ignored files), so
  // it rides the command grant like refTips.
  worktreeFolder: invoke(
    "sync:worktreeFolder",
    SyncWorktreeFolderPayloadSchema,
    Schema.Array(SyncWorktreeFolderEntrySchema),
    { remote: true, mutating: true, movesHostState: false },
  ),
  ignoredPaths: invoke(
    "sync:ignoredPaths",
    SyncIgnoredPathsPayloadSchema,
    SyncIgnoredPathsResultSchema,
    { remote: true, mutating: true, movesHostState: false },
  ),
  bundleStart: invoke(
    "sync:bundleStart",
    SyncBundleStartPayloadSchema,
    SyncBundleStartResultSchema,
    { remote: true, mutating: true, movesHostState: false },
  ),
  bundleChunk: invoke(
    "sync:bundleChunk",
    SyncBundleChunkPayloadSchema,
    SyncBundleChunkResultSchema,
    // Reads a host temp file, but it rides the command grant with the
    // rest of the transfer surface: chunk data is repo content.
    { remote: true, mutating: true, movesHostState: false },
  ),
  bundleAbort: invoke(
    "sync:bundleAbort",
    SyncBundleAbortPayloadSchema,
    Schema.Undefined,
    { remote: true, mutating: true, movesHostState: false },
  ),
  pushStart: invoke(
    "sync:pushStart",
    SyncPushStartPayloadSchema,
    SyncPushStartResultSchema,
    { remote: true, mutating: true, movesHostState: false },
  ),
  pushChunk: invoke(
    "sync:pushChunk",
    SyncPushChunkPayloadSchema,
    Schema.Undefined,
    {
      remote: true,
      mutating: true,
      movesHostState: false,
    },
  ),
  // Lands refs, so it keeps the viewer cache ping.
  pushFinish: invoke(
    "sync:pushFinish",
    SyncPushFinishPayloadSchema,
    SyncPushFinishResultSchema,
    { remote: true, mutating: true },
  ),
  hasCommits: invoke(
    "sync:hasCommits",
    SyncHasCommitsPayloadSchema,
    SyncHasCommitsResultSchema,
    // A read that discloses repo state, like refTips.
    { remote: true, mutating: true, movesHostState: false },
  ),
  // The receiving half of a send (see the header note). The check
  // moves nothing, but it discloses repo state like refTips.
  landCheck: invoke(
    "sync:landCheck",
    SyncLandTargetSchema,
    SyncLandCheckResultSchema,
    { remote: true, mutating: true, movesHostState: false },
  ),
  landWorktree: invoke(
    "sync:landWorktree",
    SyncLandWorktreePayloadSchema,
    SyncLandWorktreeResultSchema,
    { remote: true, mutating: true },
  ),
  // The local orchestrator (see the header note): remote:false keeps
  // it off every remote wire, mutating:true documents intent and keeps
  // the web loopback's fail-closed refusal.
  pullWorktree: invoke(
    "sync:pullWorktree",
    SyncPullWorktreePayloadSchema,
    SyncPullWorktreeResultSchema,
    { remote: false, mutating: true },
  ),
  // The source teardown after a pull (see the header note): local-only
  // like the pull, its remote half is the peer's ordinary grant-gated
  // worktrees:delete.
  teardownSource: invoke(
    "sync:teardownSource",
    SyncTeardownSourcePayloadSchema,
    SyncTeardownSourceResultSchema,
    { remote: false, mutating: true },
  ),
  // The send and its teardown, local-only like the pull and its own.
  sendWorktree: invoke(
    "sync:sendWorktree",
    SyncSendWorktreePayloadSchema,
    SyncPullWorktreeResultSchema,
    { remote: false, mutating: true },
  ),
  teardownSent: invoke(
    "sync:teardownSent",
    SyncTeardownSentPayloadSchema,
    SyncTeardownSourceResultSchema,
    { remote: false, mutating: true },
  ),
  // Untagged (local-only): the pull runs on the device whose renderer
  // invoked it, and the notifier hands the frames back to that caller.
  pullProgress: broadcast("sync:pullProgress", SyncPullProgressSchema),
});
