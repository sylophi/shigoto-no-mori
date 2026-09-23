// The pull orchestration's reach into a peer device's sync surface,
// provided by the binding like the CLI runner (cliDelegate.ts): the
// remote plumbing lives in main/, so this seam owns the api shape and
// the sync handlers stay free of Electron imports. The provided
// factory must route through the bridge's SHARED direct-session cache
// (makeHubHandlers), never a fresh dial: the host keeps exactly one
// authed socket per deviceId, and a second dial silently supersedes
// the session every remote-forest query is riding on.
import type { mirrorContract } from "@shared/ipc/modules/mirror";
import type { syncContract } from "@shared/ipc/modules/sync";
import type { worktreesContract } from "@shared/ipc/modules/worktrees";
import type { Client } from "@shared/ipc/types";
import { Context, Effect, Schema } from "effect";
import { hostAttempt, hostService, requireService } from "@host/runtime";
import { type Worktree, WorktreeSchema } from "@shared/schemas";

// The remote verbs the orchestrations drive. Superset of the transfer
// slices fetchBundleFromPeer and pushBundleToPeer take, so one client
// serves all of them.
export type PeerSyncApi = Pick<
  Client<typeof syncContract>,
  | "refTips"
  | "captureDirty"
  | "ignoredPaths"
  | "bundleStart"
  | "bundleChunk"
  | "bundleAbort"
  | "pushStart"
  | "pushChunk"
  | "pushFinish"
  | "hasCommits"
  | "landCheck"
  | "landWorktree"
>;

// The git follower's reach into a peer's mirror surface: read the git
// state of a served worktree and apply one there.
export type PeerMirrorApi = Pick<
  Client<typeof mirrorContract>,
  "gitState" | "applyGitState"
>;

// The transplant orchestration's teardown reach (the peer's ordinary
// worktrees:delete), the mirror start's path lookup (worktrees:list)
// and the control ops' shelving of a brought worktree's source, riding
// the same grant-gated wire as the sync verbs.
export type PeerWorktreesApi = Pick<
  Client<typeof worktreesContract>,
  "delete" | "list" | "setShelved"
>;

type PeerSyncImpl = {
  syncApiFor: (deviceId: string) => PeerSyncApi;
  worktreesApiFor: (deviceId: string) => PeerWorktreesApi;
};

export class PeerApis extends Context.Service<PeerApis, PeerSyncImpl>()(
  "sm/host/PeerApis",
) {}

const MISSING = "peer api requested before the host runtime provided PeerApis";

function requireImpl(): PeerSyncImpl {
  return hostService(PeerApis, MISSING);
}

// The same reach for a handler written as an Effect.
export const peerApis: Effect.Effect<PeerSyncImpl, never, PeerApis> =
  requireService(PeerApis, MISSING);

export function peerSyncApiFor(deviceId: string): PeerSyncApi {
  return requireImpl().syncApiFor(deviceId);
}

export function peerWorktreesApiFor(deviceId: string): PeerWorktreesApi {
  return requireImpl().worktreesApiFor(deviceId);
}

// One of a peer's worktrees, read off its own list and re-parsed
// here: its root path flows into a session this device persists, so
// the caller's say-so is never the source of it. undefined when the
// peer no longer lists it.
const decodeWorktrees = Schema.decodeUnknownSync(Schema.Array(WorktreeSchema));

export async function peerWorktreeOrUndefined(
  deviceId: string,
  projectId: string,
  worktreeId: string,
): Promise<Worktree | undefined> {
  const worktrees = decodeWorktrees(
    await peerWorktreesApiFor(deviceId).list({ projectId }),
  );
  return worktrees.find((worktree) => worktree.id === worktreeId);
}

// The same lookup as an Effect, interruptible while the peer answers.
export const peerWorktree = (
  deviceId: string,
  projectId: string,
  worktreeId: string,
): Effect.Effect<Worktree | undefined, unknown, PeerApis> =>
  Effect.flatMap(peerApis, (apis) =>
    hostAttempt(async () =>
      decodeWorktrees(
        await apis.worktreesApiFor(deviceId).list({ projectId }),
      ).find((worktree) => worktree.id === worktreeId),
    ),
  );
