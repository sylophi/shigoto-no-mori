import { pluralize } from "../words.ts";
import * as Schema from "effect/Schema";
import { push, defineContract, invoke, view } from "../contract.ts";
import { broughtPaths } from "../mirrorIgnores.ts";
import { DeviceIdSchema } from "../hubProtocol.ts";
import {
  type MirrorIgnoreMode,
  MirrorIgnoreModeSchema,
  MirrorIgnoresSchema,
  SyncCloneIntoSchema,
  SyncLandingRefSchema,
  SyncPullWorktreePayloadSchema,
  SyncPullWorktreeResultSchema,
  SyncSendWorktreePayloadSchema,
} from "./sync.ts";
import {
  CommitHashSchema,
  GitRefNameSchema,
  VoidSchema,
  WorktreeIdSchema,
} from "../schemas/index.ts";
import { HexId32Schema } from "../schemas/hexId.ts";
import { strict } from "../schemas/strict.ts";
import { errorMessageOf } from "../errors.ts";

// A mirror always runs on the device holding the original. startTo sends
// the worktree through the ordinary move and opens the mirror on top, so
// git agrees on both sides from the first second. Asked for from the
// copy's side, startFrom leaves an invitation behind so the peer's send,
// stream and git half land here whatever this device's switch says.

// Mutagen's ids, pinned loosely.
const MirrorSessionIdSchema = Schema.String.check(
  Schema.isBetweenLength(1, 128),
);

export { type MirrorIgnoreMode, MirrorIgnoreModeSchema };
export {
  anchorIgnoredPath,
  BRING_PATHS_LIMIT,
  bringIgnores,
  bringRulesRoom,
  broughtPaths,
  MIRROR_IGNORES_LIMIT,
  unanchorIgnoredPath,
} from "../mirrorIgnores.ts";

// "mirror", "mirror-branch" (a primary's mirror, its copy on
// mirror/<branch>) or "transfer-<token>" (a pull's one-shot, not a
// mirror). A label, not a field: peers parse the session strictly.
export const MIRROR_LABEL_MODE = "mode";
// The session an ignore change's re-open replaced: the follower carries
// its agreement across, and the host ends it on sight if it outlived the
// re-open.
export const MIRROR_LABEL_REPLACES = "replaces";
export function isHaltedStatus(status: string): boolean {
  return status.startsWith("halted-");
}

export function describeIgnores(mode: MirrorIgnoreMode, count: number): string {
  const paths = pluralize(count, "path");
  switch (mode) {
    case "everything":
      return "Nothing left out";
    case "gitignored":
      return "Gitignored left out";
    case "custom":
      return `${paths} left out`;
    case "bring":
      return `Gitignored left out, except ${paths}`;
  }
}

// A bring rule's patterns are mostly gitignore rules, so it counts the
// brought paths.
export function summarizeIgnores(
  mode: MirrorIgnoreMode,
  ignores: readonly string[],
): string {
  return describeIgnores(
    mode,
    mode === "bring" ? broughtPaths(ignores).length : ignores.length,
  );
}
// file-sync/engine.go mirrorStatusCode.
const MirrorStatusSchema = Schema.Literals([
  "disconnected",
  "halted-on-root-emptied",
  "halted-on-root-deletion",
  "halted-on-root-type-change",
  "connecting-local",
  "connecting-remote",
  "watching",
  "scanning",
  "waiting-for-rescan",
  "reconciling",
  "staging-local",
  "staging-remote",
  "transitioning",
  "saving",
  "unknown",
]);
export type MirrorStatus = typeof MirrorStatusSchema.Type;

const MirrorProblemSchema = strict(
  Schema.Struct({
    path: Schema.String,
    error: Schema.String,
  }),
);

const MirrorChangeSchema = strict(
  Schema.Struct({
    path: Schema.String,
    kind: Schema.Literals(["created", "deleted", "modified"]),
  }),
);

const MirrorConflictSchema = strict(
  Schema.Struct({
    root: Schema.String,
    localChanges: Schema.Array(MirrorChangeSchema),
    remoteChanges: Schema.Array(MirrorChangeSchema),
  }),
);

const MirrorStagingSchema = strict(
  Schema.Struct({
    path: Schema.String,
    receivedFiles: Schema.Natural,
    expectedFiles: Schema.Natural,
    receivedSize: Schema.Natural,
    expectedSize: Schema.Natural,
  }),
);

const MirrorEndpointStateSchema = strict(
  Schema.Struct({
    connected: Schema.Boolean,
    scanned: Schema.Boolean,
    directories: Schema.Natural,
    files: Schema.Natural,
    symbolicLinks: Schema.Natural,
    totalFileSize: Schema.Natural,
    problems: Schema.Array(MirrorProblemSchema),
    excludedProblems: Schema.Natural,
    staging: Schema.optional(MirrorStagingSchema),
  }),
);

const GitHeadSchema = Schema.Union([
  strict(
    Schema.Struct({ kind: Schema.Literal("branch"), branch: GitRefNameSchema }),
  ),
  strict(Schema.Struct({ kind: Schema.Literal("detached") })),
]);

const TreeHashSchema = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{40,64}$/),
);

export const GitStateCoreSchema = strict(
  Schema.Struct({
    head: GitHeadSchema,
    tip: CommitHashSchema,
    indexTree: TreeHashSchema,
  }),
);

const GitStateSchema = strict(
  Schema.Struct({
    ...GitStateCoreSchema.struct.fields,
    indexCommit: Schema.NullOr(CommitHashSchema),
  }),
);

export const MirrorWorktreePayloadSchema = strict(
  Schema.Struct({
    projectId: Schema.NonEmptyString,
    worktreeId: WorktreeIdSchema,
  }),
);
export type MirrorWorktreePayload = typeof MirrorWorktreePayloadSchema.Type;

const MirrorApplyGitStatePayloadSchema = strict(
  Schema.Struct({
    ...MirrorWorktreePayloadSchema.struct.fields,
    // The state the pushing side read there, in the receiving side's
    // own names: anything else moved under it, and the apply refuses.
    expect: GitStateCoreSchema,
    state: GitStateCoreSchema,
    sweep: Schema.optional(
      Schema.Array(SyncLandingRefSchema).check(Schema.isMaxLength(8)),
    ),
  }),
);
export type MirrorApplyGitStatePayload =
  typeof MirrorApplyGitStatePayloadSchema.Type;

// Why an apply left the worktree as it was. The follower words it,
// naming the devices from where its status shows. changed-locally: the
// worktree moved since the caller read it, and the caller reads again.
const GitApplyRefusalSchema = Schema.Union([
  strict(
    Schema.Struct({
      kind: Schema.Literal("operation-in-progress"),
      operation: Schema.String,
    }),
  ),
  strict(Schema.Struct({ kind: Schema.Literal("changed-locally") })),
  strict(Schema.Struct({ kind: Schema.Literal("missing-objects") })),
  strict(
    Schema.Struct({
      kind: Schema.Literal("branch-checked-out"),
      branch: Schema.String,
      path: Schema.String,
    }),
  ),
  strict(
    Schema.Struct({
      kind: Schema.Literal("branch-ahead"),
      branch: Schema.String,
    }),
  ),
]);
export type GitApplyRefusal = typeof GitApplyRefusalSchema.Type;

const MirrorApplyGitStateResultSchema = Schema.Union([
  strict(Schema.Struct({ applied: Schema.Literal(true) })),
  strict(
    Schema.Struct({
      applied: Schema.Literal(false),
      refusal: GitApplyRefusalSchema,
    }),
  ),
]);
export type MirrorApplyGitStateResult =
  typeof MirrorApplyGitStateResultSchema.Type;

// diverged: both sides changed since they last agreed, and neither is
// touched. blocked: the other side's state can't land here (detail says
// why).
const MirrorGitStatusSchema = strict(
  Schema.Struct({
    status: Schema.Literals([
      "synced",
      "following",
      "diverged",
      "blocked",
      "error",
      "off",
    ]),
    detail: Schema.String,
  }),
);
export type MirrorGitStatus = typeof MirrorGitStatusSchema.Type;

// The local side (Mutagen's alpha) holds the original; the copy is on
// deviceId's projectId/worktreeId.
export const MirrorSessionSchema = strict(
  Schema.Struct({
    session: MirrorSessionIdSchema,
    name: Schema.String,
    labels: Schema.Record(Schema.String, Schema.String),
    localRoot: Schema.String,
    localProjectId: Schema.String,
    localWorktreeId: Schema.String,
    deviceId: Schema.String,
    projectId: Schema.String,
    worktreeId: Schema.String,
    remoteRoot: Schema.String,
    paused: Schema.Boolean,
    // Without the .git pointer, never the user's choice.
    ignores: Schema.Array(Schema.String),
    ignoreMode: MirrorIgnoreModeSchema,
    createdAt: Schema.Natural,
    status: MirrorStatusSchema,
    statusText: Schema.String,
    lastError: Schema.optional(Schema.String),
    successfulCycles: Schema.Natural,
    conflicts: Schema.Array(MirrorConflictSchema),
    excludedConflicts: Schema.Natural,
    local: MirrorEndpointStateSchema,
    remote: MirrorEndpointStateSchema,
    git: Schema.optional(MirrorGitStatusSchema),
    // The list keeps a stopping session until the copy is gone, so the
    // pair reads as one worktree throughout.
    stopping: Schema.optional(Schema.Boolean),
  }),
);
export type MirrorSession = typeof MirrorSessionSchema.Type;

// As the daemon's state line carries it. An unknown top-level key is
// stripped rather than refused, so a newer engine's field can't freeze
// the stream; the nested shapes stay strict.
const {
  localProjectId: _localProjectId,
  localWorktreeId: _localWorktreeId,
  ignoreMode: _ignoreMode,
  git: _git,
  stopping: _stopping,
  ...rawSessionFields
} = MirrorSessionSchema.struct.fields;
export const MirrorSessionRawSchema = Schema.Struct(rawSessionFields);
export type MirrorSessionRaw = typeof MirrorSessionRawSchema.Type;

// A stream this device serves to a peer mirroring from here.
const MirrorServingSchema = strict(
  Schema.Struct({
    channelId: HexId32Schema,
    projectId: Schema.String,
    worktreeId: WorktreeIdSchema,
    // "" on a wire that stamps no caller.
    peerDeviceId: Schema.String,
    // The peer's copy, so the sidebar can fold its row into this one.
    peerWorktreeId: Schema.optional(WorktreeIdSchema),
    since: Schema.Natural,
  }),
);
export type MirrorServing = typeof MirrorServingSchema.Type;

const MirrorDaemonStatusSchema = Schema.Literals([
  "stopped",
  "starting",
  "running",
  "unavailable",
  "failing",
]);
export type MirrorDaemonStatus = typeof MirrorDaemonStatusSchema.Type;

export function mirrorEngineBlocker(
  status: MirrorDaemonStatus,
  where = "this device",
  failure?: string,
): string | undefined {
  switch (status) {
    case "running":
      return undefined;
    case "failing":
      return `The mirror engine on ${where} ${failure ?? "stopped"}. It restarts on its own.`;
    case "unavailable":
      return `Mirroring is unavailable on ${where}: the file-sync engine is missing.`;
    case "starting":
      return `The mirror engine on ${where} is still starting. Try again in a moment.`;
    case "stopped":
      return `The mirror engine on ${where} isn't running.`;
  }
}

const MirrorListResultSchema = strict(
  Schema.Struct({
    daemon: MirrorDaemonStatusSchema,
    daemonFailure: Schema.optional(Schema.String),
    sessions: Schema.Array(MirrorSessionSchema),
    serving: Schema.Array(MirrorServingSchema),
  }),
);
export type MirrorListResult = typeof MirrorListResultSchema.Type;

// `cloneInto` is in the peer's terms.
const MirrorStartToPayloadSchema = strict(
  Schema.Struct({
    ...SyncSendWorktreePayloadSchema.struct.fields,
    ignoreMode: MirrorIgnoreModeSchema,
    ignores: MirrorIgnoresSchema,
  }),
);
export type MirrorStartToPayload = typeof MirrorStartToPayloadSchema.Type;

// The source named as a pull names it; the identity and clone place are
// what the invitation holds the landing to.
const pullFields = SyncPullWorktreePayloadSchema.struct.fields;
const MirrorStartFromPayloadSchema = strict(
  Schema.Struct({
    sourceDeviceId: pullFields.sourceDeviceId,
    sourceProjectId: pullFields.sourceProjectId,
    sourceWorktreeId: pullFields.sourceWorktreeId,
    sourceIdentity: pullFields.sourceIdentity,
    runSetup: pullFields.runSetup,
    cloneInto: pullFields.cloneInto,
    ignoreMode: MirrorIgnoreModeSchema,
    ignores: MirrorIgnoresSchema,
  }),
);
export type MirrorStartFromPayload = typeof MirrorStartFromPayloadSchema.Type;

export const MirrorStartToResultSchema = strict(
  Schema.Struct({
    ...SyncPullWorktreeResultSchema.struct.fields,
    session: MirrorSessionIdSchema,
  }),
);

const MirrorSessionPayloadSchema = strict(
  Schema.Struct({
    session: MirrorSessionIdSchema,
  }),
);

// Stopping removes the copy, so it is refused unless the copy holds
// nothing the original lacks (mirrorStopBlocker). `force` overrides,
// after the user is told.
const MirrorStopPayloadSchema = strict(
  Schema.Struct({
    ...MirrorSessionPayloadSchema.struct.fields,
    force: Schema.optional(Schema.Boolean),
  }),
);

// Anything short of this may leave an edit on the copy that never
// reached the original.
export function mirrorFilesSettled(
  session: Pick<
    MirrorSession,
    | "paused"
    | "status"
    | "successfulCycles"
    | "conflicts"
    | "excludedConflicts"
    | "local"
    | "remote"
  >,
): boolean {
  return (
    !session.paused &&
    session.status === "watching" &&
    session.successfulCycles > 0 &&
    session.local.connected &&
    session.remote.connected &&
    session.local.staging === undefined &&
    session.remote.staging === undefined &&
    session.conflicts.length === 0 &&
    session.excludedConflicts === 0
  );
}

// Words that finish "Not confirmed in step: …".
export function mirrorStopBlocker(
  session: Parameters<typeof mirrorFilesSettled>[0] & {
    git?: MirrorGitStatus;
  },
): string | undefined {
  if (session.paused) return "the mirror is paused";
  if (isHaltedStatus(session.status)) return "the mirror is halted";
  if (!session.local.connected || !session.remote.connected) {
    return "the other device isn't connected";
  }
  const conflicts = session.conflicts.length + session.excludedConflicts;
  if (conflicts > 0) {
    return conflicts === 1
      ? "a file changed on both sides"
      : `${conflicts} files changed on both sides`;
  }
  if (!mirrorFilesSettled(session)) return "files are still syncing";
  switch (session.git?.status) {
    case "synced":
      return undefined;
    case "diverged":
      return "both sides have new commits";
    case "blocked":
    case "error":
      return "git can't follow right now";
    case "following":
      return "git changes are still crossing";
    case "off":
    case undefined:
      return "git hasn't been checked yet";
  }
}

// removedCopy false: the original was gone, so the copy stays as the
// only one there is.
const MirrorStopResultSchema = Schema.UndefinedOr(
  strict(Schema.Struct({ removedCopy: Schema.Boolean })),
);

const MIRROR_STOP_UNCONFIRMED =
  "The copy is not confirmed in step with the other device";

export function isMirrorStopUnconfirmed(error: unknown): boolean {
  const message = errorMessageOf(error);
  return message.includes(MIRROR_STOP_UNCONFIRMED);
}

const STOP_REFUSAL_TAIL =
  ", so the copy may hold work that exists nowhere else. Let the mirror catch up first, or remove the copy anyway.";

export function mirrorStopRefusal(blocker: string): string {
  return `${MIRROR_STOP_UNCONFIRMED}: ${blocker}${STOP_REFUSAL_TAIL}`;
}

export function mirrorStopRefusalReason(error: unknown): string | undefined {
  const message = errorMessageOf(error);
  const start = message.indexOf(`${MIRROR_STOP_UNCONFIRMED}: `);
  const end = message.indexOf(STOP_REFUSAL_TAIL);
  if (start === -1 || end === -1) return undefined;
  return message.slice(start + MIRROR_STOP_UNCONFIRMED.length + 2, end);
}

// The session stopped and only the copy's removal failed, told apart
// so a caller doesn't report a failure to stop.
export const MIRROR_COPY_STAYED = "The mirror stopped, but the copy";

export function isMirrorCopyStayed(error: unknown): boolean {
  const message = errorMessageOf(error);
  return message.includes(MIRROR_COPY_STAYED);
}

// The caller has attached its end of the channel; the host attaches a
// fresh `file-sync serve` as the far end before answering.
const MirrorOpenStreamPayloadSchema = strict(
  Schema.Struct({
    ...MirrorWorktreePayloadSchema.struct.fields,
    channelId: HexId32Schema,
    peerWorktreeId: Schema.optional(WorktreeIdSchema),
  }),
);
export type MirrorOpenStreamPayload = typeof MirrorOpenStreamPayloadSchema.Type;

// The engine can't reconfigure a live session, so this re-opens it and
// answers the new id.
const MirrorSetIgnoresPayloadSchema = strict(
  Schema.Struct({
    ...MirrorSessionPayloadSchema.struct.fields,
    ignoreMode: MirrorIgnoreModeSchema,
    ignores: MirrorIgnoresSchema,
  }),
);

// Keyed by the local worktree, so a re-opened session keeps the thread.
const MirrorEventKindSchema = Schema.Literals([
  "started",
  "stopped",
  "paused",
  "resumed",
  "ignores-changed",
  "connected",
  "disconnected",
  "halted",
  "error",
  "recovered",
  "conflict",
  "git-diverged",
  "git-blocked",
  "git-error",
  "git-synced",
]);
export type MirrorEventKind = typeof MirrorEventKindSchema.Type;
export const MirrorEventSchema = strict(
  Schema.Struct({
    at: Schema.Natural,
    kind: MirrorEventKindSchema,
    detail: Schema.String,
  }),
);
export type MirrorEvent = typeof MirrorEventSchema.Type;
export const MIRROR_HISTORY_LIMIT = 100;

// What the landing must match for the link to admit the peer's calls.
const MirrorInviteAskSchema = strict(
  Schema.Struct({
    peerDeviceId: DeviceIdSchema,
    sourceWorktreeId: WorktreeIdSchema,
    identity: Schema.NonEmptyString,
    cloneInto: Schema.optional(SyncCloneIntoSchema),
  }),
);
export type MirrorInviteAsk = typeof MirrorInviteAskSchema.Type;

export const MirrorInviteSchema = strict(
  Schema.Struct({
    ...MirrorInviteAskSchema.struct.fields,
    copy: Schema.optional(MirrorWorktreePayloadSchema),
  }),
);
export type MirrorInvite = typeof MirrorInviteSchema.Type;
const MirrorHistoryPayloadSchema = strict(
  Schema.Struct({
    localWorktreeId: WorktreeIdSchema,
  }),
);
const MirrorHistoryResultSchema = strict(
  Schema.Struct({
    events: Schema.Array(MirrorEventSchema).check(
      Schema.isMaxLength(MIRROR_HISTORY_LIMIT),
    ),
  }),
);

export const mirrorContract = defineContract(
  "mirror",
  "host",
  invoke("list", VoidSchema, MirrorListResultSchema, {
    remote: true,
    gated: false,
  }),
  view("watch", VoidSchema, MirrorListResultSchema, {
    remote: true,
    gated: false,
  }),
  invoke("startTo", MirrorStartToPayloadSchema, MirrorStartToResultSchema, {
    remote: true,
    gated: true,
    grant: "changeCode",
  }),
  invoke("startFrom", MirrorStartFromPayloadSchema, MirrorStartToResultSchema, {
    remote: false,
    gated: true,
  }),
  // The controls are remote: the far end drives the session through the
  // device running it.
  invoke("stop", MirrorStopPayloadSchema, MirrorStopResultSchema, {
    remote: true,
    gated: true,
    grant: "changeCode",
  }),
  // Drops the invitation for a copy no longer mirrored. Invitable: the
  // invited runner is exactly who says so.
  invoke("release", MirrorWorktreePayloadSchema, VoidSchema, {
    remote: true,
    gated: true,
    grant: "changeCode",
    invitable: "copy",
  }),
  invoke("pause", MirrorSessionPayloadSchema, VoidSchema, {
    remote: true,
    gated: true,
    grant: "changeCode",
  }),
  invoke("resume", MirrorSessionPayloadSchema, VoidSchema, {
    remote: true,
    gated: true,
    grant: "changeCode",
  }),
  invoke(
    "setIgnores",
    MirrorSetIgnoresPayloadSchema,
    strict(Schema.Struct({ session: MirrorSessionIdSchema })),
    { remote: true, gated: true, grant: "changeCode" },
  ),
  invoke("history", MirrorHistoryPayloadSchema, MirrorHistoryResultSchema, {
    remote: true,
    gated: false,
  }),
  invoke("openStream", MirrorOpenStreamPayloadSchema, VoidSchema, {
    remote: true,
    gated: true,
    grant: "browseFiles",
    invitable: "copy",
  }),
  // Gated: reading mints the index carrier ref.
  invoke("gitState", MirrorWorktreePayloadSchema, GitStateSchema, {
    remote: true,
    gated: true,
    grant: "browseFiles",
    invitable: "copy",
  }),
  invoke(
    "applyGitState",
    MirrorApplyGitStatePayloadSchema,
    MirrorApplyGitStateResultSchema,
    { remote: true, gated: true, grant: "changeCode", invitable: "copy" },
  ),
  // Carries the list, since a busy mirror fires several times a second;
  // bare when the host has none to send, and a reader re-asks.
  push("changed", Schema.UndefinedOr(MirrorListResultSchema), {
    remote: true,
  }),
  // A served worktree's index was rewritten, the one git fact the git
  // watcher ignores on purpose.
  push("gitChanged", MirrorWorktreePayloadSchema, {
    remote: true,
  }),
);
