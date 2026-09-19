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
} from "@shared/ipc/modules/sync";
import {
  CommitHashSchema,
  GitRefNameSchema,
  WorktreeIdSchema,
} from "@shared/schemas";

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
// remote viewer sees them (list is a read). The mutations are local
// orchestrators like sync:pullWorktree: start pulls the peer's
// worktree here first (branch, commits, uncommitted changes, through
// the existing transfer) and then opens the mirror on top, so the
// first cycle has little to move and git agrees on both sides from the
// first second. Controlling another device's mirrors from afar is not
// offered yet, so stop/pause/resume are remote:false.

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
// the session's history line, the live card's chip, the lab's posed
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
  z.strictObject({ kind: z.literal("branch"), branch: GitRefNameSchema }),
  z.strictObject({ kind: z.literal("detached") }),
]);

const TreeHashSchema = z.string().regex(/^[0-9a-f]{40,64}$/);

export const GitStateCoreSchema = z.strictObject({
  head: GitHeadSchema,
  tip: CommitHashSchema,
  indexTree: TreeHashSchema,
});

export const GitStateSchema = GitStateCoreSchema.extend({
  // The carrier commit for a staged index (refs/shigomori/index/<id>
  // on the reporting device), or null when nothing is staged.
  indexCommit: CommitHashSchema.nullable(),
});

export const MirrorWorktreePayloadSchema = z.strictObject({
  projectId: z.string().min(1),
  worktreeId: WorktreeIdSchema,
});

const MirrorApplyGitStatePayloadSchema = MirrorWorktreePayloadSchema.extend({
  expect: z.strictObject({
    tip: CommitHashSchema,
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

// One session this device initiates, as the daemon reports it. The
// local side is always this device (alpha in Mutagen's terms). The
// remote side is the peer named by deviceId, at remoteRoot, which is
// its worktree projectId/worktreeId. localProjectId/localWorktreeId
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
});
export type MirrorSession = z.infer<typeof MirrorSessionSchema>;

// One stream this device SERVES: a peer is mirroring the named worktree
// from here, on the channel the peer minted with openStream. Known
// from the open until the channel is gone.
const MirrorServingSchema = z.strictObject({
  channelId: HexId32Schema,
  projectId: z.string(),
  worktreeId: WorktreeIdSchema,
  // The calling device, or "" on a wire that stamps no caller.
  peerDeviceId: z.string(),
  // The peer's own worktree for this stream (its local copy), when the
  // peer named it: what lets this device's sidebar fold the peer's row
  // into the served worktree's. Absent on a peer that predates it.
  peerWorktreeId: WorktreeIdSchema.optional(),
  since: z.number().int().nonnegative(),
});
export type MirrorServing = z.infer<typeof MirrorServingSchema>;

const MirrorDaemonStatusSchema = z.enum([
  "stopped",
  "starting",
  "running",
  "unavailable",
]);

const MirrorListResultSchema = z.strictObject({
  daemon: MirrorDaemonStatusSchema,
  sessions: z.array(MirrorSessionSchema),
  serving: z.array(MirrorServingSchema),
});
export type MirrorListResult = z.infer<typeof MirrorListResultSchema>;

// Same input as the pull it is built on: which peer, which of ITS
// project/worktree ids, the repo identity to land in, the branch.
export const MirrorStartPayloadSchema = SyncPullWorktreePayloadSchema.extend({
  ignoreMode: MirrorIgnoreModeSchema,
  ignores: MirrorIgnoresSchema,
});
export type MirrorStartPayload = z.infer<typeof MirrorStartPayloadSchema>;

const MirrorStartResultSchema = SyncPullWorktreeResultSchema.extend({
  session: MirrorSessionIdSchema,
});

const MirrorSessionPayloadSchema = z.strictObject({
  session: MirrorSessionIdSchema,
});

// Stopping removes the copy on this device, so it is refused unless
// the git follower says "synced", the one state where the peer is known
// to hold this copy's commits. A paused session, an unreachable peer or
// one too young to have reconciled all report something else. `force`
// is the user overriding that after being told.
const MirrorStopPayloadSchema = MirrorSessionPayloadSchema.extend({
  force: z.boolean().optional(),
});

// Shared by the host that enforces it and the dialog that warns.
export function mirrorStopIsSafe(
  status: MirrorGitStatus["status"] | undefined,
): boolean {
  return status === "synced";
}

// The refusal's leading text, which the renderer matches to offer
// discard-and-stop. Text rather than a code because Electron's IPC
// flattens an error to its message (see COMMAND_REFUSED_MESSAGE).
export const MIRROR_STOP_UNCONFIRMED =
  "This copy is not confirmed in step with the other device";

export function isMirrorStopUnconfirmed(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(MIRROR_STOP_UNCONFIRMED);
}

// The mirror stream's open: the caller has attached its end of a byte
// channel under this id on the calling connection (shared/ipc/socket/
// channels.ts), and the host attaches a fresh `file-sync serve` for
// the named worktree as the far end before answering.
const MirrorOpenStreamPayloadSchema = MirrorWorktreePayloadSchema.extend({
  channelId: HexId32Schema,
  // See MirrorServingSchema.peerWorktreeId.
  peerWorktreeId: WorktreeIdSchema.optional(),
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
export const MirrorEventKindSchema = z.enum([
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
  localWorktreeId: WorktreeIdSchema,
});
const MirrorHistoryResultSchema = z.strictObject({
  events: z.array(MirrorEventSchema).max(MIRROR_HISTORY_LIMIT),
});

export const mirrorContract = defineContract("host", {
  list: invoke("mirror:list", z.void(), MirrorListResultSchema, {
    remote: true,
    mutating: false,
  }),
  start: invoke(
    "mirror:start",
    MirrorStartPayloadSchema,
    MirrorStartResultSchema,
    {
      remote: false,
      mutating: true,
    },
  ),
  stop: invoke("mirror:stop", MirrorStopPayloadSchema, z.void(), {
    remote: false,
    mutating: true,
  }),
  pause: invoke("mirror:pause", MirrorSessionPayloadSchema, z.void(), {
    remote: false,
    mutating: true,
  }),
  resume: invoke("mirror:resume", MirrorSessionPayloadSchema, z.void(), {
    remote: false,
    mutating: true,
  }),
  setIgnores: invoke(
    "mirror:setIgnores",
    MirrorSetIgnoresPayloadSchema,
    z.strictObject({ session: MirrorSessionIdSchema }),
    { remote: false, mutating: true },
  ),
  // Host-scoped like list: a peer viewing this device's mirror reads
  // the same thread. Nothing here moves state.
  history: invoke(
    "mirror:history",
    MirrorHistoryPayloadSchema,
    MirrorHistoryResultSchema,
    { remote: true, mutating: false },
  ),
  // Grant-gated like every byte-stream open. The stream changes nothing
  // a viewer caches (the serving set fans out on `changed` below).
  openStream: invoke(
    "mirror:openStream",
    MirrorOpenStreamPayloadSchema,
    z.void(),
    { remote: true, mutating: true, movesHostState: false },
  ),
  // The git half, served to the device mirroring FROM here: read a
  // worktree's git state (minting the index carrier ref, hence
  // mutating) and apply one. Both ride the command grant.
  gitState: invoke(
    "mirror:gitState",
    MirrorWorktreePayloadSchema,
    GitStateSchema,
    { remote: true, mutating: true, movesHostState: false },
  ),
  // Moves refs and the index here, which every viewer of this host
  // caches, so it keeps the host-state ping.
  applyGitState: invoke(
    "mirror:applyGitState",
    MirrorApplyGitStatePayloadSchema,
    MirrorApplyGitStateResultSchema,
    { remote: true, mutating: true },
  ),
  // Fired on every daemon snapshot and every serving-set change, so
  // the list query refreshes without polling, locally and on the
  // devices viewing this one. Payload-free: the list read is cheap.
  changed: broadcast("mirror:changed", z.void(), { remote: true }),
  // A served worktree's index was rewritten (something staged or
  // unstaged there). Refs and HEAD already ping through
  // git:projectChanged. The index is the one git fact that watcher
  // ignores on purpose, so the mirror announces it itself for the
  // follower on the other device.
  gitChanged: broadcast("mirror:gitChanged", MirrorWorktreePayloadSchema, {
    remote: true,
  }),
});
