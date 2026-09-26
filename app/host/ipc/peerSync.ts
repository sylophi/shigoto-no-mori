// The move orchestrations' reach into a peer device's sync surface,
// injected at boot following the setCliRunnerImpl precedent: the
// remote plumbing lives in main/, so this seam owns the api shape and
// the sync handlers stay free of Electron imports. The injected
// factory must route through the bridge's SHARED direct-session cache
// (makeHubHandlers), never a fresh dial: the host keeps exactly one
// authed socket per deviceId, and a second dial silently supersedes
// the session every remote-forest query is riding on.
import type { mirrorContract } from "@shared/ipc/modules/mirror";
import type { ChannelMux } from "@shared/ipc/socket/channels";
import type { syncContract } from "@shared/ipc/modules/sync";
import type { worktreesContract } from "@shared/ipc/modules/worktrees";
import { implSlot } from "@host/lib/util/implSlot";
import type { Client } from "@shared/ipc/types";
import { type Worktree, WorktreeSchema } from "@shared/schemas";

// The remote verbs the orchestrations drive, and the byte channels of
// the same cached session that their source links ride
// (host/lib/sync/sourceLink.ts): resolving once the direct session
// exists, rejecting when there is none.
export type PeerChannels = () => Promise<Pick<ChannelMux, "attach" | "has">>;
export type PeerSyncApi = Pick<
  Client<typeof syncContract>,
  | "ignoredPaths"
  | "hasCommits"
  | "openSource"
  | "receiveWorktree"
  | "receiveBundle"
> & { channels: PeerChannels };

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

const { set: setPeerSyncApiImpl, get: requireImpl } = implSlot<PeerSyncImpl>(
  "peer api requested before setPeerSyncApiImpl ran",
);
export { setPeerSyncApiImpl };

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
export async function peerWorktreeOrUndefined(
  deviceId: string,
  projectId: string,
  worktreeId: string,
): Promise<Worktree | undefined> {
  const worktrees = WorktreeSchema.array().parse(
    await peerWorktreesApiFor(deviceId).list({ projectId }),
  );
  return worktrees.find((worktree) => worktree.id === worktreeId);
}
