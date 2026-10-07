import { z } from "zod";
import { broadcast, defineContract, invoke } from "@shared/ipc/contract";
import { HexId32Schema } from "@shared/ipc/hexId";
import { broughtPaths } from "@shared/mirrorIgnores";
import {
  type MirrorIgnoreMode,
  MirrorIgnoreModeSchema,
  MirrorIgnoresSchema,
  SyncLandingRefSchema,
  SyncPullWorktreePayloadSchema,
  SyncPullWorktreeResultSchema,
  SyncSendWorktreePayloadSchema,
} from "@shared/ipc/modules/sync";
import {
  CommitHashZod,
  GitRefNameZod,
  WorktreeIdZod,
} from "@shared/schemas/zodBridge";

// Continuous worktree mirroring (PRODUCT.md, "Three ways to reach
// remote work"): a worktree kept identical on two devices, every file,
// both directions, live. The engine is the file-sync engine (file-sync/engine.go, on
// Mutagen). The app supervises this device's daemon
// (main/core/mirror/daemon.ts), bridges its streams to peers as byte
// channels on the direct socket (openStream below, the channel layer in
// shared/ipc/socket/channels.ts), and serves `file-sync serve` for
// peers mirroring FROM here.
//
// Host-scoped: a device's mirrors are facts about that device, and a
// remote viewer sees them (list is a read). A mirror always runs on
// the device holding the original. Its one start, startTo, sends one
// of this device's worktrees to a peer (branch, commits, uncommitted
// changes, through the ordinary move) and opens the mirror on top, so
// the first cycle has little to move and git agrees on both sides
// from the first second. A mirror asked for from the copy's side (a
// peer's page, "mirror it here") is the same start, invoked on the
// device holding the original with this device as the target: the
// local orchestrator startFrom asks it, and leaves an invitation
// behind (host/mirror/invites.ts) so the peer's send, stream and git
// half land here whatever this device's command-access switch says. The
// start and the controls (stop, pause, resume, setIgnores) act on a
// session this device runs, and are offered to peers too: a mirror
// pairs two devices, and either side's page controls it, the far end
// through the device that runs the session. They ride that device's
// command grant like every other mutation.

// Mutagen mints session identifiers ("sync_" plus a base62 body). The
// daemon echoes them verbatim, so the shape is pinned only loosely.
const MirrorSessionIdSchema = z.string().min(1).max(128);

// The leave-out rule and its patterns are defined with the pull
// (shared/ipc/modules/sync.ts), which carries them too. Re-exported so
// the mirror surfaces keep one import path.
export {
  type MirrorIgnoreMode,
  MirrorIgnoreModeSchema,
} from "@shared/ipc/modules/sync";
export {
  anchorIgnoredPath,
  BRING_PATHS_LIMIT,
  bringIgnores,
  bringRulesRoom,
  broughtPaths,
  MIRROR_IGNORES_LIMIT,
  unanchorIgnoredPath,
} from "@shared/mirrorIgnores";

// A session the pull opens to carry a transplant's ignored files
// across once and then ends (host/mirror/oneShot.ts), marked by a
// label so nothing treats it as a mirror: the git follower leaves it
// alone and the sidebar does not fold the pair over it. The label's
// value is the transfer's own token (host/mirror/registry.ts
// beginTransfer), so the mark alone says it is a transfer.
export const MIRROR_LABEL_TRANSFER = "transfer";

// Which side holds the copy: always the peer, since a session runs on
// the device holding the original (its local side) and the copy is
// its remote side. Every start writes it as "remote". Its one reader
// is the legacy sweep (host/mirror/registry.ts isLegacyMirror): an
// older build also started mirrors from the copy's device, and those
// sessions carry no such label. A label and not a session field: the
// session document crosses to peers that parse it strictly.
export const MIRROR_LABEL_COPY_SIDE = "copySide";
// A primary checkout's mirror: the copy sits on mirror/<branch> for
// whatever branch the original is on (shared/git/branches.ts
// mirrorBranchFor), since the copy's device holds the original's
// branch in its own primary. The git follower reads the two names as
// one branch. The label says so.
export const MIRROR_LABEL_MIRROR_BRANCH = "mirrorBranch";
// The session a re-open (an ignore change) replaced, on the session
// that replaced it: the git follower carries the old one's agreement
// across, and the host ends the old one on sight should it outlive the
// re-open (a quit or a failed terminate between the two). Mutagen's
// ids fit the label alphabet.
export const MIRROR_LABEL_REPLACES = "replaces";
export function mirrorOnMirrorBranch(session: {
  labels: Record<string, string>;
}): boolean {
  return session.labels[MIRROR_LABEL_MIRROR_BRANCH] === "1";
}

export function isTransferSession(session: {
  labels: Record<string, string>;
}): boolean {
  return session.labels[MIRROR_LABEL_TRANSFER] !== undefined;
}

// The engine's terminal states share a prefix (MirrorStatusSchema
// below): a root emptied, deleted or changed type under the session.
export function isHaltedStatus(status: string): boolean {
  return status.startsWith("halted-");
}

// The rule in one phrase, the same on every surface that names it:
// the session's history line, the live card's chip, the fake host's posed
// thread. `count` is the paths the rule names, which a rule still
// being picked knows outright. A session's patterns go through
// summarizeIgnores, which counts them.
export function describeIgnores(mode: MirrorIgnoreMode, count: number): string {
  const paths = `${count} ${count === 1 ? "path" : "paths"}`;
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

// The same phrase off a session's patterns. A bring rule's patterns
// are mostly gitignore rules, so its count is the brought paths.
export function summarizeIgnores(
  mode: MirrorIgnoreMode,
  ignores: readonly string[],
): string {
  return describeIgnores(
    mode,
    mode === "bring" ? broughtPaths(ignores).length : ignores.length,
  );
}
// The daemon's stable status codes (file-sync/engine.go mirrorStatusCode).
const MirrorStatusSchema = z.enum([
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
export type MirrorStatus = z.infer<typeof MirrorStatusSchema>;

const MirrorProblemSchema = z.strictObject({
  path: z.string(),
  error: z.string(),
});

const MirrorChangeSchema = z.strictObject({
  path: z.string(),
  kind: z.enum(["created", "deleted", "modified"]),
});

const MirrorConflictSchema = z.strictObject({
  root: z.string(),
  localChanges: z.array(MirrorChangeSchema),
  remoteChanges: z.array(MirrorChangeSchema),
});

const MirrorStagingSchema = z.strictObject({
  path: z.string(),
  receivedFiles: z.number().int().nonnegative(),
  expectedFiles: z.number().int().nonnegative(),
  receivedSize: z.number().int().nonnegative(),
  expectedSize: z.number().int().nonnegative(),
});

const MirrorEndpointStateSchema = z.strictObject({
  connected: z.boolean(),
  scanned: z.boolean(),
  directories: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  symbolicLinks: z.number().int().nonnegative(),
  totalFileSize: z.number().int().nonnegative(),
  problems: z.array(MirrorProblemSchema),
  excludedProblems: z.number().int().nonnegative(),
  staging: MirrorStagingSchema.optional(),
});

// The git half of a mirror (host/mirror/gitState.ts): HEAD, the tip and
// the staged tree, as one document either side can produce and apply.
const GitHeadSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("branch"), branch: GitRefNameZod }),
  z.strictObject({ kind: z.literal("detached") }),
]);

const TreeHashSchema = z.string().regex(/^[0-9a-f]{40,64}$/);

export const GitStateCoreSchema = z.strictObject({
  head: GitHeadSchema,
  tip: CommitHashZod,
  indexTree: TreeHashSchema,
});

export const GitStateSchema = GitStateCoreSchema.extend({
  // The carrier commit for a staged index (refs/shigomori/index/<id>
  // on the reporting device), or null when nothing is staged.
  indexCommit: CommitHashZod.nullable(),
});

export const MirrorWorktreePayloadSchema = z.strictObject({
  projectId: z.string().min(1),
  worktreeId: WorktreeIdZod,
});

const MirrorApplyGitStatePayloadSchema = MirrorWorktreePayloadSchema.extend({
  expect: z.strictObject({
    tip: CommitHashZod,
    indexTree: TreeHashSchema,
  }),
  state: GitStateCoreSchema,
  // Landing refs the applier may sweep afterwards: the app's
  // namespace only.
  sweep: z.array(SyncLandingRefSchema).max(8).optional(),
});

export const MirrorApplyGitStateResultSchema = z.strictObject({
  applied: z.boolean(),
  reason: z.string().optional(),
});

// The git follower's verdict on one session (host/mirror/gitFollow.ts),
// attached to the session by the host. synced: both sides agree.
// following: a change is being carried across. diverged: both sides
// changed since they last agreed, and neither is touched. blocked: the
// other side's state cannot land here (a branch collision, an unborn
// worktree), with the reason. error: the last attempt failed. off: not
// followed (paused, or the daemon has not reported the session yet).
const MirrorGitStatusSchema = z.strictObject({
  status: z.enum([
    "synced",
    "following",
    "diverged",
    "blocked",
    "error",
    "off",
  ]),
  detail: z.string(),
});
export type MirrorGitStatus = z.infer<typeof MirrorGitStatusSchema>;

// One session this device runs, as the daemon reports it. The local
// side is always this device (alpha in Mutagen's terms) and holds the
// original. The remote side is the copy, on the peer named by
// deviceId, at remoteRoot, which is its worktree projectId/worktreeId. localProjectId/localWorktreeId
// are lifted out of the labels the start orchestration wrote.
export const MirrorSessionSchema = z.strictObject({
  session: MirrorSessionIdSchema,
  name: z.string(),
  labels: z.record(z.string(), z.string()),
  localRoot: z.string(),
  localProjectId: z.string(),
  localWorktreeId: z.string(),
  deviceId: z.string(),
  projectId: z.string(),
  worktreeId: z.string(),
  remoteRoot: z.string(),
  paused: z.boolean(),
  // The engine's ignore list for this session (the .git pointer left
  // out: it is never the user's choice) and the rule it came from.
  ignores: z.array(z.string()),
  ignoreMode: MirrorIgnoreModeSchema,
  // When the session was created, epoch milliseconds, so the page can
  // say how long the mirror has been running.
  createdAt: z.number().int().nonnegative(),
  status: MirrorStatusSchema,
  statusText: z.string(),
  lastError: z.string().optional(),
  successfulCycles: z.number().int().nonnegative(),
  conflicts: z.array(MirrorConflictSchema),
  excludedConflicts: z.number().int().nonnegative(),
  local: MirrorEndpointStateSchema,
  remote: MirrorEndpointStateSchema,
  // Attached by the host from the git follower. Absent when the host
  // has no follower for it yet.
  git: MirrorGitStatusSchema.optional(),
  // Set while a stop is under way: the engine has ended the session
  // and the copy is being removed. The list keeps the session until
  // the copy is gone, so the pair reads as one worktree throughout.
  stopping: z.boolean().optional(),
});
export type MirrorSession = z.infer<typeof MirrorSessionSchema>;

// One session as the daemon's state line carries it (file-sync/
// engine.go mirrorSessionState), before the host lifts the label-borne
// ids out and attaches what it knows of its own. An unknown top-level
// key is stripped rather than refused, so a field a newer engine adds
// to the session cannot freeze the state stream. A missing or mistyped
// one still fails, and the nested shapes (endpoint, staging, conflict,
// problem, change) stay strict, shared with the contract above, so a
// field added inside them still fails the session.
export const MirrorSessionRawSchema = z.object(
  MirrorSessionSchema.omit({
    localProjectId: true,
    localWorktreeId: true,
    ignoreMode: true,
    git: true,
    stopping: true,
  }).shape,
);
export type MirrorSessionRaw = z.infer<typeof MirrorSessionRawSchema>;

// One stream this device SERVES: a peer is mirroring the named worktree
// from here, on the channel the peer minted with openStream. Known
// from the open until the channel is gone.
const MirrorServingSchema = z.strictObject({
  channelId: HexId32Schema,
  projectId: z.string(),
  worktreeId: WorktreeIdZod,
  // The calling device, or "" on a wire that stamps no caller.
  peerDeviceId: z.string(),
  // The peer's own worktree for this stream (its local copy), when the
  // peer named it: what lets this device's sidebar fold the peer's row
  // into the served worktree's. Absent on a peer that predates it.
  peerWorktreeId: WorktreeIdZod.optional(),
  since: z.number().int().nonnegative(),
});
export type MirrorServing = z.infer<typeof MirrorServingSchema>;

const MirrorDaemonStatusSchema = z.enum([
  "stopped",
  "starting",
  "running",
  "unavailable",
]);
export type MirrorDaemonStatus = z.infer<typeof MirrorDaemonStatusSchema>;

// Why a device's daemon can't take a mirror start, or undefined when
// it can: the host's refusal (requireRunningEngine) and the start
// buttons' disabled title, so the two say the same thing. `where`
// names the device, which is the one holding the original.
export function mirrorEngineBlocker(
  status: MirrorDaemonStatus,
  where = "this device",
): string | undefined {
  switch (status) {
    case "running":
      return undefined;
    case "unavailable":
      return `Mirroring is unavailable on ${where}: the file-sync engine is missing.`;
    case "starting":
      return `The mirror engine on ${where} is still starting. Try again in a moment.`;
    case "stopped":
      return `The mirror engine on ${where} isn't running.`;
  }
}

const MirrorListResultSchema = z.strictObject({
  daemon: MirrorDaemonStatusSchema,
  sessions: z.array(MirrorSessionSchema),
  serving: z.array(MirrorServingSchema),
});
export type MirrorListResult = z.infer<typeof MirrorListResultSchema>;

// The mirror start, built on the send: one of THIS device's
// worktrees, copied to a peer (cloning the repo there first when the
// peer has no checkout, `cloneInto` in the peer's terms) and kept in
// step with it. The session runs here, on the original's device: it
// reaches the peer through the peer's grant, which the send already
// needed. Invoked by the peer itself when the mirror is asked for from
// the copy's side, the target being the caller.
export const MirrorStartToPayloadSchema = SyncSendWorktreePayloadSchema.extend({
  ignoreMode: MirrorIgnoreModeSchema,
  ignores: MirrorIgnoresSchema,
});
export type MirrorStartToPayload = z.infer<typeof MirrorStartToPayloadSchema>;

// The mirror asked for from the copy's side: a peer's worktree, named
// the way a pull names its source, kept in step with a copy landed
// HERE. What the peer's startTo takes, in the pull's terms (the peer
// resolves its own branch and folder), plus the session's rule, plus
// the repo identity and the clone place the invitation holds the
// landing to. Local-only (remote:false), like the pull: this device
// invites the mirror, then asks the peer's startTo with itself as the
// target, and the peer's send and session reach the copy through that
// invitation (host/mirror/invites.ts), so this device's switch is not
// in the way.
const MirrorStartFromPayloadSchema = SyncPullWorktreePayloadSchema.pick({
  sourceDeviceId: true,
  sourceProjectId: true,
  sourceWorktreeId: true,
  sourceIdentity: true,
  runSetup: true,
  cloneInto: true,
}).extend({
  ignoreMode: MirrorIgnoreModeSchema,
  ignores: MirrorIgnoresSchema,
});
export type MirrorStartFromPayload = z.infer<
  typeof MirrorStartFromPayloadSchema
>;

// The send's result (the copy as the peer landed it) and the session.
export const MirrorStartToResultSchema = SyncPullWorktreeResultSchema.extend({
  session: MirrorSessionIdSchema,
});

const MirrorSessionPayloadSchema = z.strictObject({
  session: MirrorSessionIdSchema,
});

// Stopping removes the copy (on the peer), so it is refused unless
// the copy is known to hold nothing the original lacks: the git
// follower says "synced" (the other side holds the copy's commits and
// staging) and the files are settled (mirrorFilesSettled). A paused
// session, an unreachable peer, a conflict held still or one too young
// to have reconciled all fail that. `force` is the user overriding it
// after being told.
const MirrorStopPayloadSchema = MirrorSessionPayloadSchema.extend({
  force: z.boolean().optional(),
});

// The file half of the stop's safety (mirrorStopBlocker has both): the engine idle on a pair it has brought in step at
// least once, both sides connected and nothing held still. Anything
// else may leave an edit on the copy that never reached the original.
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

// Both halves: why a stop that removes the copy is not known to be
// safe, in words that finish "Not confirmed in step: …", or undefined
// when it is. The host's refusal and the dialog's warning say the same
// thing.
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

// What a stop did with the copy: removed it, or left it a worktree of
// its own because the original was gone (the copy is then the only one
// there is). A runner that predates the answer sends nothing, which
// reads as removed, all it ever did.
const MirrorStopResultSchema = z
  .strictObject({ removedCopy: z.boolean() })
  .optional();

// The refusal's leading text, which the renderer matches to offer
// discard-and-stop. Text rather than a code because Electron's IPC
// flattens an error to its message (see COMMAND_REFUSED_MESSAGE).
const MIRROR_STOP_UNCONFIRMED =
  "The copy is not confirmed in step with the other device";

export function isMirrorStopUnconfirmed(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(MIRROR_STOP_UNCONFIRMED);
}

// The refusal as the host words it, and its reason (mirrorStopBlocker's
// words) back out of it, one pair so the two cannot drift.
const STOP_REFUSAL_TAIL =
  ", so the copy may hold work that exists nowhere else. Let the mirror catch up first, or remove the copy anyway.";

export function mirrorStopRefusal(blocker: string): string {
  return `${MIRROR_STOP_UNCONFIRMED}: ${blocker}${STOP_REFUSAL_TAIL}`;
}

export function mirrorStopRefusalReason(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const start = message.indexOf(`${MIRROR_STOP_UNCONFIRMED}: `);
  const end = message.indexOf(STOP_REFUSAL_TAIL);
  if (start === -1 || end === -1) return undefined;
  return message.slice(start + MIRROR_STOP_UNCONFIRMED.length + 2, end);
}

// mirror:stop's other failure, thrown once the session is already
// gone: the mirror did stop and only the copy's removal failed. Text
// for the same reason, and told apart so a caller that reports the
// stop (the CLI's unmirror) does not report a failure to stop.
export const MIRROR_COPY_STAYED = "The mirror stopped, but the copy";

export function isMirrorCopyStayed(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(MIRROR_COPY_STAYED);
}

// The mirror stream's open: the caller has attached its end of a byte
// channel under this id on the calling connection (shared/ipc/socket/
// channels.ts), and the host attaches a fresh `file-sync serve` for
// the named worktree as the far end before answering.
const MirrorOpenStreamPayloadSchema = MirrorWorktreePayloadSchema.extend({
  channelId: HexId32Schema,
  // See MirrorServingSchema.peerWorktreeId.
  peerWorktreeId: WorktreeIdZod.optional(),
});

// Changing what a mirror leaves out: the engine cannot re-configure a
// live session, so the host ends it and opens a fresh one on the same
// pair. The new session id comes back.
const MirrorSetIgnoresPayloadSchema = MirrorSessionPayloadSchema.extend({
  ignoreMode: MirrorIgnoreModeSchema,
  ignores: MirrorIgnoresSchema,
});

// What happened to a mirror over time, kept by the device that runs
// it, keyed by its local worktree so a re-opened session (an ignore
// change) keeps the thread. Bounded per worktree (main/core/mirror/
// history.ts), so the list is a recent window, not an archive.
const MirrorEventKindSchema = z.enum([
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
export type MirrorEventKind = z.infer<typeof MirrorEventKindSchema>;
export const MirrorEventSchema = z.strictObject({
  at: z.number().int().nonnegative(),
  kind: MirrorEventKindSchema,
  detail: z.string(),
});
export type MirrorEvent = z.infer<typeof MirrorEventSchema>;
export const MIRROR_HISTORY_LIMIT = 100;
const MirrorHistoryPayloadSchema = z.strictObject({
  localWorktreeId: WorktreeIdZod,
});
const MirrorHistoryResultSchema = z.strictObject({
  events: z.array(MirrorEventSchema).max(MIRROR_HISTORY_LIMIT),
});

export const mirrorContract = defineContract("host", {
  list: invoke("mirror:list", z.void(), MirrorListResultSchema, {
    remote: true,
    gated: false,
  }),
  // Served to peers on the command grant: the copy's device asks the
  // original's to start the mirror into it (see the payload's note).
  startTo: invoke(
    "mirror:startTo",
    MirrorStartToPayloadSchema,
    MirrorStartToResultSchema,
    { remote: true, gated: true },
  ),
  // The ask from the copy's side, local-only like sync:pullWorktree:
  // invites the mirror, then runs the peer's startTo towards here and
  // relays its progress (sync:pullProgress, keyed by the peer's
  // worktree).
  startFrom: invoke(
    "mirror:startFrom",
    MirrorStartFromPayloadSchema,
    MirrorStartToResultSchema,
    { remote: false, gated: true },
  ),
  // The controls, served to peers on the command grant: the device at
  // the far end of a mirror drives the session from its own page
  // through the device running it (renderer/hooks/remote/useMirrors.ts
  // useWorktreeMirrorLinks). Stop moves a worktree (the copy goes),
  // and every one of them moves the list, so all keep the host-state
  // ping.
  stop: invoke("mirror:stop", MirrorStopPayloadSchema, MirrorStopResultSchema, {
    remote: true,
    gated: true,
  }),
  // A copy here is no longer mirrored (its runner ended the session and
  // kept it): the invitation this device left for that peer goes, so
  // the peer's calls on the worktree need the grant again. Invitable,
  // since an invited mirror's runner is exactly who says so.
  release: invoke("mirror:release", MirrorWorktreePayloadSchema, z.void(), {
    remote: true,
    gated: true,
    movesHostState: false,
    invitable: "copy",
  }),
  pause: invoke("mirror:pause", MirrorSessionPayloadSchema, z.void(), {
    remote: true,
    gated: true,
  }),
  resume: invoke("mirror:resume", MirrorSessionPayloadSchema, z.void(), {
    remote: true,
    gated: true,
  }),
  setIgnores: invoke(
    "mirror:setIgnores",
    MirrorSetIgnoresPayloadSchema,
    z.strictObject({ session: MirrorSessionIdSchema }),
    { remote: true, gated: true },
  ),
  // Host-scoped like list: a peer viewing this device's mirror reads
  // the same thread. Nothing here moves state.
  history: invoke(
    "mirror:history",
    MirrorHistoryPayloadSchema,
    MirrorHistoryResultSchema,
    { remote: true, gated: false },
  ),
  // Grant-gated like every byte-stream open. The stream changes nothing
  // a viewer caches (the serving set fans out on `changed` below).
  openStream: invoke(
    "mirror:openStream",
    MirrorOpenStreamPayloadSchema,
    z.void(),
    { remote: true, gated: true, movesHostState: false, invitable: "copy" },
  ),
  // The git half, served to the device mirroring FROM here: read a
  // worktree's git state (minting the index carrier ref, hence
  // gated) and apply one. Both ride the command grant, or the
  // invitation of a mirror asked for from here (invitable).
  gitState: invoke(
    "mirror:gitState",
    MirrorWorktreePayloadSchema,
    GitStateSchema,
    { remote: true, gated: true, movesHostState: false, invitable: "copy" },
  ),
  // Moves refs and the index here, which every viewer of this host
  // caches, so it keeps the host-state ping.
  applyGitState: invoke(
    "mirror:applyGitState",
    MirrorApplyGitStatePayloadSchema,
    MirrorApplyGitStateResultSchema,
    { remote: true, gated: true, invitable: "copy" },
  ),
  // Fired on every daemon snapshot and every serving-set change, so
  // the list query refreshes without polling, locally and on the
  // devices viewing this one. It carries the list it announces: a busy
  // mirror fires this several times a second, and a viewer on another
  // device would otherwise answer each one with a list round trip.
  // Optional because the host may have none to send (no daemon yet, or
  // a list that failed to build or to validate): it then announces the
  // change bare, and a reader re-asks.
  changed: broadcast("mirror:changed", MirrorListResultSchema.optional(), {
    remote: true,
  }),
  // A served worktree's index was rewritten (something staged or
  // unstaged there). Refs and HEAD already ping through
  // git:projectChanged. The index is the one git fact that watcher
  // ignores on purpose, so the mirror announces it itself for the
  // follower on the other device.
  gitChanged: broadcast("mirror:gitChanged", MirrorWorktreePayloadSchema, {
    remote: true,
  }),
});
