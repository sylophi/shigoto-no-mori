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
import { callFailureOf } from "@shigomori/contracts/errors";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import { FileSync } from "@host/fileSync/FileSync";
import { dataDir } from "@shared/paths";
import { findProjectAndWorktree } from "@host/lib/projects";
import { attachFarEnd, requireChannels } from "@host/socket/channelStreams";
import { applyGitState, readGitState, watchIndexFile } from "./gitState";
import { log } from "@shared/log";
import { MirrorSignals } from "./MirrorSignals";

// The mirror streams this host currently serves, keyed by the calling
// device and the channel id it minted (unique per connection, so the
// pair is what identifies a stream host-wide): what mirror:list
// reports as `serving`, so a worktree shows "mirrored to <device>" on
// the machine it lives on. Entries live exactly as long as their
// channel.
const serving = new Map<string, MirrorServing>();

export function listMirrorServing(): MirrorServing[] {
  return [...serving.values()];
}

// The mirror list changed without a session doing so (a stop's copy
// removal finished).
export const announceServingChange = Effect.map(MirrorSignals, (signals) =>
  signals.servingChanged(),
);

function servingKey(ctx: HandlerContext, channelId: string): string {
  return `${ctx.callerDeviceId ?? ""}:${channelId}`;
}

function forgetServing(signals: MirrorSignals["Service"], key: string): void {
  if (!serving.delete(key)) return;
  signals.servingChanged();
}

// A mirror stream: the far end is a fresh `file-sync serve` for the
// named worktree, spoken to over its stdio. The child dies with the
// channel: a peer reset, an end from both sides or the socket dying all
// kill it, and a child that exits on its own ends the channel the
// ordinary way. The child serves the worktree's path alone: the root
// the peer's Mutagen side names in the protocol is replaced by it. A
// session from before the copy moved (the v3 migration's move into
// wt/) names it by its old id, which the lookup follows.
export const serveStream = Effect.fn("Mirror.serveStream")(function* (
  { projectId, worktreeId, channelId, peerWorktreeId }: MirrorOpenStreamPayload,
  ctx: HandlerContext,
) {
  requireChannels(ctx, channelId);
  const signals = yield* MirrorSignals;
  const { worktree } = yield* findProjectAndWorktree(projectId, worktreeId);
  const worktreePath = worktree.path;
  // The child ends when its channel does.
  const closed = yield* Deferred.make<void>();
  // Its own data directory under this host's: unset, the engine's
  // caches and staging land in ~/.mutagen, shared with any real
  // Mutagen install and with every other build and profile here.
  const child = yield* (yield* FileSync).serve(
    worktreePath,
    { MUTAGEN_DATA_DIRECTORY: join(dataDir(), "file-sync", "serve") },
    Deferred.await(closed),
  );
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim();
    if (text !== "") log.warn(`[mirror] serve ${worktree.id}: ${text}`);
  });
  const key = servingKey(ctx, channelId);
  const stopChild = () => {
    Deferred.doneUnsafe(closed, Exit.void);
    child.stream.destroy();
  };
  yield* Effect.try({
    try: () =>
      attachFarEnd(ctx, channelId, child.stream, {
        onClosed: () => {
          stopChild();
          forgetServing(signals, key);
        },
      }),
    // The connection died or the id was claimed during the lookup
    // above: the child is in its own process group, so the destroyed
    // stdio alone would not end it.
    catch: (error) => {
      stopChild();
      return callFailureOf(error);
    },
  });
  serving.set(key, {
    channelId,
    projectId,
    worktreeId: worktree.id,
    peerDeviceId: ctx.callerDeviceId ?? "",
    ...(peerWorktreeId === undefined ? {} : { peerWorktreeId }),
    // oxlint-disable-next-line shigomori/no-wall-clock -- when serving began, for display
    since: Date.now(),
  });
  // A stage or unstage in the served worktree is the one git change the
  // peer's follower cannot learn from the git-directory watcher. Told
  // under the id the peer's session holds, and this device's own, for as
  // long as the child serves.
  yield* watchIndexFile(worktreePath).pipe(
    Stream.runForEach(() =>
      Effect.sync(() => {
        signals.gitChanged({ projectId, worktreeId });
        if (worktree.id !== worktreeId) {
          signals.gitChanged({ projectId, worktreeId: worktree.id });
        }
      }),
    ),
    Effect.ignore,
    Effect.forkIn(child.scope),
  );
  signals.servingChanged();
});

// The git half, read or applied in place.
export const servedGitState = ({
  projectId,
  worktreeId,
}: MirrorWorktreePayload) =>
  Effect.flatMap(
    findProjectAndWorktree(projectId, worktreeId),
    ({ project, worktree }) =>
      readGitState(project.path, worktree.path, worktree.id),
  );

export const applyServedGitState = ({
  projectId,
  worktreeId,
  expect,
  state,
  sweep,
}: MirrorApplyGitStatePayload) =>
  Effect.gen(function* () {
    const { project, worktree } = yield* findProjectAndWorktree(
      projectId,
      worktreeId,
    );
    const result = yield* applyGitState(
      project,
      { id: worktree.id, path: worktree.path },
      { expect, state, sweep },
    );
    if (!result.applied) {
      return { applied: false as const, reason: result.reason };
    }
    (yield* MirrorSignals).gitApplied(project.id);
    return { applied: true as const };
  });
