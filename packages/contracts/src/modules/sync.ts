import * as Schema from "effect/Schema";
import { errorMessageOf } from "../errors.ts";
import { MIRROR_IGNORES_LIMIT } from "../mirrorIgnores.ts";
import { isValidWorktreeDirName } from "../predicates/worktreeDirName.ts";
import { isSafeRelPath } from "../predicates/relPath.ts";
import { push, defineContract, invoke } from "../contract.ts";
import { DeviceIdSchema } from "../hubProtocol.ts";
import {
  CloneFolderNameSchema,
  CommitHashSchema,
  CreatePhaseSchema,
  FilesBroughtSchema,
  GitRefNameSchema,
  ProjectSchema,
  VoidSchema,
  WorktreeIdSchema,
  WorktreeSchema,
} from "../schemas/index.ts";
import { HexId32Schema } from "../schemas/hexId.ts";
import { strict } from "../schemas/strict.ts";

// Commits cross on a source link, one byte channel between the device
// holding the worktree and the one landing it. Whichever side opened it,
// the conversation is the same, and the grant that gates it is the one
// of the device asked to open it: the source's for a pull (openSource),
// the destination's for a send (receiveWorktree) and a follower's push
// (receiveBundle). The channel itself rides the command grant, so it
// needs no gate of its own.

// The refs a peer may request into a bundle: a branch, a remote-tracking
// branch (a clone's default branch, when the project's is one), a dirty
// capture, a mirror's index snapshot. These cross into git argv, hence
// the narrow charset. The engine's gate (Bundle.ts) differs on purpose:
// it admits any refs/* but bans a trailing "/" or ".lock", which this
// one admits. Only what clears both goes through.
const BUNDLE_REF_RE =
  /^refs\/((heads|remotes)\/[A-Za-z0-9][A-Za-z0-9._/-]*|shigomori\/(dirty|index)\/[0-9a-f]{12})$/;

export const SyncBundleRefSchema = Schema.String.check(
  Schema.isPattern(BUNDLE_REF_RE, {
    message: "Ref outside the sync allowlist",
  }),
  Schema.makeFilter(
    (ref: string) =>
      (!ref.includes("..") && !ref.includes("//")) ||
      "Ref outside the sync allowlist",
  ),
);
const isSyncBundleRef = Schema.is(SyncBundleRefSchema);

// Never a branch or a tag. Also the refs a mirror apply may sweep.
export const SyncLandingRefSchema = Schema.String.check(
  Schema.isPattern(/^refs\/shigomori\/[A-Za-z0-9][A-Za-z0-9._/-]*$/),
  Schema.makeFilter(
    (ref: string) =>
      (!ref.includes("..") && !ref.includes("//")) ||
      "Ref outside the app's namespace",
  ),
);

// A teardown compares the tree: capture commits are not deterministic,
// their trees are.
export const SyncCaptureSchema = strict(
  Schema.Struct({
    captured: Schema.Boolean,
    commit: Schema.optional(CommitHashSchema),
    tree: Schema.optional(CommitHashSchema),
  }),
);
export type SyncCapture = typeof SyncCaptureSchema.Type;

// What a capture leaves behind (it has `git add -A` semantics), which a
// teardown removes with the source. Nearly every worktree has ignored
// content, so a teardown can't refuse over it; the dialog lists it
// instead.
const SyncIgnoredPathsPayloadSchema = strict(
  Schema.Struct({
    projectId: Schema.NonEmptyString,
    worktreeId: WorktreeIdSchema,
  }),
);

// A worktree with per-file ignores can hold thousands; past the cap,
// `total` counts the rest.
export const SYNC_IGNORED_PATHS_LIMIT = 32;
const SyncIgnoredPathsResultSchema = strict(
  Schema.Struct({
    paths: Schema.Array(Schema.String).check(
      Schema.isMaxLength(SYNC_IGNORED_PATHS_LIMIT),
    ),
    total: Schema.Natural,
    // The rules behind them: a rule keeps out what is ignored tomorrow,
    // where the paths only cover today.
    patterns: Schema.Array(Schema.String).check(
      Schema.isMaxLength(MIRROR_IGNORES_LIMIT),
    ),
  }),
);
export type SyncIgnoredPathsResult = typeof SyncIgnoredPathsResultSchema.Type;

// One folder of a worktree. With `ruleIgnored`, a folder a rule names
// counts as ignored even when it holds a tracked file, as the mirror's
// picker needs (the engine stays out of it whole). The files page leaves
// it off: a tracked file must show there.
const SyncWorktreeFolderPayloadSchema = strict(
  Schema.Struct({
    ...SyncIgnoredPathsPayloadSchema.struct.fields,
    relative: Schema.String.check(
      Schema.makeFilter(
        (relative: string) =>
          isSafeRelPath(relative) || "Path must stay within the worktree",
      ),
    ),
    ruleIgnored: Schema.Boolean,
  }),
);
const SyncWorktreeFolderEntrySchema = strict(
  Schema.Struct({
    name: Schema.NonEmptyString,
    isDirectory: Schema.Boolean,
    ignored: Schema.Boolean,
  }),
);
export type SyncWorktreeFolderEntry = typeof SyncWorktreeFolderEntrySchema.Type;

// What a move leaves out. everything: only .git stays (the default).
// gitignored: what git ignores on the source stays. custom: the ignored
// paths the user picked stay. bring: gitignored, bar the ignored paths
// the user picked to bring. The patterns are the engine's gitignore-like
// syntax (a leading / anchors, ! negates, the last match wins).
export const MirrorIgnoreModeSchema = Schema.Literals([
  "everything",
  "gitignored",
  "custom",
  "bring",
]);
export type MirrorIgnoreMode = typeof MirrorIgnoreModeSchema.Type;
const MirrorIgnorePatternSchema = Schema.String.check(
  Schema.isBetweenLength(1, 1024),
  Schema.makeFilter(
    (pattern: string) =>
      !/[\r\n]/.test(pattern) || "Ignore pattern must be one line",
  ),
);
export const MirrorIgnoresSchema = Schema.Array(
  MirrorIgnorePatternSchema,
).check(Schema.isMaxLength(MIRROR_IGNORES_LIMIT));

// The capture never carries ignored files, and gitignored leaves them
// all behind.
export function pullBringsIgnoredFiles(
  mode: MirrorIgnoreMode | undefined,
): boolean {
  return mode !== undefined && mode !== "gitignored";
}

// `~` is expanded by the host.
export const SyncCloneIntoSchema = strict(
  Schema.Struct({
    parentDir: Schema.NonEmptyString,
    name: CloneFolderNameSchema,
  }),
);
export type SyncCloneInto = typeof SyncCloneIntoSchema.Type;

// What is at the folder a move would clone into, read before it starts:
// nothing yet, a checkout of the same repo (which the landing registers
// and lands in), or anything else.
const SyncCloneDestinationPayloadSchema = strict(
  Schema.Struct({
    cloneInto: SyncCloneIntoSchema,
    // The repo's identity on the source. Null never matches.
    identity: Schema.NullOr(Schema.String),
  }),
);
const SyncCloneDestinationSchema = Schema.Literals([
  "free",
  "taken",
  "same-repo",
]);
export type SyncCloneDestination = typeof SyncCloneDestinationSchema.Type;

export const SyncPullWorktreePayloadSchema = strict(
  Schema.Struct({
    sourceDeviceId: DeviceIdSchema,
    sourceProjectId: Schema.NonEmptyString,
    sourceWorktreeId: WorktreeIdSchema,
    sourceIdentity: Schema.NonEmptyString,
    branch: GitRefNameSchema.check(
      Schema.makeFilter(
        (name: string) =>
          isSyncBundleRef(`refs/heads/${name}`) ||
          "Branch name outside the sync allowlist",
      ),
    ),
    // The source's folder name, so the two sides read as one worktree.
    // Omitted when it isn't a valid managed dirname (a fresh name is
    // picked). The handler refuses, rather than renames, on a clash.
    worktreeName: Schema.optional(
      Schema.NonEmptyString.check(
        Schema.makeFilter(
          (name: string) =>
            isValidWorktreeDirName(name) || "Not a valid folder name",
        ),
      ),
    ),
    // Absent = yes.
    runSetup: Schema.optional(Schema.Boolean),
    // The only way an ignored file travels: a one-shot mirror run (the
    // "files" step). Absent when a mirror's own session will bring them.
    ignoreMode: Schema.optional(MirrorIgnoreModeSchema),
    ignores: Schema.optional(MirrorIgnoresSchema),
    // Where to clone the repo, over the link (so a repo with no remote
    // crosses too), when this device has no checkout of it. Ignored when
    // a local project already matches.
    cloneInto: Schema.optional(SyncCloneIntoSchema),
  }),
);

// Keyed by the source worktree id, the only id the caller holds before
// the copy exists.
export const SyncPullStepSchema = Schema.Literals([
  "clone",
  "capture",
  "transfer",
  "create",
  "apply",
  "files",
]);
export type SyncPullStep = typeof SyncPullStepSchema.Type;

export const SyncPullProgressSchema = strict(
  Schema.Struct({
    sourceWorktreeId: WorktreeIdSchema,
    step: SyncPullStepSchema,
    bytes: Schema.optional(Schema.Natural),
    totalBytes: Schema.optional(Schema.Natural),
    createPhase: Schema.optional(CreatePhaseSchema),
    // The copy's own id, on the create's frames once it exists.
    worktreeId: Schema.optional(WorktreeIdSchema),
  }),
);
export type SyncPullProgress = typeof SyncPullProgressSchema.Type;

export const SyncPullWorktreeResultSchema = strict(
  Schema.Struct({
    worktree: WorktreeSchema,
    // captured && !dirtyApplied: the worktree landed but the apply was
    // refused. The capture stays parked here, and the source keeps its
    // dirty state.
    captured: Schema.Boolean,
    dirtyApplied: Schema.Boolean,
    files: Schema.optional(FilesBroughtSchema),
    cloned: Schema.optional(ProjectSchema),
  }),
);
export type SyncPullWorktreeResult = typeof SyncPullWorktreeResultSchema.Type;

// The branch, folder name and identity are read off the worktree, never
// taken from the caller. `cloneInto` is in the peer's own terms.
const pullFields = SyncPullWorktreePayloadSchema.struct.fields;
export const SyncSendWorktreePayloadSchema = strict(
  Schema.Struct({
    targetDeviceId: DeviceIdSchema,
    projectId: Schema.NonEmptyString,
    worktreeId: WorktreeIdSchema,
    runSetup: pullFields.runSetup,
    ignoreMode: pullFields.ignoreMode,
    ignores: pullFields.ignores,
    cloneInto: pullFields.cloneInto,
  }),
);

const ChannelIdSchema = HexId32Schema;

const SyncOpenSourcePayloadSchema = strict(
  Schema.Struct({
    projectId: Schema.NonEmptyString,
    worktreeId: WorktreeIdSchema,
    channelId: ChannelIdSchema,
  }),
);

// Kept by the device that ran the move, so a teardown's data-loss rule
// runs on the hosts' own facts, never on a caller's say-so.
const SyncReceiptSchema = strict(
  Schema.Struct({
    branch: GitRefNameSchema,
    branchTip: CommitHashSchema,
    captured: Schema.Boolean,
    dirtyApplied: Schema.Boolean,
    captureTree: Schema.optional(CommitHashSchema),
  }),
);
export type SyncReceipt = typeof SyncReceiptSchema.Type;

// `landBranch` is the branch the copy is created on when it isn't the
// source's own (a primary's mirror lands on mirror/<branch>); the commits
// still arrive under `branch`.
const SyncReceiveWorktreePayloadSchema = strict(
  Schema.Struct({
    identity: Schema.NonEmptyString,
    branch: pullFields.branch,
    worktreeName: pullFields.worktreeName,
    landBranch: Schema.optional(GitRefNameSchema),
    sourceWorktreeId: WorktreeIdSchema,
    runSetup: pullFields.runSetup,
    ignoreMode: pullFields.ignoreMode,
    ignores: pullFields.ignores,
    cloneInto: pullFields.cloneInto,
    channelId: ChannelIdSchema,
  }),
);
const { files: _files, ...receiveResultFields } =
  SyncPullWorktreeResultSchema.struct.fields;
export const SyncReceiveWorktreeResultSchema = strict(
  Schema.Struct({
    ...receiveResultFields,
    receipt: SyncReceiptSchema,
  }),
);

const SyncReceiveBundlePayloadSchema = strict(
  Schema.Struct({
    projectId: Schema.NonEmptyString,
    refs: Schema.Array(SyncBundleRefSchema).check(
      Schema.isBetweenLength(1, 64),
    ),
    haves: Schema.Array(CommitHashSchema).check(Schema.isMaxLength(256)),
    channelId: ChannelIdSchema,
  }),
);
const SyncFetchedSchema = strict(
  Schema.Struct({
    fetched: Schema.Array(
      strict(Schema.Struct({ ref: Schema.String, commit: CommitHashSchema })),
    ),
  }),
);

// A refused teardown never fails the call: the move already succeeded.
const SyncTeardownSourceResultSchema = strict(
  Schema.Struct({
    sourceRemoved: Schema.Boolean,
    sourceError: Schema.optional(Schema.String),
  }),
);
export type SyncTeardownSourceResult =
  typeof SyncTeardownSourceResultSchema.Type;

// worktreeId is the source's. What the move captured is not on the wire:
// the host reads its own receipt.
const SyncMoveDirectionSchema = Schema.Literals(["pull", "send"]);
const SyncTeardownSourcePayloadSchema = strict(
  Schema.Struct({
    direction: SyncMoveDirectionSchema,
    deviceId: DeviceIdSchema,
    projectId: Schema.NonEmptyString,
    worktreeId: WorktreeIdSchema,
  }),
);
export type SyncMoveRef = typeof SyncTeardownSourcePayloadSchema.Type;

// Keyed by the source worktree id. Remote, for a move the asking device
// doesn't run; a host only finds the asking device's own moves.
// `cancelled` false: nothing by that key in flight.
const SyncCancelMovePayloadSchema = strict(
  Schema.Struct({
    sourceWorktreeId: WorktreeIdSchema,
  }),
);
const SyncCancelMoveResultSchema = strict(
  Schema.Struct({
    cancelled: Schema.Boolean,
  }),
);

// Matched anywhere in a message: a peer's answer arrives re-worded.
export const MOVE_CANCELLED = "The move was cancelled";

export function isMoveCancelledError(error: unknown): boolean {
  return errorMessageOf(error).includes(MOVE_CANCELLED);
}

// So a sender can thin a bundle, and skip a ref whose tip the receiver
// has (`git bundle create` would drop it silently).
const SYNC_HAS_COMMITS_LIMIT = 64;
const SyncHasCommitsPayloadSchema = strict(
  Schema.Struct({
    projectId: Schema.NonEmptyString,
    commits: Schema.Array(CommitHashSchema).check(
      Schema.isBetweenLength(1, SYNC_HAS_COMMITS_LIMIT),
    ),
  }),
);

const SyncHasCommitsResultSchema = strict(
  Schema.Struct({
    present: Schema.Array(CommitHashSchema),
  }),
);

export const syncContract = defineContract(
  "sync",
  "host",
  // Discloses the names of ignored files.
  invoke(
    "worktreeFolder",
    SyncWorktreeFolderPayloadSchema,
    Schema.Array(SyncWorktreeFolderEntrySchema),
    { remote: true, gated: true, grant: "browseFiles" },
  ),
  invoke(
    "ignoredPaths",
    SyncIgnoredPathsPayloadSchema,
    SyncIgnoredPathsResultSchema,
    { remote: true, gated: true, grant: "browseFiles" },
  ),
  // Discloses whether a path is there, as fs:listDirectory does.
  invoke(
    "cloneDestination",
    SyncCloneDestinationPayloadSchema,
    SyncCloneDestinationSchema,
    { remote: true, gated: true, grant: "browseFiles" },
  ),
  invoke(
    "hasCommits",
    SyncHasCommitsPayloadSchema,
    SyncHasCommitsResultSchema,
    { remote: true, gated: true, grant: "browseFiles" },
  ),
  invoke("openSource", SyncOpenSourcePayloadSchema, VoidSchema, {
    remote: true,
    gated: true,
    grant: "browseFiles",
  }),
  // receiveBundle lands under refs/shigomori/, never a branch, so the
  // project is scope enough.
  invoke(
    "receiveWorktree",
    SyncReceiveWorktreePayloadSchema,
    SyncReceiveWorktreeResultSchema,
    {
      remote: true,
      gated: true,
      grant: "changeCode",
      busy: "land",
    },
  ),
  invoke("receiveBundle", SyncReceiveBundlePayloadSchema, SyncFetchedSchema, {
    remote: true,
    gated: true,
    grant: "changeCode",
  }),
  // gated keeps the web client's refusal of them.
  invoke(
    "pullWorktree",
    SyncPullWorktreePayloadSchema,
    SyncPullWorktreeResultSchema,
    { remote: false, gated: true },
  ),
  invoke(
    "sendWorktree",
    SyncSendWorktreePayloadSchema,
    SyncPullWorktreeResultSchema,
    { remote: false, gated: true },
  ),
  invoke(
    "cancelMove",
    SyncCancelMovePayloadSchema,
    SyncCancelMoveResultSchema,
    { remote: true, gated: true, grant: "changeCode" },
  ),
  // After a pull, its remote half is the peer's worktrees:delete.
  invoke(
    "teardownSource",
    SyncTeardownSourcePayloadSchema,
    SyncTeardownSourceResultSchema,
    { remote: false, gated: true },
  ),
  push("pullProgress", SyncPullProgressSchema),
);
