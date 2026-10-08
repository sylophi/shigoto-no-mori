// What this device serves a peer that mirrors one of its worktrees
// from here: the file stream (a fresh `file-sync serve` per channel)
// and the git half the peer's follower reads and applies
// (host/mirror/gitState.ts). The worktree must be one this host lists:
// a peer can only mirror what this device lists, and the grant is the
// wall, as everywhere on the byte-stream surface.
import { join } from "node:path";
import type {
  MirrorApplyGitStatePayload,
  MirrorOpenStreamPayload,
  MirrorServing,
  MirrorWorktreePayload,
} from "@shigomori/contracts/modules/mirror";
import type { HandlerContext } from "@shared/ipc/transport";
import * as FileSync from "@host/fileSync/FileSync";
import { dataDir } from "@host/lib/util/paths";
import {
  findProjectAndWorktreeOrThrow,
  findWorktreePathOrThrow,
} from "@host/lib/projects";
import { attachFarEnd, requireChannels } from "@host/socket/channelStreams";
import { applyGitState, readGitState, watchIndexFile } from "./gitState";
import { log } from "@shared/log";

// The mirror streams this host currently serves, keyed by the calling
// device and the channel id it minted (unique per connection, so the
// pair is what identifies a stream host-wide): what mirror:list
// reports as `serving`, so a worktree shows "mirrored to <device>" on
// the machine it lives on. Entries live exactly as long as their
// channel. Each carries the served worktree's index watcher: a stage
// or unstage there is the one git change the peer's follower cannot
// learn from the git-directory watcher.
type Served = { entry: MirrorServing; stopIndexWatch: (() => void) | null };
const serving = new Map<string, Served>();
let onServingChange: (() => void) | null = null;
let onServingGitChange:
  | ((change: { projectId: string; worktreeId: string }) => void)
  | null = null;
// A peer's follower landed its side's git state on a worktree here: a
// ref move by the app's own git, which the git-directory watcher skips
// as the app's own, so main announces it like an outside one.
let onGitApplied: ((projectId: string) => void) | null = null;

export function setMirrorGitAppliedListener(
  listener: ((projectId: string) => void) | null,
): void {
  onGitApplied = listener;
}

// main installs the two broadcast hooks at boot. Before that (and in
// checks that never mount them) changes are simply unannounced.
export function setMirrorServingListener(listener: (() => void) | null): void {
  onServingChange = listener;
}

export function setMirrorGitChangedListener(
  listener:
    | ((change: { projectId: string; worktreeId: string }) => void)
    | null,
): void {
  onServingGitChange = listener;
}

export function listMirrorServing(): MirrorServing[] {
  return [...serving.values()].map((served) => served.entry);
}

// The mirror list changed without a session doing so (a stop's copy
// removal finished).
export function announceServingChange(): void {
  onServingChange?.();
}

function servingKey(ctx: HandlerContext, channelId: string): string {
  return `${ctx.callerDeviceId ?? ""}:${channelId}`;
}

function forgetServing(key: string): void {
  const served = serving.get(key);
  if (served === undefined) return;
  served.stopIndexWatch?.();
  serving.delete(key);
  onServingChange?.();
}

// A mirror stream: the far end is a fresh `file-sync serve` for the
// named worktree, spoken to over its stdio. The child dies with the
// channel: a peer reset, an end from both sides or the socket dying all
// kill it, and a child that exits on its own ends the channel the
// ordinary way. The root path the peer's Mutagen side names travels
// inside the protocol, which this does not read.
export async function serveStream(
  { projectId, worktreeId, channelId, peerWorktreeId }: MirrorOpenStreamPayload,
  ctx: HandlerContext,
): Promise<void> {
  requireChannels(ctx, channelId);
  const worktreePath = await findWorktreePathOrThrow({
    projectId,
    worktreeId,
  });
  // Its own data directory under this host's: unset, the engine's
  // caches and staging land in ~/.mutagen, shared with any real
  // Mutagen install and with every other build and profile here.
  const child = await FileSync.serve({
    MUTAGEN_DATA_DIRECTORY: join(dataDir(), "file-sync", "serve"),
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim();
    if (text !== "") log.warn(`[mirror] serve ${worktreeId}: ${text}`);
  });
  const key = servingKey(ctx, channelId);
  const stopChild = () => {
    // At quit the scope has closed already.
    child.close().catch(() => {});
    child.stream.destroy();
  };
  try {
    attachFarEnd(ctx, channelId, child.stream, {
      onClosed: () => {
        stopChild();
        forgetServing(key);
      },
    });
  } catch (error) {
    // The connection died or the id was claimed during the lookup
    // above: the child is in its own process group, so the destroyed
    // stdio alone would not end it.
    stopChild();
    throw error;
  }
  const served: Served = {
    entry: {
      channelId,
      projectId,
      worktreeId,
      peerDeviceId: ctx.callerDeviceId ?? "",
      ...(peerWorktreeId === undefined ? {} : { peerWorktreeId }),
      since: Date.now(),
    },
    stopIndexWatch: null,
  };
  serving.set(key, served);
  void watchIndexFile(worktreePath, () =>
    onServingGitChange?.({ projectId, worktreeId }),
  ).then(
    (stop) => {
      if (serving.get(key) === served) served.stopIndexWatch = stop;
      else stop();
    },
    () => {},
  );
  onServingChange?.();
}

// The git half, read or applied in place.
export async function servedGitState({
  projectId,
  worktreeId,
}: MirrorWorktreePayload) {
  const { project, worktree } = await findProjectAndWorktreeOrThrow(
    projectId,
    worktreeId,
  );
  return readGitState(project.path, worktree.path, worktreeId);
}

export async function applyServedGitState({
  projectId,
  worktreeId,
  expect,
  state,
  sweep,
}: MirrorApplyGitStatePayload) {
  const { project, worktree } = await findProjectAndWorktreeOrThrow(
    projectId,
    worktreeId,
  );
  const result = await applyGitState(
    project,
    { id: worktreeId, path: worktree.path },
    { expect, state, sweep },
  );
  if (!result.applied) return { applied: false, reason: result.reason };
  onGitApplied?.(project.id);
  return { applied: true };
}
